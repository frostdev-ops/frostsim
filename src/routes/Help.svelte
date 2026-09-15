<script lang="ts">
  // P14.20: Help and status, every field first-hand.
  //
  // NO EXTERNAL STATUS SERVICE, and that is the design rather than a shortcut.
  // A dot fetched from a third party reports on that service, not on the browser
  // in front of the user, and it keeps saying "operational" while the app they
  // are looking at is broken. Everything below is measured in this page, from
  // this origin, right now.
  import { app, catalogBaseUrl, engineIdentity, isBusy } from '../lib/app.svelte'
  import { engineSlotStatus, engineSlotSupported } from '../lib/simc/client'
  import {
    auditDiagnostic, browserFacts, buildDiagnostic, buildIdentity, engineCached,
    type BrowserFacts, type BuildIdentity,
  } from '../lib/diagnostics'
  import {
    applyUpdate, cacheForOffline, offline, ready, unknownState,
  } from '../lib/store/offline.svelte'
  import { run } from '../lib/job.svelte'
  import { fmtBytes, fmtInt } from '../lib/format'
  import { href } from '../lib/router.svelte'
  import Banner from '../lib/ui/Banner.svelte'

  let build = $state<BuildIdentity | null>(null)
  let browser = $state<BrowserFacts | null>(null)
  let cached = $state<boolean | null>(null)
  let slot = $state<{ supported: boolean; heldElsewhere: boolean | 'unknown' } | null>(null)
  let exportNote = $state('')

  $effect(() => {
    void buildIdentity().then((b) => (build = b))
    void browserFacts().then((b) => (browser = b))
    void engineCached().then((c) => (cached = c))
    void engineSlotStatus().then((s) => (slot = s)).catch(() => (slot = null))
  })

  const manifest = $derived(app.capability?.ok ? app.capability.manifest : null)
  const catalog = $derived(app.catalogManifest)

  /** Catalog id change signals everything derived from it is stale; disagreement is defect. */
  const versionMismatch = $derived.by(() => {
    if (!manifest || !catalog) return null
    const problems: string[] = []
    const catalogId = catalog.catalogId ?? ''
    if (catalogId && !catalogId.startsWith(manifest.wow.clientDataVersion)) {
      problems.push(
        `The engine carries game data ${manifest.wow.clientDataVersion}, and the catalog was built for a different version (${catalogId}).`,
      )
    }
    if (catalogId && manifest.engine.upstreamCommit &&
        !catalogId.includes(manifest.engine.upstreamCommit.slice(0, 7))) {
      problems.push(
        `The catalog was generated from a different SimulationCraft revision than the engine binary (${manifest.engine.upstreamCommit.slice(0, 7)}).`,
      )
    }
    return problems.length ? problems : null
  })

  const featuresOff = $derived.by(() => {
    const cap = app.capability
    if (!cap?.ok) return []
    return cap.manifest.capabilities.profilesets
      ? []
      : ['Top Gear', 'Droptimizer', 'Compare']
  })

  async function downloadDiagnostic(): Promise<void> {
    exportNote = ''
    try {
      const file = buildDiagnostic({
        build: build ?? await buildIdentity(),
        browser: browser ?? await browserFacts(),
        engineManifest: manifest,
        catalogManifest: catalog,
        capability: app.capability,
        lastRun: run.outcome
          ? {
              iterations: run.outcome.report.actualIterations,
              targetReached: run.outcome.report.targetReached,
              elapsedSeconds: run.outcome.report.timings.engineElapsedSeconds,
              warnings: run.outcome.report.warnings.length,
              status: app.job?.status ?? null,
            }
          : null,
      })
      // The file is meant to be pasted into a public issue. Anything that could
      // identify the user is a bug in this function, so it is checked rather
      // than trusted — the objects above are other tracks' and can gain fields.
      const leaks = auditDiagnostic(file)
      if (leaks.length) {
        exportNote = `Not exported: this build assembled a diagnostic containing ${leaks.join(', ')}, which could identify you. That is a bug in Frostsim — please report it without attaching anything.`
        return
      }
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'frostsim-diagnostic.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url))
      exportNote = `Download started, ${fmtBytes(blob.size)}. It carries no character name, realm or profile.`
    } catch (err) {
      exportNote = `The diagnostic could not be built: ${err instanceof Error ? err.message : String(err)}`
    }
  }
</script>

<div class="stack">
  <section class="panel stack">
    <header>
      <div class="stack-sm">
        <h1>Help and status</h1>
        <p class="muted small">
          Everything here is measured in this browser, now. Frostsim has no status service to ask
          &mdash; and a status page hosted somewhere else would keep saying &ldquo;operational&rdquo;
          while the copy in front of you was broken.
        </p>
      </div>
    </header>
  </section>

  {#if versionMismatch}
    <Banner kind="bad" title="The engine and the game data do not match" live>
      <ul>{#each versionMismatch as p, i (i)}<li>{p}</li>{/each}</ul>
      <p>
        Results from this combination may be wrong. This is a packaging defect, not something you
        can fix here.
      </p>
    </Banner>
  {/if}

  {#if featuresOff.length}
    <Banner kind="warn" title="Some tools are unavailable in this browser">
      <p>
        This engine build has no profileset support, so {featuresOff.join(', ')}
        {featuresOff.length === 1 ? 'is' : 'are'} switched off. Quick Sim and Advanced still work.
        The usual cause is a browser without <code>SharedArrayBuffer</code>.
      </p>
    </Banner>
  {/if}

  <section class="panel stack-sm">
    <h2 class="small">This build</h2>
    <dl class="kv">
      <dt>Build</dt>
      <dd class="mono">{build?.stamp ?? 'not read yet'}</dd>
      <dt>Cached release</dt>
      <dd class="mono">{build?.caches.length ? build.caches.join(', ') : 'nothing cached'}</dd>
      <dt>Service worker</dt>
      <dd>
        {build?.worker ?? '…'}
        {#if build?.updateWaiting}
          <span class="chip">update held back</span>
        {/if}
      </dd>
    </dl>
    {#if build?.updateWaiting}
      <!-- Not an error. Holding an update back is the design: swapping engine
           bytes under a running job is what P11.8 forbids. -->
      <p class="xs muted">
        A newer version is downloaded and waiting. It is deliberately not applied while a
        simulation could be running, because swapping the engine mid-run would invalidate it.
      </p>
      <div class="row-tight">
        <button class="sm primary" disabled={isBusy()} onclick={applyUpdate}>Apply the update</button>
        {#if isBusy()}<span class="xs muted">Finish or cancel the current run first.</span>{/if}
      </div>
    {/if}
  </section>

  <section class="panel stack-sm">
    <h2 class="small">Engine and game data</h2>
    {#if manifest}
      <dl class="kv">
        <dt>SimulationCraft</dt><dd class="mono">{manifest.engine.simcVersion}</dd>
        <dt>Upstream revision</dt>
        <dd class="mono">{manifest.engine.upstreamCommit.slice(0, 7)} on {manifest.engine.upstreamBranch}</dd>
        <dt>Engine licence</dt>
        <dd class="mono">GPL-3.0-only <a href="https://github.com/simulationcraft/simc">source</a></dd>
        <dt>Game data</dt><dd class="mono">{manifest.wow.clientDataVersion}</dd>
        <dt>Hotfixes</dt>
        <dd class="mono">
          {manifest.wow.hotfixHash?.slice(0, 12) ?? 'none recorded'}
          ({manifest.wow.hotfixBuild ?? '—'})
        </dd>
        <dt>PTR data</dt>
        <dd>{manifest.wow.ptr ? 'included' : 'excluded — Frostsim does not simulate PTR content'}</dd>
        <dt>Artifact</dt><dd class="mono">{manifest.artifact}</dd>
      </dl>
    {:else}
      <p class="muted small">The engine description has not loaded, so nothing here can be stated.</p>
    {/if}

    {#if catalog}
      <h3 class="xs">Item and talent data</h3>
      <dl class="kv">
        <dt>Catalog</dt><dd class="mono">{catalog.catalogId ?? '—'}</dd>
        {#if catalog.counts}
          {#each Object.entries(catalog.counts) as [k, v] (k)}
            <dt>{k}</dt><dd class="num">{fmtInt(v as number)}</dd>
          {/each}
        {/if}
      </dl>
      {#if catalog.coverage?.length}
        <details class="disclosure">
          <summary>What in this data is verified, and against what</summary>
          <div class="scroll-x">
            <table class="compact">
              <thead>
                <tr>
                  <th scope="col">Field</th><th scope="col">Status</th>
                  <th scope="col" class="n">Rows</th><th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {#each catalog.coverage as c, i (i)}
                  <tr>
                    <th scope="row">{c.field}</th>
                    <td>
                      {c.status}
                      {#if c.notes}<span class="muted xs">{c.notes}</span>{/if}
                    </td>
                    <td class="n">{c.count !== undefined ? fmtInt(c.count) : '—'}</td>
                    <td class="mono xs">{c.source}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </details>
      {/if}
    {/if}
  </section>

  <section class="panel stack-sm">
    <h2 class="small">What this browser can do</h2>
    <dl class="kv">
      <dt>Cross-origin isolation</dt>
      <dd>{browser?.crossOriginIsolated ? 'on' : 'off — the engine cannot use threads'}</dd>
      <dt>SharedArrayBuffer</dt>
      <dd>{browser?.sharedArrayBuffer ? 'available' : 'missing — single-threaded engine only'}</dd>
      <dt>Processor threads</dt>
      <dd class="num">
        {browser?.hardwareConcurrency ?? 'unknown'}
        {#if manifest}<span class="muted xs">(engine ceiling {manifest.capabilities.maxThreads})</span>{/if}
      </dd>
      <dt>Gear searches</dt>
      <dd>{manifest?.capabilities.profilesets ? 'supported' : 'not supported by this engine build'}</dd>
      <dt>Other tabs</dt>
      <dd>
        {#if !slot}
          not checked yet
        {:else if !slot.supported}
          this browser cannot coordinate between tabs, so Frostsim cannot tell
        {:else if slot.heldElsewhere === 'unknown'}
          <!-- Unknown is not free. Rendering it as free is the whole trap. -->
          unknown
        {:else if slot.heldElsewhere}
          another tab is holding the engine
        {:else}
          no other tab is simulating
        {/if}
      </dd>
    </dl>
    <p class="xs muted">
      One simulation needs on the order of two gigabytes, which is why only one runs at a time
      {#if engineSlotSupported()}across every Frostsim tab{:else}in this tab{/if}.
    </p>
  </section>

  <section class="panel stack-sm">
    <h2 class="small">Working offline</h2>
    <p class="small">
      <strong>Offline means this page opens and simulates without a network.</strong> It does not
      mean anything runs in the background: the simulation happens in this tab, so it needs the tab
      open and the device awake.
    </p>
    <dl class="kv">
      <dt>Engine cached</dt>
      <dd>
        {#if cached === null}could not be checked{:else if cached}yes{:else}no{/if}
        <span class="muted xs">about 63 MB, 6.5 MB compressed</span>
      </dd>
      <dt>App shell</dt><dd>{ready(offline.status?.shell) ? 'cached' : 'not cached'}</dd>
      <dt>Game data</dt>
      <dd>
        {#if unknownState(offline.status?.catalog)}
          unknown &mdash; {offline.status?.catalog.reason}
        {:else if offline.status?.catalog.status === 'absent'}
          none configured for this build
        {:else if ready(offline.status?.catalog)}cached
        {:else}not cached{/if}
      </dd>
    </dl>
    <p class="xs muted">
      Item icons and item lookups need the network even when everything else is cached. They are
      presentation, not results &mdash; a simulation is unaffected by their absence.
    </p>
    <div class="row-tight">
      <button class="sm" onclick={() => cacheForOffline(catalogBaseUrl())}>
        Download everything for offline use
      </button>
    </div>
  </section>

  <section class="panel stack-sm">
    <h2 class="small">What leaves this browser</h2>
    <!-- Stated as a list of what DOES leave. "Nothing leaves your machine" is
         unverifiable to a reader and not quite true. -->
    <ul class="small">
      <li>
        <strong>The simulation never leaves.</strong> There is no simulation server. Your
        character, talents, gear, settings and every result are computed here and stored in this
        browser only.
      </li>
      <li>
        <strong>Item and spell ID numbers do leave</strong>, to this same site's
        <code>/api/</code> path, which asks Blizzard's game data service for names and icons.
        ID numbers only &mdash; never your character's name, realm, profile text or results.
      </li>
      <li>
        <strong>Nothing goes to analytics or logging</strong>, because Frostsim has none
        configured. If that ever changes, this line changes with it.
      </li>
      <li>
        <strong>Links and exports carry what you chose to put in them.</strong> The sample
        character that ships has had its name and realm stripped; your own export is your own data.
      </li>
    </ul>
    {#if app.capability?.ok}
      <p class="xs muted">
        Engine identity for this page: <span class="mono">{engineIdentity()?.artifact ?? '—'}</span>
      </p>
    {/if}
  </section>

  <section class="panel stack-sm">
    <h2 class="small">When something goes wrong</h2>
    <dl class="kv">
      <dt>The page looks out of date</dt>
      <dd>Apply the waiting update above, or reload. An update is held back while a run is live.</dd>
      <dt>The engine will not load</dt>
      <dd>Check cross-origin isolation above; if it is off, the site is not sending the headers the engine needs.</dd>
      <dt>A run never finishes</dt>
      <dd>Cancel it from the run panel. Cancelling terminates the engine and settles in about a second.</dd>
      <dt>Frostsim asks you to reload</dt>
      <dd>A simulation could not be confirmed stopped. Export anything you want to keep, then reload &mdash; nothing in the page can clear that state.</dd>
      <dt>Everything is wrong</dt>
      <dd>
        <a href={href('reports')}>Export your history</a> first, then clear this site's data in your
        browser settings. Frostsim deliberately has no one-click wipe: it would delete characters
        and results that exist nowhere else.
      </dd>
    </dl>
  </section>

  <section class="panel stack-sm">
    <h2 class="small">Diagnostic file</h2>
    <p class="small">
      One JSON file describing this installation: build, engine and data versions, what this
      browser supports, and facts about the last run. <strong>It carries no character name, no
      realm, and no profile</strong>, so it is safe to attach to a public bug report. Nothing is
      uploaded &mdash; the file is yours.
    </p>
    <div class="row-tight">
      <button class="sm" onclick={downloadDiagnostic}>Download diagnostic</button>
    </div>
    {#if exportNote}<p class="xs">{exportNote}</p>{/if}
  </section>
</div>

<style>
  .kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.3rem var(--s4); margin: 0; }
  .kv dt { color: var(--text-muted); }
  .kv dd { margin: 0; overflow-wrap: anywhere; }
  .scroll-x { overflow-x: auto; }
  @media (max-width: 560px) {
    .kv { grid-template-columns: minmax(0, 1fr); gap: 0 }
    .kv dd { margin-bottom: var(--s2); }
  }
</style>
