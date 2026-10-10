<script lang="ts">
  import { tick } from 'svelte'
  // P11.2: local history; summaries from stored record; raw engine report read on demand only.
  import {
    activeCharacter, app, deleteReport, engineIdentity, exportEverything, focusScope, loadLibrary, loadRaw, openDraft, restoreReport, storageMessage, toast, updateReport, type DeletedReport,
  } from '../lib/app.svelte'
  import { fmtBytes, fmtDateTime, fmtInt, fmtPct, fmtRelative, titleCase } from '../lib/format'
  import { href, navigate, router } from '../lib/router.svelte'
  import {
    engineCompatibility, makePortable, MAX_PORTABLE_BYTES, readPortable, readPortableCharacter, redactReport, TOOL_LABELS,
    type StoredReport, type StoredSetup, type ToolId,
  } from '../lib/store/records'
  import * as db from '../lib/store/db'
  import { readLibraryImport, type LibraryImport } from '../lib/store/history-import'
  import Banner from '../lib/ui/Banner.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import Dialog from '../lib/ui/Dialog.svelte'
  import ReportResult from '../lib/ui/ReportResult.svelte'
  import { loadReportSummary, validateRequest, type SimOutcome, type SimRequest } from '../lib/simc/job'
  import { GEAR_SLOTS, parseAddonExport } from '../lib/import/character'
  import { buildProfile } from '../lib/import/serialize'
  import { sendSetup } from '../lib/handoff.svelte'
  import { advancedSettings, compareSettings, crestSettings, dropSettings, gearSettings, quickSettings, type SettingsSnapshot } from '../lib/settings.svelte'
  import { expert, persistDrafts, useSpec, type ExpertDraft } from '../lib/advanced.svelte'
  import { run, startRun } from '../lib/job.svelte'
  import { activeEngineChannel } from '../lib/simc/versions'
  import { profilesetStatus, reportEngineChannel } from '../lib/simc/report'
  import { engineChannelLabel } from '../lib/simc/channel'
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
  let undo = $state<DeletedReport | null>(null)
  let undoTimer: ReturnType<typeof setTimeout> | null = null
  let detail = $state<StoredReport | null>(null)
  let detailRaw = $state<string | null>(null)
  let detailLoading = $state(false)
  let confirmClear = $state(false)
  let importInput: HTMLInputElement | undefined = $state()
  let pendingImport = $state<LibraryImport | null>(null)
  let importing = $state(false)
  let setupOffer = $state<StoredSetup | null>(null)
  let renameOffer = $state<StoredReport | null>(null)
  let renameValue = $state('')
  const setupTools = { quick: quickSettings, compare: compareSettings, gear: gearSettings, droptimizer: dropSettings, crests: crestSettings, advanced: advancedSettings }
  const expertFields = ['raw', 'header', 'preActor', 'postActor', 'footer', 'extraOptions'] as const
  const ordinarySetups = $derived(app.setups.filter(setup => !setup.checkpoint))

  function expertDraft(settings: unknown): settings is ExpertDraft {
    if (!settings || typeof settings !== 'object') return false
    const value = settings as Record<string, unknown>
    return (value.mode === 'raw' || value.mode === 'character') && expertFields.every(key => typeof value[key] === 'string')
  }

  function canUseSetup(setup: StoredSetup): boolean {
    return Object.hasOwn(setupTools, setup.tool) && !!setup.settings && typeof setup.settings === 'object'
      && (setup.tool === 'advanced' && expertDraft(setup.settings)
        || Object.entries(quickSettings.snapshot()).some(([key, value]) => Object.hasOwn(setup.settings as object, key)
          && typeof (setup.settings as Record<string, unknown>)[key] === typeof value))
  }

  function useSavedSetup(): void {
    const setup = setupOffer
    if (!setup || !canUseSetup(setup)) return
    focusScope(setup.tool)
    if (setup.tool === 'advanced' && expertDraft(setup.settings)) {
      useSpec(activeCharacter()?.spec)
      expert.mode = setup.settings.mode
      for (const key of expertFields) expert[key] = setup.settings[key]
      if (!persistDrafts()) toast('bad', 'The Advanced draft is open in this tab but could not be saved on this device.')
    } else setupTools[setup.tool].apply(setup.settings as Partial<SettingsSnapshot>)
    setupOffer = null
    navigate(setup.tool)
  }

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
    const storedRequest = r.requestSnapshot as SimRequest | null
    if (raw && storedRequest?.schemaVersion === 1) {
      try {
        if (validateRequest(storedRequest, 64).length) throw Error('Invalid saved request')
        // Rebuild validated display fields with the frozen gear/talents, preserving edited setups.
        const snapshot = storedRequest.characterSnapshot
        const displayProfile = snapshot ? buildProfile(snapshot, { talents: snapshot.talents,
          items: Object.fromEntries(GEAR_SLOTS.map(slot => [slot, snapshot.equipped.find(item => item.slot === slot) ?? null])) }) : storedRequest.profile
        const request = { ...storedRequest, characterSnapshot: readPortableCharacter({ raw: displayProfile }) }
        const blob = new Blob([raw], { type: 'application/json' })
        const report = await loadReportSummary(blob)
        if (detail?.id !== r.id) return
        const channel = reportEngineChannel(report)
        if (channel) detail = { ...r, engine: { ...r.engine, engineChannel: channel } }
        savedOutcome = { jobId: r.id, request, report, profilesetStatus: profilesetStatus((request.profilesets ?? []).map(p => p.id), report), inputWarnings: [], appElapsedSeconds: r.summary.elapsedSeconds ?? report.timings.engineElapsedSeconds, engineIdentity: r.engine.upstreamCommit ?? '', engineNotices: [], effectiveProfile: '', effectiveArgs: [], getRawJson: () => blob, getHtmlReport: () => null }
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

  async function togglePinned(r: StoredReport, event: MouseEvent): Promise<void> {
    const focused = document.activeElement === event.currentTarget
    await updateReport(r.id, { pinned: !r.pinned })
    await tick()
    // Moving between History and Pinned recreates the row and its focused button.
    if (focused && document.activeElement === document.body) {
      document.getElementById(`report-pin-${r.id}`)?.focus()
    }
  }

  function download(name: string, text: string, type = 'application/json'): void {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  async function exportOne(r: StoredReport, anonymous = false): Promise<void> {
    const record = anonymous ? redactReport(r) : r
    const raw = record.hasRaw ? await loadRaw(record.id) : null
    download(
      `${record.title.replace(/[^\w-]+/g, '-').toLowerCase()}.frostsim.json`,
      JSON.stringify(makePortable('report', { record, rawReport: raw }, record.engine, anonymous), null, 2),
    )
  }

  async function duplicate(r: StoredReport): Promise<void> {
    try {
      const library = readLibraryImport(makePortable('report', { record: { ...$state.snapshot(r), title: `${r.title} (copy)`, pinned: false }, rawReport: r.hasRaw ? await loadRaw(r.id) : null }))
      const out = await db.importLibrary(library)
      if (!out.ok) { toast('bad', storageMessage(out.failure)); return }
      await loadLibrary()
      toast('good', 'Report copied on this device.')
    } catch (error) { toast('bad', error instanceof Error ? error.message : 'The report could not be copied.') }
  }

  async function renameReport(): Promise<void> {
    if (!renameOffer || !renameValue.trim()) return
    if (await updateReport(renameOffer.id, { title: renameValue.trim() })) renameOffer = null
  }

  // One export path, shared with the reload-required banner: a user in that
  // state must be able to keep their work, and two implementations would drift.
  const exportAll = exportEverything

  async function onImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || importing) return
    if (file.size > MAX_PORTABLE_BYTES) { toast('bad', 'This export exceeds the 8 MB import limit.'); return }
    try {
      const check = readPortable(await file.text())
      if (!check.ok) { toast('bad', check.reason); return }
      pendingImport = readLibraryImport(check.file)
    } catch (error) { toast('bad', error instanceof Error ? error.message : 'Could not read this export.'); }
  }

  async function acceptImport(): Promise<void> {
    if (!pendingImport || importing) return
    const library = $state.snapshot(pendingImport)
    importing = true
    const out = await db.importLibrary(library)
    importing = false
    if (!out.ok) { toast('bad', storageMessage(out.failure)); return }
    const count = library.reports.length + library.characters.length + library.setups.length
    pendingImport = null
    await loadLibrary()
    toast('good', `Imported ${count} saved ${count === 1 ? 'record' : 'records'} on this device.`)
  }

  async function clearAll(): Promise<void> {
    const out = await db.clearHistory()
    if (!out.ok) { toast('bad', storageMessage(out.failure)); return }
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

{#if pendingImport}
  <Dialog open={true} title="Import saved work" onclose={() => pendingImport = null}>
    <div class="stack">
      <p>{fmtInt(pendingImport.reports.length)} reports, {fmtInt(pendingImport.characters.length)} characters and {fmtInt(pendingImport.setups.length)} setups.</p>
      <ul class="small">{#each [...pendingImport.reports.map(record => record.title), ...pendingImport.characters.map(record => record.label), ...pendingImport.setups.map(record => record.label)].slice(0, 8) as label}<li>{label}</li>{/each}</ul>
      <p class="small muted">Creates local copies and keeps your existing work. Character workspaces are rebuilt from the exported addon text; recovered drafts become saved records.</p>
      {#if pendingImport.reports.some(report => !compat(report).compatible)}<p class="small">Some reports use another or unrecorded engine. Their original results stay intact; rerunning creates a new result.</p>{/if}
      <div class="row-tight"><button class="primary" disabled={importing} onclick={() => void acceptImport()}>{importing ? 'Importing…' : 'Import saved work'}</button><button class="ghost" disabled={importing} onclick={() => pendingImport = null}>Cancel</button></div>
    </div>
  </Dialog>
{/if}

{#if savedOutcome}
  <div class="stack"><div><button class="ghost sm" onclick={() => { savedOutcome = null; detail = null; navigate('reports') }}>← All reports</button></div><ReportResult outcome={savedOutcome} onrerun={() => { const request = { ...savedOutcome!.request, engineChannel: activeEngineChannel }; navigate('quick'); void startRun({ tool: 'quick', title: detail?.title ?? 'Quick Sim', request }) }} onedit={editSaved} /></div>
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
        <p id="summary-export-note" class="xs muted">Anonymous summaries keep numbers and engine versions. They exclude names, notes, inputs and raw details.</p>
      </div>
      <div class="row-tight">
        <button class="sm" disabled={importing} onclick={() => importInput?.click()}>Import export…</button>
        <input
          type="file"
          accept=".json,application/json"
          hidden
          bind:this={importInput}
          onchange={onImport}
        />
        <button class="sm" onclick={exportAll} disabled={!app.reports.length && !app.characters.length && !app.setups.length && !app.draft}>Export all</button>
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

  {#if ordinarySetups.length}
    <section class="panel stack-sm">
      <h2>Saved setups</h2>
      <ul class="plain">{#each ordinarySetups as setup (setup.id)}<li class="row"><span class="grow">{setup.label} · {TOOL_LABELS[setup.tool]}</span><button class="sm" onclick={() => setupOffer = setup}>Open</button><button class="ghost sm" onclick={() => download('frostsim-setup.json', JSON.stringify(makePortable('setup', setup), null, 2))}>Export</button></li>{/each}</ul>
    </section>
  {/if}

  {#if undo}
    <Banner kind="info" title="Report deleted" live>
      <p>“{undo.record.title}” was removed.</p>
      {#snippet actions()}
        <button
          class="sm"
          onclick={async () => {
            if (!undo) return
            const removed = undo
            if (await restoreReport(removed.record, removed.blob)) undo = null
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
                    <span class="chip">{rep.engine.engineChannel ? engineChannelLabel(rep.engine.engineChannel) : 'Channel not recorded'}</span>
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
                  <button class="ghost sm" onclick={() => { renameOffer = rep; renameValue = rep.title }}>Rename</button>
                  <button class="ghost sm" onclick={() => void duplicate(rep)}>Duplicate</button>
                  <button
                    id={`report-pin-${rep.id}`}
                    class="ghost sm"
                    aria-pressed={rep.pinned}
                    onclick={(event) => void togglePinned(rep, event)}
                  >{rep.pinned ? 'Unpin' : 'Pin'}</button>
                  <button class="ghost sm" onclick={() => void exportOne(rep)}>Export</button>
                  <button class="ghost sm" aria-describedby="summary-export-note" onclick={() => void exportOne(rep, true)}>Anonymous summary</button>
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
        <dt>Game version</dt><dd>{detail.engine.engineChannel ? engineChannelLabel(detail.engine.engineChannel) : 'Channel not recorded'}</dd>
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

      {#if reportError}<p class="small" role="status">{reportError} The saved summary and raw download are still available.</p>{/if}
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

<Dialog open={!!setupOffer} title={setupOffer?.label ?? 'Saved setup'} onclose={() => setupOffer = null}>
  {#if setupOffer}
    <p>Use these {TOOL_LABELS[setupOffer.tool]} settings with the character selected on that screen. This replaces its current settings{expertDraft(setupOffer.settings) ? ' and Advanced text' : ''}. Export first to keep a copy.</p>
    {#if !canUseSetup(setupOffer)}<p>This setup has no settings this build can apply. You can keep or export it.</p>{/if}
    <details class="disclosure"><summary>Saved contents</summary><pre class="small mono">{JSON.stringify(setupOffer.settings, null, 2)}</pre></details>
  {/if}
  {#snippet footer()}<button onclick={() => void exportAll()}>Export current work</button><button onclick={() => setupOffer = null}>Cancel</button><button class="primary" disabled={!setupOffer || !canUseSetup(setupOffer)} onclick={useSavedSetup}>Use saved setup</button>{/snippet}
</Dialog>

<Dialog open={!!renameOffer} title="Rename report" onclose={() => renameOffer = null}>
  <label class="field"><span>Title</span><input bind:value={renameValue} maxlength="200" /></label>
  {#snippet footer()}<button onclick={() => renameOffer = null}>Cancel</button><button class="primary" disabled={!renameValue.trim()} onclick={() => void renameReport()}>Save title</button>{/snippet}
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
  .actions { flex: none; flex-wrap: wrap; }
  .warn-text { color: var(--warn); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 0.3rem var(--s3); margin: 0; }
  .kv dt { color: var(--text-muted); white-space: nowrap; }
  .kv dd { margin: 0; }
  @media (max-width: 60rem) {
    .report { flex-wrap: wrap; }
    .actions { width: 100%; justify-content: flex-end; }
  }
</style>
