import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelActiveJob,
  engineAvailability,
  engineBusy,
  __resetEngineRuntimeForTests,
  runJob,
  validateRequest,
  SimEngineError,
  SimTimeoutError,
  SimValidationError,
  WORKER_PROTOCOL,
  type JobEvent,
  type JobState,
  type SimRequest,
} from './job'
import { parseReport } from './report'
import { DEFAULT_SETTINGS, type Accuracy } from './options'
import type { EngineCapability, EngineManifest } from './capability'

// Test controller lifecycle: settlement, identity, teardown, timeouts; NOT real pthread cleanup (P01.4 needs browser).

const manifest: EngineManifest = {
  schemaVersion: 1,
  artifact: 'threaded',
  engine: { simcVersion: '1210-01', upstreamCommit: 'c01572044af513f9d85b79080b8d14619f1c00c5' },
  wow: { clientDataVersion: '12.1.0.69814', hotfixHash: 'dca34b30' },
  capabilities: {
    threads: true,
    pthreadPoolSize: 16,
    maxThreads: 16,
    profilesets: true,
    networking: false,
    reportVersions: [2],
  },
  files: {
    'simc.js': { bytes: 79_724, sha256: 'bb'.repeat(32) },
    'simc.wasm': { bytes: 63_275_426, sha256: 'aa'.repeat(32) },
  },
}

const capability: EngineCapability = {
  ok: true,
  artifact: 'threaded',
  engineDir: '/engine/',
  maxThreads: 16,
  profilesets: true,
  manifest,
}

const minimalReport = {
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
      dbc: { Live: { wow_version: '12.1.0.69814', build_level: 69814 }, version_used: 'Live' },
    },
    players: [
      {
        name: 'Bob',
        specialization: 'Frost Mage',
        collected_data: {
          dps: { sum: 100, count: 49, mean: 223973.7, min: 1, max: 2, std_dev: 7634, mean_std_dev: 1090.6 },
        },
      },
    ],
    statistics: { elapsed_time_seconds: 0.17 },
  },
}

function reportBytes(report: unknown = minimalReport): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(report))
}

type Listener = ((e: unknown) => void) | null

/** Enough of the Worker surface for the controller, plus a terminate counter. */
class FakeWorker {
  onmessage: Listener = null
  onerror: Listener = null
  onmessageerror: Listener = null
  terminated = 0
  readonly sent: unknown[] = []

  postMessage(data: unknown): void {
    this.sent.push(data)
  }

  terminate(): void {
    this.terminated++
  }

  /** Deliver a message from the worker to the controller. */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  get alive(): boolean {
    return this.terminated === 0
  }
}

class FakeEngineWorker extends FakeWorker {
  jobId(): string {
    return (this.sent[0] as { jobId: string }).jobId
  }

  assets(loaded: number, total?: number, cached = false): void {
    this.emit({ protocol: WORKER_PROTOCOL, jobId: this.jobId(), type: 'assets', loaded, total, cached })
  }

  initializing(): void {
    this.emit({ protocol: WORKER_PROTOCOL, jobId: this.jobId(), type: 'initializing' })
  }

  ready(): void {
    this.emit({ protocol: WORKER_PROTOCOL, jobId: this.jobId(), type: 'ready' })
  }

  log(lines: string[], stream: 'out' | 'err' = 'out'): void {
    this.emit({ protocol: WORKER_PROTOCOL, jobId: this.jobId(), type: 'log', stream, lines })
  }

  done(report: unknown = minimalReport): void {
    this.emit({ protocol: WORKER_PROTOCOL, jobId: this.jobId(), type: 'done', report: reportBytes(report) })
  }

  failWith(code: string, message: string): void {
    this.emit({ protocol: WORKER_PROTOCOL, jobId: this.jobId(), type: 'error', code, message })
  }
}

/** Parses for real, so the round trip through the controller is honest. */
class FakeReportWorker extends FakeWorker {
  postMessage(data: unknown): void {
    super.postMessage(data)
    const { jobId, bytes } = data as { jobId: string; bytes: ArrayBuffer }
    queueMicrotask(() => {
      try {
        const report = parseReport(JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))))
        this.emit({ jobId, ok: true, kind: 'summary', report, bytes })
      } catch (err) {
        this.emit({ jobId, ok: false, kind: 'summary', message: (err as Error).message, bytes })
      }
    })
  }
}

const fixed: Accuracy = { mode: 'iterations', iterations: 1000 }

function request(over: Partial<SimRequest> = {}): SimRequest {
  return {
    schemaVersion: 1,
    profile: 'mage="Bob"\nlevel=80\n',
    settings: { ...DEFAULT_SETTINGS, threads: 4 },
    accuracy: fixed,
    ...over,
  }
}

// One engine job at a time (memory budget); afterEach cancels like real caller abandoning run.
const opened: { cancel(reason?: string): void; result: Promise<unknown> }[] = []

function track<T extends { cancel(reason?: string): void; result: Promise<unknown> }>(handle: T): T {
  opened.push(handle)
  return handle
}

afterEach(async () => {
  for (const handle of opened.splice(0)) {
    handle.cancel('test teardown')
    await handle.result.catch(() => {})
  }
  // Blocked engine survives job by design; only fresh page clears it.
  __resetEngineRuntimeForTests()
})

function harness(over: Partial<SimRequest> = {}) {
  const engine = new FakeEngineWorker()
  const reporter = new FakeReportWorker()
  const events: JobEvent[] = []
  const handle = track(
    runJob(request(over), (e) => events.push(e), {
      createEngineWorker: () => engine as unknown as Worker,
      createReportWorker: () => reporter as unknown as Worker,
      capability,
      threadReapGraceMs: 0,
    }),
  )
  const states = () => events.map((e) => e.state)
  return { engine, reporter, events, states, handle }
}

/** The controller starts asynchronously; let its capability await settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('runJob happy path', () => {
  it('walks the state machine and resolves with a parsed report', async () => {
    const h = harness()
    await tick()
    expect(h.engine.sent).toHaveLength(1)
    h.engine.assets(63_275_426, 63_275_426, true)
    h.engine.initializing()
    h.engine.ready()
    h.engine.done()
    const outcome = await h.handle.result

    expect(outcome.report.players[0].specialization).toBe('Frost Mage')
    expect(outcome.report.actualIterations).toBe(49)
    expect(outcome.jobId).toBe(h.handle.jobId)
    expect(outcome.engineIdentity).toContain('12.1.0.69814')

    const seen = h.states()
    const expected: JobState[] = ['validating', 'acquiring', 'initializing', 'running', 'analyzing', 'complete']
    expect(expected.every((s) => seen.includes(s))).toBe(true)
    expect(seen.at(-1)).toBe('complete')
  })

  it('sends a protocol-tagged message with the allowlisted paths', async () => {
    const h = harness()
    await tick()
    const msg = h.engine.sent[0] as Record<string, unknown>
    expect(msg.protocol).toBe(WORKER_PROTOCOL)
    expect(msg.profilePath).toBe('/profile.simc')
    expect(msg.reportPath).toBe('/out.json')
    expect((msg.args as string[])[0]).toBe('/profile.simc')
    expect(msg.args).toContain('target_error=0')
  })

  it('terminates both workers and leaves nothing running', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.done()
    await h.handle.result
    expect(h.engine.alive).toBe(false)
    expect(h.reporter.alive).toBe(false)
  })

  it('hands back the raw report without the main thread parsing it', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.done()
    const outcome = await h.handle.result
    const text = await outcome.getRawJson().text()
    expect(JSON.parse(text).report_version).toBe('2.0.0')
  })

  it('reports the profileset ids the engine dropped', async () => {
    const h = harness({ profilesets: [{ id: 'c-1', lines: ['x=1'] }, { id: 'c-2', lines: ['x=2'] }] })
    await tick()
    const msg = h.engine.sent[0] as { profile: string }
    expect(msg.profile).toContain('profileset."c-1"+=x=1')
    h.engine.ready()
    h.engine.done() // a report with no profilesets at all
    const outcome = await h.handle.result
    expect(outcome.profilesetStatus.missing).toEqual(['c-1', 'c-2'])
    expect(outcome.profilesetStatus.completed).toEqual([])
  })
})

describe('progress and warnings', () => {
  it('turns the engine progress bar into an iteration count', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.log(['Generating Baseline: 1/1 [=====>..............] 512/1000 3.410'])
    const progress = h.events.find((e) => e.progress)?.progress
    expect(progress).toEqual({ kind: 'iterations', done: 512, total: 1000, label: undefined })
  })

  it('reports candidate completion separately from iteration progress', async () => {
    const h = harness({ profilesets: [{ id: 'c-1', lines: ['x=1'] }, { id: 'c-2', lines: ['x=2'] }] })
    await tick()
    h.engine.ready()
    h.engine.log(['Generating Profileset: c-2 3/3 [==>.................] 5/30 191.303'])
    const event = h.events.find((e) => e.stage)
    // Phase 1 is the baseline, so phase 3 means two candidates are done.
    expect(event?.stage).toEqual({ kind: 'stage', done: 2, total: 2, label: 'c-2' })
    expect(event?.progress).toEqual({ kind: 'iterations', done: 5, total: 30, label: 'c-2' })
  })

  it('emits no stage progress when no candidates were requested', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.log(['Generating Baseline: 1/1 [=>..................] 5/30 191.303'])
    expect(h.events.every((e) => e.stage === undefined)).toBe(true)
  })

  it('keeps stderr lines as warnings rather than droppable log lines', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.log(['Using unverified values for X'], 'err')
    expect(h.events.some((e) => e.warning === 'Using unverified values for X')).toBe(true)
  })

  it('drops the emscripten process-priority perror and keeps other stderr', async () => {
    // simc always calls setpriority; emscripten's stub always returns EPERM, so
    // this prints on every single run and means nothing. Neighbouring stderr in
    // the same batch must still get through.
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.log(
      ['Could not set process priority.: Operation not permitted', 'Severe: Something real'],
      'err',
    )
    expect(h.events.some((e) => e.warning?.includes('process priority'))).toBe(false)
    expect(h.events.some((e) => e.warning === 'Severe: Something real')).toBe(true)
  })

  it('warns about neutralised options and still runs', async () => {
    const h = harness({ profile: 'mage="Bob"\nthreads=64\n' })
    await tick()
    expect(h.events.some((e) => e.warning?.includes('threads'))).toBe(true)
    expect((h.engine.sent[0] as { profile: string }).profile).not.toMatch(/^threads=64$/m)
    h.engine.ready()
    h.engine.done()
    const outcome = await h.handle.result
    expect(outcome.inputWarnings).toHaveLength(1)
  })

  it('reports asset bytes while acquiring, and stays in that state until the bytes are in', async () => {
    const h = harness()
    await tick()
    expect(h.handle.state).toBe('acquiring')
    h.engine.assets(12_400_000, 63_275_426)
    const assets = h.events.find((e) => e.progress?.kind === 'assets')
    expect(assets?.progress).toEqual({
      kind: 'assets',
      done: 12_400_000,
      total: 63_275_426,
      label: 'downloading',
    })
    expect(assets?.state).toBe('acquiring')
    h.engine.initializing()
    expect(h.handle.state).toBe('initializing')
  })

  it('accepts a download with no declared total rather than inventing a percentage', async () => {
    const h = harness()
    await tick()
    h.engine.assets(5_000_000, undefined)
    const assets = h.events.find((e) => e.progress?.kind === 'assets')
    expect(assets?.progress?.total).toBeUndefined()
    expect(assets?.progress?.done).toBe(5_000_000)
  })

  it('marks a cache hit as cached rather than as a download', async () => {
    const h = harness()
    await tick()
    h.engine.assets(63_275_426, 63_275_426, true)
    expect(h.events.find((e) => e.progress?.kind === 'assets')?.progress?.label).toBe('cached')
  })

  it('tells the worker which binary to fetch and what it should hash to', async () => {
    const h = harness()
    await tick()
    const msg = h.engine.sent[0] as { engine?: { wasmUrl: string; sha256?: string; bytes?: number } }
    expect(msg.engine).toEqual({
      wasmUrl: '/engine/simc.wasm',
      sha256: 'aa'.repeat(32),
      bytes: 63_275_426,
    })
  })

  it('omits the asset hint when the manifest does not describe the binary', async () => {
    const engine = new FakeEngineWorker()
    const bare: EngineManifest = { ...manifest, files: undefined }
    track(
      runJob(request(), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        threadReapGraceMs: 0,
        capability: { ...capability, manifest: bare },
      }),
    )
    await tick()
    expect((engine.sent[0] as { engine?: unknown }).engine).toBeUndefined()
  })

  it('appends preset profile lines to the profile, never to the args', async () => {
    // enemy_fixed_health_percentage is silently ignored as an argument, so a
    // preset that ended up there would run a different fight with no warning.
    const h = harness({ extraProfileLines: ['enemy=Fluffy_Pillow', 'enemy_fixed_health_percentage=20'] })
    await tick()
    const msg = h.engine.sent[0] as { profile: string; args: string[] }
    expect(msg.profile).toMatch(/^enemy=Fluffy_Pillow$/m)
    expect(msg.profile).toMatch(/^enemy_fixed_health_percentage=20$/m)
    expect(msg.args.some((a) => a.startsWith('enemy'))).toBe(false)
  })

  it('applies generated guided defaults to the player before presets and candidate overrides', async () => {
    const h = harness({ profile: 'warlock=Fixture\nlevel=90\nspec=demonology\n',
      extraProfileLines: ['enemy=Target'],
      profilesets: [{ id: 'alternative', lines: ['potion=liquid_luster_2'] }] })
    await tick()
    const text = (h.engine.sent[0] as { profile: string }).profile
    expect(text).toContain('warlock=Fixture\npotion=potion_of_recklessness_2\nlevel=90')
    expect(text.indexOf('potion=potion_of_recklessness_2')).toBeLessThan(text.indexOf('enemy=Target'))
    expect(text).toContain('profileset."alternative"+=potion=liquid_luster_2')
  })

  it('leaves raw-script consumable defaults to the engine', async () => {
    const h = harness({ mode: 'raw', profile: 'warlock=Fixture\nlevel=90\nspec=demonology\n' })
    await tick()
    expect((h.engine.sent[0] as { profile: string }).profile).not.toContain('potion=')
  })

  it('puts preset lines before the profileset lines, so candidates vary from them', async () => {
    const h = harness({
      extraProfileLines: ['enemy=Fluffy_Pillow'],
      profilesets: [{ id: 'c-1', lines: ['x=1'] }],
    })
    await tick()
    const profile = (h.engine.sent[0] as { profile: string }).profile
    expect(profile.indexOf('enemy=Fluffy_Pillow')).toBeLessThan(profile.indexOf('profileset."c-1"'))
  })

  it('refuses an application-owned option smuggled in as a profile line', async () => {
    const handle = runJob(request({ extraProfileLines: ['threads=64'] }), undefined, {
      createEngineWorker: () => new FakeEngineWorker() as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      capability,
      threadReapGraceMs: 0,
    })
    await expect(handle.result).rejects.toBeInstanceOf(SimValidationError)
  })

  it('clamps threads to the artifact ceiling and says so, rather than refusing', async () => {
    const engine = new FakeEngineWorker()
    const handle = runJob(request({ settings: { ...DEFAULT_SETTINGS, threads: 16 } }), undefined, {
      createEngineWorker: () => engine as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      threadReapGraceMs: 0,
      capability: { ...capability, artifact: 'fallback', maxThreads: 1, profilesets: false },
    })
    await tick()
    expect((engine.sent[0] as { args: string[] }).args).toContain('threads=1')
    engine.ready()
    engine.done()
    const outcome = await handle.result
    expect(outcome.inputWarnings[0]).toMatch(/1 thread instead of 16/)
  })

  it('asks for the artifact the capability chose', async () => {
    const asked: string[] = []
    const engine = new FakeEngineWorker()
    track(
      runJob(request(), undefined, {
        createEngineWorker: (variant) => {
          asked.push(variant)
          return engine as unknown as Worker
        },
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        threadReapGraceMs: 0,
        capability: { ...capability, artifact: 'fallback', maxThreads: 1, profilesets: false },
      }),
    )
    await tick()
    expect(asked).toEqual(['fallback'])
  })

  it('does not warn about precision, because measurement says it is not the memory lever', async () => {
    // Peak RSS measured flat and non-monotonic against iterations (5,000 ->
    // 2,333 MB, 100,000 -> 1,839 MB) and against thread count. Warning on
    // iteration count would send people after a lever that does not exist.
    const h = harness({ accuracy: { mode: 'targetError', targetError: 0.05, maxIterations: 200_000 } })
    await tick()
    h.engine.ready()
    h.engine.done()
    expect((await h.handle.result).inputWarnings).toEqual([])
  })

  it('says nothing about memory for an ordinary run', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.done()
    expect((await h.handle.result).inputWarnings).toEqual([])
  })

  it('does not copy the report on the main thread when it need not', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    const bytes = reportBytes()
    h.engine.emit({ protocol: WORKER_PROTOCOL, jobId: h.engine.jobId(), type: 'done', report: bytes })
    await h.handle.result
    // The buffer handed to the parser is the one the engine allocated, not a
    // duplicate — a large report is tens of megabytes.
    const sent = h.reporter.sent[0] as { bytes: ArrayBuffer }
    expect(sent.bytes).toBe(bytes.buffer)
  })

  it('survives a listener that throws', async () => {
    const engine = new FakeEngineWorker()
    const handle = runJob(request(), () => {
      throw new Error('bad listener')
    }, {
      createEngineWorker: () => engine as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      capability,
      threadReapGraceMs: 0,
    })
    await tick()
    engine.ready()
    engine.done()
    await expect(handle.result).resolves.toBeTruthy()
  })
})

describe('cancellation', () => {
  it('rejects with an AbortError instead of hanging', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.handle.state).toBe('cancelled')
    expect(h.engine.alive).toBe(false)
  })

  it('cancels before the engine worker even exists', async () => {
    const h = harness()
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    // The start path must notice it was cancelled and never post work.
    expect(h.engine.sent).toHaveLength(0)
  })

  it('cancels while the report is being parsed', async () => {
    const engine = new FakeEngineWorker()
    const reporter = new FakeWorker() // never answers
    const handle = runJob(request(), undefined, {
      createEngineWorker: () => engine as unknown as Worker,
      createReportWorker: () => reporter as unknown as Worker,
      threadReapGraceMs: 0,
      capability,
    })
    await tick()
    engine.ready()
    engine.done()
    await tick()
    expect(handle.state).toBe('analyzing')
    handle.cancel()
    await expect(handle.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(reporter.alive).toBe(false)
  })

  it('is idempotent: a second cancel changes nothing', async () => {
    const h = harness()
    await tick()
    h.handle.cancel('first')
    h.handle.cancel('second')
    await expect(h.handle.result).rejects.toMatchObject({ message: 'first' })
    expect(h.engine.terminated).toBe(1)
  })

  it('ignores a late completion from a cancelled run', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    // A message that raced the terminate must not revive the job.
    h.engine.done()
    await tick()
    expect(h.handle.state).toBe('cancelled')
    expect(h.states().filter((s) => s === 'complete')).toHaveLength(0)
  })
})

describe('stale identity', () => {
  it('ignores events carrying another job id', async () => {
    const h = harness()
    await tick()
    h.engine.emit({ protocol: WORKER_PROTOCOL, jobId: 'someone-else', type: 'done', report: reportBytes() })
    await tick()
    expect(h.handle.state).toBe('acquiring')
    h.engine.ready()
    h.engine.done()
    await expect(h.handle.result).resolves.toBeTruthy()
  })

  it('ignores events from a different protocol version', async () => {
    const h = harness()
    await tick()
    h.engine.emit({ protocol: 99, jobId: h.engine.jobId(), type: 'error', code: 'x', message: 'boom' })
    await tick()
    expect(h.handle.state).toBe('acquiring')
  })

  it('snapshots the request so later edits cannot change a running job', async () => {
    const req = request()
    const h = harness()
    await tick()
    req.settings.threads = 99
    h.engine.ready()
    h.engine.done()
    const outcome = await h.handle.result
    expect(outcome.request.settings.threads).toBe(4)
    expect(() => {
      ;(outcome.request.settings as { threads: number }).threads = 1
    }).toThrow()
  })

  it('gives every job its own id', async () => {
    const a = harness()
    const b = harness()
    expect(a.handle.jobId).not.toBe(b.handle.jobId)
  })
})

describe('failure paths', () => {
  it('retains shutdown confirmation that arrives before an initialization error', async () => {
    const engine = new FakeEngineWorker()
    const handle = track(runJob(request(), undefined, {
      createEngineWorker: () => engine as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      capability, threadReapGraceMs: 15,
    }))
    await tick()
    engine.emit({ protocol: WORKER_PROTOCOL, jobId: handle.jobId, type: 'shutdown', reason: 'sim-failed', threads: 16 })
    engine.failWith('sim-failed', 'simc exited 40')
    await expect(handle.result).rejects.toMatchObject({ code: 'sim-failed' })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(engineBusy()).toBe(false)
    expect(engineAvailability().available).toBe(true)
  })
  it('rejects an empty DungeonRoute before starting a worker and accepts zero-padded pull IDs', () => {
    const route = request({ settings: { ...DEFAULT_SETTINGS, fightStyle: 'DungeonRoute' } })
    expect(validateRequest(route, 16).some(i => i.message.includes('pull=1'))).toBe(true)
    expect(validateRequest({ ...route, extraProfileLines: ['raid_events+=/pull,pull=01,enemies=Mob:100000'] }, 16)).toEqual([])
  })
  it('rejects an invalid request without starting a worker', async () => {
    const engine = new FakeEngineWorker()
    const handle = runJob(request({ settings: { ...DEFAULT_SETTINGS, threads: 0 } }), undefined, {
      createEngineWorker: () => engine as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      capability,
      threadReapGraceMs: 0,
    })
    await expect(handle.result).rejects.toBeInstanceOf(SimValidationError)
    expect(engine.sent).toHaveLength(0)
    expect(handle.state).toBe('error')
  })

  it('refuses to run when the engine capability check fails', async () => {
    const handle = runJob(request(), undefined, {
      createEngineWorker: () => new FakeEngineWorker() as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      threadReapGraceMs: 0,
      capability: { ok: false, reason: 'no-isolation', detail: 'not isolated' },
    })
    await expect(handle.result).rejects.toMatchObject({ name: 'SimEngineError', code: 'no-isolation' })
  })

  it('refuses profilesets on a build that has none', async () => {
    const handle = runJob(request({ profilesets: [{ id: 'c-1', lines: ['x=1'] }] }), undefined, {
      createEngineWorker: () => new FakeEngineWorker() as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      threadReapGraceMs: 0,
      capability: { ...capability, profilesets: false } as EngineCapability,
    })
    await expect(handle.result).rejects.toMatchObject({ code: 'profilesets-unsupported' })
  })

  it('surfaces an engine failure with its code', async () => {
    const h = harness()
    await tick()
    h.engine.failWith('sim-failed', 'simc exited 1')
    await expect(h.handle.result).rejects.toBeInstanceOf(SimEngineError)
    expect(h.engine.alive).toBe(false)
  })

  it('surfaces a worker that fails to start', async () => {
    const h = harness()
    await tick()
    h.engine.onerror?.({ message: 'failed to load' } as ErrorEvent)
    await expect(h.handle.result).rejects.toMatchObject({ code: 'engine-worker' })
  })

  it('rejects a malformed report instead of resolving with zeroes', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.done({ report_version: '2.0.0', sim: { options: {} } })
    await expect(h.handle.result).rejects.toMatchObject({ code: 'report-invalid' })
  })

  it('rejects a completion that carried no report', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.emit({ protocol: WORKER_PROTOCOL, jobId: h.engine.jobId(), type: 'done', report: null })
    await expect(h.handle.result).rejects.toMatchObject({ code: 'report-missing' })
  })
})

describe('cross-tab engine slot', () => {
  it('holds the slot until the engine confirms it stopped, not until the promise settles', async () => {
    // Same rule as the in-tab budget, for the same reason: a promise settles
    // long before an engine's threads unwind, and releasing early lets another
    // tab start a second engine on top of one still holding its memory.
    const { engineSlotStatus } = await import('../engine-budget')
    const h = harness()
    await tick()
    const during = await engineSlotStatus()
    if (during.supported) expect(during.heldElsewhere === true || during.heldElsewhere === 'unknown').toBe(true)
    h.engine.ready()
    h.engine.done()
    await h.handle.result
    // Released in the same teardown that terminated the workers.
    expect(h.engine.alive).toBe(false)
  })

  it('does not leave the slot held when a job fails validation', async () => {
    const bad = track(
      runJob(request({ settings: { ...DEFAULT_SETTINGS, threads: 0 } }), undefined, {
        createEngineWorker: () => new FakeEngineWorker() as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      }),
    )
    await expect(bad.result).rejects.toBeInstanceOf(SimValidationError)
    // A later job must be able to start immediately.
    const good = harness()
    await tick()
    expect(good.engine.sent).toHaveLength(1)
    good.engine.ready()
    good.engine.done()
    await expect(good.handle.result).resolves.toBeTruthy()
  })

  it('takes the slot only after validation, so a bad request never queues others behind it', async () => {
    const engine = new FakeEngineWorker()
    const bad = track(
      runJob(request({ profilesets: [{ id: 'c-1', lines: [] }] }), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      }),
    )
    await expect(bad.result).rejects.toBeInstanceOf(SimValidationError)
    expect(engine.sent).toHaveLength(0)
  })
})

describe('one engine job at a time', () => {
  // The engine needs about 1.8 GB whatever the request asks for — measured at
  // 1,812 MB outside the browser and 1.79 GB in the renderer that Chrome then
  // killed. Two instances cannot both have that in one tab.
  it('refuses a second job while one is running', async () => {
    const first = harness()
    await tick()
    const second = harness()
    await expect(second.handle.result).rejects.toMatchObject({ code: 'engine-busy' })
    expect(second.engine.sent).toHaveLength(0)

    first.engine.ready()
    first.engine.done()
    await expect(first.handle.result).resolves.toBeTruthy()
  })

  it('frees the slot the moment a job settles, however it settles', async () => {
    const a = harness()
    await tick()
    a.engine.ready()
    a.engine.done()
    await a.handle.result

    const b = harness()
    await tick()
    expect(b.engine.sent).toHaveLength(1)
    b.handle.cancel()
    await expect(b.handle.result).rejects.toMatchObject({ name: 'AbortError' })

    // A cancel settles synchronously, so the next run must not have to wait.
    const c = harness()
    await tick()
    expect(c.engine.sent).toHaveLength(1)
    c.engine.ready()
    c.engine.done()
    await expect(c.handle.result).resolves.toBeTruthy()
  })

  it('frees the slot when a job fails validation before any worker exists', async () => {
    const bad = runJob(request({ settings: { ...DEFAULT_SETTINGS, threads: 0 } }), undefined, {
      createEngineWorker: () => new FakeEngineWorker() as unknown as Worker,
      createReportWorker: () => new FakeReportWorker() as unknown as Worker,
      capability,
      threadReapGraceMs: 0,
    })
    await expect(bad.result).rejects.toBeInstanceOf(SimValidationError)

    const good = harness()
    await tick()
    expect(good.engine.sent).toHaveLength(1)
    good.engine.ready()
    good.engine.done()
    await expect(good.handle.result).resolves.toBeTruthy()
  })

  it('can stop a job whose handle the caller has lost', async () => {
    // Observed in the browser: a search abandoned mid-run left an engine at
    // 116% CPU holding 525 MB with the UI showing no job at all and no way to
    // reach it. The watchdog would have ended it eventually; minutes of a
    // wasted 2 GB is not an acceptable way to find out.
    const h = harness()
    await tick()
    expect(engineBusy()).toBe(true)

    expect(cancelActiveJob('abandoned')).toBe(true)
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError', message: 'abandoned' })
    expect(h.engine.alive).toBe(false)
    expect(engineBusy()).toBe(false)

    // And the budget is genuinely free again.
    const next = harness()
    await tick()
    expect(next.engine.sent).toHaveLength(1)
    next.engine.ready()
    next.engine.done()
    await expect(next.handle.result).resolves.toBeTruthy()
  })

  it('says so rather than throwing when there is nothing to stop', async () => {
    expect(engineBusy()).toBe(false)
    expect(cancelActiveJob()).toBe(false)
  })

  it('skips the reap entirely without SharedArrayBuffer, which is the artifact that has no threads', async () => {
    // No cross-origin isolation means the single-threaded fallback, which
    // spawns no pthreads — so there is nothing to reap, and waiting for a
    // confirmation that can never come would hold the budget for the full
    // grace. This must not regress when capability detection falls back.
    vi.stubGlobal('SharedArrayBuffer', undefined)
    try {
      const engine = new FakeEngineWorker()
      const handle = track(
        runJob(request(), undefined, {
          createEngineWorker: () => engine as unknown as Worker,
          createReportWorker: () => new FakeReportWorker() as unknown as Worker,
          capability: { ...capability, artifact: 'fallback', maxThreads: 1, profilesets: false },
          // Deliberately NOT 0: the point is that the reap path is skipped
          // because there is no flag, not because the grace was disabled.
          threadReapGraceMs: 10_000,
        }),
      )
      await tick()
      expect((engine.sent[0] as { cancelFlag?: unknown }).cancelFlag).toBeUndefined()
      handle.cancel()
      await expect(handle.result).rejects.toMatchObject({ name: 'AbortError' })
      expect(engine.alive).toBe(false)
      expect(engineBusy()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports whether the budget is held', async () => {
    expect(engineBusy()).toBe(false)
    const h = harness()
    await tick()
    expect(engineBusy()).toBe(true)
    h.engine.ready()
    h.engine.done()
    await h.handle.result
    expect(engineBusy()).toBe(false)
  })
})

describe('timeouts', () => {
  it('gives up when the engine never finishes loading', async () => {
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const handle = runJob(request({ limits: { initTimeoutMs: 5_000 } }), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      })
      // Attach before advancing: an unobserved rejection would be an unhandled one.
      const rejected = expect(handle.result).rejects.toBeInstanceOf(SimTimeoutError)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
      expect(engine.alive).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a run that passes its deadline, which blocked wasm cannot do for itself', async () => {
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const handle = runJob(request({ limits: { initTimeoutMs: 60_000, deadlineMs: 10_000 } }), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      })
      const rejected = expect(handle.result).rejects.toMatchObject({
        name: 'SimTimeoutError',
        phase: 'deadline',
      })
      await vi.advanceTimersByTimeAsync(0)
      engine.ready()
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(engine.alive).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a job whose worker died silently instead of hanging until the deadline', async () => {
    // A dedicated worker has no exit event. If the browser kills one for
    // running out of memory, nothing fires and the promise would sit pending
    // until the whole-run deadline, which the user cannot tell from a long run.
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const handle = runJob(
        request({ limits: { initTimeoutMs: 60_000, deadlineMs: 30 * 60_000, stallTimeoutMs: 20_000 } }),
        undefined,
        {
          createEngineWorker: () => engine as unknown as Worker,
          createReportWorker: () => new FakeReportWorker() as unknown as Worker,
          capability,
          threadReapGraceMs: 0,
        },
      )
      const rejected = expect(handle.result).rejects.toMatchObject({
        name: 'SimTimeoutError',
        phase: 'stalled',
        at: 'running',
      })
      await vi.advanceTimersByTimeAsync(0)
      engine.ready()
      // One progress line proves this run speaks. Its later silence means something.
      engine.log(['Generating Baseline: 1/1 [=>..................] 5/1000 3.4'])
      await vi.advanceTimersByTimeAsync(20_000)
      await rejected
      expect(engine.alive).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never judges a run that was always quiet, because a raw script can silence the engine', async () => {
    // Silence is not proof of death. A script that turns the engine's progress
    // output off is legitimately quiet for its whole run, and killing it would
    // destroy valid work. Only the whole-run deadline applies to such a run.
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const handle = runJob(
        request({ mode: 'raw', limits: { stallTimeoutMs: 20_000, deadlineMs: 30 * 60_000 } }),
        undefined,
        {
          createEngineWorker: () => engine as unknown as Worker,
          createReportWorker: () => new FakeReportWorker() as unknown as Worker,
          capability,
          threadReapGraceMs: 0,
        },
      )
      await vi.advanceTimersByTimeAsync(0)
      engine.ready()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(handle.state).toBe('running')
      engine.done()
      await vi.advanceTimersByTimeAsync(0)
      await expect(handle.result).resolves.toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows a wider silence while the engine module is compiling', async () => {
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const handle = runJob(request({ limits: { initTimeoutMs: 10 * 60_000, stallTimeoutMs: 20_000 } }), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      })
      await vi.advanceTimersByTimeAsync(0)
      engine.initializing()
      // Compiling 60 MB of wasm on a weak device is legitimately silent.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(handle.state).toBe('initializing')
      engine.ready()
      engine.done()
      await vi.advanceTimersByTimeAsync(0)
      await expect(handle.result).resolves.toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a talkative long run alive well past the stall window', async () => {
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const handle = runJob(request({ limits: { stallTimeoutMs: 20_000 } }), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      })
      await vi.advanceTimersByTimeAsync(0)
      engine.ready()
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(15_000)
        engine.log([`Generating Baseline: 1/1 [=>..................] ${i * 100}/10000 3.4`])
      }
      expect(handle.state).toBe('running')
      engine.done()
      await vi.advanceTimersByTimeAsync(0)
      await expect(handle.result).resolves.toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails when the report parser dies silently after the engine finished', async () => {
    // The engine worker is terminated before the parse, so this is exactly the
    // "no engine heap, zero CPU, still waiting" shape.
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const mute = new FakeWorker() // accepts the report and never answers
      const handle = runJob(request({ limits: { stallTimeoutMs: 20_000 } }), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => mute as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      })
      const rejected = expect(handle.result).rejects.toMatchObject({ phase: 'stalled' })
      await vi.advanceTimersByTimeAsync(0)
      engine.ready()
      engine.done()
      await vi.advanceTimersByTimeAsync(20_000)
      await rejected
      expect(mute.alive).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a duplicate completion instead of starting a second analysis', async () => {
    const h = harness()
    await tick()
    h.engine.ready()
    h.engine.done()
    h.engine.done()
    await expect(h.handle.result).resolves.toBeTruthy()
    // One report worker, not two.
    expect(h.reporter.sent).toHaveLength(1)
  })

  it('clears the init timer once the engine is ready', async () => {
    vi.useFakeTimers()
    try {
      const engine = new FakeEngineWorker()
      const handle = runJob(request({ limits: { initTimeoutMs: 5_000, deadlineMs: 600_000 } }), undefined, {
        createEngineWorker: () => engine as unknown as Worker,
        createReportWorker: () => new FakeReportWorker() as unknown as Worker,
        capability,
        threadReapGraceMs: 0,
      })
      await vi.advanceTimersByTimeAsync(0)
      engine.ready()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(handle.state).toBe('running')
      engine.done()
      await vi.advanceTimersByTimeAsync(0)
      await expect(handle.result).resolves.toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('repeated runs', () => {
  it('runs twenty back-to-back cycles with no worker left alive', async () => {
    // Controller-level bookkeeping only. Real Emscripten pthread cleanup is
    // P01.4 and needs a browser; this cannot and does not prove it.
    // Only workers the controller actually constructed are counted; a run
    // cancelled before the report stage never starts a report worker.
    const workers: FakeWorker[] = []
    const track = <T extends FakeWorker>(w: T): Worker => {
      workers.push(w)
      return w as unknown as Worker
    }
    for (let i = 0; i < 20; i++) {
      const engine = new FakeEngineWorker()
      const handle = runJob(request(), undefined, {
        createEngineWorker: () => track(engine),
        createReportWorker: () => track(new FakeReportWorker()),
        capability,
        threadReapGraceMs: 0,
      })
      await tick()
      engine.ready()
      if (i % 2 === 0) {
        engine.done()
        await handle.result
      } else {
        handle.cancel()
        await expect(handle.result).rejects.toMatchObject({ name: 'AbortError' })
      }
    }
    expect(workers.filter((w) => w.alive)).toHaveLength(0)
    expect(workers.filter((w) => w.terminated > 1)).toHaveLength(0)
  })
})

describe('validateRequest', () => {
  it('rejects an unknown request schema outright', () => {
    expect(validateRequest({ ...request(), schemaVersion: 2 as never }, 16)).toHaveLength(1)
  })

  it('accepts a well-formed request', () => {
    expect(validateRequest(request(), 16)).toEqual([])
  })
})
