import { describe, expect, it, vi } from 'vitest'
import { makeRunBatch } from './runBatch'
import type { SimOutcome, SimRequest } from './simc/job'
import { runStagedSearch } from './optimization/runner'

const SETTINGS = { fightStyle: 'Patchwerk' as const, maxTime: 300, targets: 1, threads: 4 }

function fakeOutcome(profilesets: { name: string; mean: number }[]): SimOutcome {
  return {
    jobId: 'j1',
    request: {} as SimRequest,
    report: {
      players: [{
        name: 'P', specialization: 's',
        dps: { mean: 100_000, count: 500, sum: 0, min: 0, max: 0 },
        dpsConfidence: { level: 0.95, margin: 400, relativePct: 0.4 },
      }],
      profilesets: profilesets.map((p) => ({
        name: p.name, mean: p.mean, min: 0, max: 0, iterations: 500, meanError: 250,
      })),
      actualIterations: 500,
      options: { confidence: 0.95 },
      targetReached: true,
    } as never,
    profilesetStatus: { completed: profilesets.map((p) => p.name), missing: [] },
    inputWarnings: [],
    appElapsedSeconds: 1,
    engineIdentity: 'engine',
    getRawJson: () => new Blob([]),
  } as unknown as SimOutcome
}

function handleFor(outcome: SimOutcome, seen: SimRequest[]) {
  return (req: SimRequest) => {
    seen.push(req)
    return {
      jobId: 'j1',
      result: Promise.resolve(outcome),
      state: 'complete' as const,
      cancel: () => {},
    }
  }
}

describe('makeRunBatch', () => {
    // B4: engine’s per-profileset count only live signal inside batch.
  it('forwards the engine’s in-batch candidate count to the search', async () => {
    const seen: SimRequest[] = []
    const outcome = fakeOutcome([{ name: 'a', mean: 1 }, { name: 'b', mean: 2 }])
    const runJob = (req: SimRequest, onEvent?: (e: never) => void) => {
      seen.push(req)
      onEvent?.({ jobId: 'j1', state: 'running', stage: { done: 1, total: 2 } } as never)
      return { jobId: 'j1', result: Promise.resolve(outcome), state: 'complete' as const, cancel: () => {} }
    }
    const done: number[] = []
    await makeRunBatch({ settings: SETTINGS, runJob: runJob as never })({
      profile: 'p',
      accuracy: { mode: 'iterations', iterations: 100 },
      profilesets: [{ id: 'a', lines: ['head=1'] }, { id: 'b', lines: ['head=2'] }],
      onCandidateProgress: (n) => done.push(n),
    })
    expect(done).toEqual([1])
  })

  it('carries the staged search sample floor through the actual UI bridge', async () => {
    const seen: SimRequest[] = []
    const batch = makeRunBatch({ settings: SETTINGS, runJob: (request) => {
      // Model first-check convergence: unconfigured engine stops at 100.
      const interval = request.extraOptions?.find((line) => line.startsWith('analyze_error_interval='))
      const samples = interval ? Number(interval.split('=')[1]) : 100
      const outcome = fakeOutcome((request.profilesets ?? []).map((p) => ({ name: p.id, mean: p.id === 'a' ? 110_000 : 90_000 })))
      outcome.report.players[0].dps.count = samples
      outcome.report.actualIterations = samples
      for (const result of outcome.report.profilesets) result.iterations = samples
      return handleFor(outcome, seen)(request)
    } })
    const result = await runStagedSearch(['a', 'b'].map((id, i) => ({
      id, canonical: id, delta: {}, cost: { unknownCosts: [] },
      provenance: { kind: 'gear' as const, items: [], label: id },
      lines: [`head=,id=${i + 1}`],
    })), {
      profile: 'mage=A', catalogId: 'catalog', engineIdentity: 'engine', runBatch: batch,
      plan: { version: 1, minIterations: 200, retentionFactor: 1, stages: [
        { label: 'Survey', accuracy: { mode: 'targetError', targetError: 1, maxIterations: 1000 }, maxSurvivors: 10, batchSize: 10 },
        { label: 'Final', accuracy: { mode: 'targetError', targetError: 0.2, maxIterations: 1000 }, maxSurvivors: 10, batchSize: 10 },
      ] },
    })
    expect(seen).toHaveLength(2)
    expect(seen.every((request) => request.extraOptions?.includes('analyze_error_interval=200'))).toBe(true)
    expect(result.warnings).toEqual([])
    expect(result.candidates.find((state) => state.candidate.id === 'b')?.status).toBe('eliminated')
  })

  it('unwraps reactive settings and finalist lines before the worker transfer', async () => {
    const seen: SimRequest[] = []
    const batch = makeRunBatch({ settings: new Proxy(SETTINGS, {}),
      extraProfileLines: new Proxy(['override.bloodlust=0'], {}),
      runJob: handleFor(fakeOutcome([{ name: 'c1', mean: 105_000 }]), seen) })
    await batch({ profile: 'mage=A', accuracy: new Proxy({ mode: 'iterations' as const, iterations: 500 }, {}),
      profilesets: [{ id: 'c1', lines: new Proxy(['flask=disabled'], {}) }] })
    expect(() => structuredClone(seen[0])).not.toThrow()
    expect(seen[0].profilesets?.[0].lines).toEqual(['flask=disabled'])
  })
  it('answers a zero-line baseline candidate from the report player, not a profileset', async () => {
    const seen: SimRequest[] = []
    const batch = makeRunBatch({
      settings: SETTINGS,
      runJob: handleFor(fakeOutcome([{ name: 'c1', mean: 105_000 }]), seen),
    })
    const out = await batch({
      profile: 'mage=A',
      accuracy: { mode: 'iterations', iterations: 500 },
      profilesets: [
        { id: 'baseline', lines: [] },
        { id: 'c1', lines: ['head=,id=1'] },
      ],
    })
    // The engine never sees the empty one: validateProfilesets rejects it.
    expect(seen[0].profilesets).toEqual([{ id: 'c1', lines: ['head=,id=1'] }])
    expect(out.results).toEqual([
      { id: 'baseline', mean: 100_000, margin: 400, iterations: 500 },
      { id: 'c1', mean: 105_000, margin: 250, iterations: 500 },
    ])
  })

  it('settles a batch whose only candidate is the baseline', async () => {
    // A late stage can narrow to the baseline alone. Before this was handled the
    // request carried an empty profileset array and the batch never resolved.
    const seen: SimRequest[] = []
    const batch = makeRunBatch({
      settings: SETTINGS,
      runJob: handleFor(fakeOutcome([]), seen),
    })
    const out = await batch({
      profile: 'mage=A',
      accuracy: { mode: 'iterations', iterations: 500 },
      profilesets: [{ id: 'baseline', lines: [] }],
    })
    expect(seen[0].profilesets).toBeUndefined()
    expect(out.results).toEqual([{ id: 'baseline', mean: 100_000, margin: 400, iterations: 500 }])
    expect(out.baseline?.mean).toBe(100_000)
  })

  it('reports a candidate the engine dropped as NaN, never as zero', async () => {
    const batch = makeRunBatch({
      settings: SETTINGS,
      runJob: handleFor(fakeOutcome([]), []),
    })
    const out = await batch({
      profile: 'mage=A',
      accuracy: { mode: 'iterations', iterations: 500 },
      profilesets: [{ id: 'c9', lines: ['head=,id=1'] }],
    })
    expect(Number.isNaN(out.results[0].mean)).toBe(true)
    expect(out.results[0].margin).toBeNull()
  })

  it('propagates a rejection rather than hanging the search', async () => {
    const batch = makeRunBatch({
      settings: SETTINGS,
      runJob: () => ({
        jobId: 'j1',
        result: Promise.reject(new DOMException('cancelled', 'AbortError')),
        state: 'cancelled' as const,
        cancel: () => {},
      }),
    })
    await expect(
      batch({
        profile: 'mage=A',
        accuracy: { mode: 'iterations', iterations: 500 },
        profilesets: [{ id: 'c1', lines: ['head=,id=1'] }],
      }),
    ).rejects.toThrow()
  })

  it('cancels the in-flight engine job when the search aborts', async () => {
    const cancel = vi.fn()
    let settle: (o: SimOutcome) => void = () => {}
    const batch = makeRunBatch({
      settings: SETTINGS,
      runJob: () => ({
        jobId: 'j1',
        result: new Promise<SimOutcome>((r) => { settle = r }),
        state: 'running' as const,
        cancel,
      }),
    })
    const controller = new AbortController()
    const promise = batch({
      profile: 'mage=A',
      accuracy: { mode: 'iterations', iterations: 500 },
      profilesets: [{ id: 'c1', lines: ['head=,id=1'] }],
      signal: controller.signal,
    })
    controller.abort()
    expect(cancel).toHaveBeenCalledOnce()
    settle(fakeOutcome([{ name: 'c1', mean: 1 }]))
    await promise
  })
})
