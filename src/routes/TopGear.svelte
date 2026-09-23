<script lang="ts">
  // P08: per-slot selection, workload panel, results; candidate generation and search in src/lib/optimization.
  // the results. Candidate generation, legality, the staged search and its
  // retention statistics live in src/lib/optimization and are called, not reimplemented.
  import { onDestroy, tick } from 'svelte'
  import { slide } from 'svelte/transition'
  import { reducedMotion, ms } from '../lib/theme.svelte'
  import { savedTalentLoadouts } from '../lib/talents.svelte'
  import { withPlayerScopedLines } from '../lib/simc/options'
  import { applyWeeklyDefaults } from '../lib/simc/weekly-defaults'
  import { cancelActiveJob, engineBusy, loadPlayerDetail } from '../lib/simc/client'
  import { trace } from '../lib/trace'
  import { GEAR_SLOTS, SLOT_LABELS, PARSER_VERSION, parseAddonExport, type GearSlot, type ItemInstance, type ImportedCharacter } from '../lib/import/character'
  import { buildProfile } from '../lib/import/serialize'
  import { indistinguishable, iterationCeiling, recommendation, runAdaptiveSearch, type Selection, type WorkEstimate } from '../lib/optimization'
  import { compareCandidates, multiplicityFactor } from '../lib/optimization/statistics'
  import { STALL_TIMEOUT_MS, STALL_WARN_MS } from '../lib/searchPlan'
  import { planForTargetError } from '../lib/optimization'
  import type { OptimizationProgress, OptimizationResult } from '../lib/optimization/types'
  import { checkItemForSlot } from '../lib/catalog/legality'
  import { INVTYPE } from '../lib/catalog/enums'
  import type { GenerationReport } from '../lib/optimization/candidates'
  import {
    activeCharacter, activeStored, app, catalogClient, constraintsFor, ensureCatalog,
    engineIdentityString, isBusy, pollEngineSlot,
    maxThreads, planOptions, profilesetsSupported, saveReport, toast,
  } from '../lib/app.svelte'
  import { makeRunBatch } from '../lib/runBatch'
  import type { SimOutcome } from '../lib/simc/job'
  import type { PlayerDetail } from '../lib/simc/detail'
  import { searchSnapshot } from '../lib/store/report-share'
  import ShareReport from '../lib/ui/ShareReport.svelte'
  import SimulationDetails from '../lib/ui/SimulationDetails.svelte'
  import ItemLink from '../lib/ui/ItemLink.svelte'
  let shareOutcome = $state.raw<SimOutcome | null>(null)
  let baselineDetail = $state.raw<PlayerDetail | null>(null)
  $effect(() => {
    const outcome = shareOutcome
    if (searching || !result || setupOpen || !outcome?.report.players[0]) return
    baselineDetail = null
    let cancelled = false
    void loadPlayerDetail(outcome.getRawJson(), outcome.report.players[0].name)
      .then(detail => { if (!cancelled) baselineDetail = detail })
      .catch(() => {})
    return () => { cancelled = true }
  })
  import { markSettled, markStarted, run, teardownCancellation } from '../lib/job.svelte'
  import { sendSetup, takeHandoff } from '../lib/handoff.svelte'
  import {
    saveSelection, selectionFor, selectionStorageWorks, staleCount, gearDraftFor, rememberGearDraft,
  } from '../lib/selection.svelte'
  import RunStatus from '../lib/ui/RunStatus.svelte'
  import SimLog from '../lib/ui/SimLog.svelte'
  import CharacterBanner from '../lib/ui/CharacterBanner.svelte'
  import TalentPreview from '../lib/ui/TalentPreview.svelte'
  import { gearSettings } from '../lib/settings.svelte'
  import { display, resolveItem } from '../lib/items'
  import { fmtDelta, fmtDeltaPct, fmtInt, fmtSeconds, titleCase } from '../lib/format'
  import { href, navigate } from '../lib/router.svelte'
  import { newId } from '../lib/store/records'
  import { fractionOf, ProgressBuffer, type EngineProgress } from '../lib/ui/progress'
  import Banner from '../lib/ui/Banner.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import EnhancementPicker from '../lib/ui/EnhancementPicker.svelte'
  import ItemLine from '../lib/ui/ItemLine.svelte'
  import GearStrip from '../lib/ui/GearStrip.svelte'
  import ComparisonBars, { type ComparisonRow } from '../lib/ui/ComparisonBars.svelte'
  import ItemSearch from '../lib/ui/ItemSearch.svelte'
  import ItemUpgradePicker from '../lib/ui/ItemUpgradePicker.svelte'
  import { withMaxUpgrade } from '../lib/catalog/upgrades'
  import { serializeItem } from '../lib/catalog/serialize'
  import { classId } from '../lib/import/constraints'
  import { isHypothetical } from '../lib/hypothetical'
  import SettingsForm from '../lib/ui/SettingsForm.svelte'
  import { gearSettings as settings } from '../lib/settings.svelte'

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const busy = $derived(isBusy())
  const level = $derived(character?.level ?? 0)
  // Recover older imports without changing equipped gear or storage; predate Weekly Reward parsing.
  const importedVault = $derived((character && character.parserVersion < PARSER_VERSION
    ? parseAddonExport(character.raw).vault ?? character.vault ?? [] : character?.vault ?? [])
    .map((item) => ({ ...item, source: 'vault' as const, vaultRewardId: item.vaultRewardId ?? item.instanceId })))

  let selection = $state<Partial<Record<GearSlot, string[]>>>({})

  /** P08.15: Restore and save selection per character; check ids against current inventory; reparsed export can change ids. */
  const ownedIds = $derived(
    new Set([...(character?.equipped ?? []), ...(character?.bag ?? []), ...importedVault].map((i) => i.instanceId)),
  )
  /** Items from Droptimizer with source (P09.10). */
  let received = $state<{ name: string; source: string }[]>([])

  let restoredFor = $state<string | null>(null)
  $effect(() => {
    const id = stored?.id ?? null
    if (!id || restoredFor === id) return
    restoredFor = id
    const draft = gearDraftFor(id)
    added = draft?.added ?? {}
    selection = selectionFor(id, 'gear', new Set([...ownedIds, ...Object.values(added).flatMap((items) => (items ?? []).map((i) => i.instanceId))]))
    droppedFromStorage = staleCount(id, 'gear', ownedIds)
    gems = draft?.gems ?? {}
    enchants = draft?.enchants ?? {}
    consumables = draft?.consumables ?? {}
    embellishments = draft?.embellishments ?? {}
    requiredSets = draft?.requiredSets ?? []
    selectedLoadouts = draft?.selectedLoadouts ?? []
    result = null
    shareOutcome = null
    searchError = ''
  })
  let droppedFromStorage = $state(0)

  $effect(() => {
    const id = stored?.id
    if (!id || restoredFor !== id) return
    rememberGearDraft(id, $state.snapshot({ gems, enchants, consumables, embellishments, requiredSets, selectedLoadouts, added }))
  })

  $effect(() => {
    // Guard stops restore from immediately writing back; reading selection subscribes this.
    const snapshot = $state.snapshot(selection)
    const id = stored?.id ?? null
    if (!id || restoredFor !== id) return
    saveSelection(id, 'gear', snapshot)
  })

  /** P09.10: Items arrive as exact instances, merge into added/selected; taken after merge so failure keeps item. */
  $effect(() => {
    const id = stored?.id ?? null
    if (!id || restoredFor !== id) return
    const items = takeHandoff('gear', id)
    if (!items.length) return
    for (const h of items) {
      const list = added[h.slot] ?? []
      if (list.some((i) => i.instanceId === h.item.instanceId)) continue
      added[h.slot] = [...list, h.item]
      selection[h.slot] = [...new Set([...(selection[h.slot] ?? []), h.item.instanceId])]
    }
    received = [
      ...received,
      ...items.map((h) => ({
        name: display(h.item, app.resolved).name,
        source: h.source,
      })),
    ]
  })
  let selectedLoadouts = $state<string[]>([])
  let savedLoadouts = $state<{ name: string; talents: string }[]>([])
  $effect(() => { savedLoadouts = savedTalentLoadouts(stored?.id ?? null) })
  const loadoutOptions = $derived(character ? [
    ...character.loadouts,
    ...savedLoadouts,
  ].filter((l, i, all) => all.findIndex((other) => other.talents === l.talents) === i) : [])
  let gems = $state<Partial<Record<GearSlot, number[][]>>>({})
  let enchants = $state<Partial<Record<GearSlot, number[]>>>({})

  /** P08.2: Embellishment bonus ids per slot; slot applicability and count cap not in data, user-decided. */
  let embellishments = $state<Partial<Record<GearSlot, number[]>>>({})
  let embellishmentCatalog = $state<{ name: string; bonusId: number; spellId: number }[]>([])
  let embellishmentCap = $state({ enforce: false, limit: 2 })
  let embellishmentSlot = $state<GearSlot | null>(null)

  $effect(() => {
    const client = catalogClient()
    if (!client) { embellishmentCatalog = []; return }
    let cancelled = false
    void client.embellishments()
      .then((list) => { if (!cancelled) embellishmentCatalog = list })
      .catch(() => { if (!cancelled) embellishmentCatalog = [] })
    return () => { cancelled = true }
  })

  function toggleEmbellishment(slot: GearSlot, bonusId: number): void {
    const ids = embellishments[slot] ?? []
    const next = ids.includes(bonusId) ? ids.filter((i) => i !== bonusId) : [...ids, bonusId]
    if (next.length) embellishments[slot] = next
    else { delete embellishments[slot]; embellishments = { ...embellishments } }
  }
  let consumables = $state<Record<string, string[]>>({})
  let requiredSets = $state<{ setId: number; pieces: number }[]>([])
  /** Hand-added items not owned, kept per slot (P08.2). */
  let added = $state<Partial<Record<GearSlot, ItemInstance[]>>>({})
  let searchSlot = $state<GearSlot | null>(null)
  let searchAsVault = $state(false)
  let vaultSlot = $state<GearSlot>('head')
  const activeAdded = $derived(Object.values(added).flatMap((items) => items ?? [])
    .filter((item) => item.source !== 'vault' || importedVault.some((reward) => reward.vaultRewardId === item.vaultRewardId)))
  const vaultItems = $derived([...importedVault, ...activeAdded.filter((item) => !!item.vaultRewardId)])
  $effect(() => {
    const client = catalogClient()
    const extra = [...importedVault, ...activeAdded]
    const playerLevel = level
    if (!client || !extra.length) return
    let cancelled = false
    void client.resolve($state.snapshot(extra), playerLevel).then(({ items }) => {
      if (!cancelled) app.resolved = new Map([...app.resolved, ...items])
    }).catch(() => {})
    return () => { cancelled = true }
  })
  let collapsedSlots = $state<GearSlot[]>([])
  let itemFilter = $state('')
  let result = $state<(OptimizationResult & { generation?: GenerationReport }) | null>(null)
  let setupOpen = $state(false)
  let resultHeading: HTMLHeadingElement | undefined = $state()
  let resultExtraLines = $state<string[]>([])
  let resultSettings = $state(gearSettings.snapshot())
  let resultCharacter = $state<ImportedCharacter | null>(null)
  let lastSearch = $state.raw<{
    selection: Selection
    options: NonNullable<typeof workerOptions>
    plan: ReturnType<typeof planForTargetError>
    character: ImportedCharacter
    characterId: string | null
    label: string
    loadouts: { name: string; talents: string }[]
    settings: ReturnType<typeof gearSettings.snapshot>
    extraLines: string[]
  } | null>(null)
  let progress = $state<OptimizationProgress | null>(null)
  let searchError = $state('')
  let cancelSearch: (() => void) | null = null
  let logBuffer = new ProgressBuffer()
  let engineLog = $state<string[]>([])
  /** The engine's own iteration counter for the batch in flight. */
  let engineProgress = $state<EngineProgress | null>(null)
  /** One source of truth for "a search is running", shared by button and panel. */
  let searching = $state(false)
  $effect(() => {
    if (searching || !result) return
    setupOpen = false
  })
  $effect(() => {
    if (searching || !result || setupOpen) return
    void tick().then(() => {
      resultHeading?.focus({ preventScroll: true })
      resultHeading?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'instant' : 'smooth' })
    })
  })
  let stalledSince = $state(0)
  let now = $state(Date.now())

  const derivation = $derived(character ? constraintsFor(character) : null)

  /** The search ladder; accuracy field maps to plan via planForTargetError, versioned with optimization track. */
  const stagePlan = $derived(planForTargetError(gearSettings.targetError))

  /** Progress within current stage; whole run not current pass; samplesSpent/Remaining re-derived after each pass. */
  function runFractionOf(p: OptimizationProgress): number {
    const spent = p.samplesSpent ?? 0
    const remaining = p.estimatedSamplesRemaining ?? 0
    const total = spent + remaining
    const inPass = fractionOf(engineProgress)
      ?? (p.candidatesInBatch ? (p.candidatesDoneInBatch ?? 0) / p.candidatesInBatch : 0)
    if (total <= 0) return Math.min(1, (p.batchIndex + inPass) / Math.max(1, p.batchCount))
    return Math.min(1, (spent + remaining * inPass) / total)
  }
  /** Monotone: each pass re-estimates; larger estimate doesn't walk ring backwards. */
  let runFraction = $state(0)
  const stageFraction = $derived(
    progress ? Math.max(runFraction, runFractionOf(progress)) : undefined,
  )

  const stalledMs = $derived(stalledSince ? now - stalledSince : 0)
  const stalledSeconds = $derived(stalledMs / 1000)
  /** Armed only when engine speaks; simc CR-terminates progress updates by default, emscripten fires per NEWLINE so updates never reach app. */
  let heardFromEngine = $state(false)
  const stalled = $derived(
    searching && heardFromEngine && stalledSince > 0 && stalledMs > STALL_WARN_MS,
  )

  const STALL_MESSAGE =
    'The engine produced no output for a long time, so the search was asked to stop. '
    + 'The most likely cause is the engine running out of memory: one run needs on the order '
    + 'of two gigabytes whatever the precision, and a browser tab does not always have it. '
    + 'That is a suspicion, not a diagnosis — the browser does not tell a page why a worker '
    + 'died. Any completed stage is shown below. Fewer threads is the setting most likely to '
    + 'help; a looser accuracy target will not.'

  /** Set when watchdog aborted; explains search ending. */
  let abandoned = $state(false)
  /** Job id of search this screen started, while it owns it. */
  let ownedJobId: string | null = null

  /** Watchdog: engine worker can die mid-stage without settling promise; aborts propagate through runBatch, search settles itself. */
  $effect(() => {
    if (!searching) return
    const t = setInterval(() => {
      now = Date.now()
      if (!abandoned && heardFromEngine && stalledSince && now - stalledSince > STALL_TIMEOUT_MS) {
        abandoned = true
        cancelSearch?.()
      }
    }, 1000)
    return () => clearInterval(t)
  })

  /** Set bonuses character already wears pieces of (P08.3). */
  let wearableSets = $state<{ setId: number; owned: number; name: string; tiers: number[] }[]>([])
  $effect(() => {
    const client = catalogClient()
    if (!client || !character) { wearableSets = []; return }
    const counts = new Map<number, number>()
    for (const item of character.equipped) {
      const r = resolveItem(item, app.resolved)
      if (r?.setId) counts.set(r.setId, (counts.get(r.setId) ?? 0) + 1)
    }
    let cancelled = false
    void Promise.all(
      [...counts.entries()].map(async ([setId, owned]) => {
        const bonuses = await client.setBonuses(setId)
        if (!bonuses.length) return null
        return {
          setId, owned, name: bonuses[0].name,
          tiers: [...new Set(bonuses.map((b) => b.pieces))].sort((a, b) => a - b),
        }
      }),
    )
      .then((rows) => {
        if (!cancelled) wearableSets = rows.filter((r): r is NonNullable<typeof r> => !!r)
      })
      .catch(() => { if (!cancelled) wearableSets = [] })
    return () => { cancelled = true }
  })

  function toggleSet(setId: number, pieces: number): void {
    const has = requiredSets.some((r) => r.setId === setId && r.pieces === pieces)
    requiredSets = has
      ? requiredSets.filter((r) => !(r.setId === setId && r.pieces === pieces))
      : [...requiredSets.filter((r) => r.setId !== setId), { setId, pieces }]
  }

  const equippedBySlot = $derived(
    new Map<GearSlot, ItemInstance>((character?.equipped ?? []).map((i) => [i.slot, i])),
  )

  /** Everything character owns that catalog says can fill each slot. */
  const optionsBySlot = $derived.by(() => {
    const m = new Map<GearSlot, ItemInstance[]>()
    if (!character) return m
    const pool = [...character.equipped, ...character.bag, ...importedVault, ...activeAdded]
    for (const slot of GEAR_SLOTS) {
      const list: ItemInstance[] = []
      for (const item of pool) {
        const resolved = resolveItem(item, app.resolved)
        if (resolved) {
          if (!resolved.eligibleSlots.includes(slot) && !(slot === 'off_hand' && resolved.inventoryType === INVTYPE.TWOHAND && derivation?.constraints.canTitansGrip)) continue
          if (derivation) {
            const issues = checkItemForSlot(resolved, slot, derivation.constraints)
            if (issues.some((i) => !i.advisory)) continue
          }
        } else if (item.slot !== slot) {
          // Without catalog, fall back to recorded slot.
          const pairs: Record<string, string[]> = {
            finger1: ['finger1', 'finger2'], finger2: ['finger1', 'finger2'],
            trinket1: ['trinket1', 'trinket2'], trinket2: ['trinket1', 'trinket2'],
          }
          if (!(pairs[item.slot] ?? [item.slot]).includes(slot)) continue
        }
        list.push(item)
      }
      if (list.length) m.set(slot, list)
    }
    return m
  })

  const instanceById = $derived.by(() => {
    const m = new Map<string, ItemInstance>()
    for (const item of [
      ...(character?.equipped ?? []),
      ...(character?.bag ?? []),
      ...importedVault,
      ...activeAdded,
    ]) {
      m.set(item.instanceId, item)
    }
    return m
  })

  function groupSlots(slot: GearSlot): GearSlot[] {
    if (slot === 'finger1' || slot === 'finger2') return ['finger1', 'finger2']
    if (slot === 'trinket1' || slot === 'trinket2') return ['trinket1', 'trinket2']
    if (slot === 'main_hand' || slot === 'off_hand') return ['main_hand', 'off_hand']
    return [slot]
  }
  const gearGroups = $derived(GEAR_SLOTS.filter((s) => !['finger2', 'trinket2', 'shirt', 'tabard', 'off_hand'].includes(s))
    .map((slot) => ({
      slot,
      label: slot === 'finger1' ? 'Rings' : slot === 'trinket1' ? 'Trinkets' : slot === 'main_hand' ? 'Weapons' : SLOT_LABELS[slot],
      items: [...new Map(groupSlots(slot).flatMap((s) => optionsBySlot.get(s) ?? []).filter((item) => !item.vaultRewardId).map((i) => [i.instanceId, i])).values()],
    })))
  function chosenIds(slot: GearSlot): string[] {
    return [...new Set(groupSlots(slot).flatMap((s) => selection[s] ?? []))].filter((id) => instanceById.has(id))
  }

  function originalItem(item: ItemInstance): ItemInstance {
    return item.originalInstanceId ? instanceById.get(item.originalInstanceId) ?? item : item
  }

  function changeItemVersion(item: ItemInstance, next: ItemInstance): void {
    if (item.instanceId === next.instanceId) return
    // Updating an existing variant replaces it; the original owned/Vault item
    // stays available so the baseline always remains the actual equipped set.
    if (item.originalInstanceId && item.instanceId !== item.originalInstanceId) {
      for (const slot of GEAR_SLOTS) {
        if (added[slot]) added[slot] = added[slot]!.filter((value) => value.instanceId !== item.instanceId)
        if (selection[slot]) selection[slot] = selection[slot]!.filter((id) => id !== item.instanceId)
      }
    }
    addItemVersion(next)
  }

  function addItemVersion(next: ItemInstance): void {
    const physicalId = next.originalInstanceId ?? next.instanceId
    const serialized = serializeItem(next)
    next = [...instanceById.values()].find((item) => (item.originalInstanceId ?? item.instanceId) === physicalId && serializeItem(item) === serialized) ?? next
    if (!instanceById.has(next.instanceId)) added[next.slot] = [...(added[next.slot] ?? []), next]
    const slot = groupSlots(next.slot)[0]
    selection[slot] = [...new Set([...(selection[slot] ?? []), next.instanceId])]
  }

  function upgradeVaultToMax(items: ItemInstance[]): void {
    for (const item of items) {
      const upgraded = withMaxUpgrade(item)
      if (upgraded) addItemVersion(upgraded)
    }
  }

  function selectVault(select: boolean): void {
    if (!select) {
      const rewards = new Set(vaultItems.map((item) => item.instanceId))
      for (const slot of GEAR_SLOTS) if (selection[slot]) selection[slot] = selection[slot]!.filter((id) => !rewards.has(id))
      return
    }
    for (const item of vaultItems) {
      const slot = groupSlots(item.slot)[0]
      selection[slot] = [...new Set([...(selection[slot] ?? []), item.instanceId])]
    }
  }
  const enhancementItems = $derived([...new Map([
    ...(character?.equipped ?? []),
    ...Object.values(selection).flatMap((ids) => (ids ?? []).flatMap((id) => instanceById.get(id) ?? [])),
  ].map((item) => [item.instanceId, item])).values()])

  const baselineGear = $derived(
    new Map<GearSlot, ItemInstance | null>(
      GEAR_SLOTS.map((slot) => [slot, equippedBySlot.get(slot) ?? null]),
    ),
  )

  /** Selection as optimizer wants it; baseline always included. */
  const effectiveSelection = $derived.by<Selection>(() => {
    const slots: Partial<Record<GearSlot, ItemInstance[]>> = {}
    for (const [slot, ids] of Object.entries(selection) as [GearSlot, string[]][]) {
      if (!ids?.length) continue
      const items = ids.map((id) => instanceById.get(id)).filter((i): i is ItemInstance => !!i)
      const current = equippedBySlot.get(slot)
      const withBaseline =
        current && !items.some((i) => i.instanceId === current.instanceId)
          ? [current, ...items]
          : items
      if (withBaseline.length) slots[slot] = withBaseline
    }
    for (const first of ['finger1', 'trinket1', 'main_hand'] as const) {
      const pair = groupSlots(first)
      const ids = chosenIds(first)
      if (!ids.length) continue
      const pool = [...new Map([
        ...pair.flatMap((s) => equippedBySlot.get(s) ?? []),
        ...ids.flatMap((id) => instanceById.get(id) ?? []),
      ].map((item) => [item.instanceId, item])).values()]
      for (const slot of pair) slots[slot] = first === 'main_hand'
        ? pool.filter(item => (optionsBySlot.get(slot) ?? []).some(option => option.instanceId === item.instanceId))
        : pool
    }
    const loadouts = selectedLoadouts.length && character
      ? [character.talents ?? '', ...selectedLoadouts].filter(Boolean)
      : undefined
    return {
      slots,
      loadouts,
      gems: Object.keys(gems).length ? gems : undefined,
      enchants: Object.keys(enchants).length ? enchants : undefined,
      embellishments: Object.keys(embellishments).length ? embellishments : undefined,
      consumables: Object.keys(consumables).length ? consumables : undefined,
      requiredSets: requiredSets.length ? requiredSets : undefined,
    }
  })

  /** Plan options for catalog worker's structured-clone boundary. */
  const workerOptions = $derived(
    character && app.catalogState === 'ready'
      ? {
          ...planOptions(character, [...baselineGear.entries()], {
            embellishmentLimit: embellishmentCap.enforce ? embellishmentCap.limit : undefined,
          }),
          plan: stagePlan,
        }
      : null,
  )

  // Estimate computed in catalog worker beside item table; 15 MB payload never parsed on main thread.
  let estimate = $state<WorkEstimate | null>(null)
  $effect(() => {
    const client = catalogClient()
    const opts = workerOptions
    const selectionSnapshot = effectiveSelection
    if (!client || !opts) { estimate = null; return }
    let cancelled = false
    // Debounced: fires on every item click.
    const t = setTimeout(() => {
      client.estimateWork(selectionSnapshot, opts)
        .then((e) => { if (!cancelled) estimate = e })
        .catch(() => { if (!cancelled) estimate = null })
    }, 120)
    return () => { cancelled = true; clearTimeout(t) }
  })

  const selectedCount = $derived(
    new Set(Object.values(selection).flatMap((ids) => ids ?? []).filter((id) => instanceById.has(id))).size +
      Object.values(gems).reduce((n, l) => n + (l?.length ?? 0), 0) +
      Object.values(enchants).reduce((n, l) => n + (l?.length ?? 0), 0) +
      Object.values(embellishments).reduce((n, l) => n + (l?.length ?? 0), 0) +
      Object.values(consumables).reduce((n, l) => n + (l?.length ?? 0), 0) +
      selectedLoadouts.length,
  )

  /** Iterations per second for one candidate at thread count; placeholder until engine track measures; labelled estimate. */
  const ITERATIONS_PER_SECOND = 275

  /** Seconds for one candidate at given precision; target-error stage hits ceiling or converges; finalist ceiling 200k iterations. */
  function stageSeconds(accuracy: { mode: string; iterations?: number; maxIterations?: number }): number {
    const iterations = accuracy.mode === 'iterations'
      ? (accuracy.iterations ?? 0)
      : (accuracy.maxIterations ?? 0)
    return iterations / ITERATIONS_PER_SECOND
  }

  const plannedStages = $derived(
    (estimate?.stages ?? []).map((row, i) => ({
      ...row,
      worstSeconds: stagePlan.stages[i]
        ? row.candidates * stageSeconds(stagePlan.stages[i].accuracy)
        : undefined,
    })),
  )
  const worstTotalSeconds = $derived(
    plannedStages.reduce((n, s) => n + (s.worstSeconds ?? 0), 0),
  )

  function toggle(slot: GearSlot, item: ItemInstance): void {
    const ids = chosenIds(slot)
    const next = ids.includes(item.instanceId)
      ? ids.filter((i) => i !== item.instanceId)
      : [...ids, item.instanceId]
    for (const s of groupSlots(slot)) delete selection[s]
    if (next.length) selection[groupSlots(slot)[0]] = next
    selection = { ...selection }
  }

  function selectAll(slot: GearSlot): void {
    clearSlot(slot)
    selection[groupSlots(slot)[0]] = gearGroups.find((g) => g.slot === slot)?.items.map((i) => i.instanceId) ?? []
  }

  function clearSlot(slot: GearSlot): void {
    for (const s of groupSlots(slot)) delete selection[s]
    selection = { ...selection }
  }

  async function go(repeat = false): Promise<void> {
    if ((!character && !lastSearch) || isBusy()) return
    // Nothing before try may reject; failure here used to abort silently leaving button broken.
    let client: Awaited<ReturnType<typeof ensureCatalog>> = null
    try {
      client = await ensureCatalog()
    } catch (err) {
      searchError = `Game data could not be loaded: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    const opts = repeat ? lastSearch?.options : workerOptions
    if (!client || !opts) {
      searchError = 'Game data is required for a gear search, and it is not loaded.'
      return
    }

    let setup: NonNullable<typeof lastSearch>
    try {
      setup = repeat && lastSearch ? lastSearch : $state.snapshot({
        selection: effectiveSelection,
        options: opts,
        plan: stagePlan,
        character: character!,
        characterId: stored?.id ?? null,
        label: stored?.label ?? character!.name,
        loadouts: loadoutOptions,
        settings: gearSettings.snapshot(),
        extraLines: gearSettings.extraProfileLines() ?? [],
      })
    } catch (err) {
      searchError = err instanceof Error ? err.message : String(err)
      return
    }
    lastSearch = setup
    searchError = ''
    result = null
    shareOutcome = null
    resultExtraLines = setup.extraLines
    resultSettings = setup.settings
    resultCharacter = setup.character
    const runSelection = setup.selection
    progress = null
    runFraction = 0
    logBuffer = new ProgressBuffer()
    engineLog = []
    engineProgress = null
    searching = true
    abandoned = false
    heardFromEngine = false
    stalledSince = Date.now()
    run.outcome = null
    run.error = null

    const jobId = newId()
    ownedJobId = jobId
    trace('search.start', { jobId })
    // A search is the longest-running job in the app and so the likeliest to be
    // killed by a reload. Without this marker that ending is completely silent.
    markStarted({ tool: 'gear', title: `${setup.label} — Top Gear`, startedAt: Date.now() })
    app.job = {
      id: jobId, tool: 'gear', title: `${setup.label} — Top Gear`,
      status: 'validating', startedAt: Date.now(),
    }

    // Candidate generation runs in the catalog worker; execution stays here,
    // because runJob owns the engine worker.
    const controller = new AbortController()
    cancelSearch = () => controller.abort()

    try {
      const plan = await client.planTopGear(runSelection, opts)
      if (!plan) {
        trace('search.exit', { where: 'no-plan' })
        searchError = 'Game data is required for a gear search, and the catalog did not answer.'
        return
      }
      if (app.job?.id !== jobId) { trace('search.exit', { where: 'job-replaced-pre-search' }); return }

      // Ladder gone: search races spending precision where answer in doubt, ends with verification; setup.plan supplies retention and final precision.
      const finalStage = setup.plan.stages[setup.plan.stages.length - 1]
      const r = await runAdaptiveSearch(
        plan.candidates,
        {
          profile: buildProfile(resultCharacter),
          catalogId: plan.catalogId,
          // Without this result cache never warms; engine identity arrives after first batch, too late; runner warns per batch.
          engineIdentity: engineIdentityString(),
          runBatch: makeRunBatch({
            onOutcome: value => shareOutcome = value,
            settings: {
              fightStyle: resultSettings.fightStyle,
              maxTime: resultSettings.maxTime,
              targets: resultSettings.targets,
              threads: Math.min(resultSettings.threads, maxThreads()),
            },
            extraProfileLines: $state.snapshot(resultExtraLines),
            buffer: logBuffer,
            onEvent: () => { engineLog = [...logBuffer.lines] },
          }),
          onProgress: (p) => {
            progress = p
            // Floor moves only on progress event; derived can add engine iteration signal without writing back into input.
            runFraction = Math.max(runFraction, runFractionOf(p))
            if (app.job?.id === jobId) {
              app.job.stage = { index: p.stageIndex + 1, total: p.stageCount, label: p.stageLabel }
              app.job.status = 'running'
            }
          },
        },
        {
          targetError: finalStage.accuracy.mode === 'targetError' ? finalStage.accuracy.targetError : setup.settings.targetError,
          maxIterations: iterationCeiling(finalStage.accuracy),
          minIterations: setup.plan.minIterations,
          retentionFactor: setup.plan.retentionFactor,
          correctForMultipleComparisons: setup.plan.correctForMultipleComparisons,
        },
        controller.signal,
      )
      if (app.job?.id !== jobId) { trace('search.exit', { where: 'job-replaced-post-search' }); return }
      trace('search.returned', { incomplete: r.incomplete?.reason ?? null, candidates: r.candidates.length })
      // Generation notes belong with the result: a capped search is not exhaustive.
      const warnings = [...r.warnings]
      if (plan.report.capped) {
        warnings.push(
          `generation stopped at the candidate cap; the selection describes at least ${plan.report.upperBound} combinations, so this search is not exhaustive`,
        )
      }
      if (plan.report.rejectedIllegal) {
        warnings.push(`${plan.report.rejectedIllegal} combinations were rejected as illegal before reaching the engine`)
      }
      result = { ...r, warnings, generation: plan.report }
      app.job.status = r.incomplete ? 'error' : 'complete'

      // Saving must not discard finished search; measurements cost minutes and already on screen; TypeError or full disk not a reason to fail.
      try {
        const rec = recommendation(r)
        // Winner not baseline: history row leads with chosen setup; baseline recoverable as dps - delta from topCandidates.
        const winner = rec.measured && rec.winner
          ? r.candidates.find((s) => s.candidate.id === rec.winner!.id)?.measurement ?? null
          : null
        await saveReport({
          tool: 'gear',
          title: app.job.title,
          completion: r.incomplete ? 'partial' : 'complete',
          requestSnapshot: { selection: runSelection, settings: resultSettings },
          summary: {
            dps: winner?.mean ?? r.baseline?.mean,
            confidenceMargin: winner?.margin ?? undefined,
            confidenceLevel: winner?.confidence ?? undefined,
            actualIterations: winner?.iterations,
            candidateCount: r.candidates.length,
            topCandidates: r.candidates
              .filter((s) => s.measurement)
              .slice(0, 5)
              .map((s) => ({
                id: s.candidate.id,
                label: s.candidate.provenance.label,
                mean: s.measurement!.mean,
                delta: s.measurement!.mean - (r.baseline?.mean ?? 0),
              })),
            warnings: r.warnings.length ? r.warnings : undefined,
          },
        })
        if (rec.measured && rec.keepCurrent) toast('info', rec.reason)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        trace('search.save-failed', { message })
        result = {
          ...result,
          warnings: [...warnings, `the result could not be saved to history: ${message}. The measurements below are unaffected.`],
        }
      }
    } catch (err) {
      if (app.job?.id !== jobId) { trace('search.exit', { where: 'job-replaced-in-catch' }); return }
      trace('search.threw', { message: err instanceof Error ? err.message : String(err) })
      const cancelled = err instanceof DOMException && err.name === 'AbortError'
      app.job.status = cancelled ? 'cancelled' : 'error'
      searchError = abandoned
        ? STALL_MESSAGE
        : cancelled
          ? 'Search cancelled. Any completed stage is shown below.'
          : err instanceof Error ? err.message : String(err)
    } finally {
      trace('search.finally', {
        result: !!result, error: !!searchError, abandoned,
        job: app.job?.status ?? null, engineBusy: engineBusy(),
      })
      // Unconditional. On the normal path the job has already settled and this
      // is a no-op; on any early return it is the only thing that stops an
      // engine the screen has stopped watching. `runStagedSearch` can reject a
      // batch on its own timeout without aborting the work behind it, so
      // returning from here is NOT proof the engine stopped.
      controller.abort()
      markSettled()
      cancelSearch = null
      searching = false
      engineProgress = null
      // Classify before record; watchdog abort comes as partial result not rejection, explanation outside catch only.
      if (abandoned && !searchError) searchError = STALL_MESSAGE
      // No result and no error leaves blank screen and enabled button; every path out leaves terminal state.
      if (!result && !searchError) {
        // Search ended, produced nothing, not why; path also reached when job replaced or plan empty; memory one possibility not cause.
        searchError =
          'The search ended without producing a result, and Frostsim does not know why — '
          + 'nothing reported an error. If the engine was still running when the screen went '
          + 'quiet, the browser shutting it down is one possibility: one run needs on the order '
          + 'of two gigabytes whatever the settings, so closing other tabs and running one '
          + 'simulation at a time is worth trying. Nothing was saved.'
      }
      // Settle job record on every path; leaving at 'running' keeps isBusy() true and beforeunload warns about ended search.
      if (app.job?.id === jobId && !['complete', 'error', 'cancelled'].includes(app.job.status)) {
        app.job.status = result && !result.incomplete && !searchError ? 'complete' : 'error'
      }
      if (ownedJobId === jobId) ownedJobId = null
      pollEngineSlot()
    }
  }


  /** Search belongs to screen: progress, cancel, result all here; outliving screen means invisible and unstopped; teardown ends run. */
  onDestroy(() => {
    // Decisive reading: fires while searching=true means screen replaced under live search; that is the bug.
    trace('topgear.destroy', {
      searching, owned: ownedJobId, job: app.job?.id ?? null, engineBusy: engineBusy(),
    })
    const what = teardownCancellation({
      running: searching, ownedJobId, activeJobId: app.job?.id, engineBusy: engineBusy(),
    })
    if (what.abort) cancelSearch?.()
    if (what.forceCancel) cancelActiveJob('the screen running this search was closed')
  })

  /** P08.14: Re-measure finalists at user precision; escape hatch when ladder at 0.2% leaves candidates unresolved; reuses same run flow. */
  let verifyTarget = $state(0.05)
  let verifying = $state(false)

  const finalists = $derived(
    (result?.candidates ?? [])
      .filter((s) => s.status === 'measured' && s.measurement && Number.isFinite(s.measurement.mean) && !result?.droppedWhileAlive.includes(s.candidate.id))
      .map((s) => s.candidate),
  )

  async function verify(): Promise<void> {
    if (!character || !result || !finalists.length || isBusy()) return
    const client = catalogClient()
    if (!client) {
      searchError = 'Game data is required to re-measure, and it is not loaded.'
      return
    }
    const jobId = newId()
    ownedJobId = jobId
    runFraction = 0
    verifying = true
    searching = true
    searchError = ''
    abandoned = false
    heardFromEngine = false
    stalledSince = Date.now()
    logBuffer = new ProgressBuffer()
    engineLog = []
    markStarted({ tool: 'gear', title: `${stored?.label ?? character.name} — verify finalists`, startedAt: Date.now() })
    app.job = {
      id: jobId, tool: 'gear', title: `${stored?.label ?? character.name} — verify finalists`,
      status: 'validating', startedAt: Date.now(),
    }
    // Screen used to hand-roll this; now part of adaptive runner in verifyOnly mode; button exists for user-chosen precision tighter than final.
    const controller = new AbortController()
    const handle = {
      cancel: () => controller.abort(),
      result: runAdaptiveSearch(
        finalists,
        {
          profile: buildProfile(resultCharacter ?? character),
          catalogId: catalogIdOf(),
          engineIdentity: engineIdentityString(),
          runBatch: makeRunBatch({
            onOutcome: value => shareOutcome = value,
            settings: {
              fightStyle: resultSettings.fightStyle,
              maxTime: resultSettings.maxTime,
              targets: resultSettings.targets,
              threads: Math.min(resultSettings.threads, maxThreads()),
            },
            extraProfileLines: $state.snapshot(resultExtraLines),
            buffer: logBuffer,
            onEvent: () => { engineLog = [...logBuffer.lines] },
          }),
          onProgress: (p) => {
            progress = p
            // Floor moves only on progress event; derived can add engine iteration signal without writing back into input.
            runFraction = Math.max(runFraction, runFractionOf(p))
            if (app.job?.id === jobId) {
              app.job.stage = { index: p.stageIndex + 1, total: p.stageCount, label: p.stageLabel }
              app.job.status = 'running'
            }
          },
        },
        { targetError: verifyTarget, verifyTargetError: verifyTarget, maxIterations: 200_000, verifyOnly: true, minIterations: 0 },
        controller.signal,
      ),
    }
    cancelSearch = () => handle.cancel()
    try {
      const verified = await handle.result
      if (app.job?.id !== jobId) return
      // Verification replaces ranking as strictly better measurement of same candidates; warnings carry precision.
      result = {
        ...verified,
        warnings: [
          `these numbers come from a verification run at ${(verifyTarget).toFixed(2)}% target error, not from the staged search`,
          ...verified.warnings,
        ],
        generation: result.generation,
      }
      app.job.status = 'complete'
    } catch (err) {
      if (app.job?.id !== jobId) return
      const cancelled = err instanceof DOMException && err.name === 'AbortError'
      app.job.status = cancelled ? 'cancelled' : 'error'
      searchError = cancelled
        ? 'Verification cancelled. The previous ranking is unchanged.'
        : `The verification run failed: ${err instanceof Error ? err.message : String(err)}. The previous ranking is unchanged.`
    } finally {
      markSettled()
      cancelSearch = null
      verifying = false
      searching = false
      engineProgress = null
      if (app.job?.id === jobId && !['complete', 'error', 'cancelled'].includes(app.job.status)) {
        app.job.status = searchError ? 'error' : 'complete'
      }
      if (ownedJobId === jobId) ownedJobId = null
      pollEngineSlot()
    }
  }

  /** P08.14: Export setup as profile with candidate delta; file describes measured setup, serializer round-trips unmoldeled data. */
  function exportSetup(state: (typeof measured)[number]): void {
    if (!character) return
    const items = Object.fromEntries(state.candidate.delta.gear?.entries() ?? []) as
      Partial<Record<GearSlot, ItemInstance | null>>
    const profile = applyWeeklyDefaults(buildProfile(resultCharacter ?? character, {
      items,
      talents: state.candidate.delta.talents,
      append: withPlayerScopedLines(resultExtraLines,
        Object.entries(state.candidate.delta.consumables ?? {}).map(([key, value]) => `${key}=${value}`)),
    }))
    const label = state.candidate.id === 'baseline' ? 'current-gear' : changesOf(state)
    const name = `${lastSearch?.label ?? character.name}-${label}`
      .replace(/[^\w-]+/g, '-').toLowerCase().slice(0, 80)
    const blob = new Blob([profile], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.simc`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url))
    // "Started" not "saved": page cannot see if browser wrote file.
    toast('info', 'Download started. The file is a SimulationCraft profile.')
  }

  /** Open setup in Quick Sim for detailed run; pass candidate delta not serialized profile to preserve item options. */
  function openInQuickSim(state: (typeof measured)[number]): void {
    if (!resultCharacter) return
    app.draft = $state.snapshot(resultCharacter)
    app.activeCharacterId = null
    sendSetup({
      characterId: null,
      label: state.candidate.id === 'baseline' ? 'your current gear' : changesOf(state),
      items: Object.fromEntries(state.candidate.delta.gear?.entries() ?? []) as
        Partial<Record<GearSlot, ItemInstance | null>>,
      talents: state.candidate.delta.talents ?? resultCharacter.talents,
      settings: { ...resultSettings, loadoutName: null },
      consumables: state.candidate.delta.consumables,
      extraProfileLines: resultExtraLines,
      searchMean: state.measurement?.mean,
      baselineMean: result?.baseline?.mean,
    })
    navigate('quick')
  }

  function catalogIdOf(): string {
    return app.catalogManifest?.catalogId ?? ''
  }

  const measured = $derived(
    (result?.candidates ?? []).filter((s) => s.status === 'measured' && s.measurement && Number.isFinite(s.measurement.mean) && !result?.droppedWhileAlive.includes(s.candidate.id)),
  )
  /** Every combination engine ran, eliminated included; measured is survivors; header says simulated, elimination reported per row. */
  const simulated = $derived(
    (result?.candidates ?? []).filter((s) => s.candidate.id !== 'baseline' && s.measurement && Number.isFinite(s.measurement.mean)),
  )
  const rec = $derived(result ? recommendation(result) : null)
  const baselineMean = $derived(result?.baseline?.mean ?? 0)
  const ownedBest = $derived(measured.find((state) => state.status === 'measured'
    && !state.candidate.provenance.vaultRewardId && !result?.droppedWhileAlive.includes(state.candidate.id)))
  const vaultComparisons = $derived.by<ComparisonRow[]>(() => {
    if (!result || !lastSearch) return []
    const rewards = new Map(Object.values(lastSearch.selection.slots).flatMap((items) => items ?? [])
      .filter((item) => item.vaultRewardId).map((item) => [item.vaultRewardId!, item]))
    return [...rewards].map(([id, reward]) => {
      const best = measured.find((state) => state.status === 'measured'
        && state.candidate.provenance.vaultRewardId === id && !result!.droppedWhileAlive.includes(state.candidate.id))
      const item = best?.candidate.provenance.vaultItem ?? [...(best?.candidate.delta.gear?.values() ?? [])].find((item) => item?.vaultRewardId === id) ?? reward
      const m = best?.measurement
      const factor = lastSearch!.plan.retentionFactor * (lastSearch!.plan.correctForMultipleComparisons === false ? 1
        : multiplicityFactor(measured.length - 1, m?.confidence ?? 0.95, Math.max(1, lastSearch!.plan.stages.length - 1)))
      const verdict = m && ownedBest?.measurement && Math.min(m.iterations, ownedBest.measurement.iterations) >= lastSearch!.plan.minIterations
        ? compareCandidates(m, ownedBest.measurement, factor) : 'unknown'
      return {
        id, label: display(item as ItemInstance, app.resolved).name,
        item: best?.candidate.provenance.items.find((resolved) => resolved.instanceId === item.instanceId && resolved.slot === item.slot) ?? resolveItem(item as ItemInstance, app.resolved) ?? undefined,
        resolvedItems: best?.candidate.provenance.items,
        mean: m?.mean, margin: m?.margin ?? undefined, iterations: m?.iterations,
        indistinguishable: verdict === 'unknown' ? undefined : verdict === 'indistinguishable',
        icons: [item as ItemInstance], changedSlots: [item.slot],
        hypothetical: isHypothetical(item as ItemInstance),
        detail: result!.incomplete ? 'Partial search — best measured combination' : 'Best measured combination with this reward',
        status: m ? best!.status : 'No measured setup for this reward',
      }
    })
  })

  function deltaOf(mean: number): number {
    return mean - baselineMean
  }

  const bars = $derived<ComparisonRow[]>(
    (result?.candidates ?? [])
      .filter((state) => state.candidate.id !== 'baseline')
      .map((state) => {
        const m = state.measurement
        const usable = m && Number.isFinite(m.mean)
        return {
          id: state.candidate.id,
          label: state.candidate.id === 'baseline' ? 'Current gear' : changesOf(state),
          mean: usable ? m.mean : undefined,
          margin: usable ? (m.margin ?? undefined) : undefined,
          iterations: usable ? m.iterations : undefined,
          // Three states, not two: in the tie group, separated from it, or no error
          // estimate at all. `|| undefined` turned "separated" into "untested".
          indistinguishable: indistinguishable(
            usable && m.margin !== null ? !result!.unresolvedTie.includes(state.candidate.id) : null,
          ),
          status: state.note ?? state.status,
          detail: result?.droppedWhileAlive.includes(state.candidate.id) ? 'Earlier-stage measurement; search budget reached'
            : state.status === 'eliminated' ? 'Eliminated in an earlier stage' : undefined,
          hypothetical: [...(state.candidate.delta.gear?.values() ?? [])].some(
            (item) => item && isHypothetical(item as ItemInstance),
          ),
          // The changed items as icons. A reader recognises "the one with the
          // green trinket" far faster than a slot-name sentence, which is what
          // this row used to be.
          icons: [...(state.candidate.delta.gear?.entries() ?? [])]
            .map(([, item]) => item as ItemInstance)
            .filter(Boolean),
          resolvedItems: state.candidate.provenance.items,
          changedSlots: [...(state.candidate.delta.gear?.keys() ?? [])],
        }
      }),
  )

  function changesOf(state: (typeof measured)[number]): string {
    const gear = state.candidate.delta.gear
    const changes = [...(gear?.entries() ?? [])]
      .map(([slot, item]) => {
        const to = item ? display(item as ItemInstance, app.resolved).name : 'empty'
        return `${SLOT_LABELS[slot]}: ${to}`
      })
    for (const [kind, option] of Object.entries(state.candidate.delta.consumables ?? {})) {
      changes.push(`${titleCase(kind)}: ${titleCase(option)}`)
    }
    if (state.candidate.delta.talents) changes.push(`Talents: ${lastSearch?.loadouts.find((l) => l.talents === state.candidate.delta.talents)?.name ?? 'Custom build'}`)
    return changes.join(', ') || state.candidate.provenance.label
  }
</script>

{#if !character && !result}
  <section class="empty stack">
    <h1>No character yet</h1>
    <p class="muted">Top Gear searches the items your character owns.</p>
    <p><a href={href('character')}>Import one</a>.</p>
  </section>
{:else}
  <div class="stack top-gear">
    {#if !searching && (!result || setupOpen) && character}
    <CatalogStatus />

    <section class="panel stack gear-workspace" hidden={searching} inert={searching}>
      <header>
        <div class="stack-sm">
          <h1>Top Gear</h1>

        </div>
        <div class="row-tight">
          {#if result && !searching}
            <button class="ghost sm" onclick={() => (setupOpen = false)}>Back to result</button>
          {/if}
          {#if searching}
            <button class="danger" onclick={() => cancelSearch?.()}>Cancel</button>
          {:else}
            <button class="ghost sm" disabled={!selectedCount} onclick={() => {
              selection = {}; gems = {}; enchants = {}; consumables = {}; embellishments = {}; requiredSets = []; selectedLoadouts = []
            }}>Reset choices</button>
            <button
              class="primary"
              onclick={() => go()}
              disabled={busy || !selectedCount || !profilesetsSupported()
                || app.catalogState !== 'ready' || !estimate || estimate.exceedsCap}
            >
              Find Top Gear
            </button>
          {/if}
        </div>
      </header>

      <CharacterBanner {character} characterId={stored?.id} />

      <nav class="quick-nav" aria-label="Top Gear sections">
        {#each [['gear-vault', 'Great Vault'], ['gear-items', 'Gear'], ['gear-enhancements', 'Enhancements'], ['gear-consumables', 'Consumables'], ['gear-talents', 'Talents'], ['gear-options', 'Options']] as [id, label]}
          <button class="ghost sm" onclick={() => document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? 'instant' : 'smooth', block: 'start' })}>{label}</button>
        {/each}
      </nav>

      {#if !profilesetsSupported() && app.capabilityChecked}
        <Banner kind="warn" title="This engine build cannot run a search">
          <p>
            The single-threaded fallback compiles out the engine's variant support, so Top Gear
            needs the threaded build. Quick Sim still works.
          </p>
        </Banner>
      {/if}

      {#if received.length}
        <Banner kind="good" title="Added from the Droptimizer">
          <ul>
            {#each received as r, i (i)}
              <li>{r.name} <span class="muted xs">from {r.source}</span></li>
            {/each}
          </ul>
          <p class="xs">
            {received.length === 1 ? 'It is' : 'They are'} selected and will be searched alongside
            what you own. The exact item was carried over, not looked up again.
          </p>
          {#snippet actions()}
            <button class="sm ghost" onclick={() => (received = [])}>Dismiss</button>
          {/snippet}
        </Banner>
      {/if}

      {#if droppedFromStorage}
        <Banner kind="warn" title="Part of your saved selection no longer matches this character">
          <p>
            {droppedFromStorage} previously selected item{droppedFromStorage === 1 ? '' : 's'} could
            not be found in this character's gear, so {droppedFromStorage === 1 ? 'it was' : 'they were'}
            dropped rather than searched. Re-importing an export can change how items are
            identified. Everything still listed below is selected as before.
          </p>
        </Banner>
      {/if}

      {#if !selectionStorageWorks()}
        <Banner kind="info" title="This selection will not survive a reload">
          <p>
            This browser refused to store it — private mode, blocked site data, or a full quota.
            Your selection works normally while this tab stays open.
          </p>
        </Banner>
      {/if}

      {#if derivation?.unknown.length}
        <details class="disclosure">
          <summary>{derivation.unknown.length} rule{derivation.unknown.length > 1 ? 's' : ''} cannot be checked for this character</summary>
          <ul class="xs muted">
            {#each derivation.unknown as u, i (i)}<li>{u}</li>{/each}
          </ul>
        </details>
      {/if}

      <section id="gear-vault" class="panel stack gear-section">
        <div class="spread"><h2 class="section-title">Great Vault</h2><span class="chip">Choose one reward</span></div>
        <p class="small muted">Compare each reward with your best owned gear. Every result uses at most one Vault reward; keeping your current items is also compared.</p>
        <p class="xs muted">Unenchanted rewards inherit the equipped slot's compatible enchant when simulated. Selected enchant alternatives take precedence.</p>
        {#if vaultItems.length}
          <div class="row-tight wrap"><button class="sm" onclick={() => selectVault(true)}>Compare all choices</button><button class="sm" disabled={!vaultItems.some(item => withMaxUpgrade(item))} title="Adds and selects max-track versions. Choices with unknown tracks or crafted items are skipped." onclick={() => upgradeVaultToMax(vaultItems)}>Upgrade all to max in track</button><button class="ghost sm" onclick={() => selectVault(false)}>Clear Vault choices</button></div>
          <div class="slots">
            {#each vaultItems as item (item.instanceId)}
              <div class="stack-sm">
                <ItemLine slot={item.slot} {item} selected={chosenIds(item.slot).includes(item.instanceId)} onclick={() => toggle(item.slot, item)} trailing={item.source === 'hypothetical' ? 'Vault scenario' : 'Vault reward'} />
                <button class="ghost sm" disabled={!withMaxUpgrade(item)} title={withMaxUpgrade(item) ? 'Adds and selects a max-track version, keeping the original choice.' : 'A known upgrade track is required. Crafted items use custom item levels.'} onclick={() => upgradeVaultToMax([item])}>Upgrade to max in track</button>
                <details class="disclosure"><summary>Upgrade or override item level</summary><ItemUpgradePicker {item} original={originalItem(item)} resolved={resolveItem(item, app.resolved)} onchange={(next) => changeItemVersion(item, next)} /></details>
              </div>
            {/each}
          </div>
        {:else}
          <p class="small">Open your Great Vault in game, then paste a fresh SimulationCraft addon export to import its reward choices. You can also add a hypothetical choice below.</p>
        {/if}
        <div class="row-tight wrap"><label class="small">Reward slot <select bind:value={vaultSlot}>{#each GEAR_SLOTS.filter(slot => !['shirt', 'tabard', 'finger2', 'trinket2'].includes(slot)) as slot}<option value={slot}>{SLOT_LABELS[slot]}</option>{/each}</select></label><button class="sm" disabled={app.catalogState !== 'ready'} onclick={() => { searchAsVault = true; searchSlot = vaultSlot }}>Add Vault choice</button></div>
      </section>

      <section id="gear-items" class="stack gear-section">
        <div class="spread">
          <h2 class="section-title">Gear</h2>
          <label class="gear-filter"><span class="sr-only">Filter your gear</span><input type="search" placeholder="Filter your gear…" bind:value={itemFilter} /></label>
        </div>
        <div class="slots">
          {#each gearGroups as group (group.slot)}
            {@const slot = group.slot}
            {@const items = group.items.filter((i) => display(i, app.resolved).name.toLowerCase().includes(itemFilter.toLowerCase()))}
            {@const chosen = chosenIds(slot)}
            {#if !itemFilter || items.length}
              <section class="slot-card" class:active={chosen.length}>
                <div class="slot-heading">
                  <button class="slot-head" aria-expanded={!collapsedSlots.includes(slot)} onclick={() => collapsedSlots = collapsedSlots.includes(slot) ? collapsedSlots.filter((s) => s !== slot) : [...collapsedSlots, slot]}>
                    <strong>{group.label}</strong>
                    <span class="chip" class:accent={chosen.length > 0}>{chosen.length ? `${chosen.length} selected` : 'Equipped'}</span>
                    <span class="caret" aria-hidden="true">{collapsedSlots.includes(slot) ? '+' : '−'}</span>
                  </button>
                  <div class="row-tight slot-actions">
                    <button class="ghost sm" onclick={() => selectAll(slot)} aria-label={`Select all ${group.label.toLowerCase()}`}>All</button>
                    <button class="ghost sm" onclick={() => clearSlot(slot)} aria-label={`Clear ${group.label.toLowerCase()}`}>Reset</button>
                    <button class="ghost sm" disabled={app.catalogState !== 'ready'} onclick={() => { searchAsVault = false; searchSlot = slot }} aria-label={`Add item to ${group.label.toLowerCase()}`}>+ Add</button>
                  </div>
                </div>
                {#if !collapsedSlots.includes(slot)}
                  <div class="slot-body" transition:slide={{duration: ms('panel')}}>

                    <div class="gear-items">
                      {#each items as item (item.instanceId)}
                        {@const worn = character.equipped.some((i) => i.instanceId === item.instanceId)}
                        <div class="stack-sm">
                          <ItemLine {slot} {item} card showSlot={false} selected={chosen.includes(item.instanceId)} onclick={() => toggle(slot, item)} trailing={worn ? 'Equipped' : isHypothetical(item) ? 'Added' : undefined} />
                          <details class="disclosure"><summary>Upgrade or override item level</summary><ItemUpgradePicker {item} original={originalItem(item)} resolved={resolveItem(item, app.resolved)} onchange={(next) => changeItemVersion(item, next)} /></details>
                        </div>
                      {/each}
                    </div>
                    {#if !items.length}<p class="small muted">No items in this slot. Use + Add to search.</p>{/if}
                  </div>
                {/if}
              </section>
            {/if}
          {/each}
        </div>
      </section>

      {#if !optionsBySlot.size}
        <p class="small muted">This export has no alternative items, so there is nothing to search.</p>
      {/if}

      {#if character}
        <EnhancementPicker {character} items={enhancementItems} bind:gems bind:enchants bind:consumables />
      {/if}

      <section id="gear-talents" class="stack-sm gear-section">
        <div class="spread"><h2>Talents</h2><a href={href('talents')}>Open talent editor →</a></div>

        <div class="loadout-cards">
          <div class="loadout-card baseline"><strong>Active loadout</strong><span class="xs muted">Always compared</span></div>
          {#each loadoutOptions as loadout (loadout.talents)}
            <div class="loadout-preview"><label class="loadout-card" class:picked={selectedLoadouts.includes(loadout.talents)}><input type="checkbox" bind:group={selectedLoadouts} value={loadout.talents} /><strong>{loadout.name}</strong></label><TalentPreview {character} talents={loadout.talents} /></div>
          {/each}
        </div>
      </section>

      {#if embellishmentCatalog.length}
        <details class="disclosure">
          <summary>
            Embellishments
            {#if Object.keys(embellishments).length}
              <span class="chip accent">
                {Object.values(embellishments).reduce((n, l) => n + (l?.length ?? 0), 0)} selected
              </span>
            {/if}
          </summary>
          <div class="stack-sm">
            <p class="xs muted">
              An embellishment is applied to whichever item fills the slot, replacing one the item
              already had rather than stacking. <strong>Which slots accept one is not in the
              engine data</strong>, so the choice of slot is yours — pick the slot you would
              actually craft for.
            </p>

            <label class="xs">
              Slot
              <select bind:value={embellishmentSlot}>
                <option value={null}>Choose a slot…</option>
                {#each GEAR_SLOTS as slot (slot)}
                  <option value={slot}>
                    {SLOT_LABELS[slot]}
                    {#if embellishments[slot]?.length}({embellishments[slot]?.length}){/if}
                  </option>
                {/each}
              </select>
            </label>

            {#if embellishmentSlot}
              {@const chosen = embellishments[embellishmentSlot] ?? []}
              <label class="check xs">
                <input
                  type="checkbox"
                  checked={chosen.includes(0)}
                  onchange={() => toggleEmbellishment(embellishmentSlot!, 0)}
                />
                Also try this slot with no embellishment
              </label>
              <p class="xs faint">
                Without that, every candidate for this slot carries one.
              </p>
              <div class="embellishments">
                {#each embellishmentCatalog as e (e.bonusId)}
                  <label class="check xs">
                    <input
                      type="checkbox"
                      checked={chosen.includes(e.bonusId)}
                      onchange={() => toggleEmbellishment(embellishmentSlot!, e.bonusId)}
                    />
                    {e.name}
                  </label>
                {/each}
              </div>
            {/if}

            <label class="check xs">
              <input type="checkbox" bind:checked={embellishmentCap.enforce} />
              Limit how many the character may wear
            </label>
            {#if embellishmentCap.enforce}
              <label class="xs">
                At most
                <input type="number" min="1" max="10" bind:value={embellishmentCap.limit} />
              </label>
              <p class="xs muted">
                That number is yours. This build has no data for the real cap, so nothing here can
                confirm it — combinations above your limit are rejected before they reach the
                engine, and if the limit is wrong the search is narrower or wider than the game.
              </p>
            {:else}
              <p class="xs muted">
                No limit is applied, so a candidate may carry an embellishment in every slot you
                selected. The real cap is not in any data this build has.
              </p>
            {/if}
          </div>
        </details>
      {/if}

      {#if wearableSets.length}
        <details class="disclosure">
          <summary>
            Keep a set bonus
            {#if requiredSets.length}<span class="chip accent">{requiredSets.length}</span>{/if}
          </summary>
          <div class="stack-sm">
            <p class="xs muted">
              A combination that would drop below the piece count you require is rejected before it
              reaches the engine, so the search never spends time on a setup you would not wear.
            </p>
            {#each wearableSets as set (set.setId)}
              <div class="row-tight">
                <span class="small grow truncate">{set.name}</span>
                <span class="xs faint">{set.owned} worn</span>
                {#each set.tiers as pieces, i (i)}
                  <label class="check xs">
                    <input
                      type="checkbox"
                      checked={requiredSets.some((r) => r.setId === set.setId && r.pieces === pieces)}
                      onchange={() => toggleSet(set.setId, pieces)}
                    />
                    {pieces}-piece
                  </label>
                {/each}
              </div>
            {/each}
          </div>
        </details>
      {/if}

      <section id="gear-options" class="stack gear-section">
        <h2>Simulation options</h2>
        <SettingsForm settings={settings} staged perCandidate />
      </section>

      <details class="disclosure">
        <summary>Not yet searchable</summary>
        <ul class="xs muted">
          <li>Catalyst conversions and crafted-quality variants of an item you do not own.</li>
          <li>
            Currency budgets and affordability: the catalog has no upgrade-cost, crafting-reagent or
            Catalyst-charge data, so no candidate is filtered on what it would cost. Costs show as
            unknown, never as zero.
          </li>
        </ul>
      </details>
    </section>

    {#if estimate && !searching && (!result || setupOpen)}
      <details class="panel budget stack-sm"><summary>Search details · {fmtInt(estimate.combinations)} combinations</summary>
        <div class="spread">
          <div class="stack-sm">
            <strong class="small">
              {#if !selectedCount}
                Nothing selected yet
              {:else if estimate.overflowed}
                More setups than can be counted
              {:else}
                {estimate.exact ? '' : 'At most '}{fmtInt(estimate.combinations)} setup{estimate.combinations === 1 ? '' : 's'} to simulate
              {/if}
            </strong>
<span class="xs muted">{selectedCount} alternatives · equipped baseline included</span>
          </div>
          {#if estimate.growthDrivers.length > 1}
            <div class="xs muted">
              Largest dimensions:
              {estimate.growthDrivers.slice(0, 3).map((d) => `${d.dimension} (${d.factor})`).join(', ')}
            </div>
          {/if}
        </div>

        {#if estimate.stages.length && selectedCount}
          <div class="tbl-scroll">
            <table class="tbl">
              <caption class="sr-only">Planned stages</caption>
              <thead>
                <tr><th>Stage</th><th>Precision</th><th class="n">Candidates</th><th class="n">Rough time</th></tr>
              </thead>
              <tbody>
                {#each plannedStages as s (s.label)}
                  <tr>
                    <td>{s.label}</td>
                    <td>{s.precision}</td>
                    <td class="n">{fmtInt(s.candidates)}</td>
                    <td class="n">
                      {s.worstSeconds !== undefined ? `up to ${fmtSeconds(s.worstSeconds)}` : '—'}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="xs muted">
            Times are an upper bound, not a measurement: each stage runs until it reaches its
            accuracy target <em>or</em> its iteration ceiling, and the figure above assumes every
            candidate needs the ceiling. A candidate that converges early costs far less.
            {#if worstTotalSeconds > 300}
              The last stage is deliberately expensive — {fmtSeconds(worstTotalSeconds)} in the
              worst case for this selection. Cancel is available throughout.
            {/if}
          </p>
        {/if}

        {#if estimate.exceedsCap}
          <Banner kind="warn" title="Too many combinations">
            <p>
              This selection describes more than the {fmtInt(estimate.workCap)}-candidate cap.
              Deselect items in
              {estimate.growthDrivers[0]?.dimension ?? 'the largest dimension'} to bring it down.
              Nothing is silently dropped — the search will not start until it fits.
            </p>
          </Banner>
        {/if}
      </details>
    {/if}
    {/if}

    {#if searching}<RunStatus title="Top Gear · {lastSearch?.label ?? character?.name ?? ''}" stage={progress?.stageLabel ?? 'Preparing'} fraction={stageFraction} summary={progress ? `Pass ${progress.stageIndex + 1} of up to ${progress.stageCount} · ${fmtInt(progress.candidatesMeasured)} measured · ${fmtInt(progress.candidatesRemaining)} remaining${progress.contendersRemaining !== undefined && progress.stageIndex > 0 ? ` · ${fmtInt(progress.contendersRemaining)} still in contention` : ''}` : ''} log={engineLog} oncancel={() => cancelSearch?.()} />{/if}

    {#if searchError}
      <Banner kind={app.job?.status === 'cancelled' ? 'info' : 'bad'} title="Search stopped" live>
        <p>{searchError}</p>
      </Banner>
    {/if}

    {#if result && !searching && !setupOpen}
      <div><button class="ghost sm" onclick={() => (setupOpen = true)}>← Back to setup</button></div>
      <div class="report-layout">
      <div class="report-main">
      <h1 tabindex="-1" bind:this={resultHeading}>Top Gear results</h1>
      {#if resultCharacter}<CharacterBanner character={resultCharacter} />{/if}
      <p class="small muted">{resultSettings.fightStyle} · {resultSettings.targets} target{resultSettings.targets === 1 ? '' : 's'} · {resultSettings.maxTime}s · {fmtInt(simulated.length)} setups simulated</p>
      {#if result.incomplete && engineLog.length}<details class="disclosure"><summary>SimulationCraft log</summary><SimLog lines={engineLog} /></details>{/if}
      {#if result.incomplete}
        <Banner kind="warn" title="This search did not finish">
          <p>{result.incomplete.message}</p>
          <p>What follows is a partial result, not a complete optimization.</p>
        </Banner>
      {/if}

      {#if result.truncated}
        <Banner kind="warn" title="Some candidates were dropped while still in contention">
          <p>
            {result.droppedWhileAlive.length} candidate{result.droppedWhileAlive.length === 1 ? '' : 's'}
            were cut to fit the stage budget even though the evidence had not separated them from
            the leader. The winner below is the best of what was measured, not provably the best
            of everything selected.
          </p>
        </Banner>
      {/if}

      {#each result.warnings as w, i (i)}
        <Banner kind="warn" title="Search note"><p>{w}</p></Banner>
      {/each}

      {#if rec && !rec.measured}
        <!--
          Nothing was measured, so there is no verdict. Rendering this as advice
          is worse than rendering an error: "Keep your current gear" on zero
          measurements is indistinguishable, to the user, from the real thing.
        -->
        <Banner kind="bad" title="No recommendation — nothing was measured">
          <p>{rec.reason}</p>
          <p>
            The candidate list below shows what happened to each setup. A setup with no result was
            either rejected before it reached the engine or absent from the report, and its status
            says which.
          </p>
        </Banner>
      {:else if rec}
        <section class="panel stack">
          <h2 class="small">
            {rec.keepCurrent ? 'Keep your current gear' : 'Best setup found'}
            {#if rec.engineProblems}<span class="chip warn">numbers may be wrong</span>{/if}
          </h2>
          {#if measured[0]?.measurement}
            <span class="small muted">Highest measured DPS</span>
            <div class="row wrap">
              <strong class="big num">{fmtInt(measured[0].measurement.mean)} DPS</strong>
              <span class="small muted">{measured[0].measurement.margin !== null ? `±${fmtInt(measured[0].measurement.margin)} DPS` : 'Uncertainty unavailable'} · {fmtInt(measured[0].measurement.iterations)} samples</span>
            </div>
          {/if}
          {#if result.baseline}<p class="small muted">Equipped baseline: {fmtInt(result.baseline.mean)} DPS{result.baseline.margin !== null ? ` ±${fmtInt(result.baseline.margin)}` : ''}</p>{/if}
          <p class="small">{rec.reason}</p>
          {#if rec.engineProblems}
            <!--
              The ranking is still shown because it is the only evidence there
              is, but it must not read as a confident verdict: the engine logged
              something it classified moderate or severe while producing these
              numbers.
            -->
            <Banner kind="warn" title="The engine reported problems while measuring these setups">
              <ul>
                {#each result.problems ?? [] as p, i (i)}<li class="mono xs">{p}</li>{/each}
              </ul>
              <p>
                The ranking below is what was measured and is still the best evidence available,
                but treat the ordering as provisional rather than settled.
              </p>
            </Banner>
          {/if}
          {#if !rec.keepCurrent && rec.winner && measured[0]?.measurement}
            <div class="row">
              <strong class="big num gain">{fmtDelta(deltaOf(measured[0].measurement.mean))}</strong>
              <span class="muted">
                DPS ({fmtDeltaPct((deltaOf(measured[0].measurement.mean) / (baselineMean || 1)) * 100)})
                over your current gear
              </span>
            </div>
            <ul class="changes small">
              {#each [...(rec.winner.delta.gear?.entries() ?? [])] as [slot, item] (slot)}
                <li>
                  <span class="muted">{SLOT_LABELS[slot]}</span>
                  {#if item}{@const shown = display(item as ItemInstance, app.resolved)}<ItemLink itemId={item.itemId} name={shown.name} resolved={rec.winner.provenance.items.find((resolved) => resolved.slot === slot && resolved.itemId === item.itemId) ?? shown.resolved} />{:else}empty{/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if measured.length}
            {@const best = measured[0]}
            <div class="row-tight wrap">
              <button class="sm" onclick={() => openInQuickSim(best)}>
                Run {rec.keepCurrent ? 'the leader' : 'this setup'} in detail
              </button>
              <button class="sm ghost" onclick={() => exportSetup(best)}>
                Export as a SimulationCraft profile
              </button>
            </div>
  
          {/if}

          {#if result.unresolvedTie.length > 1}
            <p class="xs muted" title="Their confidence intervals overlap, so the measurements cannot tell them apart. Re-measuring at a tighter target would separate them if a real difference exists.">
              {result.unresolvedTie.length} setups tied at this precision.
            </p>
          {/if}
        </section>
      {/if}

      {#if vaultComparisons.length}
        <section class="panel stack-sm">
          <h2>Great Vault choices</h2>
          <p class="small muted">Each row equips one reward with its best measured gear combination. The comparison is against your best setup without taking a Vault item.</p>
          {#if ownedBest?.measurement}
            <ComparisonBars rows={vaultComparisons} baseline={{ label: 'Best setup without a Vault reward', mean: ownedBest.measurement.mean, margin: ownedBest.measurement.margin ?? undefined, equipped: false }} caption="Great Vault rewards compared one at a time" />
          {:else}
            <p class="small muted">No owned-only comparison is available yet. These are the reward measurements collected so far.</p>
            <table class="tbl"><thead><tr><th>Reward</th><th>DPS</th><th>Status</th></tr></thead><tbody>{#each vaultComparisons as row (row.id)}<tr><td>{#if row.icons?.[0]}<ItemLink itemId={row.icons[0].itemId} name={row.label} resolved={row.item} />{:else}{row.label}{/if}</td><td>{row.mean === undefined ? '—' : fmtInt(row.mean)}</td><td>{row.status}</td></tr>{/each}</tbody></table>
          {/if}
        </section>
      {/if}

      <section class="panel stack-sm">
        <h2 class="small">All measured setups</h2>
        <ComparisonBars
          rows={bars}
          baseline={{
            label: 'Current gear',
            mean: baselineMean,
            margin: result.baseline?.margin ?? undefined,
          }}
          baselineGear={resultCharacter?.equipped ?? []}
          caption="Every simulated setup, ranked against current gear"
        />
      </section>

      {#if result.stagesRun.length}
        <details class="disclosure">
          <summary>What each stage actually ran</summary>
          <div class="tbl-scroll">
            <table class="tbl">
              <thead>
                <tr><th>Stage</th><th>Precision</th><th class="n">Candidates</th><th>Target met</th></tr>
              </thead>
              <tbody>
                {#each result.stagesRun as s, i (i)}
                  <tr>
                    <td>{s.label}</td>
                    <td>
                      {s.accuracy.mode === 'iterations'
                        ? `${fmtInt(s.accuracy.iterations)} iterations`
                        : `${s.accuracy.targetError}% target error`}
                    </td>
                    <td class="n">{fmtInt(s.candidates)}</td>
                    <td>
                      {s.targetReached === null ? 'n/a' : s.targetReached ? 'yes' : 'no'}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </details>
      {/if}
      </div>
      <aside class="report-sidebar">
        <section class="panel stack-sm">
          <h2 class="small">Report options</h2>
          <button class="primary" onclick={() => go(true)} disabled={busy || !lastSearch}>Run again</button>
          <button onclick={() => (setupOpen = true)}>Edit setup</button>
          {#if shareOutcome && result.baseline}<ShareReport outcome={shareOutcome} transform={s => searchSnapshot(s, result!, 'Top Gear')} />{/if}
          {#if finalists.length}
            <details class="disclosure">
              <summary>Re-measure {finalists.length} setups</summary>
              <div class="stack-sm">
                <p class="xs muted">Fresh samples for every measured setup, with no elimination. Tighter precision takes longer.</p>
                <label class="xs">Target error
                  <select bind:value={verifyTarget} disabled={busy}>
                    <option value={0.1}>0.10%</option>
                    <option value={0.05}>0.05%</option>
                    <option value={0.025}>0.025%</option>
                  </select>
                </label>
                <button class="sm primary" onclick={verify} disabled={busy}>{verifying ? 'Re-measuring…' : 'Re-measure'}</button>
                <p class="xs muted">Completed measurements replace this ranking. Any incomplete run is marked below.</p>
              </div>
            </details>
          {/if}
        </section>
        {#if shareOutcome}
          <div class="stack-sm">
            <h2 class="small">Baseline simulation details</h2>
            <p class="xs muted">Equipped gear in the last comparison run. Processing time covers that run only; use “Run this setup in detail” for the winner.</p>
            <SimulationDetails outcome={shareOutcome} detail={baselineDetail} />
          </div>
        {/if}
      </aside>
      </div>
    {/if}
  </div>
  {#if !searching && (!result || setupOpen)}
  <div class="run-dock">
    <div class="stack-sm"><strong aria-live="polite">{searching ? progress ? `${progress.stageLabel} · Pass ${progress.stageIndex + 1} of up to ${progress.stageCount}` : 'Preparing your comparison…' : selectedCount ? estimate ? `${estimate.exact ? '' : 'Up to '}${fmtInt(estimate.combinations)} combinations` : 'Calculating combinations…' : 'Select alternatives to compare'}</strong><span class="xs muted">{settings.fightStyle} · {settings.targets} target{settings.targets === 1 ? '' : 's'} · {settings.maxTime}s · Runs on your device</span></div>
    <button class="primary" onclick={() => go()} disabled={busy || !selectedCount || !profilesetsSupported() || app.catalogState !== 'ready' || !estimate || estimate.exceedsCap}>Find Top Gear</button>
  </div>
  {/if}
{/if}

<ItemSearch
  open={!!searchSlot}
  slot={searchSlot}
  classId={character ? classId(character) : undefined}
  onclose={() => (searchSlot = null)}
  onadd={(item) => {
    const slot = searchSlot
    if (!slot) return
    if (searchAsVault) {
      const id = `manual-vault:${newId()}`
      item = { ...item, instanceId: id, originalInstanceId: id, vaultRewardId: id, source: 'hypothetical' }
    } else item = { ...item, originalInstanceId: item.instanceId }
    if (!(added[slot] ?? []).some((i) => i.instanceId === item.instanceId)) {
      added[slot] = [...(added[slot] ?? []), item]
    }
    // Adding it also selects it: nobody searches for an item to then not try it.
    const selectedSlot = groupSlots(slot)[0]
    selection[selectedSlot] = [...new Set([...(selection[selectedSlot] ?? []), item.instanceId])]
    searchSlot = null
  }}
/>

<style>
  .slots {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(21rem, 100%), 1fr));
    gap: var(--s4);
    align-items: start;
  }
  .top-gear { padding-bottom: 6rem; }
  .gear-workspace { gap: 20px; }
  .gear-section { scroll-margin-top: 9rem; min-width: 0; }
  .quick-nav { position: sticky; top: 5.25rem; z-index: 12; display: flex; flex-wrap: wrap; gap: var(--s2); padding: var(--s2); border: 1px solid var(--glass-edge); border-radius: 12px; background: var(--glass-strong); -webkit-backdrop-filter: blur(20px) saturate(1.5); backdrop-filter: blur(20px) saturate(1.5); box-shadow: var(--shadow-2), inset 0 1px 0 var(--rim); }
  .gear-filter { width: min(18rem, 100%); }
  .slot-card { border: 1px solid var(--border); border-radius: var(--r3); overflow: hidden; background: rgb(255 255 255 / 0.025); transition: border-color 0.3s var(--ease), box-shadow 0.4s var(--ease); }
  .slot-card:hover { border-color: var(--border-strong); }
  .slot-heading { display: flex; justify-content: space-between; align-items: center; background: var(--surface-2); }
  .slot-actions { padding-right: var(--s3); flex-shrink: 0; }
  .gear-items { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s2); }
  .loadout-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(12rem, 100%), 1fr)); gap: var(--s3); }
  .loadout-card { padding: var(--s4); display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); border: 1px solid var(--border); border-radius: var(--r3); background: var(--surface-2); cursor: pointer; transition: border-color 0.3s var(--ease), background 0.3s var(--ease), box-shadow 0.4s var(--ease), translate 0.45s var(--spring); }
  .loadout-card:hover { border-color: var(--accent-border); translate: 0 -2px; box-shadow: 0 14px 30px -18px var(--accent-glow); }
  .loadout-card span { flex-basis: 100%; }
  .loadout-card input { width: auto; }
  .loadout-card.picked { border-color: var(--accent); background: linear-gradient(135deg, rgb(101 203 229 / 0.2), rgb(165 139 247 / 0.08)); box-shadow: 0 0 0 1px rgb(101 203 229 / 0.3), 0 0 24px -8px var(--accent-glow); }
  .loadout-card.baseline { cursor: default; }
  .run-dock { position: fixed; left: 50%; transform: translateX(-50%); width: min(calc(100% - 2rem), calc(var(--content-max) - 2rem)); bottom: var(--s3); z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding: var(--s4) var(--s5); background: linear-gradient(180deg, var(--glass-hi), transparent 50%), var(--glass-strong); -webkit-backdrop-filter: blur(26px) saturate(1.6); backdrop-filter: blur(26px) saturate(1.6); border: 1px solid var(--accent-border); border-radius: 18px; box-shadow: var(--shadow-3), 0 0 50px -20px var(--accent-glow), inset 0 1px 0 var(--rim); animation: dock-in 0.7s var(--spring) 0.2s backwards; }
  @keyframes dock-in { from { opacity: 0; translate: 0 30px; } }
  .run-dock strong { font-variant-numeric: tabular-nums; }
  .slot-card.active { border-color: var(--accent-border); box-shadow: 0 0 30px -16px var(--accent-glow); }
  .slot-head {
    all: unset;
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex: 1;
    box-sizing: border-box;
    padding: var(--s2) var(--s3);
    cursor: pointer;
  }
  .slot-head:hover { background: var(--surface-2); }
  .slot-head:focus-visible { box-shadow: inset var(--focus); }
  .caret { flex: none; color: var(--text-faint); }
  .slot-body { display: grid; gap: var(--s3); padding: var(--s4); border-top: 1px solid var(--border); }
  .budget { background: var(--surface-2); }
  .big { font-size: var(--fs-2xl); font-weight: 700; }
  .changes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.2rem; }
  .embellishments {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
    gap: 0.1rem var(--s3);
    max-height: 16rem;
    overflow-y: auto;
  }
  .check { display: inline-flex; align-items: center; gap: var(--s2); }
  .check input { width: auto; }
  @media (max-width: 40rem) {
    .slot-heading { flex-wrap: wrap; }
    .slot-actions { padding: 0 var(--s3) var(--s2); }
    .run-dock { padding: var(--s3); flex-wrap: wrap; }
    .run-dock .primary { flex: 1; white-space: nowrap; }
  }
  @media (prefers-reduced-motion: reduce) { .slot-card, .loadout-card { transition: none; } }
</style>
