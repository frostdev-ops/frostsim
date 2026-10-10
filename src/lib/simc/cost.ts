// Progress across independently measured phases; projection never establishes completion.
import type { Accuracy } from './options'
import type { EngineProgress } from './progress'

export function runFraction(p: EngineProgress | null, accuracy: Accuracy): number | undefined {
  if (!p || !(p.phaseTotal > 0)) return undefined
  let within: number
  if (p.finished) within = 1
  else if (p.iterations === undefined) within = 0
  else if (accuracy.mode === 'targetError' && p.errorPct! > 0 && p.iterations > 0) {
    const needed = Math.min(accuracy.maxIterations, Math.max(p.iterations, p.iterations * (p.errorPct! / accuracy.targetError) ** 2))
    within = p.iterations / needed
  } else within = p.iterationTotal ? p.iterations / p.iterationTotal : 0
  const done = p.base === 'Profilesets' ? p.phaseIndex : p.phaseIndex - 1 + within
  return Math.max(0, Math.min(1, done / p.phaseTotal))
}

export function remainingSeconds(fraction: number | undefined, elapsedS: number): number | undefined {
  if (fraction === undefined || fraction < 0.02 || elapsedS <= 0) return undefined
  return elapsedS * (1 - fraction) / fraction
}
