<script lang="ts">
  import { onMount } from 'svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { draftStore } from '../stores/draftStore'
  import { blockStore } from '../stores/blockStore'
  import { buildDeviationNote } from '../utils/seq'
  import { downloadJson } from '../utils/export'
  import { db } from '../utils/db'
  import type { PrintBatch, PrintEvent, PrintKind } from '../types/batch'
  import {
    areBlocksReady,
    batchKind,
    findExistingBatch,
    formalPrintTotal,
    normalizePaperBatch,
    resolvePrintKind,
    suggestBatchNo,
    trialPrintTotal,
  } from '../types/batch'

  let batches = $state<PrintBatch[]>([])
  let showForm = $state(false)
  let draftId = $state('')
  let printedAt = $state(new Date().toISOString().slice(0, 10))
  let paperBatch = $state('')
  let inkNote = $state('')
  let qty = $state(100)
  let pieceCount = $state(4)
  let qcNote = $state('')
  let deviations = $state<Record<string, string>>({})
  let formMessage = $state('')

  const selectedDraft = $derived($draftStore.find((draft) => draft.id === draftId) ?? null)
  const selectedBlocks = $derived(
    draftId ? [...$blockStore].filter((block) => block.draftId === draftId).sort((a, b) => a.colorNo - b.colorNo) : [],
  )
  /** 本次性质只认版片现状，不看画稿的“可印”标记 */
  const blocksReady = $derived(areBlocksReady(selectedBlocks))
  const printKind: PrintKind = $derived(resolvePrintKind(selectedBlocks))
  const unreadyBlocks = $derived(
    selectedBlocks.filter((block) => block.state === '待刻' || block.state === '在刻'),
  )
  /** 按画稿 + 纸张批号找原批；同刀纸并入，换纸才开新批 */
  const mergeTarget = $derived(
    draftId && paperBatch.trim() ? findExistingBatch(batches, draftId, paperBatch) : undefined,
  )
  const isReprint = $derived(Boolean(mergeTarget))
  /** 新批批次号按画稿、性质与既有批次自动生成；补印时沿用原批号 */
  const batchNo = $derived(
    selectedDraft ? suggestBatchNo(batches, draftId, selectedDraft.title, printKind, printedAt) : '',
  )

  const totalFormalQty = $derived(batches.reduce((sum, batch) => sum + formalPrintTotal(batch), 0))
  const totalTrialQty = $derived(batches.reduce((sum, batch) => sum + trialPrintTotal(batch), 0))
  const totalReprints = $derived(batches.reduce((sum, batch) => sum + batch.reprintCount, 0))

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), refreshBatches()])
  })

  async function refreshBatches(): Promise<void> {
    const records = await db.batches.toArray()
    records.sort((a, b) => b.printedAt.localeCompare(a.printedAt) || b.batchNo.localeCompare(a.batchNo, 'zh-CN'))
    batches = records
  }

  function openForm(): void {
    showForm = true
    formMessage = ''
    if (!draftId) {
      const firstDraft = $draftStore[0]
      if (firstDraft) selectDraft(firstDraft.id)
    }
  }

  function selectDraft(nextId: string): void {
    draftId = nextId
    deviations = {}
    paperBatch = ''
    const draftBlocks = [...$blockStore].filter((block) => block.draftId === nextId)
    const readyCount = draftBlocks.filter((block) => block.state === '已刻成' || block.state === '已修版').length
    pieceCount = readyCount > 0 ? readyCount : 4
  }

  function draftTitle(targetId: string): string {
    return $draftStore.find((draft) => draft.id === targetId)?.title ?? '未知画稿'
  }

  async function submitBatch(): Promise<void> {
    if (!draftId || !paperBatch.trim() || qty <= 0 || pieceCount <= 0) {
      formMessage = '请选择画稿，并补全纸张批号和印数。'
      return
    }
    if (!mergeTarget && !batchNo.trim()) {
      formMessage = '新批批次号生成失败，请重开表单后再试。'
      return
    }
    if (selectedBlocks.length === 0) {
      formMessage = '该画稿尚无版片记录，不能登记印制。'
      return
    }

    const deviationText = buildDeviationNote(
      selectedBlocks.map((block) => ({
        blockName: block.blockName,
        deviation: deviations[block.id] ?? '',
      })),
    )
    const nextQcNote = qcNote.trim() ? `${qcNote.trim()}；${deviationText}` : deviationText

    if (mergeTarget) {
      // 补印：同画稿同刀纸并入原批，只追加印次并累加，不另开批次
      const event: PrintEvent = {
        printedAt,
        kind: printKind,
        qty: Number(qty),
        pieceCount: Number(pieceCount),
        inkNote: inkNote.trim() || '颜料与胶量待续记',
        qcNote: nextQcNote,
      }
      const changes: Partial<PrintBatch> = {
        events: [...mergeTarget.events, event],
        reprintCount: mergeTarget.reprintCount + 1,
        inkNote: event.inkNote,
        qcNote: event.qcNote,
      }
      // 该纸批首个正式事件（可能由试印批转正）或首个试印事件，记下首批印数
      if (
        printKind === '正式印' &&
        mergeTarget.firstFormalQty === 0 &&
        !mergeTarget.events.some((e) => e.kind === '正式印')
      ) {
        changes.firstFormalQty = Number(qty)
      }
      if (
        printKind === '试印' &&
        mergeTarget.trialQty === 0 &&
        !mergeTarget.events.some((e) => e.kind === '试印')
      ) {
        changes.trialQty = Number(qty)
      }
      await db.batches.update(mergeTarget.id, changes)
    } else {
      // 纸张批号变了（或首次登记）才开新批
      const event: PrintEvent = {
        printedAt,
        kind: printKind,
        qty: Number(qty),
        pieceCount: Number(pieceCount),
        inkNote: inkNote.trim() || '颜料与胶量待续记',
        qcNote: nextQcNote,
      }
      const record: PrintBatch = {
        id: `batch-${crypto.randomUUID()}`,
        draftId,
        batchNo: batchNo.trim(),
        printedAt,
        paperBatch: normalizePaperBatch(paperBatch),
        inkNote: event.inkNote,
        qcNote: event.qcNote,
        trialQty: printKind === '试印' ? Number(qty) : 0,
        firstFormalQty: printKind === '正式印' ? Number(qty) : 0,
        reprintCount: 0,
        events: [event],
        schemaRev: 3,
      }
      await db.batches.add(record)
    }

    await refreshBatches()
    resetForm()
  }

  function resetForm(): void {
    showForm = false
    paperBatch = ''
    inkNote = ''
    qty = 100
    pieceCount = 4
    qcNote = ''
    deviations = {}
    formMessage = ''
  }

  function latestPieceCount(batch: PrintBatch): number {
    return batch.events[batch.events.length - 1]?.pieceCount ?? 0
  }

  async function exportArchive(): Promise<void> {
    const [drafts, blocks, carvers, nodes] = await Promise.all([
      db.drafts.toArray(),
      db.blocks.toArray(),
      db.carvers.toArray(),
      db.nodes.toArray(),
    ])
    downloadJson('木版年画工序档案.json', { exportedAt: new Date().toISOString(), drafts, blocks, batches, carvers, nodes })
  }
</script>

<svelte:head>
  <title>印制批次登记 · 木版年画刻版工序档案</title>
</svelte:head>

<div class="page-heading">
  <div>
    <p class="eyebrow">套色印制留档</p>
    <h1>印制批次登记</h1>
    <p>同一刀纸补印并入原批累加，换纸才开新批；试印与正式印按版片现状区分。</p>
  </div>
  <div class="heading-actions">
    <button class="button ghost" type="button" onclick={exportArchive}>导出 JSON</button>
    <button class="button primary" data-testid="new-batch" type="button" onclick={openForm}>登记印制</button>
  </div>
</div>

<section class="summary-strip four">
  <div><span>登记批次</span><strong data-testid="count-batch">{batches.length}</strong></div>
  <div><span>累计正式印数</span><strong data-testid="total-formal">{totalFormalQty}</strong></div>
  <div><span>试印印数</span><strong data-testid="total-trial">{totalTrialQty}</strong></div>
  <div><span>补印次数</span><strong data-testid="total-reprint">{totalReprints}</strong></div>
</section>

{#if showForm}
  <section class="panel form-panel" data-testid="form-batch">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">{isReprint ? '补印登记' : '新印批'}</span>
        <h2>{isReprint ? `并入原批 ${mergeTarget?.batchNo}` : '登记纸张与套色检查'}</h2>
      </div>
      <button class="text-button" type="button" onclick={resetForm}>收起</button>
    </div>

    <div class="form-grid three">
      <label>
        <span>所属画稿</span>
        <select data-testid="field-draftId" value={draftId} onchange={(event) => selectDraft((event.currentTarget as HTMLSelectElement).value)}>
          <option value="">请选择</option>
          {#each $draftStore as draft}<option value={draft.id}>{draft.title} · {draft.genre}</option>{/each}
        </select>
      </label>
      <label>
        <span>纸张批号</span>
        <input data-testid="field-paperBatch" bind:value={paperBatch} placeholder="如：泾县-2605" />
      </label>
      <label>
        <span>印制日期</span>
        <input data-testid="field-printedAt" type="date" bind:value={printedAt} />
      </label>
      <label>
        <span>本次印数</span>
        <input data-testid="field-qty" type="number" min="1" bind:value={qty} />
      </label>
      <label>
        <span>每版印次</span>
        <input data-testid="field-pieceCount" type="number" min="1" bind:value={pieceCount} />
      </label>
      <label>
        <span>归批结果</span>
        <input data-testid="field-batchNo" value={isReprint ? mergeTarget?.batchNo ?? '' : batchNo} readonly />
      </label>
      <label class="wide">
        <span>颜料与胶量</span>
        <textarea data-testid="field-inkNote" rows="2" bind:value={inkNote} placeholder="分色记录颜料、胶量与稀稠"></textarea>
      </label>
    </div>

    {#if selectedDraft}
      <div class="kind-banner" data-testid="kind-banner" class:ready={blocksReady}>
        {#if blocksReady}
          <p><b>本次性质：正式印</b> —— {selectedDraft.title} 全部 {selectedBlocks.length} 块版片均已刻成或修版，可记正式印。</p>
        {:else}
          <p><b>本次性质：试印</b> —— 尚有 {unreadyBlocks.length} 块版片未刻成，只能记试印；以版片现状为准，不按画稿“可印”标记放行。</p>
          <p class="unready-list">
            {#each unreadyBlocks as block, i}{#if i > 0}；{/if}{block.colorNo} {block.blockName}（{block.state}）{/each}
          </p>
        {/if}
        {#if mergeTarget}
          <p class="merge-hint" data-testid="merge-hint">
            同刀纸 {normalizePaperBatch(paperBatch)} 已登记原批 {mergeTarget.batchNo}，本次为第 {mergeTarget.reprintCount + 1} 次补印，印数并入原记录，不另开批次。
          </p>
        {:else}
          <p class="merge-hint">纸张批号 {normalizePaperBatch(paperBatch) || '（待填）'} 无原批，将开新批：{batchNo}。</p>
        {/if}
      </div>
    {/if}

    {#if selectedDraft}
      <div class="deviation-block">
        <div class="section-title-row">
          <div>
            <span class="section-kicker">逐版检查</span>
            <h3>{selectedDraft.title}套色偏差</h3>
          </div>
          <span>{selectedBlocks.length} 块版片</span>
        </div>
        <div class="deviation-grid">
          {#each selectedBlocks as block}
            <label>
              <span><b>{block.colorNo}</b>{block.blockName}</span>
              <input
                data-testid={`field-deviation-${block.id}`}
                value={deviations[block.id] ?? ''}
                oninput={(event) => (deviations[block.id] = (event.currentTarget as HTMLInputElement).value)}
                placeholder="如：右下角偏红线半根"
              />
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <label class="stacked-field">
      <span>总检说明</span>
      <textarea data-testid="field-qcNote" rows="2" bind:value={qcNote} placeholder="走版、纸面洇墨与整体套准情况"></textarea>
    </label>

    {#if formMessage}<p class="form-message">{formMessage}</p>{/if}
    <div class="form-actions">
      <button class="button primary" data-testid="submit-batch" type="button" onclick={submitBatch}>
        {isReprint ? `保存补印（并入${mergeTarget?.batchNo}）` : `保存${printKind}`}
      </button>
      <button class="button ghost" type="button" onclick={resetForm}>取消</button>
    </div>
  </section>
{/if}

{#if batches.length === 0}
  <EmptyBox
    title="尚无印制批次"
    message="版片刻成后即可逐版试印，登记纸张与套色偏差。"
    actionLabel="登记印制"
    onaction={openForm}
  />
{:else}
  <section class="batch-list">
    {#each batches as batch (batch.id)}
      {@const kind = batchKind(batch)}
      <article class="panel batch-item" data-testid="row-batch">
        <div class="batch-number">
          <span>{batch.printedAt.replace(/-/g, '.')} · {batch.paperBatch}</span>
          <h2>
            {batch.batchNo}
            <em class="kind-tag {kind === '正式印' ? 'formal' : 'trial'}" data-testid={`kind-${batch.id}`}>{kind}</em>
          </h2>
          <p>{draftTitle(batch.draftId)} · 补印 {batch.reprintCount} 次</p>
        </div>
        <div class="batch-counts">
          <div><span>正式印累计</span><strong data-testid={`formal-${batch.id}`}>{formalPrintTotal(batch)}</strong></div>
          <div><span>试印</span><strong data-testid={`trial-${batch.id}`}>{trialPrintTotal(batch)}</strong></div>
          <div><span>补印次数</span><strong>{batch.reprintCount}</strong></div>
          <div><span>每版印次</span><strong>{latestPieceCount(batch)}</strong></div>
        </div>
        <div class="batch-notes">
          <p><b>颜料胶量：</b>{batch.inkNote}</p>
          <p><b>套色检查：</b>{batch.qcNote}</p>
          {#if batch.events.length > 0}
            <div class="event-log">
              <b>印次留痕（{batch.events.length} 次）：</b>
              <ul>
                {#each batch.events as event, index}
                  <li>
                    <em class="kind-tag {event.kind === '正式印' ? 'formal' : 'trial'}">{event.kind}</em>
                    {index === 0 ? '原批' : `第 ${index} 次补印`} · {event.printedAt.replace(/-/g, '.')} · {event.qty} 张 · 每版 {event.pieceCount} 印次
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      </article>
    {/each}
  </section>
{/if}
