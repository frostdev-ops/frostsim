import { describe, expect, it } from 'vitest'
import { estimateSearchSeconds, estimateSeconds, iterationsForTarget, observedRate } from './estimate'
import type { StagePlan } from './optimization/types'
import type { StoredReport } from './store/records'

// P06.3: Only honest source for "how long" is this machine (speed depends on processor/threads/browser tab alloc). Constant in app is wrong by unknown factor; return null.

const report = (summary: Partial<StoredReport['summary']>): StoredReport =>
  ({ id: 'r', tool: 'quick', title: 't', createdAt: 0, summary } as StoredReport)

describe('search completion estimate', () => {
  const plan: StagePlan = { version: 1, minIterations: 200, retentionFactor: 1, stages: [
    { label: 'Survey', accuracy: { mode: 'iterations', iterations: 1000 }, batchSize: 10, maxSurvivors: 5 },
    { label: 'Final', accuracy: { mode: 'iterations', iterations: 2000 }, batchSize: 5, maxSurvivors: 1 },
  ] }
  const history = [report({ actualIterations: 1000, elapsedSeconds: 10 })]
  it('counts repeated baselines and removes finished batches from remaining work', () => {
    // 20 candidates + 2 baselines, then 5 survivors + 1 baseline.
    expect(estimateSearchSeconds(history, 20, plan)?.seconds).toBe(340)
    expect(estimateSearchSeconds(history, 20, plan, {
      stageIndex: 0, stageCount: 2, stageLabel: 'Survey', accuracy: plan.stages[0].accuracy,
      batchIndex: 1, batchCount: 2, candidatesMeasured: 10, candidatesRemaining: 20,
    })?.seconds).toBe(230)
    expect(estimateSearchSeconds([], 20, plan)).toBeNull()
  })
  it('learns live speed and clamps precision work to the sample floor and ceiling', () => {
    const targetPlan: StagePlan = { ...plan, stages: [{ ...plan.stages[0], accuracy: { mode: 'targetError', targetError: 1, maxIterations: 1000 } }] }
    expect(estimateSearchSeconds([], 10, targetPlan, null, { iterationsPerSecond: 100, iterations: 100, errorPct: 0.1 })?.seconds).toBe(22)
    expect(estimateSearchSeconds([], 10, targetPlan, null, { iterationsPerSecond: 100, iterations: 100, errorPct: 100 })?.seconds).toBe(110)
    expect(estimateSearchSeconds(history, 10, targetPlan)?.ceiling).toBe(true)
  })
})

describe('observedRate', () => {
  it('is null with no usable history, rather than guessing', () => {
    expect(observedRate([])).toBeNull()
    expect(observedRate([report({})])).toBeNull()
    // Run with only one half of pair tells us nothing.
    expect(observedRate([report({ actualIterations: 1000 })])).toBeNull()
    expect(observedRate([report({ elapsedSeconds: 10 })])).toBeNull()
  })

  it('ignores zero, negative and non-finite figures', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(observedRate([report({ actualIterations: bad, elapsedSeconds: 10 })])).toBeNull()
      expect(observedRate([report({ actualIterations: 100, elapsedSeconds: bad })])).toBeNull()
    }
  })

  it('uses the median so one contended run does not drag the estimate', () => {
    const rates = [
      report({ actualIterations: 1000, elapsedSeconds: 10 }), // 100/s
      report({ actualIterations: 1000, elapsedSeconds: 10 }), // 100/s
      report({ actualIterations: 1000, elapsedSeconds: 200 }), // 5/s — a busy machine
    ]
    const r = observedRate(rates)
    expect(r?.seconds).toBe(100)
    expect(r?.samples).toBe(3)
    // Spread kept so caller can widen or withhold the claim.
    expect(r?.low).toBe(5)
    expect(r?.high).toBe(100)
  })

  it('reads only recent runs, since hardware and settings change', () => {
    const many = Array.from({ length: 20 }, () =>
      report({ actualIterations: 1000, elapsedSeconds: 10 }))
    expect(observedRate(many)?.samples).toBe(8)
  })
})

describe('estimateSeconds', () => {
  it('converts iterations to seconds with an inverted range', () => {
    const history = [
      report({ actualIterations: 1000, elapsedSeconds: 10 }), // 100/s
      report({ actualIterations: 1000, elapsedSeconds: 20 }), // 50/s
    ]
    const e = estimateSeconds(history, 10_000)
    expect(e).not.toBeNull()
    // Median of two rates is 75/s.
    expect(e!.seconds).toBeCloseTo(10_000 / 75)
    // Fastest past run predicts SHORTEST time, so bounds invert.
    expect(e!.low).toBeCloseTo(100)
    expect(e!.high).toBeCloseTo(200)
    expect(e!.low).toBeLessThan(e!.high)
  })

  it('refuses a nonsense iteration count', () => {
    const history = [report({ actualIterations: 1000, elapsedSeconds: 10 })]
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(estimateSeconds(history, bad)).toBeNull()
    }
  })
})

describe('iterationsForTarget', () => {
  it('scales as 1/targetError², the engine’s own relationship', () => {
    // Run reaching 0.4% in 1,000 iterations needs 4x for 0.2%.
    const history = [report({
      actualIterations: 1000, targetReached: true, dps: 100_000, confidenceMargin: 400,
    })]
    expect(iterationsForTarget(history, 0.2)).toBe(4000)
    expect(iterationsForTarget(history, 0.8)).toBe(250)
  })

  it('ignores a run that never reached its target', () => {
    // Ceiling stop says nothing about what target costs.
    const history = [report({
      actualIterations: 40_000, targetReached: false, dps: 100_000, confidenceMargin: 900,
    })]
    expect(iterationsForTarget(history, 0.2)).toBeNull()
  })

  it('is null with no comparable run or a nonsense target', () => {
    expect(iterationsForTarget([], 0.2)).toBeNull()
    const history = [report({
      actualIterations: 1000, targetReached: true, dps: 100_000, confidenceMargin: 400,
    })]
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(iterationsForTarget(history, bad)).toBeNull()
    }
  })
})
