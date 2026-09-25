// How many candidates simc sims at once (`profileset_work_threads`, profileset.cpp:667). By default simc runs profilesets one after
// another, each spread across every thread, and on many threads most of that time goes to starting and merging threads: a
// 100-candidate batch used 27 % of 64 cores. With T work threads simc runs floor(threads / T) candidates side by side, each on T
// threads. Every candidate is still its own complete sim, so results do not change, only the wall time.
//
// Native, measured 2026-09-25 at 18429d2f, MID2_Mage_Frost, threads=64 on a c7a.16xlarge (docs/implementation/accounts.md):
//   100 x 400 iterations, DungeonSlice  sequential 15.1 s | T=1 4.0 | T=2 4.0 | T=4 3.7 | T=8 3.7 | T=16 4.4
//   100 x 400 iterations, Patchwerk     sequential 11.4 s | T=1 2.8 | T=2 2.7 | T=4 2.5 | T=8 2.6
//   100 x 1600 iterations, DungeonSlice sequential 24.3 s | T=1 14.5 | T=2 14.6 | T=4 13.5 | T=8 13.1 | T=16 13.6
//   16 x 4000 iterations, Patchwerk     sequential 5.0 s  | T=4 3.6 | T=8 3.6 | T=16 3.7 | T=32 4.0
//   7 x 2500 iterations, Patchwerk      sequential 1.9 s  | T=8 1.3 | T=9 1.2 | T=16 1.4 | T=32 1.5
// So: about 4 threads per candidate while candidates are plentiful, all candidates at once when they are few, and every thread used.
// The iteration count barely moved the best T at 64 threads. At 14 (native on an M-series Mac, 32 candidates) it decides whether
// parallel pays at all: 400 iterations sequential 1.97 s, T=1..7 1.60-1.75; 4000 iterations sequential 16.1 s, T=1..14 17.1-18.9.
//
// Browser: only T=1. The engine's main thread blocks inside callMain for the whole run, and emscripten hands every pthread_create
// made off that thread to it, so a worker sim that starts its own threads (T > 1) waits forever: in Chrome, threads=15/T=5 and
// threads=8/T=4 both hung right after the baseline. With T=1 the main thread starts and joins every worker itself, as it does its own
// children in sequential mode, and the pool bound is the same: workers + simc's profileset parser thread. Measured in Chrome on a
// 15-core Mac, 100 x 400 DungeonSlice at threads=15: sequential 12.6 / 13.6 s, T=1 12.3 / 12.5 s. T > 1 in the browser needs a
// -sPROXY_TO_PTHREAD engine build (D11).

/** Threads per candidate while candidates outnumber what the threads can hold (native). */
export const TARGET_WORK_THREADS = 4
/** Below this many threads, native parallel mode only for candidates of at most NATIVE_FEW_THREADS_MAX_ITERATIONS. */
export const NATIVE_MANY_THREADS = 32
export const NATIVE_FEW_THREADS_MAX_ITERATIONS = 2000

/** In parallel mode simc reports progress only as candidates finish, and the browser stops a run after 180 s without any
 *  (job.ts stallTimeoutMs). So a browser candidate on its one thread must finish well inside that: at most BROWSER_CANDIDATE_S,
 *  costed at BROWSER_CORE_S_PER_UNIT core-seconds per iteration-second simulated. Chrome on an M-series Mac measured 1.3e-5
 *  (100 x 400 x 360 s in 12.4 s on 15 threads); this allows a device eight times slower. Beyond it, or when the iterations are unknown
 *  (a script), the browser keeps simc's sequential default, whose progress is continuous. */
export const BROWSER_CANDIDATE_S = 90
export const BROWSER_CORE_S_PER_UNIT = 1e-4

export interface WorkPlan {
  /** `profileset_work_threads`; 0 keeps simc's sequential default. */
  workThreads: number
  /** Candidates simmed at once. */
  workers: number
  /** `threads` for the run: unchanged natively; in the browser the workers, so simc derives the same count. */
  threads: number
}

/** Native: threads per candidate start at max(TARGET_WORK_THREADS, threads / candidates), so there are never more workers than
 *  candidates, then move by one or two to use the most threads (7 candidates on 64: 7 x 9, not 6 x 10). */
function nativePlan(threads: number, candidates: number, iterations: number | null): WorkPlan | null {
  if (threads < NATIVE_MANY_THREADS && !((iterations ?? Infinity) <= NATIVE_FEW_THREADS_MAX_ITERATIONS)) return null
  const target = Math.min(threads, Math.max(TARGET_WORK_THREADS, Math.ceil(threads / candidates)))
  let best: { t: number; workers: number } | null = null
  for (let t = Math.max(1, target - 1); t <= Math.min(threads, target + 2); t++) {
    const workers = Math.min(Math.floor(threads / t), candidates)
    // Most threads used; on a tie, fewer workers (less memory, and fewer idle ones on the last round).
    const better = !best || workers * t > best.workers * best.t || (workers * t === best.workers * best.t && t > best.t)
    if (workers >= 2 && better) best = { t, workers }
  }
  return best && { workThreads: best.t, workers: best.workers, threads }
}

/** Browser: one thread per candidate, only when the candidates fill every thread (fewer would leave threads idle that sequential
 *  uses) and a candidate on one thread stays well inside the stall window. Workers + the parser thread fit the pool. */
function browserPlan(threads: number, candidates: number, pool: number, candidateUnits: number | null): WorkPlan | null {
  const workers = Math.min(threads, pool - 1)
  if (workers < 2 || candidates < workers) return null
  if (!((candidateUnits ?? Infinity) * BROWSER_CORE_S_PER_UNIT <= BROWSER_CANDIDATE_S)) return null
  return { workThreads: 1, workers, threads: workers }
}

/** The work split for a run with `candidates` profilesets on `threads` threads. `pool`: the browser engine's pthread pool; absent,
 *  native simc. `iterations`: what one candidate runs, at most (a target error's maxIterations), null when unknown; `simSeconds`: its
 *  fight length. */
export function workPlan(o: { threads: number; candidates: number; pool?: number; iterations?: number | null; simSeconds?: number }): WorkPlan {
  const sequential = { workThreads: 0, workers: 1, threads: o.threads }
  if (o.candidates < 2 || o.threads < 2) return sequential
  const iterations = o.iterations ?? null
  const plan = o.pool === undefined
    ? nativePlan(o.threads, o.candidates, iterations)
    : browserPlan(o.threads, o.candidates, o.pool, iterations === null || !o.simSeconds ? null : iterations * o.simSeconds)
  return plan ?? sequential
}

/** Distinct profileset names in profile text (`profileset."Name"=...`, `profileset.Name+=...`). */
export function profilesetCount(profile: string): number {
  const names = new Set<string>()
  for (const m of profile.matchAll(/^[ \t]*profileset\.(?:"([^"]*)"|([^\s=+]+))\+?=/gm)) names.add(m[1] ?? m[2])
  return names.size
}
