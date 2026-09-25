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
    href, navigate, ROUTE_BLURBS, ROUTE_LABELS, router, type RouteName,
  } from './lib/router.svelte'
  import { BLIZZARD_ATTRIBUTION } from './lib/battlenet/contract'
  import { apply as applyTheme, prefs, setMotion, setTheme } from './lib/theme.svelte'
  import { decodeShare, isShareFragment, stripFragment } from './lib/store/share'
  import type { ImportedCharacter } from './lib/import/character'
  import Banner from './lib/ui/Banner.svelte'
  import EngineStatus from './lib/ui/EngineStatus.svelte'
  import Dialog from './lib/ui/Dialog.svelte'
  import SiteLegal from './lib/ui/SiteLegal.svelte'
  import Backdrop from './lib/fx/Backdrop.svelte'
  import { installPointerFx } from './lib/fx/pointer'
  import { navIndicator } from './lib/fx/nav'
  import { SOURCE_URL } from './lib/source'
  import {
    ChartColumn, CircleCheck, CircleQuestionMark, CodeXml, Coins, Crown, Gem, GitCompareArrows, Info, Menu,
    Network, Settings, Sparkles, SquareTerminal, TriangleAlert, User, X, Zap,
  } from '@lucide/svelte'
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
    pi: () => import('./routes/PowerInfusion.svelte'),
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
    // Account code compiles out unless built with VITE_FEATURE_ACCOUNTS=1 (CLAUDE.md D15); it asks nothing without its marker or a sign-in landing.
    if (import.meta.env.VITE_FEATURE_ACCOUNTS === true) void import('./lib/account/bootstrap').then((m) => m.bootstrap())
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
  $effect(() => installPointerFx())

  const ROUTE_ICONS: Partial<Record<RouteName, Component>> = {
    character: User, talents: Network, quick: Zap, compare: GitCompareArrows, gear: Crown,
    droptimizer: Gem, crests: Coins, pi: Sparkles, advanced: SquareTerminal, reports: ChartColumn,
  }
  const TOAST_ICONS = { good: CircleCheck, bad: TriangleAlert, info: Info }

  // Eleven routes read as four jobs. The header shows the groups; each page
  // shows its own group's tools as a strip, and hovering a group previews it.
  // Help sits with Settings as an icon and belongs to no group.
  const NAV_GROUPS: { id: string; label: string; icon: Component; routes: RouteName[] }[] = [
    { id: 'character', label: 'Character', icon: User, routes: ['character', 'talents'] },
    { id: 'simulate', label: 'Simulate', icon: Zap, routes: ['quick', 'compare', 'pi', 'advanced'] },
    { id: 'gear', label: 'Gear', icon: Gem, routes: ['gear', 'droptimizer', 'crests'] },
    { id: 'reports', label: 'Reports', icon: ChartColumn, routes: ['reports'] },
  ]
  /** #/plans (CLAUDE.md D15) is a page outside the tool groups, like the `s/` alias; compiled out without VITE_FEATURE_ACCOUNTS. */
  const onPlans = $derived(import.meta.env.VITE_FEATURE_ACCOUNTS === true && router.raw === 'plans')
  const group = $derived(onPlans ? undefined : NAV_GROUPS.find((g) => g.routes.includes(router.name)))
  // A group link returns to the tool last used in that group this session.
  const lastInGroup = $state<Record<string, RouteName>>({})
  $effect(() => { if (group) lastInGroup[group.id] = router.name })

  let scrolled = $state(false)
  $effect(() => {
    const on = () => (scrolled = scrollY > 8)
    on()
    addEventListener('scroll', on, { passive: true })
    return () => removeEventListener('scroll', on)
  })

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
      'engine-updating': 'Frostsim was just updated, and its matching SimulationCraft engine is still being published.',
      'manifest-invalid': 'The engine description does not match what this build understands.',
      'artifact-mismatch':
        'The engine binary does not match the revision it claims. Rebuild it before trusting any number it produces.',
      'unsupported-report-version':
        'This engine writes a report format this build cannot read. Update Frostsim or rebuild the engine.',
    }
    return { detail: cap.detail, advice: advice[cap.reason] ?? cap.detail, reason: cap.reason }
  })
</script>

<Backdrop />

<a class="skip" href="#main">Skip to content</a>

<header class="topbar" class:scrolled>
  <div class="wrap">
  <div class="bar">
    <a class="brand" href={href('character')}>
      <img class="brand-logo" src="/brand/frostsim-logo-web.png" width="180" height="48" alt="Frostsim" />
      <span class="brand-sheen" aria-hidden="true"></span>
    </a>

    <button
      class="ghost sm nav-toggle"
      aria-expanded={navOpen}
      aria-controls="main-nav"
      aria-label="Menu"
      onclick={() => (navOpen = !navOpen)}
    >
      {#if navOpen}<X size={18} />{:else}<Menu size={18} />{/if}
    </button>

    <nav id="main-nav" class="groups" class:open={navOpen} aria-label="Tools" use:navIndicator={onPlans ? router.raw : router.name}>
      {#each NAV_GROUPS as g (g.id)}
        {@const target = lastInGroup[g.id] ?? g.routes[0]}
        <div class="group" class:multi={g.routes.length > 1}>
          <a
            class="group-link"
            href={href(target)}
            data-track
            data-on={group === g ? '' : undefined}
            aria-current={!onPlans && router.name === target ? 'page' : undefined}
          >
            <g.icon size={16} strokeWidth={2.1} aria-hidden="true" />
            <span>{g.label}</span>
          </a>
          {#if g.routes.length > 1}
            <div class="flyout">
              <div class="flyout-card">
                {#each g.routes as name}
                  {@const Icon = ROUTE_ICONS[name]}
                  <a class="flyout-item" href={href(name)} class:on={router.name === name} aria-current={router.name === name ? 'page' : undefined}>
                    <span class="flyout-icon" aria-hidden="true">{#if Icon}<Icon size={17} />{/if}</span>
                    <span class="flyout-text"><strong>{ROUTE_LABELS[name]}</strong><span>{ROUTE_BLURBS[name]}</span></span>
                  </a>
                {/each}
              </div>
            </div>
          {/if}
        </div>
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
        <!-- Account builds: the chip opens the account dialog (Character stays one click away in the nav). -->
        <a class="who" href={href('character')} data-class={character.className} onclick={(e) => {
          if (import.meta.env.VITE_FEATURE_ACCOUNTS !== true) return
          e.preventDefault()
          void import('./lib/account/state.svelte').then((m) => (m.account.open = true))
        }}>
          <span class="who-mark" aria-hidden="true">{(stored?.label ?? character.name).slice(0, 1).toUpperCase()}</span>
          <span class="who-text">
            <span class="truncate">{stored?.label ?? character.name}</span>
            <span class="xs faint nowrap">
              {character.spec ? titleCase(character.spec) : classLabel(character)}
            </span>
          </span>
        </a>
      {/if}
      <a class="icon-btn" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" aria-label="Frostsim source code on GitHub (opens in a new tab)" title="Source code on GitHub"><CodeXml size={18} /></a>
      <a class="icon-btn help-btn" href={href('help')} aria-label="Help" aria-current={router.name === 'help' ? 'page' : undefined}><CircleQuestionMark size={18} /></a>
      {#if import.meta.env.VITE_FEATURE_ACCOUNTS === true}{#await import('./lib/account/AccountButton.svelte') then m}<m.default />{/await}{/if}
      <button class="ghost sm gear-btn" onclick={() => (settingsOpen = true)} aria-label="Settings"><Settings size={18} /></button>
    </div>
  </div>
  </div>
</header>

<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{ended}</div>

<main id="main" class="wrap" tabindex="-1">
  {#if group && group.routes.length > 1}
    <nav class="subnav" aria-label="{group.label} tools" use:navIndicator={router.name}>
      {#each group.routes as name}
        {@const Icon = ROUTE_ICONS[name]}
        <a href={href(name)} data-track data-on={router.name === name ? '' : undefined} aria-current={router.name === name ? 'page' : undefined}>
          {#if Icon}<Icon size={15} strokeWidth={2.1} aria-hidden="true" />{/if}
          <span>{ROUTE_LABELS[name]}</span>
        </a>
      {/each}
    </nav>
  {/if}

  <EngineStatus />

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
    {#if router.raw.startsWith('r/') || (import.meta.env.VITE_FEATURE_ACCOUNTS === true && router.raw.startsWith('s/'))}
      <SharedReport />
    {:else if import.meta.env.VITE_FEATURE_ACCOUNTS === true && onPlans}
      {#await import('./lib/account/Plans.svelte') then m}<m.default />{/await}
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
      {#if import.meta.env.VITE_FEATURE_ACCOUNTS === true && router.name === 'character'}
        {#await import('./lib/account/CharacterSlots.svelte') then m}<m.default />{/await}
      {/if}
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
  {#if import.meta.env.VITE_SITE_LEGAL}<SiteLegal />{/if}
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
  <p>
    Frostsim is free software under the <a href="https://www.gnu.org/licenses/gpl-3.0.html" rel="license">GPL-3.0</a>:
    <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">source code on GitHub</a>
    {#if import.meta.env.VITE_FEATURE_ACCOUNTS === true}· <a href="#/plans">Frostsim Cloud</a>{/if}
    · <a href="https://github.com/simulationcraft/simc" target="_blank" rel="noopener noreferrer">SimulationCraft source</a>
  </p>
</footer>

<!-- Toasts: non-blocking, never the only copy of info. -->
<div class="toasts" aria-live="polite" aria-atomic="false">
  {#each app.toasts as t (t.id)}
    {@const Icon = TOAST_ICONS[t.kind]}
    <div class="toast {t.kind}">
      <Icon size={18} aria-hidden="true" />
      <span>{t.text}</span>
      <span class="toast-timer" aria-hidden="true"></span>
    </div>
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
        Reduced motion removes transitions everywhere, including during a run, stills the animated
        background, and shows result numbers at once instead of counting up. Screen readers always
        get the final value immediately.
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

    {#if import.meta.env.VITE_FEATURE_ACCOUNTS === true}
      {#await import('./lib/account/placement.svelte') then p}
        {#if !p.placement.entitled}
          <fieldset class="stack-sm">
            <legend class="small">Run on</legend>
            <p class="xs muted row-tight">Sims run in this browser. Cloud plans run them on our servers.
              {#await import('./lib/account/PremiumPill.svelte') then m}<m.default text="See plans" />{/await}</p>
          </fieldset>
        {:else}
          <fieldset class="stack-sm">
            <legend class="small">Run on</legend>
            <div class="segmented" role="radiogroup" aria-label="Run on">
              {#each [['browser', 'This browser'], ['cloud', 'Frostsim Cloud']] as [value, label] (value)}
                <label>
                  <input
                    type="radio"
                    name="placement"
                    {value}
                    checked={p.placement.value === value}
                    onchange={() => p.setPlacement(value as 'browser' | 'cloud')}
                  />
                  {label}
                </label>
              {/each}
            </div>
            <p class="xs muted">
              Cloud runs use your plan's core-hours. A run the cloud cannot take runs in this browser instead, with a note on the
              result.
            </p>
          </fieldset>
        {/if}
      {/await}
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
    z-index: 60;
  }
  .skip:focus { left: var(--s3); top: var(--s2); box-shadow: var(--focus); }

  /* ---- Header: a floating glass bar ---------------------------------- */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 50;
    padding-top: 0.75rem;
    transition: padding 0.4s var(--ease);
  }
  .topbar.scrolled { padding-top: 0.4rem; }
  .bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s4);
    min-height: 3.75rem;
    padding: 0 0.6rem 0 0.9rem;
    border-radius: 1.1rem;
    border: 1px solid var(--glass-edge);
    background: color-mix(in oklab, var(--glass-strong) 70%, transparent);
    -webkit-backdrop-filter: blur(26px) saturate(1.7);
    backdrop-filter: blur(26px) saturate(1.7);
    box-shadow: 0 12px 40px -18px rgb(0 0 0 / 0.7), inset 0 1px 0 var(--rim);
    transition: background 0.4s var(--ease), box-shadow 0.4s var(--ease), border-color 0.4s var(--ease);
  }
  /* The open mobile menu sits over page content; don't let it show through. */
  .bar:has(.groups.open) { background: var(--glass-strong); }
  .scrolled .bar {
    background: var(--glass-strong);
    border-color: color-mix(in oklab, var(--accent) 22%, var(--glass-edge));
    box-shadow: 0 18px 50px -16px rgb(0 0 0 / 0.8), 0 0 0 1px rgb(0 0 0 / 0.2), inset 0 1px 0 var(--rim);
  }
  /* Cold hairline that glows along the bottom edge. */
  .bar::after {
    content: '';
    position: absolute;
    inset: auto 12% -1px;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), var(--accent-3), transparent);
    opacity: 0.55;
    pointer-events: none;
  }

  .brand {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: none;
    text-decoration: none;
    transition: filter 0.4s var(--ease), transform 0.5s var(--spring);
  }
  .brand:hover { filter: drop-shadow(0 0 14px var(--accent-glow)); transform: scale(1.02); }
  .brand-logo { display: block; width: 168px; height: 45px; object-fit: cover; object-position: center; }
  /* A light sweep across the logo, masked to its own letterforms. */
  .brand-sheen {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 38%, rgb(255 255 255 / 0.95) 50%, transparent 62%);
    background-size: 260% 100%;
    background-position: 130% 0;
    -webkit-mask: url('/brand/frostsim-logo-web.png') center / cover no-repeat;
    mask: url('/brand/frostsim-logo-web.png') center / cover no-repeat;
    mix-blend-mode: overlay;
    /* Once, not on a loop: a running blend inside the blurred bar keeps the GPU compositing every frame. */
    animation: sheen 7s var(--ease) 1.2s;
    pointer-events: none;
  }
  @keyframes sheen {
    0% { background-position: 130% 0; }
    22%, 100% { background-position: -30% 0; }
  }

  /* ---- Navigation --------------------------------------------------- */
  .groups {
    position: relative;
    display: flex;
    justify-content: center;
    gap: 0.25rem;
    flex: 1 1 auto;
    min-width: 0;
  }
  .group { position: relative; }
  .group-link, .subnav a {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    border-radius: 0.7rem;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 580;
    white-space: nowrap;
    transition: color 0.3s var(--ease);
  }
  .group-link { padding: 0.55rem 0.95rem; font-size: 0.95rem; }
  .group-link :global(svg), .subnav a :global(svg) {
    opacity: 0.7;
    transition: opacity 0.3s var(--ease), transform 0.45s var(--spring), color 0.3s var(--ease);
  }
  .group-link:hover, .subnav a:hover { color: var(--text); }
  .group-link:hover :global(svg), .subnav a:hover :global(svg) { opacity: 1; transform: translateY(-1px) scale(1.12); }
  .group-link[data-on], .subnav a[data-on] { color: var(--accent-hi); }
  .group-link[data-on] :global(svg), .subnav a[data-on] :global(svg) {
    opacity: 1;
    color: var(--accent);
    filter: drop-shadow(0 0 6px var(--accent-glow));
  }
  :global(:root[data-theme='light']) :is(.group-link, .subnav a)[data-on] { color: var(--accent); }

  /* Two gliding indicators drawn by lib/fx/nav.ts: ::before marks the current
     item, ::after follows the pointer. */
  .groups::before, .groups::after, .subnav::before, .subnav::after {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    border-radius: 0.7rem;
    pointer-events: none;
    opacity: 0;
    transition:
      translate 0.55s var(--spring),
      width 0.55s var(--spring),
      height 0.55s var(--spring),
      opacity 0.3s var(--ease);
  }
  .groups::before, .subnav::before {
    width: var(--pill-w);
    height: var(--pill-h);
    translate: var(--pill-x) var(--pill-y);
    background:
      linear-gradient(90deg, #5cc6e3, #7fb4ff, #a58bf7) bottom center / 52% 2px no-repeat,
      linear-gradient(180deg, rgb(101 203 229 / 0.2), rgb(101 203 229 / 0.06));
    box-shadow: inset 0 0 0 1px rgb(101 203 229 / 0.3), 0 8px 24px -10px var(--accent-glow);
  }
  .groups::after, .subnav::after {
    width: var(--hover-w);
    height: var(--hover-h);
    translate: var(--hover-x) var(--hover-y);
    background: rgb(255 255 255 / 0.055);
  }
  :global(:root[data-theme='light']) :is(.groups, .subnav)::after { background: rgb(12 26 43 / 0.05); }
  /* :global — the action sets these attributes, so Svelte can't see them. */
  .groups:global([data-pill])::before, .subnav:global([data-pill])::before,
  .groups:global([data-hover])::after, .subnav:global([data-hover])::after { opacity: 1; }

  /* Hovering a group previews its tools. Pointer convenience only: the same
     links are the strip at the top of every page in that group. */
  .flyout {
    position: absolute;
    top: 100%;
    left: 50%;
    z-index: 60;
    padding-top: 0.85rem;
    visibility: hidden;
    opacity: 0;
    transform: translateX(-50%) translateY(-8px) scale(0.97);
    transform-origin: top center;
    transition: opacity 0.2s var(--ease), transform 0.35s var(--spring), visibility 0s linear 0.2s;
  }
  .group.multi:hover .flyout {
    visibility: visible;
    opacity: 1;
    transform: translateX(-50%);
    transition: opacity 0.25s var(--ease) 0.06s, transform 0.45s var(--spring) 0.06s, visibility 0s linear 0.06s;
  }
  .flyout-card {
    position: relative;
    display: grid;
    gap: 0.15rem;
    width: 21rem;
    padding: 0.45rem;
    border: 1px solid var(--glass-edge);
    border-radius: 1rem;
    background: linear-gradient(180deg, var(--glass-hi), transparent 40%), var(--glass-strong);
    -webkit-backdrop-filter: blur(26px) saturate(1.6);
    backdrop-filter: blur(26px) saturate(1.6);
    box-shadow: var(--shadow-3), inset 0 1px 0 var(--rim), 0 0 60px -24px var(--accent-glow);
  }
  .flyout-card::before {
    content: '';
    position: absolute;
    inset: -1px 20% auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), var(--accent-3), transparent);
  }
  .flyout-item {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    align-items: center;
    padding: 0.6rem 0.7rem;
    border-radius: 0.75rem;
    color: var(--text);
    text-decoration: none;
    transition: background 0.25s var(--ease), translate 0.35s var(--spring);
  }
  .flyout-item:hover { background: linear-gradient(90deg, rgb(101 203 229 / 0.13), rgb(101 203 229 / 0.02)); translate: 3px 0; }
  .flyout-item.on { background: rgb(101 203 229 / 0.1); box-shadow: inset 0 0 0 1px rgb(101 203 229 / 0.25); }
  .flyout-icon {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 0.65rem;
    color: var(--accent);
    background: radial-gradient(circle at 30% 20%, rgb(101 203 229 / 0.28), transparent 70%), rgb(255 255 255 / 0.04);
    box-shadow: inset 0 0 0 1px rgb(101 203 229 / 0.22);
    transition: box-shadow 0.3s var(--ease), color 0.3s var(--ease);
  }
  .flyout-item:hover .flyout-icon { color: var(--accent-hi); box-shadow: inset 0 0 0 1px var(--accent-border), 0 0 18px -4px var(--accent-glow); }
  .flyout-text { display: grid; gap: 0.1rem; min-width: 0; }
  .flyout-text strong { font-family: var(--font-display); font-size: 0.95rem; font-weight: 600; letter-spacing: 0.01em; }
  .flyout-text span { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.35; }

  /* The page's own tool strip. */
  .subnav {
    position: relative;
    display: flex;
    gap: 0.2rem;
    width: fit-content;
    max-width: 100%;
    overflow-x: auto;
    padding: 0.3rem;
    border: 1px solid var(--glass-edge);
    border-radius: 0.95rem;
    background: var(--glass);
    -webkit-backdrop-filter: blur(18px) saturate(1.5);
    backdrop-filter: blur(18px) saturate(1.5);
    box-shadow: var(--panel-shadow), inset 0 1px 0 var(--rim);
    animation: subnav-in 0.6s var(--ease) backwards;
    scrollbar-width: none;
  }
  .subnav a { padding: 0.5rem 0.95rem; font-size: var(--fs-sm); }
  @keyframes subnav-in { from { opacity: 0; translate: 0 -8px; } }

  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--r2);
    color: var(--text-muted);
    transition: color 0.3s var(--ease), background 0.3s var(--ease);
  }
  .icon-btn:hover { color: var(--text); background: rgb(255 255 255 / 0.06); }
  .icon-btn[aria-current='page'] { color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent-border); }
  .help-btn :global(svg) { transition: rotate 0.6s var(--spring); }
  .help-btn:hover :global(svg) { rotate: -15deg; }

  .trailing { flex: none; gap: var(--s2); }
  .gear-btn :global(svg) { transition: rotate 0.7s var(--spring); }
  .gear-btn:hover :global(svg) { rotate: 90deg; }

  .who {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    max-width: 13rem;
    padding: 0.25rem 0.7rem 0.25rem 0.3rem;
    border: 1px solid var(--glass-edge);
    border-radius: 999px;
    background: rgb(255 255 255 / 0.03);
    color: var(--text);
    text-decoration: none;
    font-size: var(--fs-sm);
    line-height: 1.2;
    transition: border-color 0.3s var(--ease), background 0.3s var(--ease), box-shadow 0.3s var(--ease);
  }
  .who:hover {
    border-color: color-mix(in oklab, var(--class-color, var(--accent)) 50%, transparent);
    box-shadow: 0 0 20px -8px var(--class-color, var(--accent));
  }
  .who-mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.9rem;
    height: 1.9rem;
    border-radius: 50%;
    font: 700 0.85rem var(--font-display);
    color: var(--class-color, var(--accent));
    background: radial-gradient(circle at 30% 25%, color-mix(in oklab, var(--class-color, var(--accent)) 35%, transparent), transparent 70%), rgb(0 0 0 / 0.3);
    box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--class-color, var(--accent)) 60%, transparent);
  }
  .who-text { display: flex; flex-direction: column; min-width: 0; }

  .job-chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.3rem 0.75rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-hi);
    text-decoration: none;
    font-weight: 600;
    isolation: isolate;
    overflow: hidden;
  }
  /* A comet runs around the chip while the engine works. */
  .job-chip::before {
    content: '';
    position: absolute;
    inset: -60%;
    z-index: -2;
    background: conic-gradient(from 0deg, transparent 0 70%, var(--accent) 88%, #fff 92%, transparent 96%);
    animation: spin 1.6s linear infinite;
  }
  .job-chip::after {
    content: '';
    position: absolute;
    inset: 1.5px;
    z-index: -1;
    border-radius: inherit;
    background: color-mix(in oklab, var(--glass-strong) 88%, var(--accent));
  }
  @keyframes spin { to { rotate: 1turn; } }
  .pulse {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 0 var(--accent-glow);
    animation: breathe 1.6s ease-out infinite;
  }
  @keyframes breathe {
    0% { box-shadow: 0 0 0 0 var(--accent-glow); }
    100% { box-shadow: 0 0 0 8px transparent; }
  }

  .nav-toggle { display: none; }

  main {
    display: block;
    padding-block: var(--s6) var(--s7);
    min-height: 60vh;
  }
  main:focus { outline: none; }
  main > :global(* + *) { margin-top: var(--s4); }

  .update-strip {
    padding: var(--s2) var(--s3);
    border: 1px solid var(--accent-border);
    border-radius: var(--r3);
    background: var(--accent-soft);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    box-shadow: 0 0 30px -12px var(--accent-glow);
  }

  .foot {
    position: relative;
    padding-block: var(--s5) var(--s6);
  }
  .foot::before {
    content: '';
    position: absolute;
    inset: 0 var(--s4) auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--border-strong) 20%, color-mix(in oklab, var(--accent) 40%, transparent) 50%, var(--border-strong) 80%, transparent);
  }

  /* ---- Toasts -------------------------------------------------------- */
  .toasts {
    position: fixed;
    inset-inline: var(--s4);
    bottom: var(--s5);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s2);
    pointer-events: none;
    z-index: 1200;
  }
  .toast {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    max-width: min(30rem, 100%);
    padding: 0.7rem 1rem;
    border-radius: 0.9rem;
    overflow: hidden;
    background: var(--glass-strong);
    -webkit-backdrop-filter: blur(24px) saturate(1.6);
    backdrop-filter: blur(24px) saturate(1.6);
    border: 1px solid var(--glass-edge);
    box-shadow: var(--shadow-3), 0 0 40px -16px var(--tone, var(--accent));
    font-size: var(--fs-sm);
    font-weight: 520;
    animation: toast-in 0.6s var(--spring);
  }
  .toast :global(svg) { flex: none; color: var(--tone, var(--accent)); filter: drop-shadow(0 0 6px var(--tone, var(--accent))); }
  .toast.good { --tone: var(--good); }
  .toast.bad { --tone: var(--bad); }
  .toast.info { --tone: var(--accent); }
  .toast-timer {
    position: absolute;
    inset: auto 0 0 0;
    height: 2px;
    background: var(--tone, var(--accent));
    transform-origin: left;
    animation: drain 5.2s linear forwards;
    opacity: 0.8;
  }
  @keyframes toast-in { from { opacity: 0; transform: translateY(18px) scale(0.92); } }
  @keyframes drain { to { transform: scaleX(0); } }

  fieldset { margin: 0; padding: 0; border: 0; }
  legend { padding: 0; font-weight: 600; margin-bottom: var(--s2); font-family: var(--font-display); letter-spacing: 0.04em; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 0.3rem var(--s3); margin: 0; }
  .kv dt { color: var(--text-muted); }
  .kv dd { margin: 0; }
  .err-text { color: var(--bad); }

  /* The character chip shrinks to its mark when space is short or a run is
     showing its status chip. */
  .trailing:has(.job-chip) .who-text { display: none; }
  .trailing:has(.job-chip) .who { padding: 0.2rem; }
  @media (max-width: 72rem) {
    .who-text { display: none; }
    .who { padding: 0.2rem; }
    .group-link { padding-inline: 0.75rem; }
  }
  /* Narrow: the groups fold into a menu that lists every tool under its group. */
  @media (max-width: 56rem) {
    .nav-toggle { display: inline-flex; order: 3; }
    .groups {
      order: 5;
      flex-basis: 100%;
      display: none;
      grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
      gap: 0.5rem 0.75rem;
      padding: 0.35rem 0 0.8rem;
    }
    .groups.open { display: grid; animation: drop 0.4s var(--ease); }
    .groups::before, .groups::after { display: none; }
    .group-link { padding: 0.5rem 0.4rem; font-family: var(--font-display); color: var(--text); }
    .flyout, .group.multi:hover .flyout {
      position: static;
      visibility: visible;
      opacity: 1;
      transform: none;
      padding-top: 0;
      transition: none;
    }
    .flyout-card { width: auto; padding: 0; border: 0; background: none; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
    .flyout-card::before { display: none; }
    .flyout-item { padding: 0.45rem 0.5rem; }
    .flyout-icon { width: 1.9rem; height: 1.9rem; }
    .flyout-text span { display: none; }
    .trailing { margin-left: auto; }
    .bar { flex-wrap: wrap; padding-block: var(--s2); gap: var(--s2); }
    @keyframes drop { from { opacity: 0; transform: translateY(-6px); } }
  }
  @media (max-width: 30rem) {
    .brand-logo { width: 140px; height: 38px; }
    .topbar { padding-top: 0.5rem; }
    .subnav a span { display: none; }
    .subnav a[data-on] span { display: inline; }
  }

  /* Reduced motion: indicators jump, loops stop. */
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) :is(.brand-sheen, .pulse, .toast, .toast-timer),
    :global(:root:not([data-motion='full'])) .job-chip::before { animation: none; }
    :global(:root:not([data-motion='full'])) :is(.groups, .subnav)::before,
    :global(:root:not([data-motion='full'])) :is(.groups, .subnav)::after { transition: none; }
    :global(:root:not([data-motion='full'])) :is(.flyout, .subnav) { transition: none; animation: none; }
  }
  :global(:root[data-motion='reduced']) :is(.brand-sheen, .pulse, .toast, .toast-timer),
  :global(:root[data-motion='reduced']) .job-chip::before { animation: none; }
  :global(:root[data-motion='reduced']) :is(.groups, .subnav)::before,
  :global(:root[data-motion='reduced']) :is(.groups, .subnav)::after { transition: none; }
  :global(:root[data-motion='reduced']) :is(.flyout, .subnav) { transition: none; animation: none; }
</style>
