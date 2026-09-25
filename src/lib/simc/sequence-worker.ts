// Runs a split request's groups one after another as one run (role-share.ts): one engine run needs ~2 GB, so never two at once.

import { WORKER_PROTOCOL } from './job'
import { mergeCharacters } from './multi-actor'

type Msg = Record<string, unknown> & { type?: string }
/** Lifecycle messages the controller takes once; a later group's become heartbeats, which only keep the stall timer quiet. */
const ONCE = new Set(['assets', 'compiled', 'initializing', 'ready', 'replaying'])

/** Runs one engine per group, one after another (one engine run needs ~2 GB), and answers the controller as one run: the first
 *  group's lifecycle, every group's progress, one merged report. `make(i)` gives group i's engine (this browser's or the cloud's);
 *  `starts[i]` its profile and args. */
export class SequenceWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  private i = 0
  private current: Worker | null = null
  private start: Msg | null = null
  private reports: ArrayBuffer[] = []
  private threads = 0
  private stopped = false

  constructor(private readonly starts: readonly { profile: string; args: string[] }[], private readonly make: (i: number) => Worker) {}

  postMessage(data: unknown): void {
    const msg = data as Msg
    if (msg?.type === 'cancel') {
      this.stopped = true
      return this.current?.postMessage(data)
    }
    this.start = msg
    this.run(0)
  }

  terminate(): void {
    this.stopped = true
    this.current?.terminate()
  }

  private run(i: number): void {
    this.current?.terminate()
    this.i = i
    const w = this.make(i)
    this.current = w
    w.onmessage = (e) => this.from(i, e.data as Msg)
    w.onerror = (e) => this.onerror?.(e)
    w.onmessageerror = (e) => this.onmessageerror?.(e)
    // simc's html reports cannot be merged, so a split run asks for none.
    w.postMessage({ ...this.start, ...this.starts[i], htmlPath: undefined })
  }

  private post(msg: Msg): void {
    if (!this.stopped || msg.type === 'shutdown' || msg.type === 'error') this.onmessage?.({ data: msg } as MessageEvent)
  }

  /** The next group, once this one's report is in and its engine is gone. */
  private next(): void {
    if (this.stopped || this.reports.length !== this.i + 1) return
    this.run(this.i + 1)
  }

  private from(i: number, msg: Msg): void {
    if (msg?.protocol !== WORKER_PROTOCOL || i !== this.i) return
    const last = i === this.starts.length - 1
    if (msg.type === 'done') {
      this.reports.push(msg.report as ArrayBuffer)
      if (last) {
        let report: ArrayBuffer
        try {
          report = this.reports.reduce((all, r) => mergeCharacters(all, r))
        } catch {
          return this.post({ ...msg, type: 'error', code: 'report-missing', message: 'the role groups of a Dungeon Route compare could not be merged' })
        }
        // No effective profile: the controller keeps its own record of every group's.
        const { effective: _effective, html: _html, ...rest } = msg
        return this.post({ ...rest, report })
      }
      // A cloud run holds no browser engine and sends no shutdown of its own.
      if (msg.placement === 'cloud') this.next()
      return
    }
    if (msg.type === 'shutdown') {
      this.threads += Number(msg.threads) || 0
      if (!last && msg.reason === 'complete' && !this.stopped) return this.next()
      return this.post({ ...msg, threads: this.threads })
    }
    if (i > 0 && ONCE.has(msg.type ?? '')) return this.post({ protocol: WORKER_PROTOCOL, jobId: msg.jobId, type: 'heartbeat' })
    this.post(msg)
  }
}
