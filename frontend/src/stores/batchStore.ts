import { writable } from 'svelte/store'
import type { Block, BlockState } from '../types/block'
import type { PrintBatch, PrintKind } from '../types/batch'
import { db } from '../utils/db'

const batchList = writable<PrintBatch[]>([])

/** 版片已可正式印制的状态：全部刻成或经修版。 */
const READY_STATES: ReadonlySet<BlockState> = new Set(['已刻成', '已修版'])

/**
 * 以版片现状判定本次印制的性质，不看画稿的“可印”标记：
 * 还有待刻或在刻版片时只能记试印；全部刻成或修版后才记正式印。
 */
export function resolvePrintKind(blocks: Array<Pick<Block, 'state'>>): PrintKind {
  if (blocks.length === 0) return '试印'
  return blocks.every((block) => READY_STATES.has(block.state)) ? '正式印' : '试印'
}

async function load(): Promise<void> {
  const records = await db.batches.toArray()
  records.sort(
    (a, b) => b.printedAt.localeCompare(a.printedAt) || b.batchNo.localeCompare(a.batchNo, 'zh-CN'),
  )
  batchList.set(records)
}

/**
 * 按画稿、纸张批号与印制日期找原批：命中即作为补印并入原记录累加，
 * 纸张批号不同（或换画稿、换日期）才开新批。
 */
async function findOriginBatch(input: {
  draftId: string
  paperBatch: string
  printedAt: string
}): Promise<PrintBatch | undefined> {
  const sameDraft = await db.batches.where('draftId').equals(input.draftId).toArray()
  return sameDraft.find(
    (batch) => batch.paperBatch === input.paperBatch && batch.printedAt === input.printedAt,
  )
}

function appendNote(current: string, addition: string): string {
  const clean = addition.trim()
  if (!clean) return current
  if (!current) return clean
  return `${current}；${clean}`
}

export interface RegisterBatchInput {
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  /** 该画稿当前的全部版片，用于按版片现状判定试印或正式印。 */
  blocks: Array<Pick<Block, 'state'>>
}

export interface RegisterBatchResult {
  batch: PrintBatch
  reprinted: boolean
  printKind: PrintKind
}

async function registerBatch(input: RegisterBatchInput): Promise<RegisterBatchResult> {
  const printKind = resolvePrintKind(input.blocks)
  const origin = await findOriginBatch({
    draftId: input.draftId,
    paperBatch: input.paperBatch,
    printedAt: input.printedAt,
  })

  if (origin) {
    const nextReprintCount = origin.reprintCount + 1
    const nextRecord: PrintBatch = {
      ...origin,
      // 以版片现状为准：版片已齐备时，原试印批的补印升级为正式印。
      printKind,
      qty: origin.qty + input.qty,
      pieceCount: origin.pieceCount + input.pieceCount,
      reprintCount: nextReprintCount,
      inkNote: appendNote(origin.inkNote, input.inkNote),
      qcNote: appendNote(origin.qcNote, `补印${input.qty}张：${input.qcNote}`),
    }
    await db.batches.put(nextRecord)
    await load()
    return { batch: nextRecord, reprinted: true, printKind }
  }

  const record: PrintBatch = {
    id: `batch-${crypto.randomUUID()}`,
    draftId: input.draftId,
    batchNo: input.batchNo,
    printedAt: input.printedAt,
    paperBatch: input.paperBatch,
    inkNote: input.inkNote || '颜料与胶量待续记',
    qty: input.qty,
    pieceCount: input.pieceCount,
    qcNote: input.qcNote,
    printKind,
    reprintCount: 0,
  }
  await db.batches.add(record)
  await load()
  return { batch: record, reprinted: false, printKind }
}

export interface BatchSummary {
  trialCount: number
  formalCount: number
  reprintCount: number
  formalQty: number
}

export function summarizeBatches(list: PrintBatch[]): BatchSummary {
  const summary: BatchSummary = { trialCount: 0, formalCount: 0, reprintCount: 0, formalQty: 0 }
  for (const batch of list) {
    if (batch.printKind === '正式印') {
      summary.formalCount += 1
      // 累计印数只算正式印（含其补印累加后的总数）。
      summary.formalQty += batch.qty
    } else {
      summary.trialCount += 1
    }
    summary.reprintCount += batch.reprintCount
  }
  return summary
}

export const batchStore = {
  subscribe: batchList.subscribe,
  load,
  registerBatch,
  findOriginBatch,
  resolvePrintKind,
  summarizeBatches,
}
