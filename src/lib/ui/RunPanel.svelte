<script lang="ts">
  // Live job state: download, initialisation, simulated-fight as distinct phases (P06.3); no fabricated percentages.
  import { app, isBusy } from '../app.svelte'
  import { engineSlotSupported } from '../simc/client'

  // Whether waiting for another tab is FACT (Web Locks) or guess (no lock = nothing prevented, claim is unproven).
  const slotIsCrossTab = engineSlotSupported()
  import { cancelRun, run, STATUS_LABELS } from '../job.svelte'
  import { fractionOf, highWater } from './progress'
  import { remainingSeconds, runFraction } from '../simc/cost'
  import { fmtBytes, fmtInt, fmtPct, fmtSeconds } from '../format'
  import Banner from './Banner.svelte'
  import RunStatus from './RunStatus.svelte'
  import SimLog from './SimLog.svelte'

  const job = $derived(app.job)
  // A blocked engine keeps the tab busy, but a job that already ended shows its outcome, not a live run.
  const busy = $derived(isBusy() && !(job && ['complete', 'error', 'cancelled'].includes(job.status)))
  const p = $derived(run.progress)
  const configuration = $derived(run.request?.mode === 'raw' ? 'Custom SimC input' : run.request?.settings.fightStyle === 'DungeonRoute' ? 'Dungeon Route · runs through the final pull' : run.request ? `${run.request.settings.fightStyle.replace(/([a-z])([A-Z])/g, '$1 $2')} · ${fmtSeconds(run.request.settings.maxTime)} · ${run.request.settings.targets} target${run.request.settings.targets === 1 ? '' : 's'}` : '')

  // The whole run, not the current phase: finished characters, candidates or stats plus this one's share, a target error phase
  // judged by the iterations it still needs (cost.ts runFraction).
  const whole = $derived(run.outcome === null && job?.status === 'running' && run.request ? runFraction(p, run.request.accuracy) : undefined)

  // A rising error estimate can pull the projection back; the bar keeps its furthest point (never 1 before the engine says so).
  let best = $state<number | undefined>(undefined)
  $effect(() => {
    if (!busy) { best = undefined; return }
    best = highWater(best, whole === undefined ? undefined : Math.min(0.99, whole))
  })

  // Engine's iteration counter drives bar only; asset download has own, initializing has none (indeterminate = honest).
  const fraction = $derived(
    job?.status === 'running' ? (best ?? fractionOf(p))
      : job?.status === 'acquiring' && run.assetProgress?.total && !run.assetProgress.cached
        ? run.assetProgress.done / run.assetProgress.total
        : undefined,
  )

  let showLog = $state(false)
  let logExpanded = $state(false)
  let elapsed = $state(0)
  $effect(() => {
    if (!busy || !job) { elapsed = 0; return }
    const started = job.startedAt
    elapsed = (Date.now() - started) / 1000
    const t = setInterval(() => { elapsed = (Date.now() - started) / 1000 }, 1000)
    return () => clearInterval(t)
  })
  // Time left at this run's own pace since its first progress, so engine start-up and cloud queueing do not skew it.
  let simulatingSince = $state<number | undefined>(undefined)
  $effect(() => {
    if (!busy) simulatingSince = undefined
    else if (p && simulatingSince === undefined) simulatingSince = elapsed
  })
  const eta = $derived(simulatingSince === undefined ? undefined : remainingSeconds(best, elapsed - simulatingSince))
</script>
{#if job && busy && !app.engineStopping}<RunStatus title={job.title} stage={STATUS_LABELS[job.status]} summary={configuration} statusDetail={p?.iterations ? (p.base === 'Hybrid' ? `${p.phase} parts done` : fmtInt(p.iterations) + ' iterations' + (p.phaseTotal > 1 ? ` · ${p.phaseIndex} of ${p.phaseTotal}` : '')) + (eta !== undefined ? ' · ≈ ' + fmtSeconds(Math.ceil(eta)) + ' remaining' : '') : job.stage?.label ?? ''} {fraction} {elapsed} log={run.log} metrics={p} oncancel={cancelRun} />
{#if import.meta.env.VITE_FEATURE_ACCOUNTS === true}{#await import('../account/CloudNudge.svelte') then m}<m.default {elapsed} />{/await}{/if}
{:else if run.error}<Banner kind={job?.status === 'cancelled' ? 'info' : 'bad'} title={run.error.message} live>{#if run.error.detail}<details><summary>Details</summary><pre>{run.error.detail}</pre></details>{/if}</Banner>{/if}
{#if run.error && !busy && run.log.length}<details class="disclosure"><summary>SimulationCraft log</summary><SimLog lines={run.log} /></details>{/if}
