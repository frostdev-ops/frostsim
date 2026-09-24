// Frostsim Cloud engine: a Worker-shaped stand-in that runs one job on the account server and replays on this browser's engine when the cloud declines (CLAUDE.md D14, DESIGN.md C9).

import { WORKER_PROTOCOL, engineWorkerUrl, type RemoteEngine, type SimRequest } from './job'
import type { EngineVariant } from './capability'

const JOBS = '/api/v1/compute/jobs'
/** Only a published pack has a native build; `/engine/` (dev) never does. Same id rule as versions.ts validEngineBase. */
const PACK_DIR = /^\/engine\/versions\/([a-z0-9][a-z0-9.-]{0,100})\//
/** A hung request would otherwise sit silent until the controller calls it a memory stall. */
const REQUEST_TIMEOUT_MS = 30_000
/** Headers and body of the result together. Under job.ts's 180 s stall window, so a slow download replays instead of failing as a stall. */
const RESULT_TIMEOUT_MS = 150_000
/** How long polls may keep failing before a cloud job is abandoned: a lease's length, so an account-server restart or network blip does not throw away cloud work. */
const UNREACHABLE_GIVE_UP_MS = 60_000
/** How long an abandoned job's DELETE keeps retrying; a job left running is charged when it finishes. */
const DELETE_RETRY_MS = 60_000

/** Cloud jobs that may still run and charge, cancelled if the page goes away (closed tab, reload, navigation). */
const live = new Set<CloudWorker>()
// A page restored from the back/forward cache polls again, sees `cancelled` and replays here.
const onPageHide = () => live.forEach((w) => w.remove(true))

const DECLINED: Record<number, string> = {
  401: 'you are signed out',
  402: 'no compute allowance is left this period',
  409: 'this engine version has no cloud build yet',
  429: 'you already have cloud runs queued',
  503: 'cloud capacity is unavailable right now',
}
const REFUSED = 'the cloud service did not accept this run'
const UNREACHABLE = 'the cloud service could not be reached'

export interface RemoteOptions {
  fetch?: typeof fetch
  pollMs?: number
  /** Longest wait for a cloud server to claim the job, first time or after a requeue, before running here instead. */
  queueGiveUpMs?: number
}

interface JobView {
  status?: string
  lines?: unknown
  next?: unknown
  /** Once done: simc's stderr from the cloud run. */
  notices?: unknown
  /** Once done: the threads, args and profile the cloud actually ran; job.ts checks the shape. */
  effective?: unknown
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : [])

/** The function account code passes to setRemoteEngine. Expert Mode text and HTML reports stay browser-only (DESIGN.md C8). */
export function createRemoteEngine(options: RemoteOptions = {}): RemoteEngine {
  const opts = {
    fetch: options.fetch ?? fetch,
    pollMs: options.pollMs ?? 1000,
    queueGiveUpMs: options.queueGiveUpMs ?? 150_000,
  }
  return (req, engineDir) => {
    const packId = PACK_DIR.exec(engineDir)?.[1]
    // Guided Advanced and Stat Weights always send a slots object; only text in it is Expert Mode.
    const expert = Object.values(req.slots ?? {}).some((v) => typeof v === 'string' && v.trim())
    if (!packId || req.mode === 'raw' || expert || req.htmlReport) return null
    return (variant, dir) => new CloudWorker(req, packId, variant, dir, opts) as unknown as Worker
  }
}

class CloudWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null

  /** The controller's own start message, kept verbatim for a replay (same cancelFlag, profile and args). */
  private start: { jobId?: unknown } | null = null
  private jobId = ''
  private cloudId = ''
  /** The cloud job exists and may still run and charge: from a successful submit until a final status. */
  private active = false
  /** No more cloud work: cancelled, terminated, replayed or finished. */
  private closed = false
  /** terminate() was called; nothing reaches the controller after that. */
  private dead = false
  private ready = false
  private local: Worker | null = null
  /** The server's line cursor: each poll returns only lines written since the last one. */
  private after = 0
  /** When the current run of failed polls began, or 0. */
  private failingSince = 0
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  /** Set while the job waits for a cloud server. */
  private waitTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly req: SimRequest,
    private readonly packId: string,
    private readonly variant: EngineVariant,
    private readonly engineDir: string | undefined,
    private readonly opts: Required<RemoteOptions>,
  ) {}

  postMessage(data: unknown): void {
    // After a replay the real engine owns the run, cancel included.
    if (this.local) return this.local.postMessage(data)
    if ((data as { type?: unknown })?.type === 'cancel') {
      // Nothing runs here, so a shutdown is always true and keeps the controller from blocking the engine.
      this.stop()
      this.post({ type: 'shutdown', reason: 'cancelled', threads: 0 })
      return
    }
    if (this.start || this.closed) return
    this.start = data as { jobId?: unknown }
    this.jobId = String(this.start.jobId)
    // Timed from here, not from polls, so a slow submit or failing polls cannot stretch the wait past the bound.
    this.awaitServer()
    void this.submit()
  }

  /** Not a cancel: it also follows `done`. Only an unfinished cloud job is deleted, since nobody will collect it. */
  terminate(): void {
    this.dead = true
    this.local?.terminate()
    this.stop()
  }

  private close(): void {
    live.delete(this)
    this.closed = true
    clearTimeout(this.pollTimer)
    clearTimeout(this.waitTimer)
  }

  private stop(): void {
    this.close()
    this.remove()
  }

  /** Retries network errors, 429 and 5xx until DELETE_RETRY_MS passes; `keepalive` lets the request outlive an unloading page. */
  remove(keepalive = false): void {
    if (!this.active) return
    this.active = false
    live.delete(this)
    const url = `${JOBS}/${this.cloudId}`
    const until = Date.now() + DELETE_RETRY_MS
    const attempt = (delay: number): void => {
      this.call(url, { method: 'DELETE', keepalive })
        .then((res) => res.status !== 429 && res.status < 500, () => false)
        .then((settled) => {
          if (!settled && Date.now() + delay <= until) setTimeout(() => attempt(delay * 2), delay)
        })
    }
    attempt(1000)
  }

  private awaitServer(): void {
    this.waitTimer = setTimeout(() => this.abandon('no cloud server was free in time'), this.opts.queueGiveUpMs)
  }

  private async call(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    // Called unbound: window.fetch throws "Illegal invocation" when `this` is the options object.
    const f = this.opts.fetch
    return f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  }

  /** Always async, always tagged with the controller's protocol and job id. */
  private post(msg: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.dead) this.onmessage?.({ data: { protocol: WORKER_PROTOCOL, jobId: this.jobId, ...msg } } as MessageEvent)
    })
  }

  private async submit(): Promise<void> {
    // The snapshot is display-only and can pass the server's body cap on its own; slots reach here only empty, and the server refuses any.
    const { characterSnapshot: _snapshot, slots: _slots, ...request } = this.req
    let res: Response
    try {
      res = await this.call(JOBS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packId: this.packId, request }),
      })
    } catch {
      return this.replay(UNREACHABLE)
    }
    if (!res.ok) return this.replay(DECLINED[res.status] ?? REFUSED)
    const id: unknown = await res.json().then((body: { id?: unknown } | null) => body?.id, () => undefined)
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return this.replay(UNREACHABLE)
    this.cloudId = id
    this.active = true
    live.add(this)
    // Idempotent for the same listener; registered here rather than at import so it exists only where cloud runs do.
    globalThis.addEventListener?.('pagehide', onPageHide)
    // Cancelled, terminated or given up while the submit was in flight.
    if (this.closed) return this.remove()
    this.post({ type: 'initializing' })
    this.schedule()
  }

  private schedule(): void {
    this.pollTimer = setTimeout(() => void this.poll(), this.opts.pollMs)
  }

  private async poll(): Promise<void> {
    let view: JobView
    try {
      const res = await this.call(`${JOBS}/${this.cloudId}?after=${this.after}`)
      if (!res.ok) throw new Error(`status ${res.status}`)
      view = (await res.json()) as JobView
    } catch {
      if (this.closed) return
      this.failingSince ||= Date.now()
      if (Date.now() - this.failingSince >= UNREACHABLE_GIVE_UP_MS) return this.abandon(UNREACHABLE)
      return this.schedule()
    }
    if (this.closed) return
    this.failingSince = 0

    const status = view?.status
    // Any message resets the controller's stall watchdog: a live job with no new lines (Redis down, requeued) is not a stalled engine.
    this.post({ type: 'heartbeat' })
    if ((status === 'running' || status === 'done') && !this.ready) {
      this.ready = true
      this.post({ type: 'ready' })
    }
    const lines = strings(view?.lines)
    if (Number.isSafeInteger(view?.next)) this.after = view.next as number
    if (lines.length) this.post({ type: 'log', stream: 'out', lines })

    if (status === 'queued') {
      // A requeue after a lost lease waits for a server again, with the same bound.
      if (this.waitTimer === undefined) this.awaitServer()
      return this.schedule()
    }
    clearTimeout(this.waitTimer)
    this.waitTimer = undefined
    if (status === 'running') return this.schedule()
    this.active = false
    if (status === 'done') return this.collect(view)
    // failed, cancelled elsewhere, or a status this client does not know: the browser engine gives the real answer.
    return this.replay('the cloud run did not finish')
  }

  private async collect(view: JobView): Promise<void> {
    let report: ArrayBuffer
    try {
      const res = await this.call(`${JOBS}/${this.cloudId}/result`, {}, RESULT_TIMEOUT_MS)
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`)
      report = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    } catch {
      return this.replay('the cloud result could not be downloaded')
    }
    if (this.closed) return
    this.close()
    // After the download, so a replay never carries the cloud's stderr; job.ts classifies it exactly like the browser engine's.
    const notices = strings(view.notices)
    if (notices.length) this.post({ type: 'log', stream: 'err', lines: notices })
    this.post({ type: 'done', report, placement: 'cloud', effective: view.effective })
  }

  private abandon(reason: string): void {
    this.remove()
    this.replay(reason)
  }

  /** Run here instead: the stored start message goes to the real engine and everything is forwarded verbatim both ways. Never throws. */
  private replay(reason: string): void {
    if (this.closed) return
    this.close()
    // Not 'Error:': that prefix would become the run's failure message.
    this.post({ type: 'log', stream: 'err', lines: [`Frostsim Cloud: ${reason}. Running in this browser instead.`] })
    // The fallback build compiles profilesets out, and job.ts let this request through only because it was going to the cloud.
    if (this.variant === 'fallback' && this.req.profilesets?.length) {
      return this.refuse('profilesets-unsupported', 'This engine build has no profileset support, so multi-candidate runs cannot run on it.')
    }
    // job.ts restarts its load timer and deadline for the engine that starts now.
    this.post({ type: 'replaying' })
    let local: Worker | undefined
    try {
      local = new Worker(engineWorkerUrl(this.variant, this.engineDir))
      // Handlers are read at dispatch time: the controller swaps onmessage while it reaps.
      local.onmessage = (e) => this.onmessage?.(e)
      local.onerror = (e) => this.onerror?.(e)
      local.onmessageerror = (e) => this.onmessageerror?.(e)
      local.postMessage(this.start)
      this.local = local
    } catch (err) {
      // What job.ts reports when the browser engine cannot start; otherwise the run would sit silent until a stall timeout.
      local?.terminate()
      this.refuse('engine-worker', `the engine worker could not start: ${err}`)
    }
  }

  /** Nothing ran here, so shutdown goes first and the controller reaps nothing. */
  private refuse(code: string, message: string): void {
    this.post({ type: 'shutdown', reason: 'init-failed', threads: 0 })
    this.post({ type: 'error', code, message })
  }
}
