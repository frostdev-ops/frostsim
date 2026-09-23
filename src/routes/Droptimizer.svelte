<script lang="ts">
  // P09: catalog-driven source navigation; art tile per journal instance with bosses and drops at user-stated item level; P09.1 explains when loot unavailable; P09.8 no drop probability shown.
  import { onDestroy } from 'svelte'
  import { cancelActiveJob, engineBusy } from '../lib/simc/client'
  import { GEAR_SLOTS, SLOT_LABELS, type GearSlot, type ItemInstance } from '../lib/import/character'
  import { buildProfile } from '../lib/import/serialize'
  import { droptimizer, gainOverBaseline, indistinguishable, iterationCeiling, planForTargetError, runAdaptiveSearch } from '../lib/optimization'
  import type {
    DropScenario, DropSource, UsabilityCriteria,
  } from '../lib/optimization/droptimizer'
  import type { DropSourceCounts } from '../lib/catalog/protocol'
  import type { LootProvenance, LootSource, ResolvedItem } from '../lib/catalog/types'
  import type { OptimizationProgress, OptimizationResult } from '../lib/optimization/types'
  import {
    activeCharacter, activeStored, app, catalogClient, constraintsFor, engineIdentityString,
    ensureCatalog, isBusy, maxThreads, pollEngineSlot,
    planOptions, profilesetsSupported, saveReport, toast,
  } from '../lib/app.svelte'
  import { makeRunBatch } from '../lib/runBatch'
  import type { SimOutcome } from '../lib/simc/job'
  import { searchSnapshot } from '../lib/store/report-share'
  import ShareReport from '../lib/ui/ShareReport.svelte'
  let shareOutcome = $state.raw<SimOutcome | null>(null)
  import { markSettled, markStarted, teardownCancellation } from '../lib/job.svelte'
  import { retentionMessage, retentionOf } from '../lib/retention'
  import { sendItems } from '../lib/handoff.svelte'
  import { dropSettings } from '../lib/settings.svelte'
  import { MAX_ITEM_LEVEL, seasonBuildOf, upgradeSeason, upgradeTracks, withMaxUpgrade, withUpgradeRank } from '../lib/catalog/upgrades'
  import { MIN_KEY, isMplusSource, mplusReward, mplusRewardReference } from '../lib/catalog/mplusRewards'
  import { atRaidDifficulty, hasRaidRewards, raidDifficulties, raidRewardLabel, raidRewardReferences, type RaidDifficulty } from '../lib/catalog/raidRewards'
  import { serializeItem } from '../lib/catalog/serialize'
  import { display } from '../lib/items'
  import { fmtDelta, fmtDeltaPct, fmtInt, fmtSeconds } from '../lib/format'
  import { estimateSearchSeconds, type SearchTiming } from '../lib/estimate'
  import { href, navigate } from '../lib/router.svelte'
  import { newId } from '../lib/store/records'
  import RunStatus from '../lib/ui/RunStatus.svelte'
  import SimLog from '../lib/ui/SimLog.svelte'
  import { ProgressBuffer } from '../lib/ui/progress'
  import Banner from '../lib/ui/Banner.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import ItemIcon from '../lib/ui/ItemIcon.svelte'
  import ItemLink from '../lib/ui/ItemLink.svelte'
  import SettingsForm from '../lib/ui/SettingsForm.svelte'
  import ComparisonBars, { type ComparisonRow } from '../lib/ui/ComparisonBars.svelte'
  import { journalTileUrl } from '../lib/media.svelte'
  import { KIND_LABELS, groupInstances, tilesByKind } from '../lib/lootTiles'
  import { ms, stagger, reducedMotion } from '../lib/theme.svelte'
  import { fly, slide } from 'svelte/transition'

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const busy = $derived(isBusy())
  const level = $derived(character?.level ?? 0)

  let allSlots = $state(true)
  let result = $state<OptimizationResult | null>(null)
  let scenarios = $state<DropScenario[]>([])
  let sourcesFor = $state(new Map<string, string[]>())
  let planWarnings = $state<string[]>([])
  let progress = $state<OptimizationProgress | null>(null)
  /** One source of truth for "a run is in progress", shared by button and panel. */
  let running = $state(false)
  /** The job id of the run this screen started, while it owns it. */
  let ownedJobId: string | null = null
  let error = $state('')
  let onlyBest = $state(true)
  let cancelRun: (() => void) | null = null
  let logBuffer = new ProgressBuffer()
  let engineLog = $state<string[]>([])

  const equippedBySlot = $derived(
    new Map<GearSlot, ItemInstance>((character?.equipped ?? []).map((i) => [i.slot, i])),
  )
  const baselineGear = $derived(
    new Map<GearSlot, ItemInstance | null>(
      GEAR_SLOTS.map((slot) => [slot, equippedBySlot.get(slot) ?? null]),
    ),
  )

  // Loot sources from catalog's journal ingestion; empty list explains why if unavailable (P09.1).
  let lootSources = $state<LootSource[]>([])
  /** Filtered, already-converted sources from the catalog, for the run. */
  let availableSources = $state<DropSource[]>([])
  let lootProvenance = $state<LootProvenance[]>([])
  let lootUnavailable = $state<string | null>(null)
  let sourceQuery = $state('')
  /** Multiple instances with explicit selected boss lists; search only filters picker. */
  let chosenInstances = $state<Record<string, string[]>>({})
  /** When result exists, setup collapses; this reopens it. */
  let setupOpen = $state(false)
  /** 'raid' and 'mplus' both mean automatic levels; the selection decides which table applies. */
  let rewardMode = $state<'raid' | 'mplus' | 'custom'>('raid')
  let raidDifficulty = $state<RaidDifficulty>('heroic')
  let maxRaidUpgrade = $state(false)
  let keyLevel = $state(10)
  /** Nebulous Voidcore bonus roll: Great Vault level for the content. */
  let bonusRoll = $state(false)
  const mplusLevel = $derived(mplusReward(keyLevel, bonusRoll))
  /** Custom scenarios remain available for sources without verified reward mappings. */
  let sourceItemLevel = $state<number | null>(null)
  let sourceTrackId = $state<number | null>(null)
  let sourceRank = $state(1)
  const sourceTrack = $derived(upgradeTracks.find((track) => track.id === sourceTrackId))

  function chooseRewardTrack(trackId: number | null, rank = 1): void {
    sourceTrackId = trackId
    sourceRank = rank
    const step = upgradeTracks.find((track) => track.id === trackId)?.ranks.find((step) => step.rank === rank && !step.extended)
    if (step) sourceItemLevel = step.itemLevel
  }

  function evaluatedSource(source: DropSource): DropSource {
    if (useRaidRewards) return atRaidDifficulty(source, selectedSources.find(loot => loot.id === source.id)!, app.catalogManifest ? seasonBuildOf(app.catalogManifest) : undefined, raidDifficulty, maxRaidUpgrade, bonusRoll)
    if (useMplusRewards) {
      if (!mplusLevel) return { ...source, items: [] }
      const { track, rank } = mplusLevel
      return {
        ...source, hypothetical: true,
        label: `${source.label} (+${keyLevel}${bonusRoll ? ' bonus roll' : ''}${maxRaidUpgrade ? ', fully upgraded' : ''})`,
        items: source.items.map((item) => {
          const drop = withUpgradeRank(item, track.id, rank.rank)
          return maxRaidUpgrade ? withMaxUpgrade(drop)! : drop
        }),
      }
    }
    if (sourceTrackId !== null && sourceTrack) return {
      ...source, hypothetical: true,
      label: `${source.label} (${sourceTrack.label} ${sourceRank}/${sourceTrack.max})`,
      items: source.items.map((item) => withUpgradeRank(item, sourceTrackId!, sourceRank)),
    }
    return sourceItemLevel ? droptimizer.atItemLevel(source, sourceItemLevel) : source
  }
  let setupPanel: HTMLElement | undefined = $state()
  let itemLevelInput: HTMLInputElement | undefined = $state()

  /** P09.2: "Only items I can use" filters class, armour type, primary stat, slot; NOT loot specialization (no table exists). */
  let onlyUsable = $state(false)

  /** From last load; distinguishes the three empty states. */
  let dropCounts = $state<DropSourceCounts | null>(null)
  let expiresAt = $state<string | null>(null)

  const criteria = $derived.by<UsabilityCriteria | undefined>(() => {
    if (!onlyUsable || !character) return undefined
    const derived = constraintsFor(character).constraints
    return {
      classId: derived.classId,
      armorSubclass: derived.armorSubclass,
      // Not read from the export, so it is left unset rather than guessed — an
      // items-I-can-use filter that quietly guessed the stat would hide gear
      // the character can actually wear.
      primaryStat: null,
      slots: GEAR_SLOTS,
    }
  })

  /** Retention enforced on every read by Catalog track, not by this screen; this only warns ahead of limit. */
  const expiringSoon = $derived(retentionOf(expiresAt).status === 'expiring')

  /** Two calls both needed: lootSources() has kind/instanceName for list; dropSources() has converted items/counts/filter for run. */
  $effect(() => {
    const client = catalogClient()
    if (!client) return
    let cancelled = false
    client.lootSources().then((r) => {
      if (cancelled) return
      lootSources = r.sources
      lootProvenance = r.provenance
      lootUnavailable = r.unavailableReason
    }).catch(() => {
      if (!cancelled) lootUnavailable = 'The game-data catalog could not be read.'
    })
    return () => { cancelled = true }
  })

  $effect(() => {
    const client = catalogClient()
    if (!client) return
    const query = criteria
    let cancelled = false
    client.dropSources(query, character?.level ?? undefined).then((r) => {
      if (cancelled) return
      availableSources = r.available
      dropCounts = r.counts
      expiresAt = r.expiresAt
    }).catch(() => {
      if (!cancelled) dropCounts = null
    })
    return () => { cancelled = true }
  })

  // One tile per instance (right unit for run, wrong for picker); sources with no instance are own tile.
  // The user's stated precision, as a plan; feeds both search and time estimate so they agree.
  const searchPlan = $derived(planForTargetError(dropSettings.targetError))

  const instances = $derived(groupInstances(lootSources))
  const instancesByKind = $derived(tilesByKind(instances.values(), sourceQuery))
  /** Kinds showing full list instead of first dozen. */
  let expandedKinds = $state<string[]>([])
  /** Work done over work planned, not pass index over pass ceiling; denominator is work actually still planned. */
  function pctOf(p: OptimizationProgress): number {
    const spent = p.samplesSpent ?? 0
    const remaining = p.estimatedSamplesRemaining ?? 0
    const total = spent + remaining
    if (total <= 0) return 100 * (p.batchIndex / Math.max(1, p.batchCount))
    return Math.min(100, (100 * spent) / total)
  }
  /** Monotone by construction; re-estimates after each pass capped at prior value. */
  let progressPct = $state(0)

  const selectedInstances = $derived([...instances.values()].filter(t => chosenInstances[t.key] !== undefined))
  const selectedSources = $derived<LootSource[]>(
    selectedInstances.flatMap(t => t.bosses.filter(b => chosenInstances[t.key].includes(b.id))),
  )
  const raidAvailable = $derived(selectedSources.length > 0 && selectedSources.every(source => hasRaidRewards(source, app.catalogManifest ? seasonBuildOf(app.catalogManifest) : undefined)))
  const mplusAvailable = $derived(selectedSources.length > 0 && selectedSources.every(isMplusSource))
  const useRaidRewards = $derived(rewardMode !== 'custom' && raidAvailable)
  const useMplusRewards = $derived(rewardMode !== 'custom' && mplusAvailable)
  const rewardReady = $derived(useRaidRewards || (useMplusRewards ? !!mplusLevel : !!sourceItemLevel && sourceItemLevel <= MAX_ITEM_LEVEL))
  function pickInstance(key: string): void {
    if (chosenInstances[key]) {
      const next = { ...chosenInstances }
      delete next[key]
      chosenInstances = next
    } else {
      chosenInstances = { ...chosenInstances, [key]: instances.get(key)?.bosses.map(b => b.id) ?? [] }
    }
  }
  function toggleBoss(key: string, id: string): void {
    const selected = chosenInstances[key] ?? []
    const next = selected.includes(id) ? selected.filter(b => b !== id) : [...selected, id]
    if (!next.length) pickInstance(key)
    else chosenInstances = { ...chosenInstances, [key]: next }
  }
  /** Selected sources' items for preview. */
  const previewItems = $derived.by(() => {
    const seen = new Set<string>()
    const out: ItemInstance[] = []
    for (const s of selectedSources) {
      const source = dropSourceFor(s)
      for (const item of source ? evaluatedSource(source).items : []) {
        const key = serializeItem(item)
        if (seen.has(key)) continue
        seen.add(key)
        // Catalog instance lacks parser's provenance fields (line number, option order); display never reads them.
        out.push(item as ItemInstance)
      }
    }
    return out
  })
  /** Preview names/qualities; resolved here in catalog worker only for display; run resolves again at stated level. */
  let previewResolved = $state<Map<string, ResolvedItem>>(new Map())
  $effect(() => {
    const items = previewItems
    const client = catalogClient()
    if (!client || !items.length) { previewResolved = new Map(); return }
    let cancelled = false
    client.resolve(items, level || undefined)
      .then((r) => { if (!cancelled) previewResolved = r.items })
      .catch(() => { if (!cancelled) previewResolved = new Map() })
    return () => { cancelled = true }
  })
  const lootLimitations = $derived([
    ...new Set(lootProvenance.flatMap((p) => p.limitations)),
  ])
  /** Mandatory attribution for loot data; never rendered without it. */
  const lootAttribution = $derived([...new Set(lootProvenance.map((p) => p.attribution))])

  /** Source from catalog, not hand-assembled; returns null when no converted form, so caller states reason. */
  function dropSourceFor(source: LootSource): DropSource | null {
    return availableSources.find((s) => s.id === source.id) ?? null
  }

  /** P09.10: sends this scenario's item to a screen showing how it behaves with everything else; the EXACT instance travels. */
  function send(scenario: DropScenario, target: 'gear' | 'compare'): void {
    const item = scenario.candidate.delta.gear?.get(scenario.slot)
    if (!item) {
      toast('bad', 'That candidate carries no item to send, which is a bug in Frostsim.')
      return
    }
    sendItems(target, [{
      item: item as ItemInstance,
      slot: scenario.slot,
      source: sourceLabelFor(scenario.sourceId),
      characterId: stored?.id ?? null,
    }])
    toast('info', `${scenario.item.name} sent to ${target === 'gear' ? 'Top Gear' : 'Compare'}.`)
    navigate(target === 'gear' ? 'gear' : 'compare')
  }

  function sourceLabelFor(sourceId: string): string {
    const found = lootSources.find((s) => s.id === sourceId)
    if (!found) return 'Droptimizer'
    return found.instanceName ? `${found.instanceName} — ${found.name}` : found.name
  }

  const canRun = $derived(
    !!selectedSources.length && rewardReady,
  )
  const needsLevel = $derived(!busy && app.catalogState === 'ready' && !!selectedSources.length && !rewardReady)
  const needsSource = $derived(!busy && app.catalogState === 'ready' && !selectedSources.length)
  const nextStep = $derived(needsLevel ? 'Set the loot item level' : needsSource ? 'Choose dungeons or raids' : '')
  function focusNextStep(): void {
    const target = needsLevel ? itemLevelInput : setupPanel?.querySelector<HTMLButtonElement>('.tiles button')
    target?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'instant' : 'smooth' })
    target?.focus({ preventScroll: true })
  }

  let plannedCount = $state<number | null>(null)
  let planningError = $state('')
  $effect(() => {
    const client = catalogClient()
    const selected = selectedSources.map(dropSourceFor).filter((s): s is DropSource => !!s).map(evaluatedSource)
    const ready = rewardReady
    const options = character ? { ...planOptions(character, [...baselineGear.entries()]), plan: searchPlan, allEligibleSlots: allSlots } : null
    plannedCount = null
    planningError = ''
    if (!client || !options || !selected.length || !ready) return
    let cancelled = false
    const timer = setTimeout(() => {
      client.planDroptimizer(selected, options)
        .then(p => { if (!cancelled) plannedCount = p?.scenarios.length ?? 0 })
        .catch(e => { if (!cancelled) planningError = e instanceof Error ? e.message : String(e) })
    }, 150)
    return () => { cancelled = true; clearTimeout(timer) }
  })
  const timingHistory = $derived(app.reports.filter(r => {
    if (r.characterId !== stored?.id || r.completion !== 'complete' || !['quick', 'droptimizer'].includes(r.tool)) return false
    const saved = r.requestSnapshot as { settings?: { fightStyle?: string; maxTime?: number; targets?: number; threads?: number } } | null
    return saved?.settings?.fightStyle === dropSettings.fightStyle
      && saved.settings.maxTime === dropSettings.maxTime && saved.settings.targets === dropSettings.targets
      && saved.settings.threads === Math.min(dropSettings.threads, maxThreads())
  }))
  let liveTiming = $state<SearchTiming | null>(null)
  const previousTiming = $derived(timingHistory.find(r => r.summary.searchTiming)?.summary.searchTiming ?? null)
  const timeEstimate = $derived.by(() => {
    const timing = running ? liveTiming ?? previousTiming : previousTiming
    // The adaptive search knows its own remaining work — it projects it from the
    // samples the engine actually reported. Prefer that over extrapolating a fixed
    // ladder the search no longer runs, which reads zero once the passes outrun the
    // plan's stage list and shows the user "0s remaining" for the rest of the run.
    const remaining = running ? progress?.estimatedSamplesRemaining : undefined
    if (remaining !== undefined && timing?.iterationsPerSecond) {
      return { seconds: remaining / timing.iterationsPerSecond, ceiling: false }
    }
    return estimateSearchSeconds(timingHistory, running ? scenarios.length : plannedCount ?? 0, searchPlan, running ? progress : null, timing)
  })
  const largeSearch = $derived((plannedCount ?? 0) >= 100 || (timeEstimate?.seconds ?? 0) >= 600)
  let elapsed = $state(0)
  $effect(() => {
    if (!running) return
    const started = Date.now()
    elapsed = 0
    const timer = setInterval(() => { elapsed = (Date.now() - started) / 1000 }, 1000)
    return () => clearInterval(timer)
  })

  async function go(): Promise<void> {
    if (!character || !canRun || busy || plannedCount === null || plannedCount === 0) return
    let client: Awaited<ReturnType<typeof ensureCatalog>> = null
    try {
      client = await ensureCatalog()
    } catch (err) {
      error = `Game data could not be loaded: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    if (!client) {
      error = 'Game data is required to evaluate an item, and it is not loaded.'
      return
    }
    error = ''
    result = null
    shareOutcome = null
    scenarios = []
    planWarnings = []
    progress = null
    progressPct = 0
    liveTiming = null
    running = true
    logBuffer = new ProgressBuffer()
    engineLog = []

    const sources: DropSource[] = []
    if (selectedSources.length && rewardReady) {
      const skipped: string[] = []
      for (const s of selectedSources) {
        const converted = dropSourceFor(s)
        if (converted?.items.length) sources.push(evaluatedSource(converted))
        else skipped.push(s.name)
      }
      if (skipped.length) {
        // Named not silent: vanished boss would look like boss dropping nothing usable.
        error = skipped.length === selectedSources.length
          ? 'Nothing selected drops anything you can use with the current filter, so nothing was run. '
            + 'Turn the filter off to evaluate the drops anyway.'
          : `Not run (nothing usable with the current filter): ${skipped.join(', ')}.`
      }
    }
    if (!sources.length) {
      running = false
      if (!error) {
        error = 'Nothing was selected to evaluate, so there was nothing to run.'
      }
      return
    }

    const jobId = newId()
    ownedJobId = jobId
    const title = `${stored?.label ?? character.name} — Droptimizer`
    // Marker so a run killed by reload is not silent.
    markStarted({ tool: 'droptimizer', title, startedAt: Date.now() })
    app.job = {
      id: jobId, tool: 'droptimizer', title,
      status: 'validating', startedAt: Date.now(),
    }

    const controller = new AbortController()
    cancelRun = () => controller.abort()

    try {
      const plan = await client.planDroptimizer(sources, {
        ...planOptions(character, [...baselineGear.entries()]),
        plan: searchPlan,
        allEligibleSlots: allSlots,
      })
      if (!plan) {
        error = 'Game data is required to evaluate an item, and the catalog did not answer.'
        return
      }
      if (app.job?.id !== jobId) return
      scenarios = plan.scenarios
      sourcesFor = plan.sourcesFor
      planWarnings = plan.warnings

      const batch = makeRunBatch({
        onOutcome: value => shareOutcome = value,
        settings: {
          fightStyle: dropSettings.fightStyle, maxTime: dropSettings.maxTime,
          targets: dropSettings.targets, threads: Math.min(dropSettings.threads, maxThreads()),
        },
        extraProfileLines: dropSettings.extraProfileLines(),
        buffer: logBuffer,
        onEvent: () => { engineLog = [...logBuffer.lines] },
      })
      const finalStage = searchPlan.stages[searchPlan.stages.length - 1]
      const r = await runAdaptiveSearch(plan.scenarios.map((s) => s.candidate), {
        profile: buildProfile(character),
        catalogId: plan.catalogId,
        // Without this cache never warms and runner warns once per batch, producing identical strings.
        engineIdentity: engineIdentityString(),
        runBatch: async request => {
          const started = performance.now()
          const outcome = await batch(request)
          const seconds = (performance.now() - started) / 1000
          const samples = outcome.results.reduce((n, r) => n + r.iterations, outcome.baseline?.iterations ?? 0)
          if (samples > 0 && seconds > 0) {
            const baseline = outcome.baseline
            liveTiming = {
              iterationsPerSecond: samples / seconds,
              iterations: baseline?.iterations ?? 0,
              errorPct: baseline && baseline.mean > 0 && baseline.margin !== null ? baseline.margin / baseline.mean * 100 : null,
            }
          }
          return outcome
        },
        onProgress: (p) => {
          progress = p
          progressPct = Math.max(progressPct, pctOf(p))
          if (app.job?.id === jobId) {
            app.job.stage = { index: p.stageIndex + 1, total: p.stageCount, label: p.stageLabel }
            app.job.status = 'running'
          }
        },
      }, {
        targetError: finalStage.accuracy.mode === 'targetError' ? finalStage.accuracy.targetError : dropSettings.targetError,
        maxIterations: iterationCeiling(finalStage.accuracy),
        minIterations: searchPlan.minIterations,
        retentionFactor: searchPlan.retentionFactor,
        correctForMultipleComparisons: searchPlan.correctForMultipleComparisons,
      }, controller.signal)
      if (app.job?.id !== jobId) return
      result = r
      app.job.status = r.incomplete ? 'error' : 'complete'
      await saveReport({
        tool: 'droptimizer',
        title: app.job.title,
        completion: r.incomplete ? 'partial' : 'complete',
        requestSnapshot: { sources: selectedSources.map(s => s.id), raidDifficulty: useRaidRewards ? raidDifficulty : undefined, keyLevel: useMplusRewards ? keyLevel : undefined, bonusRoll: useRaidRewards || useMplusRewards ? bonusRoll : undefined, maxRaidUpgrade: useRaidRewards || useMplusRewards ? maxRaidUpgrade : undefined, itemLevel: useRaidRewards || useMplusRewards ? undefined : sourceItemLevel, trackId: useRaidRewards || useMplusRewards ? undefined : sourceTrackId, rank: !useRaidRewards && !useMplusRewards && sourceTrackId ? sourceRank : undefined, allEligibleSlots: allSlots, settings: dropSettings.snapshot() },
        summary: {
          dps: r.baseline?.mean,
          searchTiming: liveTiming ?? undefined,
          candidateCount: plan.scenarios.length,
          topCandidates: bestPerItemOf(r, plan.scenarios).slice(0, 5).map((row) => ({
            id: row.scenario.candidate.id,
            label: row.scenario.item.name,
            mean: row.mean ?? 0,
            delta: row.gain?.absolute ?? 0,
          })),
          warnings: [...r.warnings, ...plan.warnings].length
            ? [...r.warnings, ...plan.warnings]
            : undefined,
        },
      })
    } catch (err) {
      if (app.job?.id !== jobId) return
      const cancelled = err instanceof DOMException && err.name === 'AbortError'
      app.job.status = cancelled ? 'cancelled' : 'error'
      error = cancelled
        ? 'Cancelled. The batch that was running was discarded — the engine has no partial result to keep.'
        : err instanceof Error ? err.message : String(err)
    } finally {
      markSettled()
      // Returning from search is not proof engine stopped.
      controller.abort()
      cancelRun = null
      running = false
      // Classify first: deciding status from error before synthesizing prevents marking silent failures 'complete'.
      if (!result && !error) {
        // End is known, cause is not; reached when job replaced, so cannot diagnose memory.
        error = 'The run ended without producing a result, and Frostsim does not know why — '
          + 'nothing reported an error. If the engine was still running when the screen went '
          + 'quiet, the browser shutting it down is one possibility: one run needs on the order '
          + 'of two gigabytes whatever the settings. Nothing was saved.'
      }
      if (app.job?.id === jobId && !['complete', 'error', 'cancelled'].includes(app.job.status)) {
        app.job.status = result && !result.incomplete && !error ? 'complete' : 'error'
      }
      if (ownedJobId === jobId) ownedJobId = null
      pollEngineSlot()
    }
  }

  interface DropRow {
    scenario: DropScenario
    mean: number | null
    gain: ReturnType<typeof gainOverBaseline> | null
    pass?: number
    sourceIds: string[]
    status: string
  }

  /** Ranking and stats come from optimizer; presentation only. */
  function rowsOf(r: OptimizationResult, list: DropScenario[]): DropRow[] {
    const byId = new Map(r.candidates.map((c) => [c.candidate.id, c]))
    const baseline = r.baseline
    return list
      .map((scenario) => {
        const state = byId.get(scenario.candidate.id)
        const m = state?.measurement ?? null
        return {
          scenario,
          mean: m && Number.isFinite(m.mean) ? m.mean : null,
          gain: m && baseline && Number.isFinite(m.mean) ? gainOverBaseline(m, baseline) : null,
          sourceIds: sourcesFor.get(scenario.candidate.id) ?? [],
          status: state?.status ?? 'missing',
          // Pass row was last measured in, so eliminated row can say where.
          pass: m?.stageIndex,
        }
      })
      .sort((a, b) => (b.gain?.absolute ?? -Infinity) - (a.gain?.absolute ?? -Infinity))
  }

  /** Best slot per item for "only the best" view. */
  function bestPerItemOf(r: OptimizationResult, list: DropScenario[]): DropRow[] {
    const best = new Map<number, DropRow>()
    for (const row of rowsOf(r, list)) {
      const key = row.scenario.item.itemId
      const current = best.get(key)
      if (!current || (row.mean ?? -Infinity) > (current.mean ?? -Infinity)) best.set(key, row)
    }
    return [...best.values()].sort(
      (a, b) => (b.gain?.absolute ?? -Infinity) - (a.gain?.absolute ?? -Infinity),
    )
  }

  const rows = $derived<DropRow[]>(
    result ? (onlyBest ? bestPerItemOf(result, scenarios) : rowsOf(result, scenarios)) : [],
  )

  const allHypothetical = $derived(
    rows.length > 0
      && rows.every((r) => r.scenario.candidate.delta.gear?.get(r.scenario.slot)?.source === 'hypothetical'),
  )
  const bars = $derived<ComparisonRow[]>(
    rows.map((row) => ({
      id: row.scenario.candidate.id,
      label: row.scenario.item.name,
      item: row.scenario.item,
      mean: row.mean ?? undefined,
      margin: row.gain?.margin ?? undefined,
      indistinguishable: indistinguishable(row.gain?.significant),
      status: row.status,
      detail: `${SLOT_LABELS[row.scenario.slot]} · replaces ${row.scenario.replaces?.name ?? 'nothing'}`,
      // Chip on every row says nothing; when whole run hypothetical, header says once and rows stay clean.
      hypothetical: !allHypothetical
        && row.scenario.candidate.delta.gear?.get(row.scenario.slot)?.source === 'hypothetical',
      // The exact instance engine measured, so icon is that item not bag lookalike.
      icons: [row.scenario.candidate.delta.gear?.get(row.scenario.slot)].filter(
        (i): i is ItemInstance => !!i,
      ),
      changedSlots: [row.scenario.slot],
    })),
  )

  /** A run belongs to this screen, which owns its Cancel and result; one outliving screen is unstoppable. */
  onDestroy(() => {
    const what = teardownCancellation({
      running, ownedJobId, activeJobId: app.job?.id, engineBusy: engineBusy(),
    })
    if (what.abort) cancelRun?.()
    if (what.forceCancel) cancelActiveJob('the screen running this comparison was closed')
  })
</script>

{#if !character}
  <section class="empty stack">
    <h1>No character yet</h1>
    <p class="muted">Droptimizer measures an item against your current gear.</p>
    <p><a href={href('character')}>Import one</a>.</p>
  </section>
{:else}
  <div class="stack">
    <CatalogStatus />

    <!-- SOURCE -> BOSSES -> ITEMS -> RUN -> RANKED: tiles per instance/bosses/drops, one button; result folds setup to summary. -->
    <section class="panel stack setup" bind:this={setupPanel} hidden={running} class:collapsed={result && !setupOpen}>
      <header>
        <div class="stack-sm">
          <h1>Droptimizer</h1>
          <p class="muted small">
            {stored?.label ?? character.name}
            {#if selectedInstances.length}
              · {selectedInstances.length} sources · {selectedSources.length} bosses
              {#if useRaidRewards || useMplusRewards}· {useRaidRewards ? raidDifficulties[raidDifficulty] : `+${keyLevel}`} · {bonusRoll ? 'bonus roll' : 'as dropped'}{maxRaidUpgrade ? ', fully upgraded' : ''}{:else if sourceItemLevel}· item level {sourceItemLevel}{/if}
            {/if}
            · {dropSettings.fightStyle} · {dropSettings.targets}T · {dropSettings.maxTime}s
          </p>
        </div>
        <div class="run-actions">
          {#if result && !running}
            <button class="ghost sm" onclick={() => (setupOpen = !setupOpen)}>
              {setupOpen ? 'Hide setup' : 'Setup'}
            </button>
          {/if}
          {#if running}
            <button class="danger" onclick={() => cancelRun?.()}>Cancel</button>
          {:else}
            <button
              class="primary"
              onclick={go}
              aria-describedby={nextStep ? 'drop-next-step' : undefined}
              disabled={!canRun || !plannedCount || !profilesetsSupported() || app.catalogState !== 'ready' || busy}
            >
              Evaluate{#if previewItems.length} {fmtInt(previewItems.length)} items{/if}
            </button>
          {/if}
          {#if nextStep && (!result || setupOpen)}<button id="drop-next-step" class="next-step" onclick={focusNextStep}><span aria-hidden="true" class="quest-marker"></span>{nextStep}<span aria-hidden="true">→</span></button>{/if}
        </div>
      </header>

      {#if !result || setupOpen}
        {#if canRun}
          <div class="work-summary" aria-live="polite">
            <div><span class="xs muted">Comparison size</span><strong>{plannedCount === null ? 'Calculating…' : `${fmtInt(plannedCount)} item / slot combinations`}</strong></div>
            <div><span class="xs muted">Estimated completion time</span><strong>{timeEstimate ? `≈ ${fmtSeconds(timeEstimate.seconds)}` : 'Estimating after the first batch'}</strong><span class="xs muted">{timeEstimate?.ceiling ? 'Uses iteration ceilings at recent device speed' : timeEstimate ? 'Based on this character’s recent runs on this device' : 'No comparable timing history yet'}</span></div>
          </div>
          {#if largeSearch}
            <Banner kind="warn" title="Large simulation">
              <p>{fmtInt(plannedCount ?? 0)} combinations run through multiple stages on your device. {timeEstimate ? `Allow roughly ${fmtSeconds(timeEstimate.seconds)}; close results may take longer.` : 'This may take a while.'} Select fewer sources or bosses to shorten it.</p>
            </Banner>
          {/if}
          {#if planningError}<Banner kind="bad" title="Could not prepare loot"><p>{planningError}</p></Banner>
          {:else if plannedCount === 0}<Banner kind="info" title="No eligible upgrades to simulate"><p>Choose different loot sources or change the item filter.</p></Banner>{/if}
        {/if}
        {#if lootUnavailable}
          <Banner kind="warn" title="No verified loot sources in this build">
            <p>{lootUnavailable}</p>
          </Banner>
        {:else if lootSources.length}
          <p class="small muted">
            Current-season sources only.
            {#if lootProvenance.some((p) => p.provider === 'raiderio')}
              Season membership from <a href="https://raider.io" target="_blank" rel="noreferrer">Raider.IO</a>;
              loot tables from Blizzard.
            {/if}
            {#if !lootSources.some((s) => s.kind === 'delve')}
              Delves are unavailable until verified loot data is available.
            {/if}
          </p>
          <div class="spread">
            <label class="field grow search">
              <span class="sr-only">Search instances and bosses</span>
              <input type="search" bind:value={sourceQuery} placeholder="Search instances and bosses" />
            </label>
            <label
              class="check small"
              title="Filters on your class, armour type, primary stat and slot. It is not the game's loot specialization, which this data does not carry; an item usable by more than one primary stat is always shown."
            >
              <input type="checkbox" bind:checked={onlyUsable} />
              Only items I can use
              {#if onlyUsable && dropCounts && dropCounts.itemsBefore > 0}
                <span class="chip">{fmtInt(dropCounts.itemsAfter)} of {fmtInt(dropCounts.itemsBefore)}</span>
              {/if}
            </label>
          </div>

          {#if onlyUsable && dropCounts && dropCounts.itemsBefore > 0 && dropCounts.itemsAfter === 0}
            <Banner kind="info" title="Nothing here drops anything you can use">
              <p>
                All {fmtInt(dropCounts.itemsBefore)} items were filtered out by your class, armour type
                or slots. Turn the filter off to see them anyway.
              </p>
            </Banner>
          {/if}

          {#each instancesByKind as [kind, tiles] (kind)}
            {@const expanded = expandedKinds.includes(kind) || sourceQuery.trim() !== ''}
            {@const shownTiles = expanded ? tiles : tiles.slice(0, 12)}
            <div class="stack-sm">
              <div class="spread"><h2 class="small">{KIND_LABELS[kind]} <span class="chip">{fmtInt(tiles.length)}</span></h2><button class="ghost sm" onclick={() => { chosenInstances = { ...chosenInstances, ...Object.fromEntries(tiles.map(t => [t.key, t.bosses.map(b => b.id)])) } }}>Select all{sourceQuery.trim() ? ' matching' : ''}</button></div>
              <div class="tiles" class:needs-choice={needsSource}>
                {#each shownTiles as tile, i (tile.key)}
                  {@const art = journalTileUrl(tile.mediaId)}
                  <button
                    class="tile"
                    class:on={!!chosenInstances[tile.key]}
                    aria-pressed={!!chosenInstances[tile.key]}
                    onclick={() => pickInstance(tile.key)}
                    in:fly|global={{ y: 6, duration: ms('reveal'), delay: stagger(i, 12) }}
                  >
                    {#if art}
                      <!-- Missing tile: typography over surface, never broken-image glyph. -->
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onerror={(e) => ((e.currentTarget as HTMLImageElement).hidden = true)}
                      />
                    {/if}
                    <span class="tile-name">{tile.name}</span>
                    <span class="tile-check" aria-hidden="true">{chosenInstances[tile.key] ? '✓' : '+'}</span>
                    <span class="tile-meta">
                      {#if tile.bosses.length > 1}{tile.bosses.length} bosses · {/if}{fmtInt(tile.itemCount)} items
                    </span>
                  </button>
                {/each}
              </div>
              {#if !expanded && tiles.length > shownTiles.length}
                <button class="ghost sm self-start" onclick={() => (expandedKinds = [...expandedKinds, kind])}>
                  Show {fmtInt(tiles.length - shownTiles.length)} more
                </button>
              {/if}

            </div>
          {/each}
        {/if}

        {#if selectedInstances.length}
          <section class="picked stack" transition:slide={{ duration: ms('panel') }}>
            <div class="spread">
              <h2 class="small">{selectedInstances.length} sources selected</h2>
              <button class="ghost sm" onclick={() => chosenInstances = {}}>Clear all</button>
            </div>
            {#each selectedInstances as instance (instance.key)}
              <details class="disclosure">
                <summary>{instance.name} · {chosenInstances[instance.key].length}/{instance.bosses.length} bosses</summary>
                <div class="row-tight boss-picks">
                  {#each instance.bosses as boss (boss.id)}
                    <label class="check small">
                      <input type="checkbox" checked={chosenInstances[instance.key].includes(boss.id)} onchange={() => toggleBoss(instance.key, boss.id)} />
                      {boss.name}
                      {#if useRaidRewards}<span class="xs muted">{raidRewardLabel(boss, raidDifficulty, maxRaidUpgrade, bonusRoll)}</span>{/if}
                    </label>
                  {/each}
                  <button class="ghost sm" onclick={() => chosenInstances = { ...chosenInstances, [instance.key]: instance.bosses.map(b => b.id) }}>All bosses</button>
                  <button class="ghost sm" onclick={() => pickInstance(instance.key)}>Remove source</button>
                </div>
              </details>
            {/each}
            <div class="spread">
              <label class="field inline"><span>Loot levels</span><select value={useRaidRewards ? 'raid' : useMplusRewards ? 'mplus' : 'custom'} onchange={e => rewardMode = e.currentTarget.value as 'raid' | 'mplus' | 'custom'}><option value="raid" disabled={!raidAvailable}>Raid boss rewards</option><option value="mplus" disabled={!mplusAvailable}>Mythic+ key level</option><option value="custom">Custom track / item level</option></select></label>
              {#if useRaidRewards}
                <label class="field inline"><span>Raid difficulty</span><select bind:value={raidDifficulty}>{#each Object.entries(raidDifficulties) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
              {:else if useMplusRewards}
                <label class="field inline">
                  <span>Key level {#if needsLevel}<span class="required-label">Required</span>{/if}</span>
                  <input bind:this={itemLevelInput} class:needs-choice={needsLevel} type="number" min={MIN_KEY} max="30" step="1" value={keyLevel}
                    aria-describedby="drop-level-help" oninput={e => keyLevel = e.currentTarget.valueAsNumber} />
                </label>
                {#if mplusLevel}<span class="xs muted">{mplusLevel.track.label} {mplusLevel.rank.rank}/{mplusLevel.track.max} · {mplusLevel.rank.itemLevel}</span>{/if}
              {/if}
              {#if useRaidRewards || useMplusRewards}
                <label class="check small" title="Nebulous Voidcore loot drops at the Great Vault level for the content."><input type="checkbox" bind:checked={bonusRoll} />Bonus roll</label>
                <label class="check small"><input type="checkbox" bind:checked={maxRaidUpgrade} />Upgrade to max in track</label>
              {:else}
              <label class="field inline"><span>Upgrade track</span><select title={upgradeSeason.name} value={sourceTrackId ?? ''} onchange={(e) => chooseRewardTrack(e.currentTarget.value ? Number(e.currentTarget.value) : null)}><option value="">Custom item level</option>{#each upgradeTracks as track (track.id)}<option value={track.id}>{track.label}</option>{/each}</select></label>
              {#if sourceTrack}<label class="field inline"><span>Upgrade rank</span><select value={sourceRank} onchange={(e) => chooseRewardTrack(sourceTrack!.id, Number(e.currentTarget.value))}>{#each sourceTrack.ranks.filter((rank) => !rank.extended) as rank}<option value={rank.rank}>{rank.rank}/{sourceTrack.max} · ilvl {rank.itemLevel}</option>{/each}</select></label>{/if}
              <label class="field inline">
                <span>Loot item level {#if needsLevel}<span class="required-label">Required</span>{/if}</span>
                <input bind:this={itemLevelInput} class:needs-choice={needsLevel}
                  aria-required="true" aria-describedby={needsLevel ? 'drop-next-step drop-level-help' : 'drop-level-help'}
                  type="number" min="1" max={MAX_ITEM_LEVEL} step="1" readonly={!!sourceTrack} value={sourceItemLevel ?? ''} placeholder="e.g. 311"
                  oninput={e => { const n = e.currentTarget.valueAsNumber; sourceItemLevel = Number.isInteger(n) && n > 0 && n <= MAX_ITEM_LEVEL ? n : null }} />
              </label>
              {/if}
              <label class="check small" title="Try rings, trinkets and weapons in every eligible slot.">
                <input type="checkbox" bind:checked={allSlots} />Try every eligible slot
              </label>
            </div>
            <p id="drop-level-help" class="xs muted">{#if useRaidRewards && bonusRoll}Bonus rolls drop at the raid Great Vault level for the difficulty, the same for every boss. Mythic final-boss and Very Rare drops stay at 344. <a href={raidRewardReferences.at(-1)} target="_blank" rel="noreferrer">Reward details</a>.{:else if useRaidRewards}Uses each boss’s drop level and track. Mythic final-boss and Very Rare drops stay at 344, including when upgraded. <a href={raidRewardReferences[0]} target="_blank" rel="noreferrer">Reward details</a>.{:else if useMplusRewards}{bonusRoll ? 'Bonus rolls drop at the Great Vault level for the key.' : 'End-of-dungeon level for the key.'}{!mplusLevel ? ` Enter a key level of ${MIN_KEY} or higher.` : ''} <a href={mplusRewardReference} target="_blank" rel="noreferrer">Reward details</a>.{:else}Custom levels apply to all selected sources and may not be obtainable.{#if !raidAvailable && !mplusAvailable} Automatic levels require only supported raid bosses or only Mythic+ dungeons.{/if}{/if}</p>
            {#if previewItems.length}
              <details class="disclosure">
                <summary>Preview loot · {fmtInt(previewItems.length)} items</summary>
                <div class="drops">
                  {#each previewItems as item (item.instanceId)}
                    {@const shown = display(item, previewResolved)}
                    <ItemLink itemId={item.itemId} name={shown.name} resolved={shown.resolved}><ItemIcon itemId={item.itemId} quality={shown.resolved?.quality} size={40} alt={shown.name} />{#if shown.resolved}<span class="xs">{shown.resolved.itemLevel}</span>{/if}</ItemLink>
                  {/each}
                </div>
              </details>
            {/if}
          </section>
        {/if}

        <details class="disclosure">
          <summary>Run settings</summary>
          <SettingsForm settings={dropSettings} character={character} perCandidate />
        </details>

        <details class="disclosure">
          <summary>What this data can and cannot say</summary>
          <ul class="xs muted">
            <li>Items from a source are hypothetical: you do not have them.</li>
            <li>
              No drop probability or source priority is shown. Computing one needs a documented drop
              rate and an eligible-item denominator, and this data has neither.
            </li>
            {#if !character.vault?.length}
              <li>The addon does not write Great Vault choices, so your current Vault options are not shown.</li>
            {/if}
            {#each lootLimitations as l, i (i)}<li>{l}</li>{/each}
          </ul>
        </details>

        {#if expiringSoon}
          <Banner kind="warn" title="This game data expires soon">
            <p>{retentionMessage(retentionOf(expiresAt))}</p>
          </Banner>
        {/if}
        <!-- Required attribution for loot data, not decorative. -->
        {#each lootAttribution as a, i (i)}<p class="xs faint">{a}</p>{/each}
      {/if}
    </section>

    {#if running}<RunStatus title="Droptimizer · {character.name}" stage={progress?.stageLabel ?? 'Preparing'} fraction={progress ? progressPct / 100 : undefined} summary={progress ? `Pass ${progress.stageIndex + 1} of up to ${progress.stageCount} · Batch ${progress.batchIndex + 1}/${progress.batchCount}${progress.candidatesInBatch ? ` · running ${progress.candidatesInBatch} candidates` : ''}${progress.contendersRemaining !== undefined && progress.stageIndex > 0 ? ` · ${progress.contendersRemaining} still in contention` : ''}` : ''} statusDetail={timeEstimate ? `≈ ${fmtSeconds(timeEstimate.seconds)} remaining · estimate updates after each batch` : 'Estimating completion after the first batch'} {elapsed} log={engineLog} oncancel={() => cancelRun?.()} />{/if}

    {#if error}
      <Banner kind={app.job?.status === 'cancelled' ? 'info' : 'bad'} title="Run stopped" live>
        <p>{error}</p>
      </Banner>
    {/if}

    {#if result}
      {#if result.incomplete && engineLog.length}<details class="disclosure"><summary>SimulationCraft log</summary><SimLog lines={engineLog} /></details>{/if}
      {#if shareOutcome && result.baseline}<div class="row"><ShareReport outcome={shareOutcome} transform={s => searchSnapshot(s, result!, 'Droptimizer')} /></div>{/if}
      {@const notes = [...new Set([...result.warnings, ...planWarnings])]}
      <section class="stack" id="result">
        {#if result.incomplete}
          <Banner kind="warn" title="This run did not finish">
            <p>{result.incomplete.message}</p>
          </Banner>
        {/if}
        {#if notes.length}
          <!-- One banner, not one per note: four stacked boxes pushed the result off screen. -->
          <Banner kind="warn" title={notes.length === 1 ? 'Note' : `${notes.length} notes`}>
            <ul class="xs plain">{#each notes as w, i (i)}<li>{w}</li>{/each}</ul>
          </Banner>
        {/if}

        <section class="panel stack-sm">
          <div class="spread">
            <h2 class="small">
              Upgrades <span class="chip">{fmtInt(rows.length)}</span>
              {#if allHypothetical}
                <span class="chip warn" title="Potential drops at the item levels used in this simulation.">
                  hypothetical · item levels {[...new Set(scenarios.map(scenario => scenario.item.itemLevel))].sort((a, b) => a - b).join(', ')}
                </span>
              {/if}
            </h2>
            <div class="row-tight">
              {#if result.baseline}
                <span class="small muted">
                  Current gear <b class="num">{fmtInt(result.baseline.mean)}</b>
                  {#if result.baseline.margin !== null && result.baseline.margin !== undefined}
                    <span class="faint">±{fmtInt(result.baseline.margin)}</span>
                  {/if}
                </span>
              {/if}
              <label class="check small" title="One row per item: its best slot. Off shows every slot tried.">
                <input type="checkbox" bind:checked={onlyBest} />
                Best slot only
              </label>
            </div>
          </div>

          {#if result.baseline}
            <ComparisonBars
              rows={bars}
              baseline={{
                label: 'Current gear',
                mean: result.baseline.mean,
                margin: result.baseline.margin ?? undefined,
              }}
              baselineGear={character.equipped}
              caption="Each item's value against your current gear"
            />
          {/if}

          <details class="disclosure">
            <summary>Exact values, sources and actions</summary>
            <div class="tbl-scroll">
              <table class="tbl">
                <caption class="sr-only">Each item's value against your current gear, by slot</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Replaces</th>
                    <th scope="col">Source</th>
                    <th scope="col" class="n">DPS</th>
                    <th scope="col" class="n">Change</th>
                    <th scope="col" class="n">±</th>
                    <th scope="col"><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {#each rows as row (row.scenario.candidate.id)}
                    <tr>
                      <th scope="row">
                        <span class="truncate q{row.scenario.item.quality}"><ItemLink itemId={row.scenario.item.itemId} name={row.scenario.item.name} resolved={row.scenario.item} /></span>
                        <span class="chip xs">{row.scenario.item.itemLevel}</span>
                      </th>
                      <td class="small">
                        {SLOT_LABELS[row.scenario.slot]}
                        <span class="muted xs">{#if row.scenario.replaces}<ItemLink itemId={row.scenario.replaces.itemId} name={row.scenario.replaces.name} resolved={row.scenario.replaces} />{:else}nothing equipped{/if}</span>
                      </td>
                      <td class="small muted">{row.sourceIds.map(sourceLabelFor).join(', ')}</td>
                      <td class="n">{row.mean !== null ? fmtInt(row.mean) : '—'}</td>
                      <td
                        class="n"
                        class:gain={(row.gain?.absolute ?? 0) > 0 && row.gain?.significant !== false}
                        class:loss={(row.gain?.absolute ?? 0) < 0 && row.gain?.significant !== false}
                      >
                        <!-- Row with measurement shows it; eliminated means search stopped refining, not no result; show number with pass stopped at and margin. -->
                        {#if !row.gain}
                          <span class="muted">{row.status === 'measured' ? '—' : row.status}</span>
                        {:else if row.gain.significant === false}
                          <span class="muted">tie</span>
                        {:else}
                          {fmtDelta(row.gain.absolute)}
                          {#if row.gain.percent !== null}
                            <span class="xs">({fmtDeltaPct(row.gain.percent)})</span>
                          {/if}
                          {#if row.gain.margin !== null}
                            <span class="xs muted">±{fmtInt(row.gain.margin)}</span>
                          {/if}
                        {/if}
                        {#if row.gain && row.status !== 'measured'}
                          <span class="xs muted" title="The search separated it from the leader here and stopped spending iterations on it">
                            {row.status === 'eliminated' && row.pass !== undefined ? `eliminated at pass ${row.pass + 1}` : row.status}
                          </span>
                        {/if}
                      </td>
                      <td class="n">
                        {row.gain?.margin !== null && row.gain?.margin !== undefined
                          ? fmtInt(row.gain.margin)
                          : '—'}
                      </td>
                      <td class="row-tight">
                        <button class="ghost sm" onclick={() => send(row.scenario, 'gear')}>Top Gear</button>
                        <button class="ghost sm" onclick={() => send(row.scenario, 'compare')}>Compare</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </details>

          {#if rows.some((r) => r.scenario.unchecked.length)}
            <details class="disclosure">
              <summary>Rules that could not be checked</summary>
              <ul class="xs muted">
                {#each [...new Set(rows.flatMap((r) => r.scenario.unchecked))] as u, i (i)}<li>{u}</li>{/each}
              </ul>
            </details>
          {/if}

          <details class="disclosure">
            <summary>How to read this</summary>
            <ul class="xs muted">
              <li>
                Each row is one item swapped into your current gear, measured in the same batch as
                the baseline. A tie means the difference is inside the error bars.
              </li>
              <li>
                No drop probability or source priority is shown: there is no documented drop rate
                to compute one from.
              </li>
              <li>
                This answers what one item is worth right now, not what to gear towards. An item
                that looks flat alone can complete a set; send it to Top Gear to see that.
              </li>
            </ul>
          </details>
        </section>
      </section>
    {/if}
  </div>
{/if}

<style>
  .run-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .next-step { display: inline-flex; align-items: center; gap: 7px; padding: 4px 0; min-height: 26px; border: 0; background: transparent; color: #dfbd73; font-size: 12px; font-weight: 500; }
  .next-step:hover { color: #ffe4a4; }
  .quest-marker { width: 6px; height: 6px; background: #e5bf67; transform: rotate(45deg); box-shadow: 0 0 7px #d8a93c70; flex: none; }
  .required-label { margin-left: 8px; color: #dfbd73; font-size: 11px; font-weight: 500; }
  .needs-choice { outline: 1px solid #c99b4b88; outline-offset: 4px; border-radius: var(--r2); animation: quest-glow 2.6s ease-in-out infinite; }
  input.needs-choice { border-color: #c99b4b; outline-offset: 2px; }
  input.needs-choice:focus-visible { animation: none; outline: 2px solid var(--accent); outline-offset: 3px; }
  @keyframes quest-glow { 0%, 100% { box-shadow: 0 0 5px 1px #c99b4b22; } 50% { box-shadow: 0 0 16px 2px #e6b94d40; } }
  @media (prefers-reduced-motion: reduce) { .needs-choice { animation: none; box-shadow: 0 0 8px #c99b4b25; } }
  :global([data-motion='reduced']) .needs-choice { animation: none; box-shadow: 0 0 8px #c99b4b25; }
  .work-summary { display: flex; flex-wrap: wrap; gap: 20px 48px; padding: 16px 20px; background: radial-gradient(30rem 8rem at 0% 0%, rgb(101 203 229 / 0.08), transparent 70%), var(--surface-2); border: 1px solid var(--border); border-radius: var(--r3); }
  .work-summary > div { display: flex; flex-direction: column; gap: 5px; }
  .work-summary strong { font-variant-numeric: tabular-nums; }
  .boss-picks { padding-top: 12px; gap: 12px 20px; }
  .tile-check { position: absolute; top: 8px; right: 8px; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); }
  .tile.on .tile-check { background: var(--grad); color: var(--text-on-accent); border-color: transparent; box-shadow: 0 0 12px var(--accent-glow); }
  .check { display: inline-flex; align-items: center; gap: var(--s2); }
  .check input { width: auto; }
  .search { max-width: 28rem; }
  .plain { margin: 0; padding-left: 1.1rem; }
  .self-start { align-self: flex-start; }
  .setup.collapsed header { margin-bottom: 0; }

  /* Instance tiles: journal's own art, desaturated until chosen so picked one is only thing in colour. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(11.5rem, 100%), 1fr));
    gap: var(--s2);
  }
  .tile {
    all: unset;
    box-sizing: border-box;
    position: relative;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 0.1rem;
    min-height: 5.4rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--r2);
    background: var(--surface-2);
    overflow: hidden;
    cursor: pointer;
    transition:
      transform 0.45s var(--spring),
      border-color 0.3s var(--ease),
      box-shadow 0.4s var(--ease);
  }
  /* Light sweep across the art on hover. */
  .tile::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 1;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 0.18) 50%, transparent 65%);
    translate: -120% 0;
    transition: translate 0.9s var(--ease);
    pointer-events: none;
  }
  .tile:hover::before { translate: 120% 0; }
  .tile img {
    position: absolute;
    inset: 0;
    z-index: -2;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: grayscale(0.9) brightness(0.8);
    transition: filter 0.5s var(--ease), transform 0.8s var(--ease);
  }
  .tile::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(to top, rgb(8 10 14 / 0.92) 8%, transparent 60%);
  }
  .tile:hover { transform: translateY(-3px); border-color: var(--accent-border); box-shadow: 0 16px 34px -18px var(--accent-glow); }
  .tile:hover img, .tile.on img { filter: grayscale(0) brightness(1); transform: scale(1.08); }
  .tile.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), 0 0 24px var(--accent-glow), inset 0 0 30px -10px var(--accent-glow);
  }
  .tile:focus-visible { box-shadow: var(--focus); }
  .tile-name {
    font-weight: 640;
    font-size: var(--fs-sm);
    line-height: 1.2;
    text-shadow: 0 1px 3px rgb(0 0 0 / 0.7);
  }
  .tile-meta { font-size: var(--fs-xs); color: var(--text-muted); }

  .picked {
    padding: var(--s3);
    border: 1px solid var(--accent-border);
    border-radius: var(--r2);
    background: color-mix(in oklab, var(--accent-soft) 45%, transparent);
  }
  .field.inline { flex-direction: row; align-items: center; gap: var(--s2); }
  .field.inline input { width: 7rem; }

  .drops { display: flex; flex-wrap: wrap; gap: 0.3rem; }
</style>
