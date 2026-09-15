<script lang="ts">
  // Three phases: (1) each item at highest reachable rank, intermediate ranks derived; (2) multi-budget knapsack over marginal gains; (3) top plans re-simulated. Budgets stated, never assumed.
  import { onDestroy, tick } from 'svelte'
  import { cancelActiveJob, engineBusy } from '../lib/simc/client'
  import { GEAR_SLOTS, SLOT_LABELS, type GearSlot, type ItemInstance } from '../lib/import/character'
  import { buildProfile } from '../lib/import/serialize'
  import { gainOverBaseline } from '../lib/optimization'
  import { runAdaptiveSearch, type AdaptiveResult } from '../lib/optimization/adaptive'
  import {
    anchorSteps, crestBudget, crestCandidates, dominates, marginalsFrom, phaseFraction, planCandidate,
    planItemLevels, planLines, planMoney, planTargetError, planTotals, preferredPlan, solveKnapsack,
    stepCandidate, type CrestPlan, type CrestStep,
  } from '../lib/optimization/crestsim'
  import {
    applyHighWatermark, costUnavailable, crestCurrencies, crestSeason, characterCrests,
    seasonStartsAt, seasonWeekIndex, upgradeStepCost, watermarkSlotForGear, weeklyCrestCap,
  } from '../lib/catalog/upgradeCosts'
  import type { Candidate, CandidateMeasurement, OptimizationProgress } from '../lib/optimization/types'
  import {
    activeCharacter, activeStored, app, engineIdentityString, isBusy, maxThreads, pollEngineSlot,
    profilesetsSupported, saveReport,
  } from '../lib/app.svelte'
  import { makeRunBatch } from '../lib/runBatch'
  import { markSettled, markStarted, teardownCancellation } from '../lib/job.svelte'
  import { crestPlanning, crestSettings } from '../lib/settings.svelte'
  import { fmtDelta, fmtDeltaPct, fmtInt } from '../lib/format'
  import { href } from '../lib/router.svelte'
  import { newId } from '../lib/store/records'
  import RunStatus from '../lib/ui/RunStatus.svelte'
  import SimLog from '../lib/ui/SimLog.svelte'
  import { ProgressBuffer } from '../lib/ui/progress'
  import Banner from '../lib/ui/Banner.svelte'
  import GearStrip from '../lib/ui/GearStrip.svelte'
  import SettingsForm from '../lib/ui/SettingsForm.svelte'

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const busy = $derived(isBusy())

  const currencies = crestCurrencies()
  /** 0-based per catalog; null when build carries no season start. */
  const currentWeek = seasonWeekIndex()
  if (currentWeek !== null && crestPlanning.week < currentWeek) crestPlanning.week = currentWeek

  // --- budget ---------------------------------------------------------------
  /** True when export carried upgrade_currencies block. */
  const heldFromImport = $derived(!!character?.currencies?.upgrade)

  const held = $derived.by(() => {
    const fromImport = character ? characterCrests(character) : {}
    return { ...fromImport, ...crestPlanning.held }
  })
  const budget = $derived(crestBudget({
    currencies,
    held,
    heldKnown: heldFromImport || Object.keys(crestPlanning.held).length > 0,
    planAhead: crestPlanning.planAhead ? { week: crestPlanning.week, capRemoved: crestPlanning.capRemoved } : null,
    currentWeek,
    weeklyCap: weeklyCrestCap,
    perWeek: crestPlanning.perWeek,
    startQuantity: crestPlanning.startQuantity,
  }))
  const hasBudget = $derived(Object.values(budget.amounts).some((n) => n > 0))

  const slotLabels = Object.fromEntries(GEAR_SLOTS.map((slot) => [slot, SLOT_LABELS[slot]]))

  // --- candidate space ------------------------------------------------------
  // Equipped items only; bag items would require deciding their replacement (Top Gear's question).
  const equipped = $derived(
    (character?.equipped ?? [])
      .filter((item) => GEAR_SLOTS.includes(item.slot))
      .map((item) => ({ slot: item.slot, item })),
  )
  const space = $derived(crestCandidates(equipped, {
    costs: { upgradeStepCost, applyHighWatermark },
    watermarks: character?.highWatermarks,
    // Enum.ItemRedundancySlot has no entry for weapon slots this layer can resolve, so they keep full price.
    slotIndexFor: watermarkSlotForGear,
    names: app.resolved,
  }))
  /** Equipped slots the watermark enum cannot resolve, never discounted. */
  const undiscountable = $derived(
    equipped.filter((e) => watermarkSlotForGear(e.slot) === null).map((e) => slotLabels[e.slot] ?? e.slot),
  )
  const affordableSteps = $derived(space.steps.filter(
    (step) => Object.entries(step.cost).every(([id, n]) => n <= (budget.amounts[Number(id)] ?? 0)),
  ))

  // --- run state --
  let running = $state(false)
  /** Finished run fills screen; setup is one click back and re-opens without losing result. */
  let setupOpen = $state(false)
  /** The settings the run on screen was measured with, so editing them cannot relabel it. */
  let ranSettings = $state(crestSettings.snapshot())
  let ownedJobId: string | null = null
  let cancelRun: (() => void) | null = null
  let error = $state('')
  /** Phase is the heading; engine's own pass shown beneath it (different scales: screen owns phases, runner owns passes). */
  const PHASES = [
    'measuring each item at its top rank',
    'choosing how to spend',
    'simulating the best plans',
  ] as const
  /** 0 before the first phase starts. */
  let phaseIndex = $state(0)
  let phaseDetail = $state('')
  const phaseLabel = $derived(
    phaseIndex ? `Phase ${phaseIndex} of ${PHASES.length} · ${PHASES[phaseIndex - 1]}` : 'Preparing',
  )
  let progress = $state<OptimizationProgress | null>(null)
  let logBuffer = new ProgressBuffer()
  let engineLog = $state<string[]>([])
  let elapsed = $state(0)

  let result = $state<AdaptiveResult | null>(null)
  let plans = $state<CrestPlan[]>([])
  let stepsById = $state<Map<string, CrestStep>>(new Map())
  let solverExhaustive = $state(true)
  /** Measurements so far; pass re-measures, so this may exceed item count. */
  let measuredCount = $state(0)
  /** Distinct items anchored in phase 1, one per slot. */
  let anchorCount = $state(0)
  /** Step ids whose gain was derived from item's top rank. */
  let modelledIds = $state<Set<string>>(new Set())
  let skipped = $state<{ id: string; slot: string; reason: string }[]>([])
  let notSeparable = $state<string[]>([])
  let unmeasuredSlots = $state<GearSlot[]>([])
  /** Target error phase 3 actually ran at (derived, not accuracy setting). */
  let planError = $state(0)
  const round3 = (n: number) => Math.round(n * 1000) / 1000

  $effect(() => {
    if (!running) return
    const started = Date.now()
    elapsed = 0
    const timer = setInterval(() => { elapsed = (Date.now() - started) / 1000 }, 1000)
    return () => clearInterval(timer)
  })

  const BASELINE: Candidate = {
    id: 'baseline',
    provenance: { kind: 'baseline', items: [], label: 'Current gear' },
    delta: {},
    cost: { unknownCosts: [] },
    lines: [],
    canonical: '',
  }

  const canRun = $derived(
    !!character && !busy && profilesetsSupported() && hasBudget && affordableSteps.length > 0,
  )

  async function go(): Promise<void> {
    if (!character || !canRun) return
    error = ''
    result = null
    setupOpen = false
    ranSettings = crestSettings.snapshot()
    plans = []
    progress = null
    running = true
    measuredCount = 0
    anchorCount = 0
    peakFraction = 0
    phaseIndex = 0
    phaseDetail = ''
    modelledIds = new Set()
    skipped = []
    notSeparable = []
    unmeasuredSlots = []
    planError = 0
    logBuffer = new ProgressBuffer()
    engineLog = []

    const jobId = newId()
    ownedJobId = jobId
    const title = `${stored?.label ?? character.name} — Crest Sim`
    markStarted({ tool: 'crests', title, startedAt: Date.now() })
    app.job = { id: jobId, tool: 'crests', title, status: 'validating', startedAt: Date.now() }

    const controller = new AbortController()
    cancelRun = () => controller.abort()

    const steps = new Map(affordableSteps.map((s) => [s.id, s] as const))
    stepsById = steps

    const batch = makeRunBatch({
      settings: {
        fightStyle: crestSettings.fightStyle, maxTime: crestSettings.maxTime,
        targets: crestSettings.targets, threads: Math.min(crestSettings.threads, maxThreads()),
      },
      extraProfileLines: crestSettings.extraProfileLines(),
      buffer: logBuffer,
      onEvent: () => { engineLog = [...logBuffer.lines] },
    })
    const ctx = {
      profile: buildProfile(character),
      catalogId: app.catalogManifest?.catalogId ?? 'no-catalog',
      engineIdentity: engineIdentityString(),
      runBatch: batch,
      onProgress: (p: OptimizationProgress) => {
        progress = p
        if (phaseIndex === 1) measuredCount = p.candidatesMeasured
        peakFraction = Math.max(peakFraction, fractionOf(p, phaseIndex))
        if (app.job?.id === jobId) {
          app.job.stage = { index: phaseIndex, total: PHASES.length, label: phaseLabel }
          app.job.status = 'running'
        }
      },
    }

    try {
      // Phase 1: each item at top rank, user's accuracy. Small field measured well beats large one below noise floor.
      const anchors = anchorSteps(affordableSteps)
      phaseIndex = 1
      phaseDetail = `${anchors.length} item${anchors.length === 1 ? '' : 's'}, one candidate each, at ${anchorTargetError}% target error`
      const marginalRun = await runAdaptiveSearch(
        [BASELINE, ...anchors.map((step) => stepCandidate(step, app.resolved))],
        ctx,
        { targetError: anchorTargetError, maxIterations: crestSettings.maxIterations, finalists: 0 },
        controller.signal,
      )
      if (app.job?.id !== jobId) return
      const base = marginalRun.baseline
      if (!base) throw new Error('The engine returned no baseline, so no upgrade could be measured against it.')

      const measured = new Map<string, { gain: number; margin: number | null; significant: boolean | null }>()
      for (const state of marginalRun.candidates) {
        const m = state.measurement
        if (!steps.has(state.candidate.id) || !m || !Number.isFinite(m.mean)) continue
        const g = gainOverBaseline(m, base)
        measured.set(state.candidate.id, { gain: g.absolute, margin: g.margin, significant: g.significant })
      }
      measuredCount = measured.size
      anchorCount = measured.size
      const { marginals, unmeasured } = marginalsFrom(affordableSteps, measured)
      modelledIds = new Set(marginals.filter((m) => m.modelled).map((m) => m.id))
      unmeasuredSlots = unmeasured

      // Phase 2: pure, instant. Gets its own frame even if user never sees it: unseen phase cannot be trusted.
      phaseIndex = 2
      phaseDetail = `${marginals.length} candidate ranks across ${new Set(marginals.map((m) => m.slot)).size} items`
      progress = null
      await tick()
      const solved = solveKnapsack(marginals, budget.amounts, TOP_K)
      solverExhaustive = solved.exhaustive
      skipped = solved.skipped
      notSeparable = solved.notSeparable
      plans = solved.plans
      if (!plans.length) {
        error = 'Nothing in reach of this budget was measured as an improvement, so there is no plan to run.'
        result = marginalRun
        return
      }

      // Phase 3: whole plan sets; gains not additive so phase 2's ordering is proposal. Measured at least as fine as phase 1; planTargetError floors precision at phase 1 parity.
      phaseIndex = 3
      planError = planTargetError({
        planGains: plans.map((plan) => plan.gain),
        baselineMean: base.mean,
        anchorTargetError,
        anchorCount: anchors.length,
        userTargetError: crestSettings.targetError,
      })
      phaseDetail = `${plans.length} plan${plans.length === 1 ? '' : 's'} and the current gear, `
        + `simulated in full at ${round3(planError)}% target error`
      const finalRun = await runAdaptiveSearch(
        [BASELINE, ...plans.map((plan, i) => planCandidate(plan, steps, i, app.resolved))],
        ctx,
        {
          targetError: planError,
          maxIterations: crestSettings.maxIterations,
          finalists: Math.min(TOP_K, plans.length),
        },
        controller.signal,
      )
      if (app.job?.id !== jobId) return
      result = finalRun
      app.job.status = finalRun.incomplete ? 'error' : 'complete'
      // Screen recommends via dominance tie-break, not highest mean (D11); ranked is raw order, winner is rendered.
      const winningRow = winner
      await saveReport({
        tool: 'crests',
        title,
        completion: finalRun.incomplete ? 'partial' : 'complete',
        requestSnapshot: {
          budget: budget.amounts,
          planAhead: crestPlanning.planAhead
            ? { week: crestPlanning.week, capRemoved: crestPlanning.capRemoved,
                perWeek: { ...crestPlanning.perWeek }, startQuantity: { ...crestPlanning.startQuantity } }
            : null,
          settings: crestSettings.snapshot(),
        },
        summary: {
          // Plan, not baseline: history leads with crest value; baseline recoverable as winning mean - delta.
          dps: winningRow?.mean ?? finalRun.baseline?.mean,
          confidenceMargin: winningRow?.measurement?.margin ?? undefined,
          confidenceLevel: winningRow?.measurement?.confidence ?? undefined,
          actualIterations: winningRow?.measurement?.iterations,
          candidateCount: affordableSteps.length,
          topCandidates: presented.slice(0, 5).map((row) => ({
            id: row.id,
            label: `${row.label} — ${row.plan.ids.length} upgrade${row.plan.ids.length === 1 ? '' : 's'}`,
            mean: row.mean ?? 0,
            delta: row.gain?.absolute ?? 0,
          })),
          warnings: [...finalRun.warnings, ...budget.warnings].length
            ? [...finalRun.warnings, ...budget.warnings]
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
      // Returning from the search is not proof the engine stopped. See TopGear.
      controller.abort()
      cancelRun = null
      running = false
      phaseIndex = 0
      phaseDetail = ''
      if (!result && !error) {
        error = 'The run ended without producing a result, and Frostsim does not know why — '
          + 'nothing reported an error. Nothing was saved.'
      }
      if (app.job?.id === jobId && !['complete', 'error', 'cancelled'].includes(app.job.status)) {
        app.job.status = result && !result.incomplete && !error ? 'complete' : 'error'
      }
      if (ownedJobId === jobId) ownedJobId = null
      pollEngineSlot()
    }
  }

  const TOP_K = 6
  /** Phase 1 must resolve whole item upgrade (few hundred DPS); min enforces phase 1 never coarser than final. */
  const anchorTargetError = $derived(Math.min(crestPlanning.anchorTargetError, crestSettings.targetError))

  // --- results --------------------------------------------------------------

  interface PlanRow {
    id: string
    label: string
    plan: CrestPlan
    mean: number | null
    /** Phase-3 measurement behind mean; saved row cannot re-lookup. */
    measurement: CandidateMeasurement | null
    gain: ReturnType<typeof gainOverBaseline> | null
    status: string
    tied: boolean
  }

  const ranked = $derived.by<PlanRow[]>(() => {
    if (!result || !plans.length) return []
    const byId = new Map(result.candidates.map((c) => [c.candidate.id, c]))
    const base = result.baseline
    return plans
      .map((plan, i) => {
        const state = byId.get(`plan-${i}`)
        const m = state?.measurement ?? null
        return {
          id: `plan-${i}`,
          label: `Plan ${i + 1}`,
          plan,
          mean: m && Number.isFinite(m.mean) ? m.mean : null,
          measurement: m,
          gain: m && base && Number.isFinite(m.mean) ? gainOverBaseline(m, base) : null,
          status: state?.status ?? 'missing',
          tied: result!.unresolvedTie.includes(`plan-${i}`),
        }
      })
      .sort((a, b) => (b.mean ?? -Infinity) - (a.mean ?? -Infinity))
  })

  /** Inside tie, mean carries no information, so recommendation decided by plan value via preferredPlan. */
  const tiedWithLeader = $derived.by(() => {
    const leader = ranked[0]
    if (!leader || !result) return []
    const ties = new Set(result.unresolvedTie)
    return ranked.filter((row) => row.mean !== null && (row === leader || ties.has(row.id)))
  })
  const preferredId = $derived(
    tiedWithLeader.length > 1
      ? preferredPlan(tiedWithLeader.map((row) => ({ id: row.id, plan: row.plan })), stepsById)
      : null,
  )
  /** Tie-break moved recommendation from highest-mean plan. */
  const tieBroken = $derived(!!preferredId && preferredId !== ranked[0]?.id)
  /** Tied set contains dominance relation (not same as tieBroken: highest-mean may already dominate). */
  const tieHasDominance = $derived(
    tiedWithLeader.some((a) => tiedWithLeader.some((b) => a !== b && dominates(a.plan, b.plan, stepsById))),
  )
  const winner = $derived(
    (preferredId ? ranked.find((row) => row.id === preferredId) : null) ?? ranked[0] ?? null,
  )
  /** This decides whether setup or results appears. */
  const resultReady = $derived(!!result && !!winner)
  const runnersUp = $derived(ranked.filter((row) => row !== winner))
  /** Screen order: recommendation, then rest (what gets saved). */
  const presented = $derived(winner ? [winner, ...runnersUp] : ranked)
  const unspent = $derived(
    winner
      ? totals(winner.plan).filter((t) => Number.isFinite(t.remaining) && t.remaining > 0)
      : [],
  )
  /** Phase 2 proposed plan 1, phase 3 measured something else ahead; measurement only, tie-break has own banner. */
  const reordered = $derived(ranked.length > 0 && ranked[0].id !== 'plan-0')
  const modelledInWinner = $derived(
    winner ? winner.plan.ids.filter((id) => modelledIds.has(id)).length : 0,
  )
  const skippedRows = $derived(skipped.map((row) => ({
    ...row,
    label: stepsById.get(row.id)
      ? `${slotLabels[row.slot] ?? row.slot} — ${stepsById.get(row.id)!.trackLabel} ${stepsById.get(row.id)!.toRank}`
      : row.id,
  })))

  function lines(plan: CrestPlan) {
    return planLines(plan, stepsById, currencies, { slotLabels, names: app.resolved, modelled: modelledIds })
  }
  function totals(plan: CrestPlan) {
    return planTotals(plan, budget.amounts, currencies)
  }
  function planItems(plan: CrestPlan): ItemInstance[] {
    return plan.ids.flatMap((id) => { const s = stepsById.get(id); return s ? [s.item as ItemInstance] : [] })
  }
  function planSlots(plan: CrestPlan): GearSlot[] {
    return plan.ids.flatMap((id) => { const s = stepsById.get(id); return s ? [s.slot] : [] })
  }
  /** Empty means unset, not zero (see crestPlanning). */
  function setAmount(into: Record<number, number>, id: number, raw: string): void {
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(value)) delete into[id]
    else into[id] = Math.max(0, Math.round(value))
  }
  const gold = (copper: number) => fmtInt(Math.floor(copper / 10_000))
  const amount = (n: number) => (Number.isFinite(n) ? fmtInt(n) : 'no limit')

  /** Highest fraction reached so far; estimate only improves, never regresses. */
  let peakFraction = $state(0)
  function fractionOf(p: OptimizationProgress | null, phase: number): number {
    // phaseFraction weights phases by engine cost, not equal thirds (P1 85% clock / 11% bar).
    return phaseFraction(p, phase)
  }
  /** Across whole run by phase (what user counts); floor moves in onProgress, phase transition still walks ring. */
  const runFraction = $derived(
    phaseIndex ? Math.max(peakFraction, fractionOf(progress, phaseIndex)) : undefined,
  )
  /** The engine's own pass name, shown under the phase rather than instead of it. */
  const enginePass = $derived(
    progress ? `Engine pass: ${progress.stageLabel} · batch ${progress.batchIndex + 1} of ${progress.batchCount}` : '',
  )

  onDestroy(() => {
    const what = teardownCancellation({
      running, ownedJobId, activeJobId: app.job?.id, engineBusy: engineBusy(),
    })
    if (what.abort) cancelRun?.()
    if (what.forceCancel) cancelActiveJob('the screen running this plan was closed')
  })
</script>

{#if !character}
  <section class="empty stack">
    <h1>No character yet</h1>
    <p class="muted">Crest Sim spends your crests on the gear you already have equipped.</p>
    <p><a href={href('character')}>Import one</a>.</p>
  </section>
{:else}
  <div class="stack">
    {#if !running && (!resultReady || setupOpen)}
    <section class="panel stack setup" hidden={running}>
      <header>
        <div class="stack-sm">
          <h1>Crest Sim</h1>
          <p class="muted small">
            {stored?.label ?? character.name} · {crestSeason.name}
            · {affordableSteps.length} of {space.steps.length} upgrades within budget
            · {crestSettings.fightStyle} · {crestSettings.targets}T · {crestSettings.maxTime}s
          </p>
        </div>
        <div class="run-actions">
          {#if resultReady && !running}
            <button class="ghost sm" onclick={() => (setupOpen = false)}>Back to result</button>
          {/if}
          {#if running}
            <button class="danger" onclick={() => cancelRun?.()}>Cancel</button>
          {:else}
            <button class="primary" onclick={go} disabled={!canRun}>
              Plan {affordableSteps.length ? fmtInt(affordableSteps.length) + ' upgrades' : ''}
            </button>
          {/if}
        </div>
      </header>

      {#if !profilesetsSupported() && app.capabilityChecked}
        <Banner kind="warn" title="This engine build cannot run variants in one pass">
          <p>
            The single-threaded fallback compiles out the engine's variant support, so Crest Sim
            cannot measure upgrades against one another. Reload on a host that can send the
            cross-origin isolation headers to get the threaded build.
          </p>
        </Banner>
      {/if}

      <!-- BUDGET. Every figure below says where it came from; nothing is assumed. -->
      <section class="stack-sm">
        <h2 class="small">Budget</h2>
        {#if !heldFromImport}
          <Banner kind="warn" title="This export carries no crest amounts">
            <p>
              The addon did not write an <code>upgrade_currencies</code> line, so nothing is known
              about what you hold. Type the amounts in below — Frostsim will not guess them.
            </p>
          </Banner>
        {/if}
        <div class="tbl-scroll">
          <table class="tbl">
            <caption class="sr-only">Crests available, and where each figure came from</caption>
            <thead>
              <tr>
                <th scope="col">Crest</th>
                <th scope="col" class="n">Held</th>
                {#if crestPlanning.planAhead}
                  <th scope="col" class="n">Per week</th>
                  <th scope="col" class="n">At season start</th>
                {/if}
                <th scope="col" class="n">Available</th>
                <th scope="col">Where it came from</th>
              </tr>
            </thead>
            <tbody>
              {#each budget.sources as source (source.currencyId)}
                <tr>
                  <th scope="row">{source.name}</th>
                  <td class="n">
                    <label>
                      <span class="sr-only">{source.name} held</span>
                      <input
                        class="num-input" type="number" min="0" step="1" disabled={busy}
                        value={source.held}
                        onchange={(e) => crestPlanning.held[source.currencyId] = Math.max(0, Number(e.currentTarget.value) || 0)}
                      />
                    </label>
                  </td>
                  {#if crestPlanning.planAhead}
                    <td class="n">
                      <label>
                        <span class="sr-only">{source.name} earned per week</span>
                        <input
                          class="num-input" type="number" min="0" step="1" disabled={busy}
                          placeholder="unknown"
                          value={crestPlanning.perWeek[source.currencyId] ?? ''}
                          onchange={(e) => setAmount(crestPlanning.perWeek, source.currencyId, e.currentTarget.value)}
                        />
                      </label>
                    </td>
                    <td class="n">
                      <label>
                        <span class="sr-only">{source.name} granted at season start</span>
                        <input
                          class="num-input" type="number" min="0" step="1" disabled={busy}
                          placeholder="unknown"
                          value={crestPlanning.startQuantity[source.currencyId] ?? ''}
                          onchange={(e) => setAmount(crestPlanning.startQuantity, source.currencyId, e.currentTarget.value)}
                        />
                      </label>
                    </td>
                  {/if}
                  <td class="n"><b>{amount(source.total)}</b></td>
                  <td class="small muted">{source.note}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="row">
          <label class="check small">
            <input type="checkbox" bind:checked={crestPlanning.planAhead} disabled={busy} />
            Plan ahead to a later week
          </label>
          {#if crestPlanning.planAhead}
            <label class="field">
              <span>Season week</span>
              <input
                type="number" min="1" max="52" disabled={busy}
                value={crestPlanning.week + 1}
                onchange={(e) => crestPlanning.week = Math.min(51, Math.max(0, (Number(e.currentTarget.value) || 1) - 1))}
              />
            </label>
            <label class="check small" title="Blizzard removes the weekly crest cap by hotfix. No game data records the date, so it is a switch here.">
              <input type="checkbox" bind:checked={crestPlanning.capRemoved} disabled={busy} />
              Weekly cap removed
            </label>
          {/if}
        </div>
        {#if crestPlanning.planAhead}
          <p class="xs muted">
            <b>Per week and at season start are not verified game data.</b> No client table and no
            published Blizzard statement gives a season {crestSeason.id} crest cap, so Frostsim will
            not supply one. Read the numbers off the in-game currency tooltip and type them in;
            a crest left blank is simply left out of the plan-ahead figure.
          </p>
        {/if}
        <p class="xs muted">
          {#if seasonStartsAt && currentWeek !== null}
            Season started {new Date(seasonStartsAt).toLocaleDateString()}; you are in week {currentWeek + 1}.
          {:else}
            The season start is not in this build, so the current week is unknown and has to be chosen.
          {/if}
          {#if character.highWatermarks?.length}
            High-watermark discounts are applied: a rank your slot has already reached costs no
            crests, only gold.
          {:else}
            This export carries no slot high watermarks, so every cost here is the full one.
          {/if}
          {#if undiscountable.length}
            No discount is applied to {undiscountable.join(', ')} — the game's watermark enum splits
            weapons by weapon class, which this data does not state.
          {/if}
        </p>
        {#each budget.warnings as note, i (i)}
          <p class="xs warn-text">{note}</p>
        {/each}
        {#each costUnavailable as note, i (i)}
          <p class="xs muted">{note}</p>
        {/each}
      </section>

      {#if space.excluded.length}
        <details class="disclosure">
          <summary>{space.excluded.length} item{space.excluded.length === 1 ? '' : 's'} or rank{space.excluded.length === 1 ? '' : 's'} left out</summary>
          <ul class="xs plain">
            {#each space.excluded as row, i (i)}
              <li>
                <b>{slotLabels[row.slot] ?? row.slot}</b> — {row.itemName}{#if row.rank !== null} rank {row.rank}{/if}: {row.reason}
              </li>
            {/each}
          </ul>
        </details>
      {/if}

      {#if !affordableSteps.length && space.steps.length > 0}
        <Banner kind="info" title="Nothing is affordable with this budget">
          <p>Every upgrade in reach costs more than the crests above. Raise the amounts or plan ahead to a later week.</p>
        </Banner>
      {/if}

      <details class="disclosure">
        <summary>Simulation settings</summary>
        <div class="stack-sm">
          <label class="field">
            <span>Measurement precision (%)</span>
            <input
              type="number" min="0.01" max="1" step="0.01" disabled={busy}
              value={crestPlanning.anchorTargetError}
              onchange={(e) => {
                const v = Number(e.currentTarget.value)
                if (Number.isFinite(v)) crestPlanning.anchorTargetError = Math.min(1, Math.max(0.01, v))
              }}
            />
            <span class="hint">
              How precisely each item's top rank is measured in phase 1, in percent of DPS, and the
              loosest phase 3 may be. One item's whole upgrade is worth a few hundred DPS, so a
              coarse setting here lets noise decide which items enter the plan. A chosen default,
              not a number from game data. The run uses {anchorTargetError}%, and phase 3 goes
              finer still when the plans it has to separate are close together — never coarser.
            </span>
          </label>
          <p class="hint">
            The accuracy field below caps how loose this run may be and nothing else. It cannot
            make Crest Sim coarser than the precision above, and on a measured run the engine
            bottoms out around 0.33% no matter what is asked for, so any value between there and
            its 10% maximum changes neither the cost nor the answer.
          </p>
          <SettingsForm settings={crestSettings} {character} staged perCandidate />
        </div>
      </details>
    </section>
    {/if}

    {#if running}
      <RunStatus
        title="Crest Sim · {character.name}"
        stage={phaseLabel}
        fraction={runFraction}
        summary={phaseDetail}
        statusDetail={[enginePass, measuredCount ? `${measuredCount} measurements` : '']
          .filter(Boolean)
          .join(' · ')}
        {elapsed}
        log={engineLog}
        oncancel={() => cancelRun?.()}
      />
    {/if}

    {#if error}
      <Banner kind={app.job?.status === 'cancelled' ? 'info' : 'bad'} title="Run stopped" live>
        <p>{error}</p>
      </Banner>
    {/if}

    {#if result && winner && !running && !setupOpen}
      {@const notes = [...new Set([...result.warnings, ...budget.warnings])]}
      <section class="stack" id="result">
        <div><button class="ghost sm" onclick={() => (setupOpen = true)}>← Back to setup</button></div>
        <div class="stack-sm">
          <h1>Crest Sim results</h1>
          <p class="muted small">
            {stored?.label ?? character.name} · {crestSeason.name}
            · {winner.plan.ids.length} upgrade{winner.plan.ids.length === 1 ? '' : 's'} recommended
            · {ranSettings.fightStyle} · {ranSettings.targets}T · {ranSettings.maxTime}s
          </p>
        </div>
        {#if result.incomplete}
          <Banner kind="warn" title="This run did not finish">
            <p>{result.incomplete.message}</p>
          </Banner>
        {/if}
        {#if result.budgetExhausted}
          <Banner kind="warn" title="The search stopped on its budget, not on an answer">
            <p>Some plans are still separated by less than their error bars.</p>
          </Banner>
        {/if}
        {#if !solverExhaustive}
          <Banner kind="warn" title="The plan search was truncated">
            <p>Too many combinations to enumerate exhaustively, so these are the best plans found, not provably the best possible.</p>
          </Banner>
        {/if}
        {#if reordered}
          <Banner kind="info" title="Simulating the whole plans changed the order">
            <p>
              The plan below is not the one the budget maths put first. Upgrade gains do not
              simply add up, so phase 3 simulates each plan as a complete set and that
              measurement decides — not the estimate that proposed it.
            </p>
          </Banner>
        {/if}
        {#if winner.tied || tieBroken}
          <Banner kind="warn" title="These plans are tied within this precision">
            <p>
              The leading plans sit inside one another's error bars, so the DPS figures cannot
              order them.
              {#if tieHasDominance}
                Frostsim therefore recommends the plan that spends crests on strictly higher ranks:
                it buys everything a tied plan buys and more, for the same budget, so it cannot be
                the worse choice whichever way the noise fell.
              {:else}
                Every tied plan buys a different set of ranks, so none of them is strictly better
                than the others; any is a defensible choice.
              {/if}
              Tighten the accuracy setting to separate them properly.
            </p>
          </Banner>
        {/if}
        {#if notes.length}
          <Banner kind="warn" title={notes.length === 1 ? 'Note' : `${notes.length} notes`}>
            <ul class="xs plain">{#each notes as w, i (i)}<li>{w}</li>{/each}</ul>
          </Banner>
        {/if}
        {#if result.problems.length}
          <Banner kind="bad" title="The engine reported problems during this search">
            <ul class="xs plain">{#each result.problems as p, i (i)}<li>{p}</li>{/each}</ul>
          </Banner>
        {/if}

        <section class="panel stack-sm">
          <div class="spread">
            <h2 class="small">
              Spend your crests here
              {#if winner.plan.ids.some((id) => stepsById.get(id)?.item.upgradeTrackHypothetical)}
                <span class="chip warn">hypothetical</span>
              {/if}
            </h2>
            <span class="small muted">
              {#if result.baseline}Current gear <b class="num">{fmtInt(result.baseline.mean)}</b>{/if}
              {#if winner.gain}
                →
                <b class="num" class:gain={winner.gain.absolute > 0 && winner.gain.significant !== false}>
                  {fmtInt(winner.mean ?? 0)}
                </b>
                <span class="chip">{fmtDelta(winner.gain.absolute)}{#if winner.gain.percent !== null} ({fmtDeltaPct(winner.gain.percent)}){/if}</span>
                {#if winner.gain.significant === false}<span class="chip warn">inside the error bars</span>
                {:else if winner.gain.margin !== null}<span class="faint">±{fmtInt(winner.gain.margin)}</span>{/if}
              {/if}
            </span>
          </div>

          <GearStrip
            items={character.equipped}
            resolvedItems={app.resolved}
            changed={planSlots(winner.plan)}
          />

          <ol class="plan">
            {#each lines(winner.plan) as line (line.stepId)}
              <li>
                <span class="slot">{line.slotLabel}</span>
                <span class="what">
                  <b>{line.itemName}</b>
                  <span class="muted">{line.trackLabel} {line.fromRank}/{line.maxRank} → {line.toRank}/{line.maxRank}</span>
                  <span class="chip xs">+{line.ilvlDelta} ilvl</span>
                  {#if line.hypothetical}<span class="chip warn xs">hypothetical</span>{/if}
                  {#if line.modelled}<span class="chip xs" title="This rank's value was estimated from the same item measured at its top rank. The plan as a whole was simulated.">estimated rank</span>{/if}
                </span>
                <span class="cost">
                  {#each line.costs as c (c.currencyId)}
                    <span class="chip xs">{fmtInt(c.amount)} {c.name}</span>
                  {:else}
                    <span class="muted xs">no crests</span>
                  {/each}
                </span>
              </li>
            {/each}
          </ol>

          <div class="tbl-scroll">
            <table class="tbl">
              <caption class="sr-only">What this plan spends, against the budget</caption>
              <thead>
                <tr><th scope="col">Crest</th><th scope="col" class="n">Spent</th><th scope="col" class="n">Budget</th><th scope="col" class="n">Left</th></tr>
              </thead>
              <tbody>
                {#each totals(winner.plan) as t (t.currencyId)}
                  <tr>
                    <th scope="row">{t.name}</th>
                    <td class="n">{fmtInt(t.spent)}</td>
                    <td class="n">{amount(t.budget)}</td>
                    <td class="n">{amount(t.remaining)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if unspent.length}
            <p class="xs muted">
              {unspent.map((t) => `${fmtInt(t.remaining)} ${t.name}`).join(', ')} left unspent —
              nothing this plan could buy with {unspent.length === 1 ? 'them' : 'those'} measured as
              an improvement, or the ranks they would reach are already bought.
            </p>
          {/if}
          <p class="xs muted">
            Gold is charged on top of the crests and is not part of the budget:
            this plan costs {gold(planMoney(winner.plan, stepsById))} gold.
            {anchorCount} item{anchorCount === 1 ? ' was' : 's were'} simulated at their top
            rank to build it{#if modelledInWinner}, and {modelledInWinner} of the rows above land on
            an intermediate rank whose value was estimated from that measurement rather than
            simulated on its own{/if}. The plan itself was simulated in full, so the DPS figure
            above is measured.
          </p>
        </section>

        {#if runnersUp.length}
          <section class="panel stack-sm">
            <h2 class="small">Other plans <span class="chip">{runnersUp.length}</span></h2>
            {#each runnersUp as row (row.id)}
              <details class="disclosure">
                <summary>
                  {row.label} —
                  {#if row.mean !== null}
                    {fmtInt(row.mean)} DPS
                    {#if row.gain}<span class="muted">({fmtDelta(row.gain.absolute)}{#if row.gain.percent !== null}, {fmtDeltaPct(row.gain.percent)}{/if})</span>{/if}
                  {:else}
                    <span class="muted">{row.status}</span>
                  {/if}
                  {#if row.tied}<span class="chip warn xs">tied with the leader</span>{/if}
                </summary>
                <ul class="xs plain">
                  {#each lines(row.plan) as line (line.stepId)}<li>{line.text}</li>{/each}
                </ul>
                <GearStrip items={planItems(row.plan)} resolvedItems={app.resolved} inline />
              </details>
            {/each}
          </section>
        {/if}

        {#if skippedRows.length || unmeasuredSlots.length || notSeparable.length}
          <details class="disclosure">
            <summary>{skippedRows.length + unmeasuredSlots.length + notSeparable.length} upgrade{skippedRows.length + unmeasuredSlots.length + notSeparable.length === 1 ? '' : 's'} no plan bought</summary>
            <ul class="xs plain">
              {#each unmeasuredSlots as slot, i (i)}
                <li><b>{slotLabels[slot] ?? slot}</b> — the engine returned no result for it, so nothing was estimated from it.</li>
              {/each}
              {#each skippedRows as row (row.id)}
                <li><b>{row.label}</b> — {row.reason}.</li>
              {/each}
              {#each notSeparable as id, i (i)}
                {@const step = stepsById.get(id)}
                {#if step}
                  <li>
                    <b>{slotLabels[step.slot] ?? step.slot} — {step.trackLabel} {step.toRank}</b> —
                    measured at or below your current gear but not separable from it at this
                    precision, so it stayed eligible and was simply never preferred.
                  </li>
                {/if}
              {/each}
            </ul>
          </details>
        {/if}
        {#if engineLog.length}
          <details class="disclosure"><summary>SimulationCraft log</summary><SimLog lines={engineLog} /></details>
        {/if}
      </section>
    {/if}
  </div>
{/if}

<style>
  .setup header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .run-actions { display: flex; gap: 8px; align-items: center; }
  .num-input { width: 7ch; }
  .plan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; counter-reset: step; }
  .plan li { display: grid; grid-template-columns: 9ch 1fr auto; gap: 12px; align-items: baseline; padding: 8px 10px; border-radius: 8px; background: var(--surface-2, transparent); }
  .plan .slot { color: var(--text-muted); font-size: 12px; }
  .plan .what { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; min-width: 0; }
  .plan .cost { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .warn-text { color: var(--warn, var(--text-muted)); }
  @media (max-width: 640px) {
    .plan li { grid-template-columns: 1fr; gap: 4px; }
    .plan .cost { justify-content: flex-start; }
  }
</style>
