<script lang="ts">
  import { onMount } from 'svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { draftStore } from '../stores/draftStore'
  import { blockStore } from '../stores/blockStore'
  import { batchStore, summarizeBatches, type RegisterBatchResult } from '../stores/batchStore'
  import { buildDeviationNote } from '../utils/seq'
  import { downloadJson } from '../utils/export'
  import { db } from '../utils/db'
  import type { PrintBatch } from '../types/batch'
  import type { Block, BlockState } from '../types/block'

  let showForm = $state(false)
  let draftId = $state('')
  let batchNo = $state('')
  let printedAt = $state(new Date().toISOString().slice(0, 10))
  let paperBatch = $state('')
  let inkNote = $state('')
  let qty = $state(100)
  let pieceCount = $state(4)
  let qcNote = $state('')
  let deviations = $state<Record<string, string>>({})
  let formMessage = $state('')
  let lastResult = $state<RegisterBatchResult | null>(null)

  const batches = $batchStore
  const summary = $derived(summarizeBatches(batches))

  const selectedDraft = $derived($draftStore.find((draft) => draft.id === draftId) ?? null)
  const selectedBlocks = $derived(
    draftId ? [...$blockStore].filter((block) => block.draftId === draftId).sort((a, b) => a.colorNo - b.colorNo) : [],
  )
  /** 以版片现状判定本次保存可记的印制性质，画稿“可印”标记不放行。 */
  const pendingBlocks = $derived(selectedBlocks.filter((block) => block.state === '待刻' || block.state === '在刻'))
  const effectivePrintKind = $derived(
    selectedBlocks.length > 0 && pendingBlocks.length === 0 ? '正式印' : '试印',
  )

  // 同画稿、同纸张批号、同印制日期的已登记批次即原批，命中则并入补印、不开新批。
  const matchedBatch = $derived.by(() => {
    if (!draftId || !paperBatch.trim() || !printedAt) return undefined
    return batches.find(
      (batch) =>
        batch.draftId === draftId &&
        batch.paperBatch === paperBatch.trim() &&
        batch.printedAt === printedAt,
    )
  })

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), batchStore.load()])
  })

  function openForm(): void {
    showForm = true
    formMessage = ''
    lastResult = null
    if (!draftId) {
      const firstDraft = $draftStore[0]
      if (firstDraft) selectDraft(firstDraft.id)
    }
  }

  function resetForm(): void {
    batchNo = ''
    paperBatch = ''
    inkNote = ''
    qty = 100
    pieceCount = 4
    qcNote = ''
    deviations = {}
    formMessage = ''
  }

  function selectDraft(nextId: string): void {
    draftId = nextId
    deviations = {}
    const target = $draftStore.find((draft) => draft.id === nextId)
    if (target) batchNo = `${target.title}-${new Date().getFullYear()}-01`
  }

  function draftTitle(targetId: string): string {
    return $draftStore.find((draft) => draft.id === targetId)?.title ?? '未知画稿'
  }

  function pendingStateText(pending: Array<Pick<Block, 'state'>>): string {
    const counts: Partial<Record<BlockState, number>> = {}
    for (const block of pending) counts[block.state] = (counts[block.state] ?? 0) + 1
    return [
      counts['待刻'] ? `待刻 ${counts['待刻']} 块` : '',
      counts['在刻'] ? `在刻 ${counts['在刻']} 块` : '',
    ]
      .filter(Boolean)
      .join('、')
  }

  async function submitBatch(): Promise<void> {
    if (!draftId || !paperBatch.trim() || qty <= 0 || pieceCount <= 0) {
      formMessage = '请选择画稿，并补全纸张批号和印数。'
      return
    }
    if (!matchedBatch && !batchNo.trim()) {
      formMessage = '开新批需填写批次号；并入原批时批次号沿用原记录。'
      return
    }
    if (selectedBlocks.length === 0) {
      formMessage = '该画稿尚无版片，暂不能登记印制。'
      return
    }

    const deviationText = buildDeviationNote(
      selectedBlocks.map((block) => ({
        blockName: block.blockName,
        deviation: deviations[block.id] ?? '',
      })),
    )
    const mergedQcNote = qcNote.trim() ? `${qcNote.trim()}；${deviationText}` : deviationText

    const result = await batchStore.registerBatch({
      draftId,
      batchNo: (matchedBatch?.batchNo ?? batchNo).trim(),
      printedAt,
      paperBatch: paperBatch.trim(),
      inkNote: inkNote.trim(),
      qty: Number(qty),
      pieceCount: Number(pieceCount),
      qcNote: mergedQcNote,
      blocks: selectedBlocks,
    })

    lastResult = result
    showForm = false
    resetForm()
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
    <p>同刀纸试印后补印并入原批累加；版片尚有待刻、在刻时只记试印，全部刻成或修版后才记正式印。</p>
  </div>
  <div class="heading-actions">
    <button class="button ghost" type="button" onclick={exportArchive}>导出 JSON</button>
    <button class="button primary" data-testid="new-batch" type="button" onclick={openForm}>登记印次</button>
  </div>
</div>

<section class="summary-strip five" aria-label="印制概况">
  <div><span>试印批</span><strong data-testid="count-trial">{summary.trialCount}</strong></div>
  <div><span>正式印批</span><strong data-testid="count-formal">{summary.formalCount}</strong></div>
  <div><span>补印次数</span><strong data-testid="count-reprint">{summary.reprintCount}</strong></div>
  <div><span>累计正式印数</span><strong data-testid="count-formal-qty">{summary.formalQty}</strong></div>
  <div><span>覆盖画稿</span><strong>{new Set(batches.map((batch) => batch.draftId)).size}</strong></div>
</section>

{#if lastResult}
  <p class="notice" data-testid="save-notice">
    {#if lastResult.reprinted}
      已并入原批「{lastResult.batch.batchNo}」记为补印（第 {lastResult.batch.reprintCount} 次），
    {:else}
      已开新批「{lastResult.batch.batchNo}」，
    {/if}
    本次性质：{lastResult.printKind}；该批累计印数 {lastResult.batch.qty} 张。
  </p>
{/if}

{#if showForm}
  <section class="panel form-panel" data-testid="form-batch">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">登记印次</span>
        <h2>纸张、印数与套色检查</h2>
      </div>
      <button class="text-button" type="button" onclick={() => (showForm = false)}>收起</button>
    </div>

    {#if selectedDraft}
      <div class="print-gate" data-testid="print-gate" class:formal={effectivePrintKind === '正式印'}>
        {#if effectivePrintKind === '正式印'}
          <b>本次将记为正式印</b>
          <span>《{selectedDraft.title}》{selectedBlocks.length} 块版片均已刻成或修版，以版片现状放行（不看画稿状态标记）。</span>
        {:else}
          <b>本次只能记试印</b>
          <span>《{selectedDraft.title}》尚有{pendingStateText(pendingBlocks)}；待全部刻成或修版后方可记正式印。</span>
        {/if}
      </div>
    {/if}

    <div class="form-grid three">
      <label>
        <span>所属画稿</span>
        <select data-testid="field-draftId" value={draftId} onchange={(event) => selectDraft((event.currentTarget as HTMLSelectElement).value)}>
          <option value="">请选择</option>
          {#each $draftStore as draft}<option value={draft.id}>{draft.title} · {draft.genre}</option>{/each}
        </select>
      </label>
      <label>
        <span>批次号</span>
        <input
          data-testid="field-batchNo"
          bind:value={batchNo}
          readonly={Boolean(matchedBatch)}
          placeholder={matchedBatch ? '并入原批，沿用原批次号' : '如：莲鱼-甲辰-03'}
        />
      </label>
      <label>
        <span>印制日期</span>
        <input data-testid="field-printedAt" type="date" bind:value={printedAt} />
      </label>
      <label>
        <span>纸张批号</span>
        <input data-testid="field-paperBatch" bind:value={paperBatch} placeholder="如：泾县-2605" />
      </label>
      <label>
        <span>本次印数</span>
        <input data-testid="field-qty" type="number" min="1" bind:value={qty} />
      </label>
      <label>
        <span>本次每版印次</span>
        <input data-testid="field-pieceCount" type="number" min="1" bind:value={pieceCount} />
      </label>
      <label class="wide">
        <span>颜料与胶量</span>
        <textarea data-testid="field-inkNote" rows="2" bind:value={inkNote} placeholder="分色记录颜料、胶量与稀稠；补印时会追加到原批"></textarea>
      </label>
    </div>

    {#if matchedBatch}
      <p class="form-message merge-hint" data-testid="merge-hint">
        已找到同画稿、同刀纸（{matchedBatch.paperBatch}）、同日期（{matchedBatch.printedAt}）的原批「{matchedBatch.batchNo}」，
        本次保存将作为第 {matchedBatch.reprintCount + 1} 次补印并入原记录累加，不另开新批。
      </p>
    {:else if draftId && paperBatch.trim()}
      <p class="form-message new-hint" data-testid="new-hint">纸张批号未命中原批，保存时将开新批。</p>
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
              <span><b>{block.colorNo}</b>{block.blockName}<em class="state-chip state-{block.state}">{block.state}</em></span>
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
        {matchedBatch ? `并入原批记补印（第 ${matchedBatch.reprintCount + 1} 次）· ${effectivePrintKind}` : `保存为新批 · ${effectivePrintKind}`}
      </button>
      <button class="button ghost" type="button" onclick={() => (showForm = false)}>取消</button>
    </div>
  </section>
{/if}

{#if batches.length === 0}
  <EmptyBox
    title="尚无印制批次"
    message="版片刻成后即可逐版试印，登记纸张与套色偏差；同刀纸补印会自动并入原批。"
    actionLabel="登记印次"
    onaction={openForm}
  />
{:else}
  <section class="batch-list">
    {#each batches as batch (batch.id)}
      <article class="panel batch-item" data-testid="row-batch">
        <div class="batch-number">
          <span>{batch.printedAt.replace(/-/g, '.')}</span>
          <h2>
            {batch.batchNo}
            <em class={`print-kind kind-${batch.printKind}`} data-testid="print-kind">{batch.printKind}</em>
          </h2>
          <p>{draftTitle(batch.draftId)} · {batch.paperBatch}</p>
          {#if batch.reprintCount > 0}
            <p class="reprint-line" data-testid="reprint-line">含补印 {batch.reprintCount} 次</p>
          {/if}
        </div>
        <div class="batch-counts">
          <div><span>累计印数</span><strong data-testid="row-qty">{batch.qty}</strong></div>
          <div><span>每版累计印次</span><strong>{batch.pieceCount}</strong></div>
          <div><span>补印次数</span><strong>{batch.reprintCount}</strong></div>
        </div>
        <div class="batch-notes">
          <p><b>颜料胶量：</b>{batch.inkNote}</p>
          <p><b>套色检查：</b>{batch.qcNote}</p>
        </div>
      </article>
    {/each}
  </section>
{/if}
