// Run cost model (cost.ts): work, iterations for a target, speed fits and whole-run progress.
import { describe, expect, it } from 'vitest'
import { cvOf, fitSpeed, iterationsFor, remainingSeconds, reportUnits, runFraction, secondsFor, unitsOf, workOf, Z } from './cost'
import type { SimRequest } from './assemble'
import type { EngineProgress } from './progress'

const request = (over: Partial<SimRequest> = {}): SimRequest => ({
  schemaVersion: 1, profile: 'mage="Ann"\nspec=frost', settings: { fightStyle: 'Patchwerk', maxTime: 300, targets: 1, threads: 8 },
  accuracy: { mode: 'iterations', iterations: 1000 }, ...over,
} as SimRequest)
const TARGET = { mode: 'targetError', targetError: 0.1, maxIterations: 100_000 } as const
const line = (over: Partial<EngineProgress>): EngineProgress => ({ base: 'Baseline', phaseIndex: 1, phaseTotal: 1, finished: false, ...over })

describe('work', () => {
  it('counts every independent sim, the shared baseline included', () => {
    expect(workOf(request()).pieces).toBe(1)
    expect(workOf(request({ profile: 'mage="Ann"\nspec=frost\nrogue="Bo"\nspec=outlaw' })).pieces).toBe(2)
    expect(workOf(request({ profilesets: [{ id: 'a', lines: [] }, { id: 'b', lines: [] }] })).pieces).toBe(3)
    // Baseline, the primary run on both sides, and two stats.
    expect(workOf(request({ extraOptions: ['calculate_scale_factors=1', 'scale_only=intellect,crit,haste', 'normalize_scale_factors=1'] })).pieces).toBe(4)
    expect(unitsOf(workOf(request()), 1000)).toBe(300_000)
  })

  it('finds the iterations a target error needs from the DPS spread, within the ceiling', () => {
    expect(iterationsFor({ mode: 'iterations', iterations: 500 })).toBe(500)
    expect(iterationsFor(TARGET)).toBeNull()
    // 5% spread at 0.1%: (1.96 x 5 / 0.1)^2 = 9604.
    expect(iterationsFor(TARGET, 0.05)).toBe(9604)
    expect(iterationsFor(TARGET, 0.5)).toBe(100_000)
    // A margin from n iterations gives back the spread it came from.
    expect(cvOf(100_000, (Z * 0.05 * 100_000) / Math.sqrt(9604), 9604)).toBeCloseTo(0.05)
  })

  it('counts a report\'s actual iterations, repeating the baseline for stat runs', () => {
    const player = (count: number) => ({ dps: { count } }) as never
    expect(reportUnits(workOf(request({ profile: 'mage="Ann"\nrogue="Bo"' })), { players: [player(100), player(300)], profilesets: [] })).toBe(400 * 300)
    const stats = workOf(request({ extraOptions: ['calculate_scale_factors=1', 'scale_only=crit,haste'] }))
    expect(reportUnits(stats, { players: [player(100)], profilesets: [] })).toBe(3 * 100 * 300)
  })
})

describe('speed', () => {
  it('fits start-up and rate from runs of different sizes', () => {
    // 5 s start-up, 0.001 s per unit per thread.
    const samples = [1e5, 4e5, 8e5].map((units) => ({ units, threads: 8, wall: 5 + (units * 0.001) / 8 }))
    const fit = fitSpeed(samples)!
    expect(fit.overheadS).toBeCloseTo(5)
    expect(fit.secondsPerUnit).toBeCloseTo(0.001)
    expect(secondsFor(fit, 16e5, 16)).toBeCloseTo(105)
  })

  it('falls back to the median rate with few or noisy runs, and to nothing with none', () => {
    expect(fitSpeed([{ units: 1000, threads: 2, wall: 10 }])).toEqual({ overheadS: 0, secondsPerUnit: 0.02 })
    expect(fitSpeed([])).toBeNull()
    // Bigger runs finishing sooner would fit a negative rate.
    expect(fitSpeed([{ units: 1000, threads: 1, wall: 10 }, { units: 2000, threads: 1, wall: 9 }, { units: 3000, threads: 1, wall: 8 }])!.overheadS).toBe(0)
  })
})

describe('run progress', () => {
  it('counts finished phases plus the current one', () => {
    expect(runFraction(line({ phaseIndex: 3, phaseTotal: 4, iterations: 500, iterationTotal: 1000 }), { mode: 'iterations', iterations: 1000 })).toBe(0.625)
    expect(runFraction(line({ base: 'Profilesets', phaseIndex: 3, phaseTotal: 4 }), TARGET)).toBe(0.75)
    expect(runFraction(null, TARGET)).toBeUndefined()
  })

  it('judges a target error phase by the iterations still needed, not by how far the error fell', () => {
    // Twice the target error: a quarter of the iterations it needs.
    expect(runFraction(line({ iterations: 2000, iterationTotal: 100_000, errorPct: 0.2 }), TARGET)).toBe(0.25)
    // Capped by the iteration ceiling.
    expect(runFraction(line({ iterations: 50_000, iterationTotal: 100_000, errorPct: 1 }), TARGET)).toBe(0.5)
  })

  it('projects the time left from the pace so far, once there is enough to go on', () => {
    expect(remainingSeconds(0.25, 30)).toBe(90)
    expect(remainingSeconds(0.01, 30)).toBeUndefined()
  })
})
