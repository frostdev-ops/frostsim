import { describe, expect, it } from 'vitest'
import { runComparison } from './compare'
import { parseReport } from './report'
import { DEFAULT_SETTINGS } from './options'
import { WORKER_PROTOCOL, type SimRequest } from './job'
import type { EngineCapability, EngineManifest } from './capability'

// Fake workers; covers strategy selection, ranking, partial results (not real engine behavior).

const manifest: EngineManifest = {
  schemaVersion: 1,
  artifact: 'threaded',
  engine: { simcVersion: '1210-01', upstreamCommit: 'c015720' },
  wow: { clientDataVersion: '12.1.0.69814' },
  capabilities: {
    threads: true,
    pthreadPoolSize: 16,
    maxThreads: 16,
    profilesets: true,
    networking: false,
    reportVersions: [2],
  },
}

const threaded: EngineCapability = {
  ok: true,
  artifact: 'threaded',
  engineDir: '/engine/',
  maxThreads: 16,
  profilesets: true,
  manifest,
}

const fallback: EngineCapability = {
  ok: true,
  artifact: 'fallback',
  engineDir: '/engine/fallback/',
  maxThreads: 1,
  profilesets: false,
  manifest: { ...manifest, artifact: 'fallback' },
}

function baseReport(dpsMean: number, profilesets?: { name: string; mean: number }[]) {
  return {
    version: '1210-01',
    report_version: '2.0.0',
    sim: {
      options: {
        iterations: 53,
        target_error: 0,
        threads: 4,
        max_time: 300,
        fight_style: 'Patchwerk',
        desired_targets: 1,
        single_actor_batch: false,
        fixed_time: true,
        confidence: 0.95,
        confidence_estimator: 1.9599639854088815,
      },
      players: [
        {
          name: 'Bob',
          specialization: 'Frost Mage',
          collected_data: {
            dps: { sum: 1, count: 49, mean: dpsMean, min: 1, max: 2, std_dev: 100, mean_std_dev: 50 },
          },
        },
      ],
      statistics: { elapsed_time_seconds: 0.1 },
      ...(profilesets
        ? {
            profilesets: {
              metric: 'Damage per Second',
              results: profilesets.map((p) => ({
                name: p.name,
                mean: p.mean,
                min: p.mean - 100,
                max: p.mean + 100,
                stddev: 500,
                mean_stddev: 100,
                mean_error: 196,
                iterations: 30,
              })),
            },
          }
        : {}),
    },
  }
}

class Fake {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessageerror: ((e: unknown) => void) | null = null
  terminated = 0
  readonly sent: unknown[] = []
  postMessage(data: unknown): void {
    this.sent.push(data)
  }
  terminate(): void {
    this.terminated++
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

class Reporter extends Fake {
  postMessage(data: unknown): void {
    super.postMessage(data)
    const { jobId, bytes } = data as { jobId: string; bytes: ArrayBuffer }
    queueMicrotask(() => {
      const report = parseReport(JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))))
      this.emit({ jobId, ok: true, kind: 'summary', report, bytes })
    })
  }
}

/**
 * Answers each engine job automatically with the next scripted report, so a
 * sequential comparison runs to completion without hand-driving every worker.
 */
function scriptedEngines(reports: unknown[], onCreate?: (index: number, worker: Fake) => void) {
  const created: Fake[] = []
  return {
    created,
    create(): Worker {
      const index = created.length
      const worker = new Fake()
      created.push(worker)
      const original = worker.postMessage.bind(worker)
      worker.postMessage = (data: unknown) => {
        original(data)
        const { jobId } = data as { jobId: string }
        queueMicrotask(() => {
          worker.emit({ protocol: WORKER_PROTOCOL, jobId, type: 'ready' })
          const report = reports[Math.min(index, reports.length - 1)]
          worker.emit({
            protocol: WORKER_PROTOCOL,
            jobId,
            type: 'done',
            report: new TextEncoder().encode(JSON.stringify(report)),
          })
        })
      }
      onCreate?.(index, worker)
      return worker as unknown as Worker
    },
  }
}

const base: SimRequest = {
  schemaVersion: 1,
  profile: 'mage="Bob"\n',
  settings: { ...DEFAULT_SETTINGS, threads: 4 },
  accuracy: { mode: 'iterations', iterations: 1000 },
}

const candidates = [
  { id: 'c-1', lines: ['gear_crit_rating=100'] },
  { id: 'c-2', lines: ['gear_haste_rating=100'] },
  { id: 'c-3', lines: ['gear_mastery_rating=100'] },
]

describe('profileset strategy', () => {
  it('runs one job and ranks the candidates by mean', async () => {
    const engines = scriptedEngines([
      baseReport(200000, [
        { name: 'c-1', mean: 210000 },
        { name: 'c-2', mean: 230000 },
        { name: 'c-3', mean: 220000 },
      ]),
    ])
    const handle = runComparison(base, candidates, undefined, {
      capability: threaded,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    })
    const out = await handle.result
    expect(out.strategy).toBe('profilesets')
    expect(engines.created).toHaveLength(1)
    expect(out.candidates.map((c) => c.id)).toEqual(['c-2', 'c-3', 'c-1'])
    expect(out.candidates[0].iterations).toBe(30)
    // mean_error is already margin at report's confidence level.
    expect(out.candidates[0].confidence).toEqual({
      level: 0.95,
      margin: 196,
      relativePct: (196 / 230000) * 100,
    })
    expect(out.candidates[0].meanStdDev).toBe(100)
  })

  it('marks a candidate the engine dropped as missing, not as zero', async () => {
    const engines = scriptedEngines([baseReport(200000, [{ name: 'c-1', mean: 210000 }])])
    const out = await runComparison(base, candidates, undefined, {
      capability: threaded,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    }).result
    const missing = out.candidates.filter((c) => c.status === 'missing')
    expect(missing.map((c) => c.id).sort()).toEqual(['c-2', 'c-3'])
    expect(missing[0].mean).toBeUndefined()
  })
})

describe('sequential fallback strategy', () => {
  it('runs one job per candidate when the engine has no profilesets', async () => {
    const engines = scriptedEngines([baseReport(210000), baseReport(230000), baseReport(220000)])
    const out = await runComparison(base, candidates, undefined, {
      capability: fallback,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    }).result

    expect(out.strategy).toBe('sequential')
    expect(engines.created).toHaveLength(3)
    expect(out.candidates.map((c) => c.id)).toEqual(['c-2', 'c-3', 'c-1'])
    expect(out.candidates[0].mean).toBe(230000)
    expect(out.outcomes).toHaveLength(3)
  })

  it('applies each candidate in ACTOR scope, matching profileset semantics', async () => {
    // Profileset options re-parsed in actor scope; sim arguments are not. Wrong scope makes all fallback return baseline.
    const engines = scriptedEngines([baseReport(1), baseReport(2), baseReport(3)])
    await runComparison(base, candidates, undefined, {
      capability: fallback,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    }).result

    const first = engines.created[0].sent[0] as { args: string[]; profile: string }
    expect(first.profile).toMatch(/^gear_crit_rating=100$/m)
    expect(first.args).not.toContain('gear_crit_rating=100')
    expect(first.profile).not.toContain('profileset.')
  })

  it('carries an item line where the engine will actually read it', async () => {
    // item.cpp parses gear in actor scope only; line in arguments equips nothing.
    const gear = [{ id: 'g-1', lines: ['trinket1=some_name,id=270164'] }]
    const engines = scriptedEngines([baseReport(210000)])
    await runComparison(base, gear, undefined, {
      capability: fallback,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    }).result
    const sent = engines.created[0].sent[0] as { args: string[]; profile: string }
    expect(sent.profile).toMatch(/^trinket1=some_name,id=270164$/m)
    expect(sent.args.some((a) => a.startsWith('trinket1='))).toBe(false)
  })

  it('gives every sequential run its own job id', async () => {
    const engines = scriptedEngines([baseReport(1), baseReport(2), baseReport(3)])
    await runComparison(base, candidates, undefined, {
      capability: fallback,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    }).result
    const ids = engines.created.map((w) => (w.sent[0] as { jobId: string }).jobId)
    expect(new Set(ids).size).toBe(3)
  })

  it('keeps going past a candidate that fails', async () => {
    let failIndex = -1
    const engines = scriptedEngines([baseReport(210000), baseReport(230000), baseReport(220000)], (index, worker) => {
      if (index !== 1) return
      failIndex = index
      worker.postMessage = (data: unknown) => {
        const { jobId } = data as { jobId: string }
        queueMicrotask(() =>
          worker.emit({ protocol: WORKER_PROTOCOL, jobId, type: 'error', code: 'sim-failed', message: 'boom' }),
        )
      }
    })
    const out = await runComparison(base, candidates, undefined, {
      capability: fallback,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    }).result

    expect(failIndex).toBe(1)
    const failed = out.candidates.find((c) => c.id === 'c-2')
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toMatch(/boom/)
    expect(out.candidates.filter((c) => c.status === 'complete')).toHaveLength(2)
  })

  it('keeps the candidates already finished when cancelled mid-batch', async () => {
    const handle = { current: null as { cancel(): void } | null }
    const engines = scriptedEngines([baseReport(210000), baseReport(230000), baseReport(220000)], (index) => {
      // Cancel once second candidate's worker exists.
      if (index === 1) queueMicrotask(() => handle.current?.cancel())
    })
    const comparison = runComparison(base, candidates, undefined, {
      capability: fallback,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    })
    handle.current = comparison
    const out = await comparison.result

    expect(out.cancelled).toBe(true)
    // Losing finished candidates to cancel costs optimizer its batch.
    expect(out.candidates.filter((c) => c.status === 'complete').length).toBeGreaterThanOrEqual(1)
    expect(out.candidates.filter((c) => c.status === 'missing').length).toBeGreaterThanOrEqual(1)
  })
})

describe('strategy selection', () => {
  it('follows the engine capability rather than a guess', async () => {
    const engines = scriptedEngines([baseReport(1), baseReport(2), baseReport(3)])
    const out = await runComparison(base, candidates.slice(0, 1), undefined, {
      capability: async () => fallback,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    }).result
    expect(out.strategy).toBe('sequential')
  })

  it('reports nothing rather than something when cancelled before it starts', async () => {
    const engines = scriptedEngines([baseReport(1)])
    const comparison = runComparison(base, candidates, undefined, {
      capability: threaded,
      createEngineWorker: engines.create,
      createReportWorker: () => new Reporter() as unknown as Worker,
      threadReapGraceMs: 0,
    })
    comparison.cancel()
    const out = await comparison.result
    expect(out.cancelled).toBe(true)
    expect(out.candidates).toEqual([])
  })
})
