import type { Block, BlockState } from './block'

/** 印次性质：版片未齐时刻的是试印，全部刻成/修版后才是正式印 */
export type PrintKind = '试印' | '正式印'

export interface PrintEvent {
  /** 本次印制日期 */
  printedAt: string
  /** 本次性质，以保存当时的版片状态为准 */
  kind: PrintKind
  /** 本次印数 */
  qty: number
  /** 本次每版印次 */
  pieceCount: number
  inkNote: string
  qcNote: string
}

export interface PrintBatch {
  id: string
  draftId: string
  batchNo: string
  /** 原批首次印制日期；补印只追加印次，不改原批日期 */
  printedAt: string
  /** 纸张批号：同一画稿同一刀纸并入原批，换纸才开新批 */
  paperBatch: string
  inkNote: string
  qcNote: string
  /** 首批试印印数（无试印则为 0） */
  trialQty: number
  /** 首批正式印数（未转正则为 0） */
  firstFormalQty: number
  /** 补印次数：除该纸批首批之外的追加印次 */
  reprintCount: number
  /** 逐次印制留痕，第 1 条为原批，其后均为补印 */
  events: PrintEvent[]
  schemaRev?: number
}

/** 版片进入可正式印状态的刻版状态 */
const READY_STATES: ReadonlySet<BlockState> = new Set(['已刻成', '已修版'])

/** 以版片现状判断能否正式印：没有任何待刻/在刻版片才算刻齐 */
export function areBlocksReady(blocks: Pick<Block, 'state'>[]): boolean {
  return blocks.length > 0 && blocks.every((block) => READY_STATES.has(block.state))
}

/** 按版片现状给出本次印次性质；不以画稿的“可印”标记放行 */
export function resolvePrintKind(blocks: Pick<Block, 'state'>[]): PrintKind {
  return areBlocksReady(blocks) ? '正式印' : '试印'
}

/** 纸张批号归一化，避免同刀纸因空格/大小写差异被拆成两批 */
export function normalizePaperBatch(value: string): string {
  return value.trim().replace(/\s+/g, '')
}

/** 批次归批键：画稿 + 纸张批号（印制日期只作记录，不参与归批） */
export function batchMatchKey(draftId: string, paperBatch: string): string {
  return `${draftId}::${normalizePaperBatch(paperBatch)}`
}

/** 找原批：同画稿、同刀纸即并入；纸张批号变了返回 null，由调用方开新批 */
export function findExistingBatch(
  batches: PrintBatch[],
  draftId: string,
  paperBatch: string,
): PrintBatch | undefined {
  const target = normalizePaperBatch(paperBatch)
  return batches.find(
    (batch) => batch.draftId === draftId && normalizePaperBatch(batch.paperBatch) === target,
  )
}

/** 正式印累计只算正式印数：首批正式印 + 历次正式补印，试印不计入 */
export function formalPrintTotal(batch: PrintBatch): number {
  return batch.events
    .filter((event) => event.kind === '正式印')
    .reduce((sum, event) => sum + event.qty, 0)
}

/** 试印印数（累计试印，含同纸批的追加试印） */
export function trialPrintTotal(batch: PrintBatch): number {
  return batch.events
    .filter((event) => event.kind === '试印')
    .reduce((sum, event) => sum + event.qty, 0)
}

/** 批次当前性质：已转正则标正式印，否则仍是试印批 */
export function batchKind(batch: PrintBatch): PrintKind {
  return batch.events.some((event) => event.kind === '正式印') ? '正式印' : '试印'
}

/** 新批批次号：试印批带“试印”序号，正式印按该画稿既有正式批顺延 */
export function suggestBatchNo(
  batches: PrintBatch[],
  draftId: string,
  draftTitle: string,
  kind: PrintKind,
  printedAt: string,
): string {
  const ownBatches = batches.filter((batch) => batch.draftId === draftId)
  const year = printedAt.slice(0, 4)
  if (kind === '试印') {
    const trialCount = ownBatches.filter((batch) => batch.batchNo.includes('试印')).length
    return `${draftTitle}-试印-${String(trialCount + 1).padStart(2, '0')}`
  }
  const formalNos = ownBatches
    .filter((batch) => batchKind(batch) === '正式印' && !batch.batchNo.includes('试印'))
    .map((batch) => /(\d+)$/.exec(batch.batchNo))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
  const nextNo = (formalNos.length ? Math.max(...formalNos) : 0) + 1
  return `${draftTitle}-${year}-${String(nextNo).padStart(2, '0')}`
}
