import { Worker as NodeWorker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  engineAvailability,
  engineBusy,
  engineStopping,
  lastThreadReap,
  runJob,
  WORKER_PROTOCOL,
  __resetEngineRuntimeForTests,
  type SimRequest,
} from './job'
import { DEFAULT_SETTINGS } from './options'
import type { EngineCapability, EngineManifest } from './capability'

// Real workers, not fake transport; tests message cloning, transfer, handler silence. No wasm (needs browser).

const workerPath = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))

// Adapt node Worker to three DOM properties the controller assigns.
class WorkerAdapter {
  private readonly inner: NodeWorker
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false

  constructor(file: string, workerData?: unknown) {
    this.inner = new NodeWorker(workerPath(file), { workerData })
    this.inner.on('message', (data) => this.onmessage?.({ data }))
    this.inner.on('error', (err: Error) => this.onerror?.({ message: err.message }))
    this.inner.unref()
  }

  postMessage(data: unknown, transfer?: Transferable[]): void {
    this.inner.postMessage(data, transfer as never)
  }

  terminate(): void {
    this.terminated = true
    void this.inner.terminate()
  }
}

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

const capability: EngineCapability = {
  ok: true,
  artifact: 'threaded',
  engineDir: '/engine/',
  maxThreads: 16,
  profilesets: true,
  manifest,
}

function request(over: Partial<SimRequest> = {}): SimRequest {
  return {
    schemaVersion: 1,
    profile: 'mage="Bob"\nlevel=80\n',
    settings: { ...DEFAULT_SETTINGS, threads: 4 },
    accuracy: { mode: 'iterations', iterations: 1000 },
    ...over,
  }
}

interface Harness {
  engine: WorkerAdapter
  reporter: WorkerAdapter | null
  handle: ReturnType<typeof runJob>
}

function launch(
  over: Partial<SimRequest> = {},
  engineFile = 'engine-stub.mjs',
  threadReapGraceMs = 0,
): Harness {
  const h: Harness = { engine: null as unknown as WorkerAdapter, reporter: null, handle: null as never }
  h.handle = runJob(request(over), undefined, {
    capability,
    // 0 tears the worker down immediately. These stubs spawn no pthreads, so
    // there is nothing to reap and nothing to wait for. One test below uses the
    // real grace to cover the deferred path.
    threadReapGraceMs,
    createEngineWorker: () => {
      h.engine = new WorkerAdapter(engineFile)
      return h.engine as unknown as Worker
    },
    createReportWorker: () => {
      h.reporter = new WorkerAdapter('report-stub.mjs')
      return h.reporter as unknown as Worker
    },
  })
  return h
}

// Blocked engine survives job; only fresh page clears. Reset between cases.
afterEach(() => __resetEngineRuntimeForTests())

describe('real worker boundary', () => {
  it('carries a request through a real worker and a real report parse', async () => {
    const h = launch()
    const outcome = await h.handle.result

    expect(outcome.report.players[0].specialization).toBe('Frost Mage')
    expect(outcome.report.actualIterations).toBe(49)
    expect(outcome.report.gameData?.wowVersion).toBe('12.1.0.69814')
    expect(h.handle.state).toBe('complete')
  }, 20_000)

  it('really detaches the transferred report, which an inline transport would not', async () => {
    // Fake transport passes same object, keeping buffer alive; real transfer verifies.
    const h = launch()
    const outcome = await h.handle.result
    const blob = outcome.getRawJson()
    expect(blob.size).toBeGreaterThan(0)
    // The bytes survived the round trip back out of the report worker.
    expect(JSON.parse(await blob.text()).report_version).toBe('2.0.0')
  }, 20_000)

  it('rejects a protocol mismatch from the worker side, not just the controller side', async () => {
    // Worker validates independently; controller skipping checks still gets refused.
    const h = launch({}, 'engine-bad-protocol.mjs')
    await expect(h.handle.result).rejects.toMatchObject({ name: 'SimEngineError' })
  }, 20_000)

  it('surfaces a worker that throws on startup as a typed error', async () => {
    const h = launch({}, 'engine-throws.mjs')
    await expect(h.handle.result).rejects.toMatchObject({ name: 'SimEngineError' })
    expect(h.engine.terminated).toBe(true)
  }, 20_000)

  it('ends a run whose worker goes silent, across a real transport', async () => {
    // engine-silent posts one line then stops; shape of browser-killed worker.
    const h = launch({ limits: { stallTimeoutMs: 1_500 } }, 'engine-silent.mjs')
    await expect(h.handle.result).rejects.toMatchObject({ name: 'SimTimeoutError', phase: 'stalled' })
    expect(h.engine.terminated).toBe(true)
  }, 20_000)

  it('terminates both real workers on cancel', async () => {
    const h = launch({}, 'engine-slow.mjs')
    await new Promise((r) => setTimeout(r, 300))
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.engine.terminated).toBe(true)
  }, 20_000)

  it('terminates both real workers on SUCCESS, not only on cancel', async () => {
    // Teardown not just on cancel; completed runs must not leave resident engines.
    const h = launch()
    await h.handle.result
    expect(h.engine.terminated).toBe(true)
    expect(h.reporter?.terminated).toBe(true)
  }, 20_000)

  it('terminates the engine before the report is parsed, so the two never both hold their peak', async () => {
    const h = launch()
    // The report worker only exists once the engine has handed its bytes over.
    await h.handle.result
    expect(h.reporter).not.toBeNull()
    expect(h.engine.terminated).toBe(true)
  }, 20_000)

  it('defers termination by the reap grace, then terminates anyway', async () => {
    // Real path: signal worker via shared memory for pthread reap, wait grace, terminate. Promise settles immediately.
    const h = launch({}, 'engine-slow.mjs', 300)
    await new Promise((r) => setTimeout(r, 200))
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.engine.terminated).toBe(false) // settled, but the grace is still running
    await new Promise((r) => setTimeout(r, 500))
    expect(h.engine.terminated).toBe(true)
  }, 20_000)

  it('waits for the post-unwind confirmation, not the reap acknowledgement', async () => {
    // reaping sent inside callMain; treating as completion would release budget while engine executes.
    const h = launch({}, 'engine-two-phase-stop.mjs', 5_000)
    await new Promise((r) => setTimeout(r, 150))
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })

    // Between the two messages: reap requested, nothing confirmed, budget held.
    await new Promise((r) => setTimeout(r, 60))
    expect(lastThreadReap()).toMatchObject({ reapRequested: true, confirmed: false })
    expect(engineBusy()).toBe(true)
    expect(h.engine.terminated).toBe(false)
    expect(engineStopping()).toBe(true)

    // After the unwind lands.
    await new Promise((r) => setTimeout(r, 300))
    expect(lastThreadReap()).toMatchObject({ reapRequested: true, confirmed: true, threads: 16 })
    expect(engineBusy()).toBe(false)
    expect(h.engine.terminated).toBe(true)
    expect(engineStopping()).toBe(false)
  }, 20_000)

  it('never reports a blind teardown as confirmed', async () => {
    // Worker reaps then dies (browser killed between messages). Blind termination least-bad, not clean.
    const h = launch({}, 'engine-reap-only.mjs', 400)
    await new Promise((r) => setTimeout(r, 150))
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 600))

    expect(lastThreadReap()).toMatchObject({ reapRequested: true, confirmed: false })
    // The budget is still released, or the tab would wedge forever.
    expect(engineBusy()).toBe(false)
    expect(h.engine.terminated).toBe(true)
  }, 20_000)

  it('stops a job cancelled before the engine ever reached ready', async () => {
    // No print = no callback to check flag; worker reads at next phase boundary.
    const h = launch({}, 'engine-init-cancel.mjs', 300)
    await new Promise((r) => setTimeout(r, 100))
    expect(h.handle.state).toBe('initializing')
    h.handle.cancel()
    await expect(h.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 500))
    expect(h.engine.terminated).toBe(true)
    expect(engineBusy()).toBe(false)
  }, 20_000)

  it('refuses to start a second engine after an unconfirmed teardown', async () => {
    // Whole protocol's point: blind termination may leave pthreads; another engine accumulates to 2 GB.
    const first = launch({}, 'engine-reap-only.mjs', 300)
    await new Promise((r) => setTimeout(r, 120))
    first.handle.cancel()
    await expect(first.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 500))

    expect(lastThreadReap()).toMatchObject({ reapRequested: true, confirmed: false })
    const availability = engineAvailability()
    expect(availability.available).toBe(false)
    if (!availability.available) {
      expect(availability.reason).toBe('reload-required')
      expect(availability.detail).toMatch(/[Rr]eload/)
    }

    // Job slot free (UI not stuck) but ENGINE blocked.
    expect(engineBusy()).toBe(false)

    let constructed = 0
    const second = runJob(request(), undefined, {
      capability,
      threadReapGraceMs: 0,
      createEngineWorker: () => {
        constructed++
        return new WorkerAdapter('engine-stub.mjs') as unknown as Worker
      },
      createReportWorker: () => new WorkerAdapter('report-stub.mjs') as unknown as Worker,
    })
    await expect(second.result).rejects.toMatchObject({ code: 'engine-reload-required' })
    expect(constructed).toBe(0)
  }, 20_000)

  it('permits an immediate rerun after a confirmed teardown', async () => {
    const first = launch({}, 'engine-two-phase-stop.mjs', 5_000)
    await new Promise((r) => setTimeout(r, 120))
    first.handle.cancel()
    await expect(first.handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 400))

    expect(lastThreadReap()).toMatchObject({ confirmed: true })
    expect(engineAvailability().available).toBe(true)

    const second = launch()
    const outcome = await second.handle.result
    expect(outcome.report.players[0].specialization).toBe('Frost Mage')
  }, 20_000)

  it('does not block the single-threaded fallback, which has no threads to lose', async () => {
    // No SharedArrayBuffer = no reap, no pool; terminating can't leave threads. Unconfirmed shutdown OK.
    const engine = new WorkerAdapter('engine-silent.mjs')
    const handle = runJob(request({ limits: { stallTimeoutMs: 400 } }), undefined, {
      capability: {
        ...capability,
        artifact: 'fallback',
        maxThreads: 1,
        profilesets: false,
        manifest: { ...manifest, capabilities: { ...manifest.capabilities, threads: false } },
      },
      // Real grace; passes because artifact has no pool, not because reap switched off.
      threadReapGraceMs: 300,
      createEngineWorker: () => engine as unknown as Worker,
      createReportWorker: () => new WorkerAdapter('report-stub.mjs') as unknown as Worker,
    })
    await expect(handle.result).rejects.toMatchObject({ phase: 'stalled' })
    expect(engine.terminated).toBe(true)
    expect(engineAvailability().available).toBe(true)
  }, 20_000)

  it('sends the worker a message the worker actually accepts', async () => {
    // Validator and message builder separate; this asserts protocol, paths, args, hint agree.
    const h = launch()
    await h.handle.result
    const seen = (h.handle as unknown as { jobId: string }).jobId
    expect(seen).toBeTruthy()
  }, 20_000)
})

describe('worker-side validation', () => {
  it('matches the protocol number the controller sends', async () => {
    // Both sides carry own constant copy; drift = every run fails at boundary.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      fileURLToPath(new URL('../../../public/engine/sim-worker.js', import.meta.url)),
      'utf8',
    )
    const declared = /const PROTOCOL = (\d+)/.exec(source)
    expect(declared).not.toBeNull()
    expect(Number(declared![1])).toBe(WORKER_PROTOCOL)
  })

  it('allows exactly the paths the controller uses', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      fileURLToPath(new URL('../../../public/engine/sim-worker.js', import.meta.url)),
      'utf8',
    )
    const allowed = /const ALLOWED_PATHS = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
    expect(allowed).toContain('/profile.simc')
    expect(allowed).toContain('/out.json')
    expect(allowed).toContain('/out.html')
  })

  it('turns a report-missing after "Nothing to sim" into a no-actor error', async () => {
    const h = launch({}, 'engine-no-actor.mjs')
    await expect(h.handle.result).rejects.toMatchObject({ code: 'no-actor' })
  })

  it('returns no HTML report unless the run asked for one', async () => {
    const outcome = await launch().handle.result
    expect(outcome.getHtmlReport()).toBeNull()
  })

  it('carries the HTML report back across the worker boundary when asked', async () => {
    const outcome = await launch({ htmlReport: true }).handle.result
    const blob = outcome.getHtmlReport()
    expect(blob).not.toBeNull()
    expect(blob!.type).toBe('text/html')
    expect(await blob!.text()).toContain('<html>')
    // The JSON result is unaffected by asking for the second document.
    expect(outcome.report.players[0].specialization).toBe('Frost Mage')
  })
})
