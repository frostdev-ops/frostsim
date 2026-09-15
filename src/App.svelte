<script lang="ts">
  import { onMount } from 'svelte'
  // Application shell: navigation, character summary, active job indicator, route outlet (P03.1, P03.2, P03.7).
  import {
    activeCharacter, activeStored, app, catalogBaseUrl, checkCapability, exportEverything,
    isBusy, loadLibrary, pollEngineSlot, prepareForReload, type ReloadReadiness,
    saveCharacter, storageMessage, toast,
  } from './lib/app.svelte'
  import {
    applyUpdate, cacheForOffline, fullyOffline, offline, ready, refreshStatus, register,
    unknownState,
  } from './lib/store/offline.svelte'
  import { cancelActiveJob } from './lib/simc/client'
  import { notify, notifyFinished, refreshPermission, setWanted, support } from './lib/notify.svelte'
  import { trace } from './lib/trace'
  import { fmtInt } from './lib/format'
  import { installShortcuts, SHORTCUT_HINT } from './lib/shortcuts.svelte'
  import { initMedia, media } from './lib/media.svelte'
  import { TOOL_LABELS } from './lib/store/records'
  import { STATUS_LABELS, takeInterrupted, type InterruptedJob } from './lib/job.svelte'
  import { classLabel } from './lib/import/character'
  import { titleCase } from './lib/format'
  import type { Component } from 'svelte'
  import {
    href, navigate, ROUTE_BLURBS, ROUTE_LABELS, ROUTES, router, type RouteName,
  } from './lib/router.svelte'
  import { BLIZZARD_ATTRIBUTION } from './lib/battlenet/contract'
  import { apply as applyTheme, prefs, setMotion, setTheme } from './lib/theme.svelte'
  import { decodeShare, isShareFragment, stripFragment } from './lib/store/share'
  import type { ImportedCharacter } from './lib/import/character'
  import Banner from './lib/ui/Banner.svelte'
  import Dialog from './lib/ui/Dialog.svelte'
  import Character from './routes/Character.svelte'
  import QuickSim from './routes/QuickSim.svelte'
  import Compare from './routes/Compare.svelte'
  import TopGear from './routes/TopGear.svelte'
  import Droptimizer from './routes/Droptimizer.svelte'
  import CrestSim from './routes/CrestSim.svelte'
  import Advanced from './routes/Advanced.svelte'
  import Reports from './routes/Reports.svelte'
  import SharedReport from './routes/SharedReport.svelte'

  const SCREENS = {
    character: Character,
    quick: QuickSim,
    compare: Compare,
    gear: TopGear,
    droptimizer: Droptimizer,
    crests: CrestSim,
    advanced: Advanced,
    reports: Reports,
  }

  /** Talents and Help lazy-load (not on path to first result, budget constraint at 150 kB). */
  const LAZY: Partial<Record<RouteName, () => Promise<{ default: Component }>>> = {
    talents: () => import('./routes/Talents.svelte'),
    help: () => import('./routes/Help.svelte'),
  }

  const lazyLoader = $derived(LAZY[router.name])

  let settingsOpen = $state(false)

  let notifySupport = $state<ReturnType<typeof support>>('askable')
  let notifyNote = $state('')
  $effect(() => {
    refreshPermission()
    notifySupport = support()
  })

  async function toggleNotify(on: boolean): Promise<void> {
    const result = await setWanted(on)
    notifySupport = result
    notifyNote = !on
      ? ''
      : result === 'granted'
        ? ''
        : result === 'denied'
          ? 'Your browser refused. Notifications stay off.'
          : 'Your browser did not answer, so notifications stay off. Try again if you want them.'
  }
  let shareOffer = $state<{ character: ImportedCharacter } | null>(null)
  let shareError = $state('')
  let navOpen = $state(false)
  /** Work running when page went away (P11.3). */
  let interrupted = $state<InterruptedJob | null>(null)

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const busy = $derived(isBusy())
  const Screen = $derived(SCREENS[router.name as keyof typeof SCREENS])

  applyTheme()

  onMount(() => {
    trace('app.start', { route: router.name })
    void checkCapability()
    void loadLibrary()
    void register().then(() => refreshStatus(catalogBaseUrl()))
    interrupted = takeInterrupted()
    void initMedia()
  })

  // Decisive half of Top Gear trace: app.start after page.hide means page came back (explains vanished panel).
  $effect(() => {
    const hide = () => trace('page.hide', { job: app.job?.status ?? null })
    addEventListener('pagehide', hide)
    return () => removeEventListener('pagehide', hide)
  })

  // Share link arrives as fragment; read and strip immediately, ask before importing (P11.5).
  $effect(() => {
    if (typeof window === 'undefined' || !isShareFragment(window.location.hash)) return
    const hash = window.location.hash
    stripFragment()
    void decodeShare(hash).then((check) => {
      if (!check.ok) { shareError = check.reason; return }
      if (check.file.kind !== 'character') {
        shareError = 'That link holds a saved setup or report; character links only, for now.'
        return
      }
      shareOffer = { character: check.file.payload as ImportedCharacter }
    })
  })

  $effect(() => {
    const on = () => (app.online = true)
    const off = () => (app.online = false)
    addEventListener('online', on)
    addEventListener('offline', off)
    return () => { removeEventListener('online', on); removeEventListener('offline', off) }
  })

  // Warn before refresh throws away running simulation (don't trap behind dialog on dead engine).
  $effect(() => {
    if (!busy || app.job?.status === 'error' || app.job?.status === 'cancelled') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  })

  $effect(() => installShortcuts())

  // Close mobile nav on navigation.
  $effect(() => {
    void router.name
    navOpen = false
  })

  /** Run takes tens of seconds; app-level live region announces end since no visual change. */
  let ended = $state('')
  $effect(() => {
    const job = app.job
    if (!job) return
    ended =
      job.status === 'complete'
        ? `${TOOL_LABELS[job.tool]} finished. The results are below.`
        : job.status === 'error'
          ? `${TOOL_LABELS[job.tool]} failed. ${job.error ?? ''}`
          : job.status === 'cancelled'
            ? `${TOOL_LABELS[job.tool]} cancelled. Nothing was saved.`
            : ''
    // P06.11. Same trigger as the announcement, for the same reason: this is
    // the one place every run ending passes through, so no tool can be missed.
    // It is a no-op unless the user opted in and the tab is hidden.
    if (ended) notifyFinished(`Frostsim — ${job.title}`, ended)
  })

  /** What reload actually costs from real state, not assumed. Null until check runs. */
  let reloadCheck = $state<ReloadReadiness | null>(null)
  let reloadConfirmed = $state(false)
  let exporting = $state(false)
  let exportNote = $state('')

  $effect(() => {
    if (!app.engineBlocked) { reloadCheck = null; reloadConfirmed = false; exportNote = ''; return }
    void prepareForReload().then((r) => (reloadCheck = r))
  })

  async function runExport(): Promise<void> {
    exporting = true
    exportNote = ''
    const result = await exportEverything()
    exporting = false
    exportNote = result.ok
      // Deliberately not "saved" or "downloaded": a page cannot see whether the
      // browser wrote the file or the user cancelled the save dialog.
      ? `Download started: ${result.characters} character${result.characters === 1 ? '' : 's'} and ${result.reports} report${result.reports === 1 ? '' : 's'}, ${fmtInt(result.bytes)} bytes. Check your downloads before reloading.`
      : `The export failed and nothing was written: ${result.reason}. Do not reload — you would lose what the export could not save.`
    if (!result.ok) reloadConfirmed = false
  }

  /** Never reload silently on save failure; first press acks list, second reloads. */
  async function doReload(): Promise<void> {
    const check = reloadCheck ?? (await prepareForReload())
    reloadCheck = check
    if (!check.ok && !reloadConfirmed) { reloadConfirmed = true; return }
    location.reload()
  }

  /** Should always be false. True means abandoned run still burning CPU. Poll worker state (not reactive) every 2s. */
  $effect(() => {
    const t = setInterval(pollEngineSlot, 2000)
    return () => clearInterval(t)
  })

  // Shown in licence line for exact revision.
  const engineBuild = $derived(
    app.capability?.ok
      ? `${app.capability.manifest.engine.simcVersion} @ ${app.capability.manifest.engine.upstreamCommit.slice(0, 7)}`
      : '',
  )

  const capabilityMessage = $derived.by(() => {
    const cap = app.capability
    if (!app.capabilityChecked || !cap || cap.ok) return null
    const advice: Record<string, string> = {
      'no-isolation':
        'The page is not cross-origin isolated, so the browser will not share memory between the engine threads. The server must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
      'no-shared-array-buffer':
        'This browser does not expose SharedArrayBuffer, which the multi-threaded engine needs. A single-threaded build covers Quick Sim at lower speed.',
      'no-secure-context': 'Open Frostsim over https, or on localhost.',
      'no-wasm': 'This browser has no WebAssembly support, so the engine cannot run at all.',
      'manifest-unavailable':
        'The engine description could not be fetched. Build it with `npm run engine:build`, or check the network.',
      'manifest-invalid': 'The engine description does not match what this build understands.',
      'artifact-mismatch':
        'The engine binary does not match the revision it claims. Rebuild it before trusting any number it produces.',
      'unsupported-report-version':
        'This engine writes a report format this build cannot read. Update Frostsim or rebuild the engine.',
    }
    return { detail: cap.detail, advice: advice[cap.reason] ?? cap.detail, reason: cap.reason }
  })
</script>

<a class="skip" href="#main">Skip to content</a>

<header class="topbar">
  <div class="wrap bar">
    <a class="brand" href={href('character')}>
      <img class="brand-logo" src="/brand/frostsim-logo-web.png" width="180" height="48" alt="Frostsim" />
    </a>

    <button
      class="ghost sm nav-toggle"
      aria-expanded={navOpen}
      aria-controls="main-nav"
      onclick={() => (navOpen = !navOpen)}
    >
      Menu
    </button>

    <nav id="main-nav" class:open={navOpen} aria-label="Tools">
      {#each ROUTES as name (name)}
        <a
          href={href(name)}
          aria-current={router.name === name ? 'page' : undefined}
          title={ROUTE_LABELS[name]}
        >
          {ROUTE_LABELS[name]}
        </a>
      {/each}
    </nav>

    <div class="row-tight trailing">
      {#if app.job && busy}
        <a class="job-chip" href={href(app.job.tool === 'quick' ? 'quick' : app.job.tool)}>
          <span class="pulse" aria-hidden="true"></span>
          <span class="xs">{STATUS_LABELS[app.job.status]}</span>
        </a>
      {/if}
      {#if character}
        <a class="who" href={href('character')}>
          <span class="truncate">{stored?.label ?? character.name}</span>
          <span class="xs faint nowrap">
            {character.spec ? titleCase(character.spec) : classLabel(character)}
          </span>
        </a>
      {/if}
      <button class="ghost sm" onclick={() => (settingsOpen = true)} aria-label="Settings">⚙</button>
    </div>
  </div>
</header>

<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{ended}</div>

<main id="main" class="wrap" tabindex="-1">
  {#if capabilityMessage}
    <Banner kind="bad" title="The simulation engine cannot start here" live>
      <p>{capabilityMessage.advice}</p>
      <p class="mono xs">{capabilityMessage.detail}</p>
      <p>Your imported characters and saved reports are unaffected.</p>
    </Banner>
  {/if}

  {#if !app.storage.available}
    <Banner kind="warn" title="Nothing can be saved on this device">
      <p>{app.storage.failure ? storageMessage(app.storage.failure) : ''}</p>
    </Banner>
  {/if}

  {#if !app.online}
    <Banner kind="info" title="Offline">
      <p>
        {#if fullyOffline()}
          Everything Frostsim needs is cached on this device, so simulation still works. It needs
          this tab open and running — the engine computes here, not in the background.
        {:else}
          The engine and game data are not fully cached, so a run may fail until you are back
          online. Saved characters and past reports are unaffected.
        {/if}
      </p>
    </Banner>
  {/if}

  {#if offline.updateReady}
    <!-- One line, not a panel: it must be visible without occupying the top of every screen. -->
    <div class="update-strip row-tight" role="status">
      <span class="small">
        A new version of Frostsim is ready.
        <span class="muted">
          {busy
            ? 'It will switch once the current run has finished or been cancelled.'
            : 'Applying it reloads the page so app and engine come from the same release.'}
        </span>
      </span>
      <span class="grow"></span>
      <button class="sm primary" disabled={busy} onclick={applyUpdate}>Apply update</button>
    </div>
  {/if}

  {#if interrupted}
    {@const job = interrupted}
    <Banner kind="warn" title="A simulation was interrupted">
      <p>
        “{job.title}” was still running when this page last closed, so it produced no
        result and nothing was saved. Frostsim cannot resume a simulation that was already in
        flight — the engine's state went with the tab — but the setup is unchanged, so running it
        again starts from where you left off.
      </p>
      {#snippet actions()}
        <button class="sm" onclick={() => { interrupted = null; navigate(job.tool) }}>
          Go to {TOOL_LABELS[job.tool]}
        </button>
        <button class="sm ghost" onclick={() => (interrupted = null)}>Dismiss</button>
      {/snippet}
    </Banner>
  {/if}

  {#if app.engineBlocked}
    <!--
      The one state the app cannot recover from in place: a threaded run whose
      shutdown could not be confirmed, so its pthreads may still be running.
      Starting a second engine on top of them is the accumulation the run slot
      exists to prevent, so the engine layer refuses and only a fresh page
      clears it.

      THE COPY HERE MUST NOT OVER-PROMISE. An earlier version said "everything
      you have is still here and still saved — nothing is discarded either way",
      which is false whenever storage is blocked or full, whenever a pasted
      character has not been kept, and for any result still on screen from a run
      that did not finish. `prepareForReload()` computes what a reload would
      actually cost from this tab's real state, and the reload button will not
      fire while there is anything it cannot preserve and the user has not said
      to go ahead.
    -->
    <Banner kind="bad" title="Reload Frostsim before simulating again" live>
      <p>{app.engineBlocked.detail}</p>

      {#if reloadCheck === null}
        <p>Checking what a reload would affect…</p>
      {:else if reloadCheck.ok}
        <p>
          Everything Frostsim knows how to save has been written to this browser's storage, and
          a reload keeps it. Two things it cannot save either way: a result on screen from a run
          that did not finish, and any selection you have made on a search screen. Export first
          if you want those.
        </p>
        <p class="xs muted">
          Browser storage can also be cleared by the browser itself. A downloaded export is the
          only copy nothing else can remove.
        </p>
      {:else}
        <p><strong>A reload would lose:</strong></p>
        <ul>
          {#each reloadCheck.losses as loss, i (i)}<li>{loss}</li>{/each}
        </ul>
        <p>Export first — the file is the only copy of those.</p>
      {/if}

      {#if exportNote}<p class="xs">{exportNote}</p>{/if}

      {#snippet actions()}
        <button class="sm" disabled={exporting} onclick={runExport}>
          {exporting ? 'Exporting…' : 'Export everything'}
        </button>
        <button
          class="sm primary"
          disabled={reloadCheck === null}
          onclick={doReload}
        >
          {reloadCheck && !reloadCheck.ok && !reloadConfirmed ? 'Reload anyway' : 'Reload'}
        </button>
      {/snippet}
    </Banner>
  {:else if app.engineStopping}
    <p class="small muted" role="status">Stopping simulation… releasing engine threads.</p>
  {:else if app.engineStray}
    <Banner kind="bad" title="A simulation is still running" live>
      <p>
        Frostsim has no record of it, so it cannot show its progress or its result. That is a bug
        in Frostsim, not something you did. It keeps using this tab's processor and memory, and no
        new simulation can start, until it is stopped.
      </p>
      {#snippet actions()}
        <button
          class="sm danger"
          onclick={() => { cancelActiveJob('stopped from the stray-run notice'); pollEngineSlot() }}
        >
          Stop it
        </button>
      {/snippet}
    </Banner>
  {/if}

  {#if shareError}
    <Banner kind="bad" title="That share link could not be opened" live>
      <p>{shareError}</p>
    </Banner>
  {/if}

  <!--
    A screen that throws while RENDERING used to disappear leaving nothing behind:
    no result, no error, no message. Top Gear reached this — the search ran, the
    report parsed, and the last hop from parsed report to displayed result took
    the screen down with it. A render error is the one failure a try/catch around
    the work cannot see, because it happens after the work succeeded.

    Svelte's own boundary catches it. The state behind the screen is untouched,
    so Try again re-renders with the same data and usually reproduces it — which
    is what makes the message worth reading rather than worth hiding.
  -->
  <svelte:boundary onerror={(e) => trace('screen.render-failed', { message: e instanceof Error ? e.message : String(e) })}>
    {#if router.raw.startsWith('r/')}
      <SharedReport />
    {:else if lazyLoader}
      {#await lazyLoader()}
        <p class="muted small">Loading&hellip;</p>
      {:then module}
        <module.default />
      {:catch error}
        <Banner kind="bad" title="This screen could not be loaded" live>
          <p>
            The code for this page did not download. If you are offline it may not be cached yet;
            otherwise reloading usually fixes it.
          </p>
          <p class="mono xs">{error instanceof Error ? error.message : String(error)}</p>
        </Banner>
      {/await}
    {:else}
      <Screen />
    {/if}

    {#snippet failed(error, reset)}
      <Banner kind="bad" title="This screen could not be displayed" live>
        <p>
          Frostsim ran into a problem drawing this page. Any simulation that finished still
          finished — nothing was lost from your saved characters or reports — but what was on
          screen could not be shown.
        </p>
        <p class="mono xs">{error instanceof Error ? error.message : String(error)}</p>
        {#snippet actions()}
          <button class="sm" onclick={reset}>Try again</button>
          <button class="sm ghost" onclick={() => navigate('character')}>Go to Character</button>
        {/snippet}
      </Banner>
    {/snippet}
  </svelte:boundary>
</main>

<footer class="wrap foot xs faint">
  {#if media.configured}
    <!-- Blizzard API terms require conspicuous attribution without implying endorsement. -->
    <p>{media.attribution || BLIZZARD_ATTRIBUTION}</p>
  {/if}
  <p
    class="row-tight"
    title="Frostsim builds SimulationCraft from a pinned upstream revision; the build scripts, any patches applied and the corresponding source are published alongside each release."
  >
    <span>Runs entirely in this browser.</span>
    <span>·</span>
    <span>SimulationCraft is <a href="https://www.gnu.org/licenses/gpl-3.0.html" rel="license">GPL-3.0</a>{#if engineBuild}, built from {engineBuild}{/if}; sources and patches ship with each release.</span>
  </p>
</footer>

<!-- Toasts: non-blocking, never the only copy of info. -->
<div class="toasts" aria-live="polite" aria-atomic="false">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}">{t.text}</div>
  {/each}
</div>

<Dialog bind:open={settingsOpen} title="Settings" width="26rem" onclose={() => (settingsOpen = false)}>
  <div class="stack">
    <fieldset class="stack-sm">
      <legend class="small">Theme</legend>
      <div class="segmented" role="radiogroup" aria-label="Theme">
        {#each ['system', 'light', 'dark'] as choice (choice)}
          <label>
            <input
              type="radio"
              name="theme"
              value={choice}
              checked={prefs.theme === choice}
              onchange={() => setTheme(choice as 'system' | 'light' | 'dark')}
            />
            {titleCase(choice)}
          </label>
        {/each}
      </div>
    </fieldset>

    <!-- P06.11: checkbox IS the user gesture permission needs. Label reports what browser actually said. -->
    <fieldset class="stack-sm">
      <legend class="small">When a run finishes</legend>
      {#if notifySupport === 'unsupported'}
        <p class="xs muted">This browser has no notification support.</p>
      {:else if notifySupport === 'denied'}
        <p class="xs muted">
          Notifications are blocked for this site. Your browser's site settings are the only place
          that can change it — a page cannot ask again once it has been refused.
        </p>
      {:else}
        <label class="row-tight">
          <input
            type="checkbox"
            checked={notify.wanted}
            onchange={(e) => void toggleNotify(e.currentTarget.checked)}
          />
          Notify me when a simulation ends
        </label>
        <p class="xs muted">
          Only while this tab is in the background, and only from this device. Nothing is sent
          anywhere, and a notification cannot arrive after you close the tab — the simulation runs
          in this page, so there is nothing left to finish.
        </p>
        {#if notifyNote}<p class="xs">{notifyNote}</p>{/if}
      {/if}
    </fieldset>

    <fieldset class="stack-sm">
      <legend class="small">Motion</legend>
      <div class="segmented" role="radiogroup" aria-label="Motion">
        {#each [['system', 'Follow system'], ['full', 'Full'], ['reduced', 'Reduced']] as [value, label] (value)}
          <label>
            <input
              type="radio"
              name="motion"
              {value}
              checked={prefs.motion === value}
              onchange={() => setMotion(value as 'system' | 'full' | 'reduced')}
            />
            {label}
          </label>
        {/each}
      </div>
      <p class="xs muted">
        Reduced motion removes transitions everywhere, including during a run. Final values always
        appear immediately regardless of this setting.
      </p>
    </fieldset>

    <fieldset class="stack-sm">
      <legend class="small">Keyboard</legend>
      <dl class="kv xs">
        <dt><kbd>{SHORTCUT_HINT.run}</kbd></dt>
        <dd>Run the current tool</dd>
        <dt><kbd>{SHORTCUT_HINT.search}</kbd></dt>
        <dd>Focus the search field, where there is one</dd>
        <dt><kbd>Esc</kbd></dt>
        <dd>Close a dialog</dd>
      </dl>
    </fieldset>

    {#if offline.supported}
      <fieldset class="stack-sm">
        <legend class="small">Offline</legend>
        {#if !offline.registered}
          <p class="xs muted">
            Offline caching is only active in a production build, not on a dev server.
          </p>
        {:else if offline.caching}
          <p class="xs muted" aria-live="polite">
            Caching… {offline.progress ? `${offline.progress.done} of ${offline.progress.total} files` : ''}
            {offline.progress?.failed ? `· ${offline.progress.failed} failed` : ''}
          </p>
        {:else}
          <dl class="kv xs">
            <dt>App</dt>
            <dd>{ready(offline.status?.shell) ? 'cached' : 'not cached'}</dd>
            <dt>Engine</dt>
            <dd>
              {#if ready(offline.status?.engine)}cached
              {:else if offline.status}{fmtInt(offline.status.engine.have)} of {fmtInt(offline.status.engine.need)} files
              {:else}unknown{/if}
            </dd>
            <dt>Game data</dt>
            <dd>
              <!-- "Unknown" not rendered cached; catalog offline can't be read. -->
              {#if unknownState(offline.status?.catalog)}
                unknown &mdash; {offline.status?.catalog.reason}
              {:else if offline.status?.catalog.status === 'absent'}
                no game data is configured for this build
              {:else if ready(offline.status?.catalog)}cached
              {:else if offline.status}{fmtInt(offline.status.catalog.have)} of {fmtInt(offline.status.catalog.need)} files
              {:else}not checked yet{/if}
            </dd>
          </dl>
          <button class="sm" onclick={() => cacheForOffline(catalogBaseUrl())}>
            {fullyOffline() ? 'Re-check cached files' : 'Make available offline'}
          </button>
          <p class="xs muted">
            About 80 MB: the engine and the game-data catalog. Offline means the app opens and runs
            without a network — it still needs this tab open, because the simulation computes here.
            Browser storage can be evicted, so this is not a guarantee.
          </p>
        {/if}
        {#if offline.error}<p class="xs err-text">{offline.error}</p>{/if}
      </fieldset>
    {/if}

    {#if app.capability?.ok}
      <fieldset class="stack-sm">
        <legend class="small">Engine</legend>
        <dl class="kv xs">
          <dt>Build</dt>
          <dd>{app.capability.manifest.engine.simcVersion}
            ({app.capability.manifest.engine.upstreamCommit.slice(0, 7)})</dd>
          <dt>Game data</dt>
          <dd>{app.capability.manifest.wow.clientDataVersion}</dd>
          <dt>Artifact</dt>
          <dd>{app.capability.manifest.artifact}, up to {app.capability.maxThreads} threads</dd>
          <dt>Candidate runs</dt>
          <dd>{app.capability.profilesets ? 'supported' : 'not in this build'}</dd>
        </dl>
      </fieldset>
    {/if}
  </div>
</Dialog>

<Dialog
  open={!!shareOffer}
  title="Open shared character?"
  width="28rem"
  onclose={() => (shareOffer = null)}
>
  {#if shareOffer}
    <div class="stack-sm">
      <p>
        This link carries a character named <strong>{shareOffer.character.name}</strong> with
        {shareOffer.character.equipped.length} equipped items and
        {shareOffer.character.loadouts.length} talent loadouts.
      </p>
      <p class="small muted">
        Nothing has been saved yet, and the link has already been removed from the address bar.
      </p>
    </div>
  {/if}
  {#snippet footer()}
    <button onclick={() => (shareOffer = null)}>Discard</button>
    <button
      class="primary"
      onclick={() => {
        if (shareOffer) {
          void saveCharacter(shareOffer.character, `Shared: ${shareOffer.character.name}`)
          toast('good', 'Shared character imported.')
        }
        shareOffer = null
        navigate('character')
      }}
    >
      Import
    </button>
  {/snippet}
</Dialog>

<style>
  .skip {
    position: absolute;
    left: -9999px;
    padding: var(--s2) var(--s3);
    background: var(--surface);
    border-radius: var(--r2);
    z-index: 10;
  }
  .skip:focus { left: var(--s3); top: var(--s2); box-shadow: var(--focus); }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 5;
    background: color-mix(in oklab, var(--surface-2) 85%, transparent);
    backdrop-filter: blur(8px) saturate(1.3);
    -webkit-backdrop-filter: blur(8px) saturate(1.3);
    border-bottom: 1px solid var(--border);
  }
  /* Cold hairline under header, accent edge-to-edge. */
  .topbar::after {
    content: '';
    position: absolute;
    inset: auto 0 -1px;
    height: 1px;
    background: linear-gradient(
      90deg, transparent, color-mix(in oklab, var(--accent) 45%, transparent) 30%,
      color-mix(in oklab, var(--accent) 45%, transparent) 70%, transparent
    );
    pointer-events: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--s4);
    min-height: var(--header-h);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    text-decoration: none;
    flex: none;
  }
  /* Original angular frost shard, not a logo lift. */
  .brand-logo { display: block; width: 180px; height: 48px; object-fit: cover; object-position: center; }

  nav { display: flex; gap: 0.1rem; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; }
  nav a {
    position: relative;
    padding: 0.35rem 0.65rem;
    border-radius: var(--r2);
    color: var(--text-muted);
    text-decoration: none;
    font-size: var(--fs-sm);
    font-weight: 550;
    white-space: nowrap;
    transition: background var(--t-nav) var(--ease), color var(--t-nav) var(--ease);
  }
  nav a:hover { background: var(--surface-3); color: var(--text); }
  nav a[aria-current='page'] { background: var(--accent-soft); color: var(--accent); }
  /* Selected indicator: color and rule, never page-scale movement. */
  nav a[aria-current='page']::after {
    content: '';
    position: absolute;
    inset: auto 0.65rem -1px;
    height: 2px;
    border-radius: 2px;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
  }

  .trailing { flex: none; }
  .update-strip {
    padding: var(--s2) var(--s3);
    border: 1px solid var(--accent-border);
    border-radius: var(--r2);
    background: var(--accent-soft);
  }
  .who {
    display: flex;
    flex-direction: column;
    max-width: 11rem;
    padding: 0.1rem var(--s2);
    border-left: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
    font-size: var(--fs-sm);
    line-height: 1.25;
  }
  .job-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.55rem;
    border: 1px solid var(--accent-border);
    border-radius: var(--r-pill);
    background: var(--accent-soft);
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .pulse {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: currentColor;
    animation: breathe 1.6s ease-in-out infinite;
  }
  @keyframes breathe { 50% { opacity: 0.25; } }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .pulse { animation: none; }
  }
  :global(:root[data-motion='reduced']) .pulse { animation: none; }

  .nav-toggle { display: none; }

  main {
    display: block;
    padding-block: var(--s5) var(--s6);
    min-height: 60vh;
  }
  main:focus { outline: none; }
  main > :global(* + *) { margin-top: var(--s4); }
  /* A short settle on the incoming screen. Never delays a final value. */
  main :global(> .stack),
  main :global(> .empty) { animation: settle var(--t-reveal) var(--ease); }
  @keyframes settle { from { opacity: 0; transform: translateY(4px); } }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) main :global(> .stack),
    :global(:root:not([data-motion='full'])) main :global(> .empty) { animation: none; }
  }
  :global(:root[data-motion='reduced']) main :global(> .stack),
  :global(:root[data-motion='reduced']) main :global(> .empty) { animation: none; }

  .foot { padding-block: var(--s4) var(--s6); border-top: 1px solid var(--border); }

  .toasts {
    position: fixed;
    inset-inline: var(--s4);
    bottom: var(--s4);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s2);
    pointer-events: none;
    z-index: 20;
  }
  .toast {
    max-width: min(28rem, 100%);
    padding: var(--s2) var(--s3);
    border-radius: var(--r3);
    background: var(--glass);
    backdrop-filter: blur(var(--glass-blur)) saturate(1.3);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.3);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-2);
    font-size: var(--fs-sm);
    animation: rise var(--t-reveal) var(--spring);
  }
  .toast.good { border-color: var(--good); }
  .toast.bad { border-color: var(--bad); }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }

  fieldset { margin: 0; padding: 0; border: 0; }
  legend { padding: 0; font-weight: 600; margin-bottom: var(--s2); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 0.2rem var(--s3); margin: 0; }
  .kv dt { color: var(--text-muted); }
  .kv dd { margin: 0; }
  .err-text { color: var(--bad); }

  @media (max-width: 56rem) {
    .nav-toggle { display: inline-flex; order: 3; }
    nav {
      order: 5;
      flex-basis: 100%;
      display: none;
      padding-bottom: var(--s2);
    }
    nav.open { display: flex; }
    .bar { flex-wrap: wrap; padding-block: var(--s2); gap: var(--s2); }
    /* Spec line removed; name alone fits with brand and menu. */
    .who { max-width: 8rem; }
    .who .xs { display: none; }
  }
</style>
