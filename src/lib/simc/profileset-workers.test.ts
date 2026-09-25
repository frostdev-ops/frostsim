// Parallel profilesets (profileset_work_threads): the split the benchmark picked, the browser pool bound, and the browser's stall guard.
import { describe, expect, it } from 'vitest'
import { BROWSER_CANDIDATE_S, BROWSER_CORE_S_PER_UNIT, profilesetCount, workPlan } from './profileset-workers'

describe('workPlan, native (no pool)', () => {
  it('matches the 64-core benchmark: ~4 threads per candidate when plentiful, all candidates at once when few', () => {
    expect(workPlan({ threads: 64, candidates: 100 })).toEqual({ workThreads: 4, workers: 16, threads: 64 })
    expect(workPlan({ threads: 64, candidates: 16 })).toEqual({ workThreads: 4, workers: 16, threads: 64 })
    // Measured best: 9 threads each, all 7 at once on 63 threads.
    expect(workPlan({ threads: 64, candidates: 7 })).toEqual({ workThreads: 9, workers: 7, threads: 64 })
    expect(workPlan({ threads: 64, candidates: 2 })).toEqual({ workThreads: 32, workers: 2, threads: 64 })
  })

  it('below 32 threads, runs parallel only for small candidates (the 14-thread measurement)', () => {
    expect(workPlan({ threads: 16, candidates: 100, iterations: 1673 })).toEqual({ workThreads: 4, workers: 4, threads: 16 })
    expect(workPlan({ threads: 16, candidates: 100, iterations: 4000 }).workThreads).toBe(0)
    expect(workPlan({ threads: 16, candidates: 100, iterations: null }).workThreads).toBe(0)
    expect(workPlan({ threads: 64, candidates: 16, iterations: 4000 }).workThreads).toBe(4)
  })

  it('stays sequential with one candidate, or too few threads for two workers', () => {
    expect(workPlan({ threads: 64, candidates: 1 })).toMatchObject({ workThreads: 0, threads: 64 })
    expect(workPlan({ threads: 4, candidates: 50 })).toMatchObject({ workThreads: 0, threads: 4 })
    expect(workPlan({ threads: 1, candidates: 50 })).toMatchObject({ workThreads: 0, threads: 1 })
    expect(workPlan({ threads: 16, candidates: 20, iterations: 400 })).toEqual({ workThreads: 4, workers: 4, threads: 16 })
  })

  it('ignores the browser stall guard at 64 threads', () => {
    expect(workPlan({ threads: 64, candidates: 100, iterations: 1e9 }).workThreads).toBe(4)
  })
})

describe('workPlan, browser pool', () => {
  it('runs one candidate per thread, workers + the parser thread inside the pool, simc deriving the same count', () => {
    expect(workPlan({ threads: 16, candidates: 100, pool: 16, iterations: 1, simSeconds: 1000 })).toEqual({ workThreads: 1, workers: 15, threads: 15 })
    expect(workPlan({ threads: 8, candidates: 100, pool: 16, iterations: 1, simSeconds: 1000 })).toEqual({ workThreads: 1, workers: 8, threads: 8 })
    for (let pool = 2; pool <= 32; pool++) {
      for (let threads = 1; threads <= pool; threads++) {
        for (const candidates of [1, 2, 3, 7, 16, 100]) {
          const p = workPlan({ threads, candidates, pool, iterations: 1, simSeconds: 1 })
          if (p.workThreads) {
            // T > 1 deadlocks the browser build: never.
            expect(p.workThreads).toBe(1)
            expect(p.workers + 1).toBeLessThanOrEqual(pool)
            expect(p.threads).toBe(p.workers)
            expect(p.workers).toBeLessThanOrEqual(candidates)
          } else expect(p.threads).toBe(threads)
        }
      }
    }
  })

  it('stays sequential when candidates would leave threads idle', () => {
    expect(workPlan({ threads: 16, candidates: 14, pool: 16, iterations: 1, simSeconds: 1000 }).workThreads).toBe(0)
    expect(workPlan({ threads: 16, candidates: 15, pool: 16, iterations: 1, simSeconds: 1000 }).workThreads).toBe(1)
  })

  it('stays sequential when a candidate on one thread could outlast the stall window, or its size is unknown', () => {
    const limit = BROWSER_CANDIDATE_S / BROWSER_CORE_S_PER_UNIT
    expect(workPlan({ threads: 16, candidates: 100, pool: 16, iterations: limit, simSeconds: 1 }).workThreads).toBe(1)
    expect(workPlan({ threads: 16, candidates: 100, pool: 16, iterations: limit + 1, simSeconds: 1 }).workThreads).toBe(0)
    expect(workPlan({ threads: 16, candidates: 100, pool: 16, iterations: null, simSeconds: 300 }).workThreads).toBe(0)
    // A Top Gear at target error 1 (at most 1673 iterations of 360 s) runs in parallel; 40,000 iterations of 300 s do not.
    expect(workPlan({ threads: 16, candidates: 100, pool: 16, iterations: 1673, simSeconds: 360 }).workThreads).toBe(1)
    expect(workPlan({ threads: 16, candidates: 100, pool: 16, iterations: 40_000, simSeconds: 300 }).workThreads).toBe(0)
  })
})

describe('profilesetCount', () => {
  it('counts distinct names, quoted or not, with continuation lines', () => {
    expect(profilesetCount('mage=x\nprofileset."A"=head=1\nprofileset."A"+=neck=2\nprofileset.B=head=3\n  profileset."C d"=x=1\n')).toBe(3)
    expect(profilesetCount('mage=x\n# profileset."A"=head=1\n')).toBe(0)
  })
})
