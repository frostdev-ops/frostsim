// Run-duration estimates from device history (P06.3): iterations vs seconds on real runs, no guesses.

import type { ReportSummary, StoredReport } from './store/records'
import type { OptimizationProgress, StagePlan } from './optimization/types'

export type SearchTiming = NonNullable<ReportSummary['searchTiming']>

/** Includes the baseline repeated in each batch; survivor counts are estimates. */
export function estimateSearchSeconds(
  reports: readonly StoredReport[], candidates: number, plan: StagePlan,
  progress: OptimizationProgress | null = null, timing: SearchTiming | null = null,
): { seconds: number; ceiling: boolean } | null {
  const rate = timing?.iterationsPerSecond ?? observedRate(reports)?.seconds
  if (!rate || !Number.isFinite(rate) || rate <= 0 || candidates <= 0) return null
  let entering = progress?.candidatesRemaining ?? candidates
  let work = 0
  let ceiling = false
  for (let i = progress?.stageIndex ?? 0; i < plan.stages.length; i++) {
    const stage = plan.stages[i]
    const remaining = Math.max(0, entering - (i === progress?.stageIndex ? progress.batchIndex * stage.batchSize : 0))
    const accuracy = stage.accuracy
    let samples: number
    if (accuracy.mode === 'iterations') samples = accuracy.iterations
    else {
      const projected = timing?.errorPct && timing.iterations > 0
        ? timing.iterations * (timing.errorPct / accuracy.targetError) ** 2
        : iterationsForTarget(reports, accuracy.targetError)
      if (projected === null) ceiling = true
      samples = Math.min(accuracy.maxIterations, Math.max(plan.minIterations, projected ?? accuracy.maxIterations))
    }
    work += (remaining + Math.ceil(remaining / stage.batchSize)) * samples
    entering = Math.min(entering, stage.maxSurvivors)
  }
  return { seconds: work / rate, ceiling }
}

export interface Estimate {
  seconds: number
  /** How many past runs the estimate is built from. Fewer than 3 is a guess. */
  samples: number
  /** Spread across those samples, so the UI can widen or withhold the claim. */
  low: number
  high: number
}

/** Iterations per second, from one completed run, when both are usable. */
function rateOf(summary: ReportSummary | undefined): number | null {
  const iterations = summary?.actualIterations
  const seconds = summary?.elapsedSeconds
  if (!iterations || !seconds || !Number.isFinite(iterations) || !Number.isFinite(seconds)) {
    return null
  }
  if (iterations <= 0 || seconds <= 0) return null
  return iterations / seconds
}

/**
 * How fast this device has actually run simulations, from the most recent runs.
 *
 * Recent only: a thread-count change, a different engine build, or simply a
 * machine under different load makes an old sample misleading, and averaging
 * over months hides exactly the change a user would want reflected.
 */
export function observedRate(reports: readonly StoredReport[], take = 8): Estimate | null {
  const rates: number[] = []
  for (const r of reports) {
    const rate = rateOf(r.summary)
    if (rate !== null) rates.push(rate)
    if (rates.length >= take) break
  }
  if (!rates.length) return null
  const sorted = [...rates].sort((a, b) => a - b)
  // Median not mean: outlier runs (build, video call) don't skew it.
  const mid = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  return { seconds: mid, samples: rates.length, low: sorted[0], high: sorted[sorted.length - 1] }
}

/**
 * Seconds a run of `iterations` is likely to take on this device, with the
 * range the observed spread supports.
 *
 * Returns null when there is nothing to learn from, and the caller must then say
 * the duration is unknown rather than substitute a constant.
 */
export function estimateSeconds(
  reports: readonly StoredReport[],
  iterations: number,
): Estimate | null {
  if (!iterations || !Number.isFinite(iterations) || iterations <= 0) return null
  const rate = observedRate(reports)
  if (!rate) return null
  return {
    seconds: iterations / rate.seconds,
    samples: rate.samples,
    // Fastest run = shortest time; bounds invert.
    low: iterations / rate.high,
    high: iterations / rate.low,
  }
}

/** Target-error run has no iteration count in advance; converts target to iterations needed; 1/error² scaling from engine. */
export function iterationsForTarget(
  reports: readonly StoredReport[],
  targetError: number,
): number | null {
  if (!targetError || !Number.isFinite(targetError) || targetError <= 0) return null
  for (const r of reports) {
    const iterations = r.summary?.actualIterations
    const reached = r.summary?.targetReached
    const past = r.summary?.confidenceMargin && r.summary?.dps
      ? (r.summary.confidenceMargin / r.summary.dps) * 100
      : null
    // Only a run that actually reached its target tells us what that target
    // costs; one that stopped at a ceiling says nothing about the rest.
    if (!iterations || reached !== true || past === null || past <= 0) continue
    return Math.round(iterations * (past / targetError) ** 2)
  }
  return null
}
