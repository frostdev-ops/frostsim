// This device's measured engine speed and DPS spread (cost.ts), from its own finished runs, by fight style. A per-device
// convenience in localStorage: a blocked store only means estimates start from nothing, never a failed run.

import { cvOf, fitSpeed, reportUnits, workOf, type Speed, type SpeedSample } from './cost'
import type { SimRequest } from './assemble'
import type { SimReport } from './report'

const KEY = 'frostsim.speed.v1'
/** Recent runs kept per fight style: old ones describe a machine, thread count or engine that may have changed. */
const KEEP = 20
/** Weight of the newest run in the spread average. */
const ALPHA = 0.3

type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined
interface Saved {
  /** Runs by fight style. */
  runs: Record<string, SpeedSample[]>
  /** Average squared DPS spread (standard deviation over mean) by fight style: iterations needed grow with its square. */
  cv2: Record<string, number>
}

const defaultStore = (): Store => {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function load(store: Store): Saved {
  try {
    const saved = JSON.parse(store?.getItem(KEY) ?? 'null') as Saved | null
    return { runs: saved?.runs ?? {}, cv2: saved?.cv2 ?? {} }
  } catch {
    return { runs: {}, cv2: {} }
  }
}

function save(store: Store, saved: Saved): void {
  try {
    store?.setItem(KEY, JSON.stringify(saved))
  } catch { /* Storage blocked or full: this run teaches nothing. */ }
}

/** Remembers one run of this device's engine: its work against its wall time, and its players' DPS spread. */
export function recordSample(fightStyle: string, sample: SpeedSample, cvs: readonly number[], store: Store = defaultStore()): void {
  const saved = load(store)
  if (sample.units > 0 && sample.wall > 0) saved.runs[fightStyle] = [...(saved.runs[fightStyle] ?? []), sample].slice(-KEEP)
  const valid = cvs.filter((v) => v > 0 && Number.isFinite(v))
  if (valid.length) {
    const cv2 = valid.reduce((a, v) => a + v * v, 0) / valid.length
    const was = saved.cv2[fightStyle]
    saved.cv2[fightStyle] = was === undefined ? cv2 : was + ALPHA * (cv2 - was)
  }
  save(store, saved)
}

/** A finished run of this device's engine, from its request and report. `wallS`: measured from the start message when the caller
 *  has it; otherwise the engine's own elapsed time. */
export function recordRun(req: SimRequest, report: SimReport, wallS?: number, store: Store = defaultStore()): void {
  try {
    const work = workOf(req)
    const cvs = report.players.map((p) => (p.dps.stdDev !== undefined && p.dps.mean > 0 ? p.dps.stdDev / p.dps.mean : cvOf(p.dps.mean, p.dpsConfidence?.margin ?? 0, p.dps.count)))
    recordSample(work.fightStyle, { units: reportUnits(work, report), threads: report.options.threads, wall: wallS ?? report.timings.engineElapsedSeconds }, cvs.filter((v): v is number => v !== null), store)
  } catch { /* Learning never fails a run. */ }
}

/** This device's fitted speed for a fight style, from that style's own runs, or from every run before its first. */
export function localSpeed(fightStyle: string, store: Store = defaultStore()): Speed | null {
  const { runs } = load(store)
  const own = runs[fightStyle] ?? []
  return fitSpeed(own.length ? own : Object.values(runs).flat())
}

/** The DPS spread this device measured for a fight style, or null before its first run of it. */
export function localCv(fightStyle: string, store: Store = defaultStore()): number | null {
  const cv2 = load(store).cv2[fightStyle]
  return cv2 > 0 ? Math.sqrt(cv2) : null
}

/** recordRun for a raw simc JSON report, as a hybrid run's local chunks hand them over (only the fields the model reads). */
export function recordRawReport(req: SimRequest, bytes: ArrayBuffer, store: Store = defaultStore()): void {
  try {
    const sim = JSON.parse(new TextDecoder().decode(bytes)).sim
    const report = {
      players: (sim.players ?? []).map((p: { collected_data?: { dps?: { mean: number; count: number; std_dev?: number } } }) => {
        const d = p.collected_data?.dps
        return { dps: { mean: d?.mean ?? 0, count: d?.count ?? 0, stdDev: d?.std_dev } }
      }),
      profilesets: (sim.profilesets?.results ?? []).map((r: { iterations?: number }) => ({ iterations: r.iterations ?? 0 })),
      options: { threads: sim.options?.threads },
      timings: { engineElapsedSeconds: sim.statistics?.elapsed_time_seconds },
    } as unknown as SimReport
    recordRun(req, report, undefined, store)
  } catch { /* Learning never fails a run. */ }
}
