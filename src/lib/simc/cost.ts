// Progress across independently measured phases; projection never establishes completion.
import { simcTokens, type Accuracy } from './options'
import { assembleRun, type SimRequest } from './assemble'
import type { EngineProgress } from './progress'

/** Character/role decomposition is valid only when the effective engine options make actors independent. */
export function canSplitCharacters(req: SimRequest): boolean {
  // Use the actual assembly order: profile/slots first, guided defaults next,
  // expert arguments last. A single_actor_batch=0 argument wins in guided mode.
  const run = assembleRun(req, 1, null)
  let independent = false
  for (const text of [run.profile, ...run.args]) {
    for (const line of text.split('\n')) {
      if (line.trimStart().startsWith('#')) continue
      for (const token of simcTokens(line)) {
        if (token.startsWith('single_actor_batch=')) {
          // Unknown/template-dependent values cannot establish independence.
          independent = token.slice('single_actor_batch='.length) === '1'
        }
      }
    }
  }
  return independent
}

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
