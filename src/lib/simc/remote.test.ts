import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEngineRuntimeForTests,
  engineAvailability,
  engineBusy,
  runJob,
  setRemoteEngine,
  WORKER_PROTOCOL,
  type JobEvent,
  type SimOutcome,
  type SimRequest,
} from './job'
import { createRemoteEngine, type RemoteOptions } from './remote'
import { parseEngineNotice, parseReport } from './report'
import { assembleRun } from './assemble'
import { DEFAULT_SETTINGS } from './options'
import type { EngineCapability, EngineManifest } from './capability'

// DESIGN.md C9 seam: mocked fetch and fake workers only. No network, no real engine.

const manifest: EngineManifest = {
  schemaVersion: 1,
  artifact: 'threaded',
  engine: { simcVersion: '1210-01', upstreamCommit: 'c01572044af513f9d85b79080b8d14619f1c00c5' },
  wow: { clientDataVersion: '12.1.0.69814', hotfixHash: 'dca34b30' },
  capabilities: { threads: true, pthreadPoolSize: 16, maxThreads: 16, profilesets: true, networking: false, reportVersions: [2] },
  files: { 'simc.wasm': { bytes: 63_275_426, sha256: 'aa'.repeat(32) } },
}

const PACK_DIR = '/engine/versions/pack-1/'
const capability: EngineCapability = { ok: true, artifact: 'threaded', engineDir: PACK_DIR, maxThreads: 16, profilesets: true, manifest }
const fallbackCapability: EngineCapability = {
  ok: true, artifact: 'fallback', engineDir: `${PACK_DIR}fallback/`, maxThreads: 1, profilesets: false,
  manifest: { ...manifest, artifact: 'fallback', capabilities: { ...manifest.capabilities, threads: false, maxThreads: 0, profilesets: false } },
}

const report = {
  version: '1210-01',
  report_version: '2.0.0',
  sim: {
    options: {
      iterations: 53, target_error: 0, threads: 4, max_time: 300, fight_style: 'Patchwerk', desired_targets: 1,
      single_actor_batch: false, fixed_time: true, confidence: 0.95, confidence_estimator: 1.9599639854088815,
      dbc: { Live: { wow_version: '12.1.0.69814', build_level: 69814 }, version_used: 'Live' },
    },
    players: [{ name: 'Bob', specialization: 'Frost Mage', collected_data: { dps: { sum: 100, count: 49, mean: 223973.7, min: 1, max: 2, std_dev: 7634, mean_std_dev: 1090.6 } } }],
    statistics: { elapsed_time_seconds: 0.17 },
  },
}
const reportText = JSON.stringify(report)
const PROGRESS = 'Generating Baseline: 1/1 [=====>..............] 512/1000 3.410'
const CLOUD_ID = '6f1c1c9e-0d1b-4c43-9a55-6c1f8f3f0a01'

function request(over: Partial<SimRequest> = {}): SimRequest {
  return {
    schemaVersion: 1,
    profile: 'mage="Bob"\nlevel=80\n',
    settings: { ...DEFAULT_SETTINGS, threads: 4 },
    accuracy: { mode: 'iterations', iterations: 1000 },
    ...over,
  }
}

type Listener = ((e: unknown) => void) | null

class FakeWorker {
  onmessage: Listener = null
  onerror: Listener = null
  onmessageerror: Listener = null
  terminated = 0
  readonly sent: Record<string, unknown>[] = []
  postMessage(data: unknown): void {
    this.sent.push(data as Record<string, unknown>)
  }
  terminate(): void {
    this.terminated++
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

/** The browser engine as the stubbed global Worker; like sim-worker.js it confirms a cancel with shutdown. */
const spawned: LocalEngine[] = []
class LocalEngine extends FakeWorker {
  constructor(readonly url: string) {
    super()
    spawned.push(this)
  }
  postMessage(data: unknown): void {
    super.postMessage(data)
    if ((data as { type?: string }).type === 'cancel') queueMicrotask(() => this.say({ type: 'shutdown', reason: 'cancelled', threads: 16 }))
  }
  say(msg: Record<string, unknown>): void {
    this.emit({ protocol: WORKER_PROTOCOL, jobId: this.sent[0].jobId, ...msg })
  }
  finish(): void {
    this.say({ type: 'initializing' })
    this.say({ type: 'ready' })
    this.say({ type: 'log', stream: 'out', lines: [PROGRESS] })
    this.say({ type: 'done', report: new TextEncoder().encode(reportText) })
  }
}

class FakeReportWorker extends FakeWorker {
  postMessage(data: unknown): void {
    super.postMessage(data)
    const { jobId, bytes } = data as { jobId: string; bytes: ArrayBuffer }
    queueMicrotask(() => this.emit({ jobId, ok: true, kind: 'summary', report: parseReport(JSON.parse(new TextDecoder().decode(bytes))), bytes }))
  }
}

function gzip(text: string): Response {
  const body = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(body, { headers: { 'content-type': 'application/gzip' } })
}

interface Call { method: string; url: string; body?: { packId: string; request: SimRequest }; keepalive?: true }

/** The account server's compute routes as far as the client sees them. */
class CloudServer {
  calls: Call[] = []
  submit: number | 'network' = 200
  status = 'queued'
  /** Every progress line written so far; a poll gets the ones after its cursor, like compute's jobView. */
  log: string[] = []
  /** queue.ts's Redis-down view: no lines, the cursor echoed back. */
  redisDown = false
  pollFailures = 0
  /** Statuses the next DELETEs answer with before the default 204. */
  deleteStatuses: number[] = []
  /** Fields only a done job's view carries (notices, effective). */
  done: Record<string, unknown> = {}
  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const method = init.method ?? 'GET'
    this.calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, ...(init.keepalive ? { keepalive: true as const } : {}) })
    if (method === 'POST') {
      if (this.submit === 'network') throw new TypeError('Failed to fetch')
      return this.submit === 200 ? Response.json({ id: CLOUD_ID }) : Response.json({ error: 'x', message: 'no' }, { status: this.submit })
    }
    if (method === 'DELETE') return new Response(null, { status: this.deleteStatuses.shift() ?? 204 })
    if (url.endsWith('/result')) return gzip(reportText)
    if (this.pollFailures > 0) {
      this.pollFailures--
      throw new TypeError('Failed to fetch')
    }
    const after = Number(new URL(url, 'https://sim.test').searchParams.get('after'))
    return Response.json({
      ...(this.redisDown ? { status: this.status, lines: [], next: after } : { status: this.status, lines: this.log.slice(after), next: this.log.length }),
      ...(this.status === 'done' ? this.done : {}),
    })
  }) as typeof fetch
  deletes(): Call[] {
    return this.calls.filter((c) => c.method === 'DELETE')
  }
  polls(): Call[] {
    return this.calls.filter((c) => c.method === 'GET' && !c.url.endsWith('/result'))
  }
  cursors(): (string | null)[] {
    return this.polls().map((c) => new URL(c.url, 'https://sim.test').searchParams.get('after'))
  }
}

const server = () => new CloudServer()

const opened: { cancel(reason?: string): void; result: Promise<unknown> }[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', LocalEngine)
})

afterEach(async () => {
  for (const handle of opened.splice(0)) {
    handle.cancel('test teardown')
    await handle.result.catch(() => {})
  }
  await vi.advanceTimersByTimeAsync(20_000)
  setRemoteEngine(null)
  spawned.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetEngineRuntimeForTests()
})

function start(req: SimRequest, cap: EngineCapability = capability, extra: { createEngineWorker?: () => Worker } = {}) {
  const events: JobEvent[] = []
  const handle = runJob(req, (e) => events.push(e), {
    createReportWorker: () => new FakeReportWorker() as unknown as Worker,
    capability: cap,
    ...extra,
  })
  opened.push(handle)
  return { handle, events, warnings: () => events.flatMap((e) => (e.warning ? [e.warning] : [])) }
}

function cloudRun(s: CloudServer, req = request(), cap: EngineCapability = capability, opts: RemoteOptions = {}) {
  setRemoteEngine(createRemoteEngine({ fetch: s.fetch, pollMs: 1000, ...opts }))
  return start(req, cap)
}

/** Drive a queued cloud job to a finished one. */
async function finishInCloud(s: CloudServer): Promise<void> {
  s.status = 'running'
  s.log.push(PROGRESS)
  await vi.advanceTimersByTimeAsync(1000)
  s.status = 'done'
  await vi.advanceTimersByTimeAsync(1000)
}

describe('job.ts remote seam', () => {
  it('runs on the local engine factory when no remote engine is registered', async () => {
    const run = start(request())
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].url).toBe(`${PACK_DIR}sim-worker.js?worker=3`)
    spawned[0].finish()
    const outcome = await run.handle.result
    expect(outcome.placement).toBe('browser')
  })

  it('never consults the remote engine when a test injects the engine worker', async () => {
    const remote = vi.fn(() => null)
    setRemoteEngine(remote)
    const engine = new LocalEngine('injected')
    spawned.length = 0
    start(request(), capability, { createEngineWorker: () => engine as unknown as Worker })
    await vi.advanceTimersByTimeAsync(0)
    expect(remote).not.toHaveBeenCalled()
    expect(engine.sent).toHaveLength(1)
  })

  it('consults it only after the capability check, with the frozen request', async () => {
    const remote = vi.fn(() => null)
    setRemoteEngine(remote)
    const refused = start(request(), { ok: false, reason: 'no-isolation', detail: 'not isolated' })
    await expect(refused.handle.result).rejects.toMatchObject({ code: 'no-isolation' })
    expect(remote).not.toHaveBeenCalled()

    const run = start(request())
    await vi.advanceTimersByTimeAsync(0)
    expect(remote).toHaveBeenCalledTimes(1)
    const [seen, engineDir] = remote.mock.calls[0] as unknown as [SimRequest, string]
    expect(Object.isFrozen(seen)).toBe(true)
    expect(seen.jobId).toBe(run.handle.jobId)
    // The pack id lives in the engine folder; without one the factory declines.
    expect(engineDir).toBe(PACK_DIR)
    // null means an ordinary local run.
    expect(spawned).toHaveLength(1)
  })
})

describe('remote engine happy path', () => {
  it('renders the same outcome as a browser run, apart from placement', async () => {
    const local = start(request({ jobId: 'same-job' }), capability, { createEngineWorker: () => new LocalEngine('injected') as unknown as Worker })
    await vi.advanceTimersByTimeAsync(0)
    spawned[0].finish()
    const browser = await local.handle.result
    spawned.length = 0

    const s = server()
    const cloud = cloudRun(s, request({ jobId: 'same-job', characterSnapshot: { name: 'Bob' } as never }))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls[0]).toMatchObject({ method: 'POST', url: '/api/v1/compute/jobs', body: { packId: 'pack-1' } })
    // The display-only snapshot stays home; the rest of the frozen request goes as is.
    expect(s.calls[0].body!.request).not.toHaveProperty('characterSnapshot')
    expect(s.calls[0].body!.request.profile).toBe(request().profile)
    await finishInCloud(s)
    const remote = await cloud.handle.result

    expect(spawned).toHaveLength(0)
    expect(remote.placement).toBe('cloud')
    const same = (o: SimOutcome) => {
      const { placement: _p, appElapsedSeconds: _a, getRawJson: _r, getHtmlReport: _h, request: req, ...rest } = o
      const { characterSnapshot: _c, ...sent } = req
      return { ...rest, request: sent }
    }
    expect(same(remote)).toEqual(same(browser))
    expect(await remote.getRawJson().text()).toBe(await browser.getRawJson().text())
    const states = cloud.events.map((e) => e.state)
    for (const state of ['acquiring', 'initializing', 'running', 'analyzing', 'complete']) expect(states).toContain(state)
    expect(cloud.events.find((e) => e.progress)?.progress).toEqual({ kind: 'iterations', done: 512, total: 1000, label: undefined })
    // The next poll resumes after the cursor, so a line is forwarded once.
    expect(cloud.events.filter((e) => e.log).length).toBe(1)
    expect(s.cursors()).toEqual(['0', '1'])
    expect(cloud.warnings()).toEqual([])
  })

  it('runs profilesets in the cloud even when this browser has only the fallback build', async () => {
    const s = server()
    const run = cloudRun(s, request({ profilesets: [{ id: 'c-1', lines: ['talents=abc'] }] }), fallbackCapability)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls[0].body!.packId).toBe('pack-1')
    await finishInCloud(s)
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'cloud' })
  })

  it('outlasts the local init timeout while the job waits for a cloud server', async () => {
    const s = server()
    const run = cloudRun(s, request(), capability, { queueGiveUpMs: 300_000 })
    await vi.advanceTimersByTimeAsync(200_000)
    expect(run.handle.state).toBe('initializing')
    await finishInCloud(s)
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'cloud' })
    expect(s.deletes()).toHaveLength(0)
  })

  it('is not cancelled by the terminate that follows done', async () => {
    const s = server()
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    await finishInCloud(s)
    await run.handle.result
    const calls = s.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.deletes()).toHaveLength(0)
    expect(s.calls.length).toBe(calls)
    expect(engineBusy()).toBe(false)
  })
})

describe('remote engine cancellation', () => {
  it('cancels mid-queue without ever blocking the engine', async () => {
    const s = server()
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(2000)
    expect(run.handle.state).toBe('initializing')
    run.handle.cancel()
    await expect(run.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(16_000)
    expect(engineAvailability().available).toBe(true)
    expect(engineBusy()).toBe(false)
    expect(s.deletes()).toEqual([{ method: 'DELETE', url: `/api/v1/compute/jobs/${CLOUD_ID}`, body: undefined }])
    const polls = s.polls().length
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.polls().length).toBe(polls)
  })

  it('deletes a job whose submit was still in flight when the run was cancelled', async () => {
    const s = server()
    let release!: () => void
    const inner = s.fetch
    s.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') await new Promise<void>((r) => { release = r })
      return inner(input, init)
    }) as typeof fetch
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    run.handle.cancel()
    await expect(run.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.deletes()).toHaveLength(1)
    expect(s.polls()).toHaveLength(0)
    expect(engineAvailability().available).toBe(true)
  })
})

describe('remote engine fallback', () => {
  const cases: [string, (s: CloudServer) => void, number, boolean][] = [
    ['402 no allowance', (s) => { s.submit = 402 }, 0, false],
    ['409 no native build', (s) => { s.submit = 409 }, 0, false],
    ['429 too many jobs', (s) => { s.submit = 429 }, 0, false],
    ['503 no capacity', (s) => { s.submit = 503 }, 0, false],
    ['a network error', (s) => { s.submit = 'network' }, 0, false],
    ['a failed cloud job', (s) => { s.status = 'failed' }, 1000, false],
    ['a minute of failed polls', (s) => { s.pollFailures = 1000 }, 61_000, true],
    ['a queue wait past the bound', () => {}, 152_000, true],
  ]

  it.each(cases)('replays on this browser after %s', async (_name, setup, wait, deletes) => {
    const s = server()
    setup(s)
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(wait)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(1)
    const engine = spawned[0]
    expect(engine.url).toBe(`${PACK_DIR}sim-worker.js?worker=3`)
    // The controller's own start message, untouched: same job, profile, args and cancel flag.
    expect(engine.sent[0]).toMatchObject({ protocol: WORKER_PROTOCOL, jobId: run.handle.jobId, profilePath: '/profile.simc' })
    expect(engine.sent[0].cancelFlag).toBeInstanceOf(SharedArrayBuffer)
    expect(s.deletes()).toHaveLength(deletes ? 1 : 0)

    engine.say({ type: 'assets', loaded: 10, total: 100, cached: false })
    engine.finish()
    const outcome = await run.handle.result
    expect(outcome.placement).toBe('browser')
    expect(run.events.some((e) => e.progress?.kind === 'assets')).toBe(true)
    const notices = run.warnings()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^Frostsim Cloud: .+ Running in this browser instead\.$/)
    expect(outcome.engineNotices).toEqual([])
  })

  it('keeps a running cloud job through an account-server restart of most of a minute', async () => {
    const s = server()
    s.pollFailures = 58
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(58_000)
    await finishInCloud(s)
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'cloud' })
    expect(spawned).toHaveLength(0)
  })

  it('retries the DELETE of an abandoned job until the server answers it', async () => {
    const s = server()
    s.pollFailures = 1000
    s.deleteStatuses = [502, 502]
    cloudRun(s)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(s.deletes()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.deletes()).toHaveLength(3)
    expect(spawned).toHaveLength(1)
  })

  it('cancels a live cloud job with a keepalive DELETE when the page goes away', async () => {
    const listeners: (() => void)[] = []
    vi.stubGlobal('addEventListener', (type: string, fn: () => void) => { if (type === 'pagehide') listeners.push(fn) })
    const s = server()
    cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    expect(listeners.length).toBeGreaterThan(0)
    listeners[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.deletes()).toEqual([{ method: 'DELETE', url: `/api/v1/compute/jobs/${CLOUD_ID}`, body: undefined, keepalive: true }])
    // The run's own teardown finds nothing left to delete.
    listeners[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.deletes()).toHaveLength(1)
  })

  it('gives the result download a longer bound than other requests', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout')
    const s = server()
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    await finishInCloud(s)
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'cloud' })
    const resultCall = s.calls.findIndex((c) => c.url.endsWith('/result'))
    expect(timeouts.mock.calls[resultCall][0]).toBe(150_000)
    expect(timeouts.mock.calls[0][0]).toBe(30_000)
    timeouts.mockRestore()
  })

  it('forwards a cancel to the replayed engine and waits for its own shutdown', async () => {
    const s = server()
    s.submit = 402
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    const engine = spawned[0]
    engine.say({ type: 'initializing' })
    run.handle.cancel()
    await expect(run.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(engine.sent.at(-1)).toEqual({ protocol: WORKER_PROTOCOL, jobId: run.handle.jobId, type: 'cancel' })
    await vi.advanceTimersByTimeAsync(16_000)
    expect(engine.terminated).toBeGreaterThan(0)
    expect(engineAvailability().available).toBe(true)
    expect(engineBusy()).toBe(false)
  })

  it('refuses profilesets instead of replaying them on the fallback build', async () => {
    const s = server()
    s.submit = 402
    const run = cloudRun(s, request({ profilesets: [{ id: 'c-1', lines: ['talents=abc'] }] }), fallbackCapability)
    await expect(run.handle.result).rejects.toMatchObject({ code: 'profilesets-unsupported' })
    expect(spawned).toHaveLength(0)
    expect(engineAvailability().available).toBe(true)
  })
})

describe('remote engine liveness', () => {
  it('keeps a live cloud job whose progress lines stop past the stall window', async () => {
    const s = server()
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    s.status = 'running'
    s.log.push(PROGRESS)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run.handle.state).toBe('running')
    // Redis down: compute drops progress lines, the job itself is fine (DESIGN.md A5).
    s.redisDown = true
    await vi.advanceTimersByTimeAsync(200_000)
    expect(run.handle.state).toBe('running')
    s.redisDown = false
    s.status = 'done'
    await vi.advanceTimersByTimeAsync(1000)
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'cloud' })
    expect(s.deletes()).toHaveLength(0)
  })

  it('bounds a requeue after a lost lease like the first wait', async () => {
    const s = server()
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    s.status = 'running'
    s.log.push(PROGRESS)
    await vi.advanceTimersByTimeAsync(1000)
    // Seen queued again at the 2 s poll, so the bound ends at 152 s.
    s.status = 'queued'
    await vi.advanceTimersByTimeAsync(149_000)
    expect(run.handle.state).toBe('running')
    expect(spawned).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(spawned).toHaveLength(1)
    expect(s.deletes()).toHaveLength(1)
    expect(run.warnings()).toEqual(['Frostsim Cloud: no cloud server was free in time. Running in this browser instead.'])
    spawned[0].finish()
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'browser' })
  })

  it('gives up 150 s after the start message however slow the submit, leaving the local load its full time', async () => {
    const s = server()
    const inner = s.fetch
    s.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') await new Promise((r) => setTimeout(r, 200_000))
      return inner(input, init)
    }) as typeof fetch
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(149_000)
    expect(spawned).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(spawned).toHaveLength(1)
    // The submit lands after the replay: that job is deleted and never polled.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.deletes()).toHaveLength(1)
    expect(s.polls()).toHaveLength(0)
    spawned[0].say({ type: 'assets', loaded: 1, total: 100, cached: false })
    // 179 s into the replay, which started at 150 s: the local load is timed from the replay.
    await vi.advanceTimersByTimeAsync(118_000)
    expect(run.handle.state).not.toBe('error')
    spawned[0].finish()
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'browser' })
  })

  it('forwards each progress line exactly once across a Redis outage, repeats included', async () => {
    const s = server()
    const run = cloudRun(s)
    await vi.advanceTimersByTimeAsync(0)
    s.status = 'running'
    s.log.push('same', 'same')
    await vi.advanceTimersByTimeAsync(1000)
    s.redisDown = true
    await vi.advanceTimersByTimeAsync(1000)
    s.redisDown = false
    s.log.push('next')
    await vi.advanceTimersByTimeAsync(1000)
    s.status = 'done'
    await vi.advanceTimersByTimeAsync(1000)
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'cloud' })
    expect(run.events.flatMap((e) => e.log ?? [])).toEqual(['same', 'same', 'next'])
    expect(s.cursors()).toEqual(['0', '2', '2', '3'])
  })

  /** A cloud run that fails after 29 minutes and replays here, just before the controller's original 30 min deadline. */
  async function lateReplay() {
    const s = server()
    const run = cloudRun(s)
    const settled = run.handle.result.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(0)
    s.status = 'running'
    s.log.push(PROGRESS)
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    s.status = 'failed'
    await vi.advanceTimersByTimeAsync(1000)
    expect(spawned).toHaveLength(1)
    return { run, settled, engine: spawned[0] }
  }

  it('gives a late replay the full local load time, counted from the replay', async () => {
    const { run, settled, engine } = await lateReplay()
    engine.say({ type: 'initializing' })
    // Past the original deadline, and past neither the local 180 s load nor the cloud's 360 s.
    await vi.advanceTimersByTimeAsync(179_000)
    expect(run.handle.state).toBe('initializing')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await settled).toMatchObject({ name: 'SimTimeoutError', phase: 'initializing' })
  })

  it('gives a late replay the full local deadline, counted from the replay', async () => {
    const { run, settled, engine } = await lateReplay()
    engine.say({ type: 'initializing' })
    engine.say({ type: 'ready' })
    // A healthy run: a progress line every minute keeps the stall watchdog quiet.
    for (let minute = 0; minute < 30; minute++) {
      engine.say({ type: 'log', stream: 'out', lines: [PROGRESS] })
      await vi.advanceTimersByTimeAsync(60_000)
      if (minute < 29) expect(run.handle.state).toBe('running')
    }
    expect(await settled).toMatchObject({ name: 'SimTimeoutError', phase: 'deadline' })
  })

  it('stops a replay that hangs, once its own progress arms the stall watchdog', async () => {
    const s = server()
    const run = cloudRun(s)
    const settled = run.handle.result.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(0)
    s.status = 'running'
    s.log.push(PROGRESS)
    await vi.advanceTimersByTimeAsync(1000)
    s.status = 'failed'
    await vi.advanceTimersByTimeAsync(1000)
    const engine = spawned[0]
    engine.say({ type: 'initializing' })
    engine.say({ type: 'ready' })
    // The cloud's progress does not vouch for this engine: silence before its first line is allowed, as in any local run.
    await vi.advanceTimersByTimeAsync(200_000)
    expect(run.handle.state).toBe('running')
    engine.say({ type: 'log', stream: 'out', lines: [PROGRESS] })
    await vi.advanceTimersByTimeAsync(179_000)
    expect(run.handle.state).toBe('running')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await settled).toMatchObject({ name: 'SimTimeoutError', phase: 'stalled' })
    expect(s.deletes()).toHaveLength(0)
  })

  it('fails at once when the browser engine cannot start for a replay', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new DOMException('blocked', 'SecurityError') } })
    const s = server()
    s.submit = 402
    const run = cloudRun(s)
    await expect(run.handle.result).rejects.toMatchObject({ code: 'engine-worker' })
    expect(engineAvailability().available).toBe(true)
    expect(engineBusy()).toBe(false)
  })
})

describe('remote engine provenance', () => {
  it('records the profile, args and stderr the cloud ran, without this browser\'s thread clamp', async () => {
    const s = server()
    const effective = { threads: 32, args: ['/profile.simc', 'threads=32', 'json=/out.json,version=2'], profile: 'mage="Bob"\nlevel=80\n# assembled by the server\n' }
    const notices = ['Moderate: Player Bob has no gear.', 'a plain stderr line']
    s.done = { effective, notices }
    // The fallback build allows 1 thread, so this browser clamps the request's 4; the cloud picked 32.
    const run = cloudRun(s, request(), fallbackCapability)
    await vi.advanceTimersByTimeAsync(0)
    await finishInCloud(s)
    const outcome = await run.handle.result
    expect(outcome.placement).toBe('cloud')
    expect(outcome.effectiveProfile).toBe(effective.profile)
    expect(outcome.effectiveArgs).toEqual(effective.args)
    expect(outcome.inputWarnings).toEqual([])
    // The live log already showed the clamp at start; the cloud's stderr follows as engine warnings.
    expect(run.warnings()).toEqual([expect.stringMatching(/^Running on 1 thread instead of 4/), ...notices])
    expect(outcome.engineNotices).toEqual([parseEngineNotice(notices[0])])
  })

  it.each([
    ['no effective', undefined],
    ['a profile that is not text', { threads: 16, profile: 5, args: [] }],
    ['an arg that is not text', { threads: 16, profile: 'x', args: ['a', 7] }],
    ['args that are not a list', { threads: 16, profile: 'x', args: 'a' }],
  ])('keeps this browser\'s assembly when the done view has %s', async (_name, effective) => {
    const s = server()
    s.done = { effective }
    const req = request()
    const run = cloudRun(s, req)
    await vi.advanceTimersByTimeAsync(0)
    await finishInCloud(s)
    const outcome = await run.handle.result
    const local = assembleRun(req, capability.maxThreads)
    expect(outcome.placement).toBe('cloud')
    expect(outcome.effectiveProfile).toBe(local.profile)
    expect(outcome.effectiveArgs).toEqual(local.args)
  })

  it('never carries cloud stderr or provenance into a run replayed here', async () => {
    const s = server()
    s.done = { effective: { threads: 32, profile: 'cloud', args: ['cloud'] }, notices: ['Severe: from the cloud'] }
    // The result has expired, so the browser engine runs the job after all.
    const inner = s.fetch
    s.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/result') ? new Response(null, { status: 404 }) : inner(input, init)) as typeof fetch
    const run = cloudRun(s, request(), fallbackCapability)
    await vi.advanceTimersByTimeAsync(0)
    s.status = 'done'
    await vi.advanceTimersByTimeAsync(1000)
    expect(spawned).toHaveLength(1)
    spawned[0].finish()
    const outcome = await run.handle.result
    expect(outcome.placement).toBe('browser')
    expect(outcome.effectiveProfile).not.toBe('cloud')
    expect(outcome.engineNotices).toEqual([])
    expect(outcome.inputWarnings).toEqual([expect.stringMatching(/^Running on 1 thread instead of 4/)])
  })
})

describe('remote engine eligibility', () => {
  const eligible = createRemoteEngine({ fetch: (() => { throw new Error('no network in tests') }) as typeof fetch })

  it('leaves Expert Mode text, HTML reports and unpublished engines in the browser', () => {
    expect(eligible(request({ mode: 'raw' }), PACK_DIR)).toBeNull()
    expect(eligible(request({ slots: { header: 'x=1' } }), PACK_DIR)).toBeNull()
    expect(eligible(request({ htmlReport: true }), PACK_DIR)).toBeNull()
    expect(eligible(request(), '/engine/')).toBeNull()
    expect(eligible(request(), '/engine/fallback/')).toBeNull()
    expect(eligible(request(), PACK_DIR)).toBeTypeOf('function')
    expect(eligible(request(), `${PACK_DIR}fallback/`)).toBeTypeOf('function')
  })

  it('sends guided Advanced runs, whose slots are empty, to the cloud without them', async () => {
    const s = server()
    const run = cloudRun(s, request({ slots: { header: undefined, preActor: '', footer: '  \n' } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls[0].method).toBe('POST')
    expect(s.calls[0].body!.request).not.toHaveProperty('slots')
    await finishInCloud(s)
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'cloud' })
  })

  it('runs in this browser, without a request or a notice, when the engine is not a published pack', async () => {
    const s = server()
    const run = cloudRun(s, request(), { ...capability, engineDir: '/engine/' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls).toHaveLength(0)
    expect(spawned[0].url).toBe('/engine/sim-worker.js?worker=3')
    spawned[0].finish()
    await expect(run.handle.result).resolves.toMatchObject({ placement: 'browser' })
    expect(run.warnings()).toEqual([])
  })

  it('refuses profilesets on an unpublished fallback build before taking the engine', async () => {
    const s = server()
    const run = cloudRun(s, request({ profilesets: [{ id: 'c-1', lines: ['talents=abc'] }] }), { ...fallbackCapability, engineDir: '/engine/fallback/' })
    await expect(run.handle.result).rejects.toMatchObject({ code: 'profilesets-unsupported' })
    expect(run.events.map((e) => e.state)).not.toContain('acquiring')
    expect(run.warnings()).toEqual([])
    expect(s.calls).toHaveLength(0)
  })

  it('terminate is idempotent, stops polling, and deletes only an unfinished job', async () => {
    const s = server()
    const worker = createRemoteEngine({ fetch: s.fetch, pollMs: 1000 })(request(), PACK_DIR)!('threaded', PACK_DIR)
    const heard: { type?: string }[] = []
    worker.onmessage = (e) => heard.push(e.data)
    worker.postMessage({ protocol: WORKER_PROTOCOL, jobId: 'direct' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(heard[0]).toEqual({ protocol: WORKER_PROTOCOL, jobId: 'direct', type: 'initializing' })
    worker.terminate()
    worker.terminate()
    const before = heard.length
    await vi.advanceTimersByTimeAsync(200_000)
    expect(s.deletes()).toHaveLength(1)
    expect(s.polls()).toHaveLength(1)
    expect(heard).toHaveLength(before)
    expect(heard.map((m) => m.type)).not.toContain('log')
  })
})
