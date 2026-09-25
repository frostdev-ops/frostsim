import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetEngineRuntimeForTests, runJob, setRemoteEngine, WORKER_PROTOCOL, type JobEvent, type SimRequest } from './job'
import { createHybridEngine, mergeCharacters, mergeProfilesets, mergeStats, planOf, priorPaces, splitOf, type RunPlace } from './hybrid'
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
  finished = false
  finish(): void {
    this.finished = true
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
  /** The last job submitted, and every one, by id. */
  posted: SimRequest | null = null
  jobs = new Map<string, SimRequest>()
  deletes = 0
  /** GET /api/v1/compute/capacity's answer; null answers 404 (an older server). */
  capacity: unknown = null
  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/capacity')) return this.capacity ? Response.json(this.capacity) : new Response(null, { status: 404 })
    if (init.method === 'POST') {
      this.posted = JSON.parse(String(init.body)).request
      if (this.submit !== 200) return Response.json({ error: 'x' }, { status: this.submit })
      const id = CLOUD_ID.slice(0, -2) + String(this.jobs.size).padStart(2, '0')
      this.jobs.set(id, this.posted!)
      return Response.json({ id })
    }
    if (init.method === 'DELETE') {
      this.deletes++
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/result')) {
      const job = this.jobs.get(url.split('/').at(-2)!)!
      const body = new Blob([reportFor((job.profilesets ?? []).map((p) => p.id), namesIn(job.profile))]).stream().pipeThrough(new CompressionStream('gzip'))
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

const memoryStore = (init: Record<string, unknown> = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

let places: RunPlace[] = []
function hybridRun(s: CloudServer, req: SimRequest, speedStore: ReturnType<typeof memoryStore> | null = null) {
  places = []
  setRemoteEngine(createHybridEngine({ fetch: s.fetch, pollMs: 1000, cloudThreads: 12, onplace: (p) => places.push(p), speedStore, now: () => Date.now() }))
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

/** request(4) at 100 iterations of 300 s is 30,000 units a candidate: this PC 5 s a candidate on 4 threads, the cloud 2.5 s on 12
 *  plus 2 s of start-up. */
const LOCAL_RUN = { 'frostsim.speed.v1': { runs: { Patchwerk: [{ units: 30_000, threads: 4, wall: 5 }] }, cv2: {} } }
const CLOUD_MODEL = { speed: { Patchwerk: { overheadS: 2, secondsPerUnit: 0.001 } }, cv: {} }

describe('hybrid plans', () => {
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

  it('gives any chunk of characters its own profile, with the scenario lines, keeping the controller\'s args', () => {
    const plan = planOf(twoCharacters())!
    expect(namesIn(plan.request([1]).profile)).toEqual(['Ann'])
    const local = plan.localStart({ profile: 'whole', args: ['a'] }, [0])
    expect(namesIn(local.profile)).toEqual(['Bob'])
    expect(local.profile).toContain('enemy=Boss')
    expect(local.args).toEqual(['a'])
  })

  it('gives a chunk of stats its scale_only, the primary on every chunk when normalizing, swapping only that argument', () => {
    const plan = planOf(weights(true))!
    expect(plan).toMatchObject({ kind: 'stats', names: ['crit', 'haste', 'mastery', 'versatility'], shared: 2, both: ['intellect'] })
    expect(plan.request([1, 2, 3]).extraOptions).toContain('scale_only=intellect,haste,mastery,versatility')
    expect(plan.localStart({ profile: 'p', args: ['x', 'scale_only=intellect,crit,haste,mastery,versatility', 'y'] }, [0]).args)
      .toEqual(['x', 'scale_only=intellect,crit', 'y'])
  })

  it('drops the other candidates\' lines from a local chunk', () => {
    const plan = planOf(request(3))!
    const profile = 'mage="Bob"\nprofileset."c-0"+=talents=t0\nprofileset."c-1"+=talents=t1\nprofileset."c-2"+=talents=t2'
    expect(idsIn(plan.localStart({ profile, args: [] }, [0, 2]).profile)).toEqual(['c-0', 'c-2'])
  })

  it('paces each side from this device\'s runs and the server\'s cloud model, at the iterations the spread needs', () => {
    const store = memoryStore(LOCAL_RUN)
    expect(priorPaces(request(4), 12, { state: 'warm', waitS: 0, model: CLOUD_MODEL }, store)).toEqual({
      local: { piece: 5, chunk: 5 }, cloud: { piece: 2.5, chunk: 4.5 },
    })
    // A target error with no measured spread: the iterations, and so the paces, are unknown.
    expect(priorPaces({ ...request(4), accuracy: { mode: 'targetError', targetError: 0.1, maxIterations: 1000 } }, 12, null, store)).toEqual({})
  })
})

describe('merges', () => {
  it('appends the cloud results, creating the section when the local side had none', () => {
    const merged = (a: string[], b: string[]) => parseReport(dec(mergeProfilesets(enc(JSON.parse(reportFor(a))), enc(JSON.parse(reportFor(b))))))
    expect(merged(['c-0'], ['c-1', 'c-2']).profilesets.map((p) => p.name)).toEqual(['c-0', 'c-1', 'c-2'])
    expect(merged([], ['c-1']).profilesets.map((p) => p.name)).toEqual(['c-1'])
    expect(merged(['c-0'], []).profilesets.map((p) => p.name)).toEqual(['c-0'])
  })

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

/** Finishes every local engine as it appears and lets the cloud answer, until the run settles. */
async function drive(s: CloudServer, settled: () => boolean): Promise<void> {
  s.status = 'done'
  for (let i = 0; i < 40 && !settled(); i++) {
    for (const w of spawned.filter((x) => x.url !== 'report' && !x.finished && x.sent.length)) w.finish()
    await vi.advanceTimersByTimeAsync(1000)
  }
}

describe('hybrid runs', () => {
  it('runs a multi-character Quick Sim a character each side and returns one report with both, and says so', async () => {
    const s = new CloudServer()
    const run = hybridRun(s, twoCharacters())
    await vi.advanceTimersByTimeAsync(0)
    expect(places).toEqual([expect.objectContaining({ mode: 'hybrid', kind: 'characters', hereNames: ['Bob'], thereNames: ['Ann'] })])
    expect(namesIn(String(spawned[0].sent[0].profile))).toEqual(['Bob'])
    expect(namesIn(s.posted!.profile)).toEqual(['Ann'])

    // A server claims Ann's job; Bob takes 10 s here.
    s.status = 'running'
    await vi.advanceTimersByTimeAsync(10_000)
    spawned[0].finish()
    s.status = 'done'
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await run.handle.result
    expect(outcome.report.players.map((p) => p.name)).toEqual(['Bob', 'Ann'])
    expect(spawned.filter((w) => w.url !== 'report')).toHaveLength(1)
  })

  it('says why a run with one piece runs whole on Frostsim Cloud', async () => {
    const run = hybridRun(new CloudServer(), request(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(places).toEqual([expect.objectContaining({ mode: 'cloud', note: expect.stringContaining('two or more candidates, characters or stat weights') })])
    run.handle.cancel()
    await expect(run.handle.result).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('hands out chunks as each side frees up, and returns every candidate once, with whole-run progress', async () => {
    const s = new CloudServer()
    const run = hybridRun(s, request(6))
    await vi.advanceTimersByTimeAsync(0)
    // By thread share (4 here, 12 there) and halved: one here, two there, the rest held back.
    expect(spawned[0].ids()).toEqual(['c-0'])
    expect(s.posted!.profilesets!.map((p) => p.id)).toEqual(['c-4', 'c-5'])

    spawned[0].say({ type: 'ready' })
    spawned[0].say({ type: 'log', stream: 'out', lines: [progress('c-0', 2, 2)] })
    expect(run.events.at(-1)?.engineProgress).toMatchObject({ base: 'Hybrid', phase: '0 of 6' })

    let outcome: Awaited<typeof run.handle.result> | undefined
    void run.handle.result.then((o) => { outcome = o })
    await drive(s, () => outcome !== undefined)
    expect(outcome!.report.profilesets.map((p) => p.name).sort()).toEqual(['c-0', 'c-1', 'c-2', 'c-3', 'c-4', 'c-5'])
    expect(outcome!.profilesetStatus.missing).toEqual([])
    // More than one chunk ran on each side.
    expect(spawned.filter((w) => w.url !== 'report').length).toBeGreaterThan(1)
    expect(s.jobs.size).toBeGreaterThan(1)
  })

  it('sends a declined cloud chunk\'s candidates back to this PC, after its current engine is gone', async () => {
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
    expect(places.at(-1)?.note).toContain('The rest runs on this PC')
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

  it('learns this device\'s speed from its chunks', async () => {
    const store = memoryStore()
    const s = new CloudServer()
    const run = hybridRun(s, request(4), store)
    let settled = false
    void run.handle.result.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    await drive(s, () => settled)
    expect(JSON.parse(store.getItem('frostsim.speed.v1')!).runs.Patchwerk.length).toBeGreaterThan(0)
  })

  it('splits by measured pace when a cloud server is free, and keeps everything here when one would have to boot', async () => {
    const warm = new CloudServer()
    warm.capacity = { state: 'warm', waitS: 0, model: CLOUD_MODEL }
    const run = hybridRun(warm, request(4), memoryStore(LOCAL_RUN))
    await vi.advanceTimersByTimeAsync(0)
    // Both finish near 15 s: two candidates here (5 s start-up + 10 s), two there (2 s wait + 4.5 s + 5 s).
    expect(places.at(-1)).toMatchObject({ mode: 'hybrid', here: 2, there: 2 })
    run.handle.cancel()
    await expect(run.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(20_000)
    __resetEngineRuntimeForTests()
    spawned.length = 0

    const cold = new CloudServer()
    cold.capacity = { state: 'cold', waitS: 60, model: CLOUD_MODEL }
    const alone = hybridRun(cold, request(4), memoryStore(LOCAL_RUN))
    await vi.advanceTimersByTimeAsync(0)
    expect(cold.posted).toBeNull()
    expect(spawned[0].ids()).toEqual(['c-0', 'c-1', 'c-2', 'c-3'])
    expect(places.at(-1)).toMatchObject({ here: 4, there: 0, note: expect.stringContaining('none of your allowance') })
    spawned[0].finish()
    expect((await alone.handle.result).report.profilesets).toHaveLength(4)
  })

  it('runs here without submitting when the cloud says it cannot take the run', async () => {
    const s = new CloudServer()
    s.capacity = { state: 'none' }
    const run = hybridRun(s, request(4))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.posted).toBeNull()
    expect(places.at(-1)?.note).toContain('cannot take runs')
    spawned[0].finish()
    expect((await run.handle.result).report.profilesets).toHaveLength(4)
  })

  it('takes back a cloud chunk no server has claimed once this PC is idle', async () => {
    const s = new CloudServer()
    const run = hybridRun(s, twoCharacters())
    await vi.advanceTimersByTimeAsync(0)
    expect(namesIn(s.posted!.profile)).toEqual(['Ann'])
    // The cloud job is still queued when this PC finishes Bob.
    spawned[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.deletes).toBe(1)
    expect(namesIn(String(spawned[1].sent[0].profile))).toEqual(['Ann'])
    spawned[1].finish()
    expect((await run.handle.result).report.players.map((p) => p.name)).toEqual(['Bob', 'Ann'])
  })

  it('races a cloud chunk running far slower than expected, and cancels the side that loses', async () => {
    const s = new CloudServer()
    s.capacity = { state: 'warm', waitS: 0, model: CLOUD_MODEL }
    const run = hybridRun(s, twoCharacters(), memoryStore(LOCAL_RUN))
    await vi.advanceTimersByTimeAsync(0)
    expect(namesIn(s.posted!.profile)).toEqual(['Ann'])
    // The cloud is a tenth of the way through Ann after about 20 s; Bob took 20 s here.
    s.status = 'running'
    s.lines = ['Generating\t1\t1\t10\t100\t5\t0']
    await vi.advanceTimersByTimeAsync(20_000)
    spawned[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(namesIn(String(spawned[1].sent[0].profile))).toEqual(['Ann'])
    spawned[1].finish()
    expect((await run.handle.result).report.players.map((p) => p.name)).toEqual(['Bob', 'Ann'])
    await vi.advanceTimersByTimeAsync(0)
    expect(s.deletes).toBe(1)
  })

  it('reports before shutting down, and confirms a cancel at once when nothing is left running', async () => {
    const s = new CloudServer()
    const worker = createHybridEngine({ fetch: s.fetch, pollMs: 1000, cloudThreads: 12, speedStore: null })(request(4), PACK_DIR)!('threaded') as unknown as LocalEngine
    const got: Record<string, unknown>[] = []
    worker.onmessage = (e) => got.push((e as MessageEvent).data)
    worker.postMessage({ protocol: WORKER_PROTOCOL, jobId: 'j1', profile: 'x', args: [] })
    await vi.advanceTimersByTimeAsync(0)
    await drive(s, () => got.some((m) => m.type === 'shutdown'))
    expect(got.filter((m) => m.type === 'done' || m.type === 'shutdown').map((m) => m.type)).toEqual(['done', 'shutdown'])
    worker.postMessage({ type: 'cancel' })
    expect(got.at(-1)).toMatchObject({ type: 'shutdown', reason: 'cancelled' })
  })

  it('sends a run with one candidate to the cloud whole', async () => {
    const s = new CloudServer()
    hybridRun(s, request(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(0)
    expect(s.posted!.profilesets).toHaveLength(1)
  })
})
