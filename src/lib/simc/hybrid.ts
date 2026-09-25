// Hybrid runs (Avalanche, CLAUDE.md D14): one profileset run's candidates split between this browser and Frostsim Cloud at once,
// merged into one report. Candidates are independent sims, so the merge is a concatenation, never a statistical combine (D3).

import { WORKER_PROTOCOL, engineWorkerUrl, type RemoteEngine, type SimRequest } from './job'
import { createRemoteEngine, type RemoteOptions } from './remote'
import { profilesetLines } from './options'
import { candidatesDone, parseProgressLine } from './progress'
import type { EngineVariant } from './capability'

export interface HybridOptions extends Omit<RemoteOptions, 'replayWorker'> {
  /** Threads a cloud job runs on (the plan's width); with the browser's own threads it sets each side's share. */
  cloudThreads: number
}

/** How many of `count` candidates go to the cloud: by thread share, at least one each side. */
export function cloudShare(count: number, cloudThreads: number, localThreads: number): number {
  // ponytail: a fixed split by thread count ignores cloud queue/boot time; a cold server makes the browser side wait at the end.
  const n = Math.round((count * cloudThreads) / (cloudThreads + Math.max(1, localThreads)))
  return Math.min(count - 1, Math.max(1, n))
}

/** The local report with the cloud's profileset results appended. simc writes `sim.profilesets` only when a candidate has a mean. */
export function mergeProfilesets(local: ArrayBuffer, cloud: ArrayBuffer): ArrayBuffer {
  const decode = (b: ArrayBuffer) => JSON.parse(new TextDecoder().decode(b))
  const merged = decode(local)
  const extra = decode(cloud)?.sim?.profilesets
  if (extra?.results?.length) {
    merged.sim.profilesets ??= { metric: extra.metric, results: [] }
    merged.sim.profilesets.results.push(...extra.results)
  }
  return new TextEncoder().encode(JSON.stringify(merged)).buffer as ArrayBuffer
}

/** A progress record renumbered to the whole run: phase 1 is the baseline, then one phase per finished candidate. */
function renumber(line: string, done: number, total: number): string {
  const f = line.split('\t')
  const offset = f[1]?.trim() !== '' && Number.isFinite(Number(f[1])) ? 0 : 1
  f[offset + 1] = String(1 + done)
  f[offset + 2] = String(1 + total)
  return f.join('\t')
}

/** Profileset runs with two or more candidates split; everything else the cloud engine would take runs in the cloud as usual. */
export function createHybridEngine(options: HybridOptions): RemoteEngine {
  const cloud = createRemoteEngine(options)
  return (req, engineDir) => {
    const whole = cloud(req, engineDir)
    const sets = req.profilesets ?? []
    if (!whole || sets.length < 2) return whole
    // The fallback build has no profilesets to run a local share with.
    return (variant, dir) => (variant === 'fallback' ? whole(variant, dir) : (new HybridWorker(req, engineDir, variant, dir, options) as unknown as Worker))
  }
}

type Msg = Record<string, unknown> & { type?: string }

class HybridWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null

  private readonly local: Worker
  private readonly cloud: Worker
  private readonly localSets: SimRequest['profilesets'] & object
  private readonly cloudSets: SimRequest['profilesets'] & object
  /** Each side's report, once it has one. */
  private reports: { local?: ArrayBuffer; cloud?: ArrayBuffer } = {}
  /** Candidates each side finished, from its own progress lines. */
  private done = { local: 0, cloud: 0 }
  /** Sides that may still hold a browser engine; a shutdown reaches the controller only when none does. */
  private holding = new Set<'local' | 'cloud'>(['local', 'cloud'])
  private reaped = 0
  private startLater: (() => void) | null = null
  private jobId: unknown
  private dead = false

  constructor(
    private readonly req: SimRequest,
    engineDir: string,
    variant: EngineVariant,
    dir: string | undefined,
    options: HybridOptions,
  ) {
    const sets = req.profilesets!
    const split = sets.length - cloudShare(sets.length, options.cloudThreads, req.settings.threads)
    this.localSets = sets.slice(0, split)
    this.cloudSets = sets.slice(split)
    this.local = new Worker(engineWorkerUrl(variant, dir))
    this.local.onmessage = (e) => this.fromLocal(e.data as Msg)
    this.local.onerror = (e) => this.onerror?.(e)
    this.local.onmessageerror = (e) => this.onmessageerror?.(e)
    // A declined cloud share replays here, but only after the local share's engine is gone: one engine run needs ~2 GB.
    const replayWorker = (v: EngineVariant, d?: string) =>
      new Later(() => new Worker(engineWorkerUrl(v, d)), (go) => {
        this.startLater = go
        this.localFinished()
      }) as unknown as Worker
    this.cloud = createRemoteEngine({ ...options, replayWorker })({ ...req, profilesets: this.cloudSets }, engineDir)!(variant, dir)
    this.cloud.onmessage = (e) => this.fromCloud(e.data as Msg)
    this.cloud.onerror = (e) => this.onerror?.(e)
  }

  postMessage(data: unknown): void {
    if ((data as Msg)?.type === 'cancel') {
      this.local.postMessage(data)
      this.cloud.postMessage(data)
      return
    }
    // The controller's start message: each side gets the profile without the other side's candidates.
    const start = data as Msg & { profile: string }
    this.jobId = start.jobId
    const without = (sets: { id: string; lines: string[] }[]) => {
      const drop = new Set(profilesetLines(sets))
      return start.profile.split('\n').filter((l) => !drop.has(l)).join('\n')
    }
    this.local.postMessage({ ...start, profile: without(this.cloudSets) })
    this.cloud.postMessage({ ...start, profile: without(this.localSets) })
  }

  terminate(): void {
    this.dead = true
    this.local.terminate()
    this.cloud.terminate()
  }

  private post(msg: Msg): void {
    if (!this.dead) this.onmessage?.({ data: msg } as MessageEvent)
  }

  /** Progress lines renumbered to the whole run, shown from the side still running (the browser first). */
  private progress(side: 'local' | 'cloud', msg: Msg): Msg | null {
    const lines = Array.isArray(msg.lines) ? (msg.lines as string[]) : []
    const own = side === 'local' ? this.localSets.length : this.cloudSets.length
    const shown = side === 'local' || this.reports.local !== undefined
    const out: string[] = []
    for (const line of lines) {
      const p = parseProgressLine(line)
      if (!p) {
        if (side === 'local') out.push(line)
        continue
      }
      this.done[side] = candidatesDone(p, own)
      if (shown && line.includes('\t')) out.push(renumber(line, this.done.local + this.done.cloud, this.req.profilesets!.length))
      else if (shown) out.push(line)
    }
    return out.length ? { ...msg, lines: out } : null
  }

  private release(side: 'local' | 'cloud', threads: number, msg?: Msg): void {
    if (!this.holding.delete(side)) return
    this.reaped += threads
    if (side === 'local') this.localFinished()
    if (!this.holding.size) this.post({ protocol: WORKER_PROTOCOL, jobId: this.jobId, reason: 'complete', ...msg, type: 'shutdown', threads: this.reaped })
  }

  /** Starts a replayed cloud share once the local share finished and its engine is gone; a failed local share never starts it. */
  private localFinished(): void {
    if (!this.holding.has('local') && this.reports.local) this.startLater?.()
  }

  private fromLocal(msg: Msg): void {
    if (msg?.protocol !== WORKER_PROTOCOL) return
    switch (msg.type) {
      case 'done':
        this.reports.local = msg.report as ArrayBuffer
        return this.finish(msg)
      case 'shutdown':
        return this.release('local', Number(msg.threads) || 0, msg)
      case 'log': {
        if (msg.stream === 'err') return this.post(msg)
        const out = this.progress('local', msg)
        if (out) this.post(out)
        return
      }
      default:
        // assets, compiled, initializing, ready, error: the browser side owns the run's lifecycle.
        return this.post(msg)
    }
  }

  private fromCloud(msg: Msg): void {
    if (msg?.protocol !== WORKER_PROTOCOL) return
    switch (msg.type) {
      case 'done':
        this.reports.cloud = msg.report as ArrayBuffer
        // A cloud run holds no browser engine; a replay here confirms its own shutdown after done.
        if (msg.placement === 'cloud') this.release('cloud', 0)
        return this.finish(msg)
      case 'shutdown':
        return this.release('cloud', Number(msg.threads) || 0, msg)
      case 'log': {
        if (msg.stream === 'err') return this.post(msg)
        const out = this.progress('cloud', msg)
        if (out) this.post(out)
        return
      }
      case 'heartbeat':
      case 'error':
        return this.post(msg)
      default:
        // initializing, ready, replaying, assets, compiled: the controller's timers follow the browser side only.
        return
    }
  }

  private finish(msg: Msg): void {
    const { local, cloud } = this.reports
    if (!local || !cloud) return
    let report: ArrayBuffer
    try {
      report = mergeProfilesets(local, cloud)
    } catch {
      return this.post({ ...msg, type: 'error', code: 'report-missing', message: 'the two halves of a hybrid run could not be merged' })
    }
    // No placement: job.ts then keeps this browser's own assembly of the whole request as the effective profile.
    this.post({ protocol: WORKER_PROTOCOL, jobId: msg.jobId, type: 'done', report })
  }
}

/** A browser engine that starts only when `gate` fires; until then it queues messages, and a cancel ends it without starting. */
class Later {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  private real: Worker | null = null
  private queued: unknown[] = []
  private dead = false

  constructor(make: () => Worker, gate: (go: () => void) => void) {
    gate(() => {
      if (this.dead || this.real) return
      const w = make()
      w.onmessage = (e) => this.onmessage?.(e)
      w.onerror = (e) => this.onerror?.(e)
      w.onmessageerror = (e) => this.onmessageerror?.(e)
      this.real = w
      for (const m of this.queued.splice(0)) w.postMessage(m)
    })
  }

  postMessage(data: unknown): void {
    if (this.real) return this.real.postMessage(data)
    const msg = data as Msg
    if (msg?.type !== 'cancel') return void this.queued.push(data)
    this.dead = true
    const start = this.queued[0] as Msg | undefined
    queueMicrotask(() => this.onmessage?.({ data: { protocol: WORKER_PROTOCOL, jobId: start?.jobId, type: 'shutdown', reason: 'cancelled', threads: 0 } } as MessageEvent))
  }

  terminate(): void {
    this.dead = true
    this.real?.terminate()
  }
}
