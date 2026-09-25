<script lang="ts">
  // P11.2: local history; summaries from stored record; raw engine report read on demand only.
  import {
    app, deleteReport, engineIdentity, exportEverything, loadRaw, openDraft, restoreReport, toast, updateReport,
  } from '../lib/app.svelte'
  import { fmtBytes, fmtDateTime, fmtInt, fmtPct, fmtRelative, titleCase } from '../lib/format'
  import { href, navigate, router } from '../lib/router.svelte'
  import {
    engineCompatibility, makePortable, readPortable, TOOL_LABELS,
    type StoredReport, type ToolId,
  } from '../lib/store/records'
  import * as db from '../lib/store/db'
  import Banner from '../lib/ui/Banner.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import Dialog from '../lib/ui/Dialog.svelte'
  import ReportResult from '../lib/ui/ReportResult.svelte'
  import { loadReportSummary, type SimOutcome, type SimRequest } from '../lib/simc/job'
  import { parseAddonExport } from '../lib/import/character'
  import { sendSetup } from '../lib/handoff.svelte'
  import { quickSettings } from '../lib/settings.svelte'
  import { run, startRun } from '../lib/job.svelte'
  let savedOutcome = $state<SimOutcome | null>(null)
  let reportError = $state('')
  function editSaved(): void {
    if (!savedOutcome) return
    const request = savedOutcome.request
    const character = request.characterSnapshot ?? parseAddonExport(request.profile)
    openDraft(character, 'quick')
    quickSettings.restoreDefaults()
    quickSettings.apply({ ...request.settings, accuracyMode: request.accuracy.mode === 'targetError' ? 'targetError' : request.accuracy.mode === 'iterations' ? 'iterations' : 'script', ...request.accuracy })
    sendSetup({ characterId: null, label: detail?.title ?? 'Saved setup', items: Object.fromEntries(character.equipped.map(item => [item.slot, item])), talents: character.talents, extraProfileLines: request.extraProfileLines, settings: quickSettings.snapshot() })
    run.outcome = null
    navigate('quick')
  }

  let query = $state('')
  let toolFilter = $state<ToolId | 'all'>('all')
  let undo = $state<StoredReport | null>(null)
  let undoTimer: ReturnType<typeof setTimeout> | null = null
  let detail = $state<StoredReport | null>(null)
  let detailRaw = $state<string | null>(null)
  let detailLoading = $state(false)
  let confirmClear = $state(false)
  let importInput: HTMLInputElement | undefined = $state()

  const current = $derived(engineIdentity())

  const filtered = $derived(
    app.reports.filter((r) => {
      if (toolFilter !== 'all' && r.tool !== toolFilter) return false
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (
        r.title.toLowerCase().includes(q) ||
        r.characterLabel.toLowerCase().includes(q) ||
        (r.summary.specialization ?? '').toLowerCase().includes(q)
      )
    }),
  )
  const pinned = $derived(filtered.filter((r) => r.pinned))
  const rest = $derived(filtered.filter((r) => !r.pinned))

  // Report route resolves local id (no character data in URL).
  $effect(() => {
    const id = router.rest[0]
    if (!id) return
    const found = app.reports.find((r) => r.id === id)
    if (found && detail?.id !== id) void open(found)
  })

  async function open(r: StoredReport): Promise<void> {
    detail = r
    savedOutcome = null
    reportError = ''
    detailRaw = null
    if (!r.hasRaw) return
    detailLoading = true
    const raw = await loadRaw(r.id)
    if (detail?.id !== r.id) return
    detailRaw = raw
    detailLoading = false
    const request = r.requestSnapshot as SimRequest | null
    if (raw && request?.schemaVersion === 1 && typeof request.profile === 'string' && request.settings && request.accuracy) {
      try {
        const blob = new Blob([raw], { type: 'application/json' })
        const report = await loadReportSummary(blob)
        if (detail?.id !== r.id) return
        savedOutcome = { jobId: r.id, request, report, profilesetStatus: { completed: report.profilesets.map(p => p.name), missing: [] }, inputWarnings: [], appElapsedSeconds: r.summary.elapsedSeconds ?? report.timings.engineElapsedSeconds, engineIdentity: r.engine.upstreamCommit ?? '', engineNotices: [], effectiveProfile: '', effectiveArgs: [], getRawJson: () => blob, getHtmlReport: () => null }
      } catch { reportError = 'The saved detail could not be read.' }
    }
  }

  async function remove(r: StoredReport): Promise<void> {
    const record = await deleteReport(r.id)
    if (!record) return
    undo = record
    if (undoTimer) clearTimeout(undoTimer)
    undoTimer = setTimeout(() => (undo = null), 9000)
  }

  function download(name: string, text: string, type = 'application/json'): void {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  async function exportOne(r: StoredReport): Promise<void> {
    const raw = r.hasRaw ? await loadRaw(r.id) : null
    download(
      `${r.title.replace(/[^\w-]+/g, '-').toLowerCase()}.frostsim.json`,
      JSON.stringify(makePortable('report', { record: r, rawReport: raw }, r.engine), null, 2),
    )
  }

  // One export path, shared with the reload-required banner: a user in that
  // state must be able to keep their work, and two implementations would drift.
  const exportAll = exportEverything

  async function onImport(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    const check = readPortable(await file.text())
    if (!check.ok) { toast('bad', check.reason); return }
    toast('info', `Read a ${check.file.kind} export from ${fmtDateTime(check.file.exportedAt)}.`)
    if (check.file.kind === 'character') navigate('character')
  }

  async function clearAll(): Promise<void> {
    await db.clear('reports')
    await db.clear('blobs')
    app.reports = []
    confirmClear = false
    toast('good', 'History cleared.')
  }

  function compat(r: StoredReport) {
    return engineCompatibility(r.engine, current)
  }

  const usagePct = $derived(
    app.storage.usage && app.storage.quota
      ? (app.storage.usage / app.storage.quota) * 100
      : undefined,
  )
</script>

{#if savedOutcome}
  <div class="stack"><div><button class="ghost sm" onclick={() => { savedOutcome = null; detail = null; navigate('reports') }}>← All reports</button></div><ReportResult outcome={savedOutcome} onrerun={() => { const request = savedOutcome!.request; navigate('quick'); void startRun({ tool: 'quick', title: detail?.title ?? 'Quick Sim', request }) }} onedit={editSaved} /></div>
{:else}
<div class="stack">
  <CatalogStatus />

  <section class="panel stack">
    <header>
      <div class="stack-sm">
        <h1>Reports</h1>
        <p class="muted small" title="Everything you have run on this device. Browser storage can be evicted, so an export is the copy that survives.">
          {fmtInt(app.reports.length)} on this device
          {#if app.storage.usage !== undefined}
            · {fmtBytes(app.storage.usage)}{app.storage.quota ? ` of ~${fmtBytes(app.storage.quota)}` : ''}
            {#if usagePct !== undefined}({fmtPct(usagePct, 1)}){/if}
          {/if}
          {#if app.storage.persisted}
            · <span title="This origin has persistent storage, which makes eviction unlikely but not impossible.">persistent</span>
          {:else}
            · <span title="The browser may evict this data when space runs low. Export anything you need to keep.">evictable</span>
          {/if}
        </p>
      </div>
      <div class="row-tight">
        <button class="sm" onclick={() => importInput?.click()}>Import export…</button>
        <input
          type="file"
          accept=".json,application/json"
          class="sr-only"
          bind:this={importInput}
          onchange={onImport}
        />
        <button class="sm" onclick={exportAll} disabled={!app.reports.length}>Export all</button>
      </div>
    </header>

    <div class="row">
      <label class="field grow">
        <span class="sr-only">Search reports</span>
        <input type="search" bind:value={query} placeholder="Search by title, character or spec" />
      </label>
      <label class="field">
        <span class="sr-only">Filter by tool</span>
        <select bind:value={toolFilter}>
          <option value="all">All tools</option>
          {#each Object.entries(TOOL_LABELS) as [id, label] (id)}
            <option value={id}>{label}</option>
          {/each}
        </select>
      </label>
    </div>

  </section>

  {#if undo}
    <Banner kind="info" title="Report deleted" live>
      <p>“{undo.title}” was removed.</p>
      {#snippet actions()}
        <button
          class="sm"
          onclick={() => {
            if (undo) void restoreReport(undo)
            undo = null
          }}
        >Undo</button>
      {/snippet}
    </Banner>
  {/if}

  {#if !app.reports.length}
    <section class="empty stack">
      <h2>Nothing yet</h2>
      <p class="muted">Reports appear here as soon as you run something.</p>
      <p><a href={href('quick')}>Run a Quick Sim</a></p>
    </section>
  {:else if !filtered.length}
    <section class="empty">
      <p class="muted">No report matches that filter.</p>
    </section>
  {:else}
    {#each [['Pinned', pinned], ['History', rest]] as [heading, group] (heading)}
      {#if (group as StoredReport[]).length}
        <section class="panel panel-flush">
          <h2 class="small group-head">{heading}</h2>
          <ul class="plain">
            {#each group as r ((r as StoredReport).id)}
              {@const rep = r as StoredReport}
              {@const c = compat(rep)}
              <li class="report">
                <button class="open grow" onclick={() => open(rep)}>
                  <span class="row-tight">
                    <strong class="truncate">{rep.title}</strong>
                    <span class="chip">{TOOL_LABELS[rep.tool]}</span>
                    {#if rep.completion === 'partial'}<span class="chip warn">partial</span>{/if}
                    {#if rep.completion === 'cancelled'}<span class="chip">cancelled</span>{/if}
                    {#if rep.completion === 'failed'}<span class="chip bad">failed</span>{/if}
                    {#if !c.compatible}<span class="chip warn">older engine</span>{/if}
                  </span>
                  <span class="xs muted row-tight">
                    <span>{rep.characterLabel}</span>
                    {#if rep.summary.specialization}
                      <span>· {titleCase(rep.summary.specialization)}</span>
                    {/if}
                    <span>· {fmtRelative(rep.createdAt)}</span>
                    {#if rep.summary.actualIterations}
                      <span>· {fmtInt(rep.summary.actualIterations)} samples</span>
                    {/if}
                    {#if rep.summary.targetReached === false}
                      <span class="warn-text">· accuracy target not reached</span>
                    {/if}
                  </span>
                </button>
                <div class="metric-cell">
                  {#if rep.summary.dps !== undefined}
                    <span class="num big">{fmtInt(rep.summary.dps)}</span>
                    <span class="xs muted">
                      DPS{#if rep.summary.confidenceMargin !== undefined}
                        ±{fmtInt(rep.summary.confidenceMargin)}
                      {/if}
                    </span>
                  {:else if rep.summary.candidateCount}
                    <span class="num big">{rep.summary.candidateCount}</span>
                    <span class="xs muted">variants</span>
                  {/if}
                </div>
                <div class="row-tight actions">
                  <button
                    class="ghost sm"
                    aria-pressed={rep.pinned}
                    onclick={() => void updateReport(rep.id, { pinned: !rep.pinned })}
                  >{rep.pinned ? 'Unpin' : 'Pin'}</button>
                  <button class="ghost sm" onclick={() => void exportOne(rep)}>Export</button>
                  <button class="ghost sm danger" onclick={() => void remove(rep)}>Delete</button>
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {/each}

    <div class="row">
      <button class="sm danger" onclick={() => (confirmClear = true)}>Clear all history</button>
    </div>
  {/if}
</div>

{/if}

<Dialog
  open={!!detail && !savedOutcome}
  title={detail?.title ?? ''}
  width="42rem"
  onclose={() => { detail = null; detailRaw = null }}
>
  {#if detail}
    {@const c = compat(detail)}
    <div class="stack">
      {#if !c.compatible}
        <Banner kind="warn" title="Produced by a different build">
          <p>{c.reason}</p>
          <p>
            The numbers below are exactly what that build reported. Running the same input now
            produces a new result, not a corrected version of this one.
          </p>
        </Banner>
      {/if}

      <dl class="kv">
        <dt>Character</dt><dd>{detail.characterLabel}</dd>
        <dt>Ran</dt><dd>{fmtDateTime(detail.createdAt)}</dd>
        <dt>Tool</dt><dd>{TOOL_LABELS[detail.tool]}</dd>
        {#if detail.summary.dps !== undefined}
          <dt>DPS</dt>
          <dd>
            {fmtInt(detail.summary.dps)}
            {#if detail.summary.confidenceMargin !== undefined}
              ± {fmtInt(detail.summary.confidenceMargin)}
              at {Math.round((detail.summary.confidenceLevel ?? 0) * 100)}%
            {:else if detail.summary.standardError !== undefined}
              (standard error {fmtInt(detail.summary.standardError)}; no confidence estimator
              reported)
            {/if}
          </dd>
        {/if}
        {#if detail.summary.actualIterations !== undefined}
          <dt>Samples</dt>
          <dd>
            {fmtInt(detail.summary.actualIterations)}
            {#if detail.summary.targetReached === false}
              <span class="chip warn">accuracy target not reached</span>
            {/if}
          </dd>
        {/if}
        <dt>Engine</dt>
        <dd>
          {detail.engine.simcVersion ?? 'unknown'}
          {#if detail.engine.upstreamCommit}({detail.engine.upstreamCommit.slice(0, 7)}){/if}
          {#if detail.engine.wowVersion}· game data {detail.engine.wowVersion}{/if}
        </dd>
      </dl>

      {#if detail.summary.topCandidates?.length}
        <div class="tbl-scroll">
          <table class="tbl">
            <thead>
              <tr><th>Variant</th><th class="n">DPS</th><th class="n">Change</th></tr>
            </thead>
            <tbody>
              {#each detail.summary.topCandidates as tc (tc.id)}
                <tr>
                  <td>{tc.label}</td>
                  <td class="n">{fmtInt(tc.mean)}</td>
                  <td class="n" class:gain={tc.delta > 0} class:loss={tc.delta < 0}>
                    {tc.delta > 0 ? '+' : ''}{fmtInt(tc.delta)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if detail.summary.warnings?.length}
        <details class="disclosure">
          <summary>{detail.summary.warnings.length} engine notices</summary>
          <ul class="xs mono muted">
            {#each detail.summary.warnings as w, i (i)}<li>{w}</li>{/each}
          </ul>
        </details>
      {/if}

      <label class="field">
        <span>Note</span>
        <input
          type="text"
          value={detail.note ?? ''}
          placeholder="Why you ran this"
          onchange={(e) => detail && void updateReport(detail.id, { note: e.currentTarget.value })}
        />
      </label>

      {#if detail.hasRaw}
        <p class="xs muted">
          {#if detailLoading}
            Loading the raw report…
          {:else if detailRaw}
            Raw engine report kept: {fmtBytes(detailRaw.length)}.
          {:else}
            The raw report could not be read back from storage.
          {/if}
        </p>
      {:else}
        <p class="xs muted">No raw report was kept for this run.</p>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    {#if detail}
      {#if detailRaw}
        <button onclick={() => download(`${detail!.id}.json`, detailRaw!)}>Download raw JSON</button>
      {/if}
      <button onclick={() => void exportOne(detail!)}>Export</button>
      <button class="primary" onclick={() => { navigate(detail!.tool); detail = null }}>
        Set up a rerun
      </button>
    {/if}
  {/snippet}
</Dialog>

<Dialog
  bind:open={confirmClear}
  title="Clear all history?"
  width="26rem"
  onclose={() => (confirmClear = false)}
>
  <p>
    {app.reports.length} report{app.reports.length === 1 ? '' : 's'} and every raw engine report
    will be deleted from this browser. Saved characters are kept. This cannot be undone.
  </p>
  {#snippet footer()}
    <button onclick={() => void exportAll()}>Export first</button>
    <button onclick={() => (confirmClear = false)}>Cancel</button>
    <button class="danger" onclick={clearAll}>Delete everything</button>
  {/snippet}
</Dialog>

<style>
  ul.plain { list-style: none; margin: 0; padding: 0; }
  .group-head { padding: var(--s3) var(--s4) var(--s2); color: var(--text-muted); }
  .report {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s2) var(--s4);
    border-top: 1px solid var(--border);
  }
  .open {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
    cursor: pointer;
    padding: var(--s2) 0;
  }
  .open:hover strong { color: var(--accent); }
  .open:focus-visible { box-shadow: var(--focus); border-radius: var(--r1); }
  .metric-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    flex: none;
    line-height: 1.2;
  }
  .big { font-size: var(--fs-lg); font-weight: 650; }
  .actions { flex: none; }
  .warn-text { color: var(--warn); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 0.3rem var(--s3); margin: 0; }
  .kv dt { color: var(--text-muted); white-space: nowrap; }
  .kv dd { margin: 0; }
  @media (max-width: 44rem) {
    .report { flex-wrap: wrap; }
    .actions { width: 100%; justify-content: flex-end; }
  }
</style>
