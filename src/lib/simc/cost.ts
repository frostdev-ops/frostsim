// Run cost model (CLAUDE.md D14): how much engine work a request is, how long one side takes for it, and how far a running one is.
// Pure, and shared by the browser (run progress, hybrid splits) and the account server (cloud speed, queue waits).
//
// Work is counted in units of one iteration of one simulated second: a run is `pieces` independent sims (candidates and their
// baseline, characters, stat weight runs) of `iterations` each, every iteration simulating about `maxTime` seconds. A side's
// speed is a fixed start-up plus seconds per unit per thread, fitted from its own finished runs.

import type { SimRequest } from './assemble'
import type { Accuracy } from './options'
import type { EngineProgress } from './progress'
import type { SimReport } from './report'
import { characterBlocks } from './multi-actor'

/** simc's default confidence estimator: target_error is this many standard errors as a percentage of the mean. */
export const Z = 1.96

/** What a run was split into. */
export type SplitKind = 'candidates' | 'characters' | 'stats'

const PRIMARY = new Set(['strength', 'agility', 'intellect'])
export const SCALE_ONLY = /^\s*scale_only\s*=\s*(.*)$/

/** A stat weights run's stats (`scale_only`), and the ones both sides must run: the primary stats when weights are normalized. */
export function scaleStats(extraOptions: readonly string[]): { stats: string[]; both: string[] } | null {
  if (!extraOptions.some((o) => /^\s*calculate_scale_factors\s*=\s*1\s*$/.test(o))) return null
  const listed = extraOptions.map((o) => SCALE_ONLY.exec(o)?.[1]).filter((v) => v !== undefined).at(-1)
  if (!listed) return null
  // Engine splits on ",:;/|" (scale_factor_control.cpp).
  const all = listed.split(/[,:;/|]/).map((v) => v.trim()).filter(Boolean)
  const normalized = extraOptions.some((o) => /^\s*normalize_scale_factors\b/.test(o))
  const both = normalized ? all.filter((v) => PRIMARY.has(v.toLowerCase())) : []
  return { stats: all.filter((v) => !both.includes(v)), both }
}

/** How a request splits into independent pieces, or null when it has fewer than two. Candidates win over characters. */
export function splitOf(req: SimRequest): { kind: SplitKind; pieces: number } | null {
  if ((req.profilesets?.length ?? 0) >= 2) return { kind: 'candidates', pieces: req.profilesets!.length }
  if (req.mode === 'raw' || req.profilesets?.length) return null
  const stats = scaleStats(req.extraOptions ?? [])
  if (stats) return stats.stats.length >= 2 ? { kind: 'stats', pieces: stats.stats.length } : null
  const characters = characterBlocks(req.profile).length
  return characters >= 2 ? { kind: 'characters', pieces: characters } : null
}

/** Pieces of a split that every share runs again: a candidate run's baseline, a stat weights run's baseline and primary stats. */
export function sharedPieces(req: SimRequest, kind: SplitKind): number {
  return kind === 'candidates' ? 1 : kind === 'stats' ? 1 + scaleStats(req.extraOptions ?? [])!.both.length : 0
}

export interface Work {
  fightStyle: string
  /** Independent sims in the run. */
  pieces: number
  /** Simulated seconds per iteration: the fight length (a Dungeon Route's is its cap; the fit absorbs the difference). */
  simSeconds: number
  accuracy: Accuracy
}

/** The work a request asks for. A split run's pieces include what is shared (the baseline); a raw script is one sim of its own. */
export function workOf(req: SimRequest): Work {
  const split = splitOf(req)
  const pieces = split ? split.pieces + sharedPieces(req, split.kind) : req.profilesets?.length ? req.profilesets.length + 1 : 1
  return { fightStyle: req.settings.fightStyle, pieces, simSeconds: Math.max(1, req.settings.maxTime), accuracy: req.accuracy }
}

/** Iterations each piece runs: fixed, or what `cv` (DPS standard deviation over mean) needs to reach the target error. Null when
 *  unknown: a target with no measured variance, or a script. */
export function iterationsFor(accuracy: Accuracy, cv?: number | null): number | null {
  if (accuracy.mode === 'iterations') return accuracy.iterations
  if (accuracy.mode !== 'targetError' || !(cv! > 0)) return null
  return Math.min(accuracy.maxIterations, Math.max(1, Math.ceil(((Z * cv! * 100) / accuracy.targetError) ** 2)))
}

/** Units of work for `pieces` pieces (all of them by default). */
export const unitsOf = (work: Work, iterations: number, pieces = work.pieces) => pieces * iterations * work.simSeconds

/** DPS standard deviation over mean, from a result's 95% margin and its iterations. */
export function cvOf(mean: number, margin: number, iterations: number): number | null {
  return mean > 0 && margin > 0 && iterations > 0 ? (margin * Math.sqrt(iterations)) / (Z * mean) : null
}

/** The work a finished report did, in units: each sim's actual iterations times the fight length. */
export function reportUnits(work: Work, report: Pick<SimReport, 'players' | 'profilesets'>): number {
  const counts = [...report.players.map((p) => p.dps.count), ...report.profilesets.map((p) => p.iterations)]
  // Stat weight runs repeat the baseline's iterations for every stat and report only the baseline.
  const done = counts.length >= work.pieces ? counts.reduce((a, b) => a + b, 0) : (counts[0] ?? 0) * work.pieces
  return done * work.simSeconds
}

/** A side's speed: wall seconds = overheadS + units x secondsPerUnit / threads. */
export interface Speed { overheadS: number; secondsPerUnit: number }
export interface SpeedSample { units: number; threads: number; wall: number }

export function secondsFor(speed: Speed, units: number, threads: number): number {
  return speed.overheadS + (units * speed.secondsPerUnit) / Math.max(1, threads)
}

/** Least squares over recent runs; with too few or too alike runs, no start-up and the median rate. Null with no usable run. */
export function fitSpeed(samples: readonly SpeedSample[]): Speed | null {
  const pts = samples.filter((s) => s.units > 0 && s.wall > 0 && s.threads > 0).map((s) => ({ x: s.units / s.threads, y: s.wall }))
  if (!pts.length) return null
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const fallback = { overheadS: 0, secondsPerUnit: median(pts.map((p) => p.y / p.x)) }
  if (pts.length < 3) return fallback
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0)
  if (sxx <= 0) return fallback
  const slope = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx
  const intercept = my - slope * mx
  // A negative start-up or a flat rate is noise from runs of one size: the median rate explains them no worse.
  if (!(slope > 0) || intercept < 0 || intercept > Math.min(...pts.map((p) => p.y))) return fallback
  return { overheadS: intercept, secondsPerUnit: slope }
}

/** How far a run is, 0 to 1, from its latest progress line: finished phases plus this phase's share. A target error phase's share
 *  is iterations so far over iterations needed at the current error, since error falls with the square root of iterations. */
export function runFraction(p: EngineProgress | null, accuracy: Accuracy): number | undefined {
  if (!p || !(p.phaseTotal > 0)) return undefined
  let within: number
  if (p.finished) within = 1
  else if (p.iterations === undefined) within = 0
  else if (accuracy.mode === 'targetError' && p.errorPct! > 0 && p.iterations > 0) {
    const needed = Math.min(accuracy.maxIterations, Math.max(p.iterations, p.iterations * (p.errorPct! / accuracy.targetError) ** 2))
    within = p.iterations / needed
  } else within = p.iterationTotal ? p.iterations / p.iterationTotal : 0
  // The parallel profileset line counts finished candidates in phaseIndex; every other line counts the phase it is on.
  const done = p.base === 'Profilesets' ? p.phaseIndex : p.phaseIndex - 1 + within
  return Math.max(0, Math.min(1, done / p.phaseTotal))
}

/** Seconds left at the pace so far, once there is enough of a run to judge it by. */
export function remainingSeconds(fraction: number | undefined, elapsedS: number): number | undefined {
  if (fraction === undefined || fraction < 0.02 || elapsedS <= 0) return undefined
  return (elapsedS * (1 - fraction)) / fraction
}
