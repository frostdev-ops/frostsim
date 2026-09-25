import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetEngineRuntimeForTests, runJob, setRemoteEngine, WORKER_PROTOCOL, type JobEvent, type SimRequest } from './job'
import { cloudShare, createHybridEngine, mergeCharacters, mergeProfilesets, mergeStats, splitOf, splitRequest, type RunPlace } from './hybrid'
import { parseReport } from './report'
import { DEFAULT_SETTINGS } from './options'
import type { EngineCapability, EngineManifest } from './capability'

// Hybrid runs (DESIGN.md C9 seam): mocked fetch and fake workers only.

const manifest: EngineManifest = {
  schemaVersion: 1,
  artifact: 'threaded',
  engine: { simcVersion: '1210-01', upstreamCommit: 'c01572044af513f9d85b79080b8d14619f1c00c5' },
  wow: { clientDataVersion: '12.1.0.69814', hotfixHash: 'dca34b30' },
  capabilities: { threads: true, pthreadPoolSize: 16, maxThreads: 16, profilesets: true, networking: false, reportVersions: [2] },
  files: { 'simc.wasm': { bytes: 1, sha256: 'aa'.repeat(32) } },
}
const PACK_DIR = '/engine/versions/pack-1/'
const capability: EngineCapability = { ok: true, artifact: 'threaded', engineDir: PACK_DIR, maxThreads: 16, profilesets: true, manifest }
const CLOUD_ID = '6f1c1c9e-0d1b-4c43-9a55-6c1f8f3f0a01'

/** A simc JSON report whose profilesets are `ids`, each with mean 1000 + its index, and whose players are `names`. */
function reportFor(ids: string[], names = ['Bob']): string {
  const results = ids.map((name) => ({ name, mean: 1000 + Number(name.slice(2)), min: 1, max: 2, iterations: 100 }))
  return JSON.stringify({
    version: '1210-01',
    report_version: '2.0.0',
    sim: {
      options: {
        iterations: 100, target_error: 0, threads: 4, max_time: 300, fight_style: 'Patchwerk', desired_targets: 1, single_actor_batch: false,
        fixed_time: true, confidence: 0.95, confidence_estimator: 1.96, dbc: { Live: { wow_version: '12.1.0.69814', build_level: 69814 }, version_used: 'Live' },
      },
      players: names.map((name) => ({ name, specialization: 'Frost Mage', collected_data: { dps: { sum: 1, count: 100, mean: 900, min: 1, max: 2, std_dev: 1, mean_std_dev: 1 } } })),
      statistics: { elapsed_time_seconds: 1 },
      ...(results.length ? { profilesets: { metric: 'dps', results } } : {}),
    },
  })
}
const namesIn = (profile: string) => [...profile.matchAll(/^mage="([^"]+)"/gm)].map((m) => m[1])
const idsIn = (profile: string) => [...profile.matchAll(/^profileset\."([^"]+)"\+=/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i)
const progress = (id: string, idx: number, total: number) => `Profileset\t${id}\t${idx}\t${total}\t50\t100\t3.4\t10`

const spawned: LocalEngine[] = []
class LocalEngine {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessageerror: ((e: unknown) => void) | null = null
  readonly sent: Record<string, unknown>[] = []
  constructor(readonly url: string) {
    spawned.push(this)
  }
  postMessage(data: unknown): void {
    this.sent.push(data as Record<string, unknown>)
    if ((data as { type?: string }).type === 'cancel') queueMicrotask(() => this.say({ type: 'shutdown', reason: 'cancelled', threads: 4 }))
  }
  terminate(): void {}
  say(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: { protocol: WORKER_PROTOCOL, jobId: this.sent[0].jobId, ...msg } })
  }
  ids(): string[] {
    return idsIn(String(this.sent[0].profile))
  }
  finish(): void {
    this.say({ type: 'ready' })
    this.say({ type: 'done', report: new TextEncoder().encode(reportFor(this.ids(), namesIn(String(this.sent[0].profile)))) })
    this.say({ type: 'shutdown', reason: 'complete', threads: 4 })
  }
}

class FakeReportWorker extends LocalEngine {
  postMessage(data: unknown): void {
    const { jobId, bytes } = data as { jobId: string; bytes: ArrayBuffer }
    queueMicrotask(() => this.onmessage?.({ data: { jobId, ok: true, kind: 'summary', report: parseReport(JSON.parse(new TextDecoder().decode(bytes))), bytes } }))
  }
}

class CloudServer {
  submit = 200
  status = 'queued'
  lines: string[] = []
  posted: SimRequest | null = null
  deletes = 0
  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    if (init.method === 'POST') {
      this.posted = JSON.parse(String(init.body)).request
      return this.submit === 200 ? Response.json({ id: CLOUD_ID }) : Response.json({ error: 'x' }, { status: this.submit })
    }
    if (init.method === 'DELETE') {
      this.deletes++
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/result')) {
      const body = new Blob([reportFor((this.posted!.profilesets ?? []).map((p) => p.id), namesIn(this.posted!.profile))]).stream().pipeThrough(new CompressionStream('gzip'))
      return new Response(body)
    }
    return Response.json({ status: this.status, lines: this.lines, next: this.lines.length })
  }) as typeof fetch
}

const sets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c-${i}`, lines: [`talents=t${i}`] }))
const request = (n: number): SimRequest => ({
  schemaVersion: 1,
  profile: 'mage="Bob"\nlevel=80\n',
  settings: { ...DEFAULT_SETTINGS, threads: 4 },
  accuracy: { mode: 'iterations', iterations: 100 },
  profilesets: sets(n),
})

let places: RunPlace[] = []
function hybridRun(s: CloudServer, req: SimRequest) {
  places = []
  setRemoteEngine(createHybridEngine({ fetch: s.fetch, pollMs: 1000, cloudThreads: 12, onplace: (p) => places.push(p) }))
  const events: JobEvent[] = []
  const handle = runJob(req, (e) => events.push(e), { createReportWorker: () => new FakeReportWorker('report') as unknown as Worker, capability })
  return { handle, events }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', LocalEngine)
})

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(20_000)
  setRemoteEngine(null)
  spawned.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetEngineRuntimeForTests()
})

describe('hybrid split and merge', () => {
  it('splits by thread share, leaving each side at least one candidate', () => {
    expect(cloudShare(4, 12, 4)).toBe(3)
    expect(cloudShare(100, 16, 16)).toBe(50)
    expect(cloudShare(2, 16, 1)).toBe(1)
    expect(cloudShare(10, 1, 64)).toBe(1)
  })

  it('appends the cloud results, creating the section when the local side had none', () => {
    const enc = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer
    const merged = (a: string[], b: string[]) => parseReport(JSON.parse(new TextDecoder().decode(mergeProfilesets(enc(reportFor(a)), enc(reportFor(b))))))
    expect(merged(['c-0'], ['c-1', 'c-2']).profilesets.map((p) => p.name)).toEqual(['c-0', 'c-1', 'c-2'])
    expect(merged([], ['c-1']).profilesets.map((p) => p.name)).toEqual(['c-1'])
    expect(merged(['c-0'], []).profilesets.map((p) => p.name)).toEqual(['c-0'])
  })
})

const twoCharacters = (): SimRequest => ({
  schemaVersion: 1,
  profile: '# Bob - frost\nmage="Bob"\nlevel=80\ntalents=a\n# Ann - fire\nmage="Ann"\nlevel=80\ntalents=b',
  settings: { ...DEFAULT_SETTINGS, threads: 4 },
  accuracy: { mode: 'iterations', iterations: 100 },
  extraProfileLines: ['enemy=Boss'],
})
const weights = (normalize: boolean, stats = 'intellect,crit,haste,mastery,versatility'): SimRequest => ({
  schemaVersion: 1,
  profile: 'mage="Bob"\nlevel=80',
  settings: { ...DEFAULT_SETTINGS, threads: 4 },
  accuracy: { mode: 'iterations', iterations: 100 },
  extraOptions: ['calculate_scale_factors=1', `scale_only=${stats}`, ...(normalize ? ['normalize_scale_factors=1'] : [])],
})
const enc = (t: unknown) => new TextEncoder().encode(JSON.stringify(t)).buffer as ArrayBuffer
const dec = (b: ArrayBuffer) => JSON.parse(new TextDecoder().decode(b))

describe('what splits', () => {
  it('splits candidates, characters of a multi-character run, and stat weights; never one character or a custom script', () => {
    expect(splitOf(request(3))).toEqual({ kind: 'candidates', pieces: 3 })
    expect(splitOf(twoCharacters())).toEqual({ kind: 'characters', pieces: 2 })
    expect(splitOf(weights(false))).toEqual({ kind: 'stats', pieces: 5 })
    // Normalized weights keep the primary stat on both sides, so four stats split.
    expect(splitOf(weights(true))).toEqual({ kind: 'stats', pieces: 4 })
    expect(splitOf(weights(true, 'intellect,crit'))).toBeNull()
    expect(splitOf(request(1))).toBeNull()
    expect(splitOf({ ...request(0), profilesets: undefined })).toBeNull()
    expect(splitOf({ ...twoCharacters(), mode: 'raw' })).toBeNull()
  })

  it('gives this browser the first character, with the scenario lines, and the cloud the rest', () => {
    const sides = splitRequest(twoCharacters(), 12)!
    expect(sides.place).toMatchObject({ mode: 'hybrid', kind: 'characters', hereNames: ['Bob'], thereNames: ['Ann'] })
    expect(namesIn(sides.cloud.profile)).toEqual(['Ann'])
    const local = sides.localStart({ profile: 'whole', args: ['a'] })
    expect(namesIn(local.profile)).toEqual(['Bob'])
    expect(local.profile).toContain('enemy=Boss')
    expect(local.args).toEqual(['a'])
  })

  it('splits stats by scale_only, the primary on both sides when normalizing, and swaps only that argument locally', () => {
    const sides = splitRequest(weights(true), 12)!
    expect(sides.place).toMatchObject({ kind: 'stats', both: ['intellect'], hereNames: ['crit'], thereNames: ['haste', 'mastery', 'versatility'] })
    expect(sides.cloud.extraOptions).toContain('scale_only=intellect,haste,mastery,versatility')
    expect(sides.localStart({ profile: 'p', args: ['x', 'scale_only=intellect,crit,haste,mastery,versatility', 'y'] }).args)
      .toEqual(['x', 'scale_only=intellect,crit', 'y'])
  })
})

describe('merges', () => {
  it('appends the cloud characters after this browser\'s', () => {
    const merged = parseReport(dec(mergeCharacters(enc(JSON.parse(reportFor([], ['Bob']))), enc(JSON.parse(reportFor([], ['Ann', 'Cy']))))))
    expect(merged.players.map((p) => p.name)).toEqual(['Bob', 'Ann', 'Cy'])
  })

  it('adds the cloud stat weights to each player, keeping this browser\'s primary, and lists every stat', () => {
    const report = (factors: Record<string, number>) => {
      const r = JSON.parse(reportFor([]))
      r.sim.options.scaling = { calculate_scale_factors: 1, scale_only: Object.keys(factors).join(',') }
      Object.assign(r.sim.players[0], { scale_factors: factors, scale_deltas: factors, scale_factors_all: { dps: factors } })
      return enc(r)
    }
    const merged = dec(mergeStats(report({ Int: 1, Crit: 0.5 }), report({ Int: 1.02, Haste: 0.4 }), ['intellect', 'crit', 'haste']))
    const p = merged.sim.players[0]
    expect(p.scale_factors).toEqual({ Int: 1, Crit: 0.5, Haste: 0.4 })
    expect(p.scale_factors_all.dps).toEqual({ Int: 1, Crit: 0.5, Haste: 0.4 })
    expect(merged.sim.options.scaling.scale_only).toBe('intellect,crit,haste')
  })
})

describe('hybrid runs', () => {
  it('runs a multi-character Quick Sim a character each side and returns one report with both, and says so', async () => {
    const s = new CloudServer()
    const run = hybridRun(s, twoCharacters())
    await vi.advanceTimersByTimeAsync(0)
    expect(places).toEqual([expect.objectContaining({ mode: 'hybrid', kind: 'characters', hereNames: ['Bob'], thereNames: ['Ann'] })])
    expect(namesIn(String(spawned[0].sent[0].profile))).toEqual(['Bob'])
    expect(namesIn(s.posted!.profile)).toEqual(['Ann'])

    spawned[0].finish()
    s.status = 'done'
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await run.handle.result
    expect(outcome.report.players.map((p) => p.name)).toEqual(['Bob', 'Ann'])
  })

  it('says why a run with one piece runs whole on Frostsim Cloud', async () => {
    const run = hybridRun(new CloudServer(), request(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(places).toEqual([expect.objectContaining({ mode: 'cloud', note: expect.stringContaining('two or more candidates, characters or stat weights') })])
    run.handle.cancel()
    await expect(run.handle.result).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('runs each share on its own side at once and returns one report with every candidate', async () => {
    const s = new CloudServer()
    const run = hybridRun(s, request(4))
    await vi.advanceTimersByTimeAsync(0)

    expect(spawned).toHaveLength(1)
    const local = spawned[0]
    expect(local.ids()).toEqual(['c-0'])
    expect(s.posted!.profilesets!.map((p) => p.id)).toEqual(['c-1', 'c-2', 'c-3'])

    // Candidate progress counts both sides against the whole run: 1 local + 2 cloud done of 4.
    s.status = 'running'
    s.lines = [progress('c-3', 3, 4)]
    await vi.advanceTimersByTimeAsync(1000)
    local.say({ type: 'ready' })
    local.say({ type: 'log', stream: 'out', lines: [progress('c-0', 2, 2)] })
    expect(run.events.at(-1)?.stage).toMatchObject({ done: 3, total: 4 })

    local.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.events.some((e) => e.state === 'analyzing')).toBe(false)
    s.status = 'done'
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await run.handle.result
    expect(outcome.report.profilesets.map((p) => p.name).sort()).toEqual(['c-0', 'c-1', 'c-2', 'c-3'])
    expect(outcome.profilesetStatus.missing).toEqual([])
    expect(spawned.filter((w) => w.url !== 'report')).toHaveLength(1)
  })

  it('runs a declined cloud share here, only after the local share has shut down', async () => {
    const s = new CloudServer()
    s.submit = 402
    const run = hybridRun(s, request(4))
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(1)

    spawned[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(2)
    expect(spawned[1].ids()).toEqual(['c-1', 'c-2', 'c-3'])
    spawned[1].finish()
    const outcome = await run.handle.result
    expect(outcome.report.profilesets).toHaveLength(4)
    expect(run.events.some((e) => e.warning?.startsWith('Frostsim Cloud: no compute allowance'))).toBe(true)
  })

  it('cancels both sides and deletes the cloud job', async () => {
    const s = new CloudServer()
    const run = hybridRun(s, request(4))
    await vi.advanceTimersByTimeAsync(0)
    run.handle.cancel()
    await expect(run.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.deletes).toBe(1)
    expect(spawned[0].sent.some((m) => m.type === 'cancel')).toBe(true)
  })

  it('sends a run with one candidate to the cloud whole', async () => {
    const s = new CloudServer()
    hybridRun(s, request(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(0)
    expect(s.posted!.profilesets).toHaveLength(1)
  })
})
