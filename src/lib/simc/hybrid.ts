// Hybrid runs (Avalanche, CLAUDE.md D14): a run made of independent sims (pieces) runs on this browser and Frostsim Cloud at once,
// in chunks from one queue. Three kinds split: profileset candidates (Top Gear, Droptimizer, Crest, Compare), characters in a
// multi-character Quick Sim (single_actor_batch=1: each character is its own sim) and stat weights (one sim per stat). Each side
// takes the next chunk when it is free, sized from the cost model (cost.ts) so both finish together; a side that would finish
// later than the other doing everything alone takes none; and at the end an idle side takes back a chunk no cloud server has
// claimed yet, or races the other side's last chunk when it would clearly win. Chunk reports merge into one: every merge is a
// concatenation of results computed whole, never a statistical combine (D3). A single-character Quick Sim has nothing
// independent to split and runs whole in the cloud.

import { WORKER_PROTOCOL, engineWorkerUrl, type RemoteEngine, type SimRequest } from './job'
import { createRemoteEngine, type RemoteOptions } from './remote'
import { assembleRun } from './assemble'
import { profilesetLines } from './options'
import { parseProgressLine, type EngineProgress } from './progress'
import { characterBlocks, mergeCharacters } from './multi-actor'
import {
  SCALE_ONLY, iterationsFor, remainingSeconds, runFraction, scaleStats, sharedPieces, splitOf, workOf, type Speed, type SplitKind,
} from './cost'
import { localCv, localSpeed, recordRawReport } from './speed-store'
import type { EngineVariant } from './capability'

export { characterBlocks, mergeCharacters, splitOf, type SplitKind }

export interface HybridOptions extends Omit<RemoteOptions, 'replayWorker' | 'onreplay'> {
  /** Threads a cloud job runs on (the plan's width). */
  cloudThreads: number
  /** Where each run goes, for the run panel: called when a run starts and whenever its parts move. */
  onplace?: (place: RunPlace) => void
  /** Where this device's measured speed lives (speed-store.ts; localStorage by default). */
  speedStore?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Clock in milliseconds. */
  now?: () => number
}

/** The account server's answer to "where would a job start now" (GET /api/v1/compute/capacity, queue.ts capacityView), with
 *  the cloud's fitted speed and DPS spread by fight style. */
export interface Capacity {
  state: 'warm' | 'booting' | 'cold' | 'queued' | 'none'
  waitS?: number
  model?: { speed: Record<string, Speed>; cv: Record<string, number> }
}

const CAPACITY = '/api/v1/compute/capacity'
/** A hybrid run waits at most this long for the capacity answer, then plans from this device's measurements alone. */
const CAPACITY_TIMEOUT_MS = 1500
/** Submitting and the first poll, beyond the server's own wait estimate. */
const SUBMIT_S = 2
/** Chunks are halved only while each half stays this many times its start-up (engine start, shared baseline). */
const CHUNK_OVER_STARTUP = 4
/** Cloud jobs one run may submit: each is a queue round-trip, and the account server rate-limits submissions. */
const MAX_CLOUD_CHUNKS = 8
/** An idle side races the other's last chunk only when it would finish it this much sooner. */
const RACE_MARGIN = 1.25

/** The capacity answer, or null when it is late, refused or malformed. */
export async function fetchCapacity(f: typeof fetch = fetch): Promise<Capacity | null> {
  try {
    const res = await f(CAPACITY, { signal: AbortSignal.timeout(CAPACITY_TIMEOUT_MS) })
    if (!res.ok) return null
    const body = (await res.json()) as Capacity
    return ['warm', 'booting', 'cold', 'queued', 'none'].includes(body?.state) ? body : null
  } catch {
    return null
  }
}

/** Where a run is going, as the run panel says it. */
export interface RunPlace {
  mode: 'hybrid' | 'cloud' | 'browser'
  kind?: SplitKind
  /** Hybrid: parts each side has run or is running, by count and, for characters and stats, by name. */
  here?: number
  there?: number
  hereNames?: string[]
  thereNames?: string[]
  /** Stat weights: stats both sides run, so each side's weights are normalized against its own measurement. */
  both?: string[]
  /** Why a hybrid run is where it is, or why the cloud handed work to this browser. */
  note?: string
}

/** How a request splits into pieces: their names, the sub-request for any set of them, and this browser's start message for one. */
interface Plan {
  kind: SplitKind
  names: string[]
  /** Pieces every chunk runs again (cost.ts sharedPieces). */
  shared: number
  both?: string[]
  request: (pieces: readonly number[]) => SimRequest
  localStart: (start: { profile: string; args: string[] }, pieces: readonly number[]) => { profile: string; args: string[] }
}

export function planOf(req: SimRequest): Plan | null {
  const split = splitOf(req)
  if (!split) return null
  const shared = sharedPieces(req, split.kind)
  if (split.kind === 'candidates') {
    const sets = req.profilesets!
    const request = (pieces: readonly number[]) => ({ ...req, profilesets: pieces.map((i) => sets[i]) })
    return {
      kind: 'candidates', names: sets.map((s) => s.id), shared, request,
      localStart: (start, pieces) => {
        const keep = new Set(pieces)
        const drop = new Set(profilesetLines(sets.filter((_, i) => !keep.has(i))))
        return { ...start, profile: start.profile.split('\n').filter((l) => !drop.has(l)).join('\n') }
      },
    }
  }
  if (split.kind === 'characters') {
    const blocks = characterBlocks(req.profile)
    const request = (pieces: readonly number[]) => ({ ...req, profile: pieces.map((i) => blocks[i].text).join('\n') })
    return {
      kind: 'characters', names: blocks.map((b) => b.name), shared, request,
      // The profile is independent of the thread ceiling; args stay the controller's own.
      localStart: (start, pieces) => ({ ...start, profile: assembleRun(request(pieces), Math.max(1, req.settings.threads)).profile }),
    }
  }
  const { stats, both } = scaleStats(req.extraOptions ?? [])!
  const option = (pieces: readonly number[]) => `scale_only=${[...both, ...pieces.map((i) => stats[i])].join(',')}`
  return {
    kind: 'stats', names: stats, shared, both,
    request: (pieces) => ({ ...req, extraOptions: (req.extraOptions ?? []).map((o) => (SCALE_ONLY.test(o) ? option(pieces) : o)) }),
    // extraOptions become args in order (buildArgs), so the local args swap the one scale_only argument.
    localStart: (start, pieces) => ({ ...start, args: start.args.map((a) => (SCALE_ONLY.test(a) ? option(pieces) : a)) }),
  }
}

/** Seconds per piece, and per chunk beyond its pieces (start-up and the shared pieces). */
interface Pace { piece: number; chunk: number }

/** Each side's pace before anything of this run has finished: this device's fitted speed and the server's fitted cloud speed,
 *  at the iterations the DPS spread needs. Undefined for a side with no measurement. */
export function priorPaces(req: SimRequest, cloudThreads: number, capacity: Capacity | null, store?: HybridOptions['speedStore']): { local?: Pace; cloud?: Pace } {
  const work = workOf(req)
  const split = splitOf(req)
  const shared = split ? sharedPieces(req, split.kind) : 0
  const iterations = iterationsFor(work.accuracy, localCv(work.fightStyle, store) ?? capacity?.model?.cv[work.fightStyle])
  const pace = (speed: Speed | null | undefined, threads: number): Pace | undefined => {
    if (!speed || !iterations) return undefined
    const piece = (speed.secondsPerUnit * iterations * work.simSeconds) / Math.max(1, threads)
    return { piece, chunk: speed.overheadS + shared * piece }
  }
  const model = capacity?.model
  return {
    local: pace(localSpeed(work.fightStyle, store), req.settings.threads),
    cloud: pace(model?.speed[work.fightStyle] ?? model?.speed['*'], cloudThreads),
  }
}

type Report = { sim: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
const decode = (b: ArrayBuffer): Report => JSON.parse(new TextDecoder().decode(b))
const encode = (r: Report) => new TextEncoder().encode(JSON.stringify(r)).buffer as ArrayBuffer

/** The local report with the cloud's profileset results appended. simc writes `sim.profilesets` only when a candidate has a mean. */
export function mergeProfilesets(local: ArrayBuffer, cloud: ArrayBuffer): ArrayBuffer {
  const merged = decode(local)
  const extra = decode(cloud)?.sim?.profilesets
  if (extra?.results?.length) {
    merged.sim.profilesets ??= { metric: extra.metric, results: [] }
    merged.sim.profilesets.results.push(...extra.results)
  }
  return encode(merged)
}

/** The local report with the cloud's stat weights added to each player's; a stat both sides ran keeps the local value. The
 *  report's scale_only then names every stat. */
export function mergeStats(local: ArrayBuffer, cloud: ArrayBuffer, stats: string[]): ArrayBuffer {
  const merged = decode(local)
  const theirs = decode(cloud).sim.players ?? []
  const add = (into: Record<string, unknown> | undefined, from: Record<string, unknown> | undefined) =>
    from ? { ...from, ...into } : into
  for (const player of merged.sim.players ?? []) {
    const other = theirs.find((p: { name?: string }) => p.name === player.name)
    if (!other) continue
    player.scale_factors = add(player.scale_factors, other.scale_factors)
    player.scale_deltas = add(player.scale_deltas, other.scale_deltas)
    if (other.scale_factors_all) {
      player.scale_factors_all ??= {}
      for (const [metric, values] of Object.entries(other.scale_factors_all)) {
        player.scale_factors_all[metric] = add(player.scale_factors_all[metric], values as Record<string, unknown>)
      }
    }
  }
  if (merged.sim.options?.scaling) merged.sim.options.scaling.scale_only = stats.join(',')
  return encode(merged)
}


const WHOLE = 'Hybrid splits runs with two or more candidates, characters or stat weights; this one runs whole on Frostsim Cloud.'

/** Runs that split (splitOf) go both ways at once; everything else the cloud engine would take runs whole in the cloud. */
export function createHybridEngine(options: HybridOptions): RemoteEngine {
  const place = (p: RunPlace) => options.onplace?.(p)
  const cloud = createRemoteEngine({
    ...options,
    onreplay: (reason) => place({ mode: 'browser', note: `Frostsim Cloud: ${reason}. This run moved to this PC.` }),
  })
  return (req, engineDir) => {
    const whole = cloud(req, engineDir)
    if (!whole) return whole
    const plan = planOf(req)
    // Asked as soon as the run is known, so the answer is usually in before the start message.
    const capacity = plan ? fetchCapacity(options.fetch) : null
    return (variant, dir) => {
      // The fallback build has no profilesets for a local share, and a run with one piece has nothing to split.
      if (!plan || !capacity || (variant === 'fallback' && plan.kind === 'candidates')) {
        place({ mode: 'cloud', note: plan ? 'This browser cannot run profilesets, so the whole run is on Frostsim Cloud.' : WHOLE })
        return whole(variant, dir)
      }
      let answer: Capacity | null = null
      // The start message waits (at most CAPACITY_TIMEOUT_MS) for the plan; a cancel before then ends the run with nothing started.
      return new Later(
        () => new HybridWorker(req, plan, engineDir, variant, dir, options, answer) as unknown as Worker,
        (go) => void capacity.then((c) => { answer = c; go() }),
      ) as unknown as Worker
    }
  }
}

type Msg = Record<string, unknown> & { type?: string }
type Side = 'local' | 'cloud'
const other = (side: Side): Side => (side === 'local' ? 'cloud' : 'local')

interface Chunk {
  side: Side
  pieces: number[]
  worker: Worker
  /** Seconds on this run's clock: sent, first progress. */
  startAt: number
  firstAt?: number
  progress: EngineProgress | null
  /** Cloud: a server has claimed it. A local chunk runs at once. */
  claimed: boolean
  /** Seconds before it can start: the cloud's first job waits for a server. */
  waitS: number
  /** The same pieces raced on the other side; the first to finish wins and the other is cancelled. */
  twin?: Chunk
  /** The later of a racing pair, which the run panel does not count as its own share. */
  racer?: boolean
  done?: boolean
  cancelled?: boolean
}

/** Lifecycle messages the controller takes once; later engines' become heartbeats, which only keep the stall timer quiet. */
const ONCE = new Set(['assets', 'initializing', 'ready'])

class HybridWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null

  private readonly clock: () => number
  private readonly t0: number
  /** Pieces nobody has taken, in order. */
  private queue: number[]
  private readonly done = new Set<number>()
  private readonly results: { pieces: number[]; report: ArrayBuffer; side: Side }[] = []
  private readonly running = new Set<Chunk>()
  /** The one local chunk whose engine is alive, until it shuts down: one engine run needs ~2 GB. */
  private localEngine: Chunk | null = null
  private cloudAlive: boolean
  private cloudChunks = 0
  private localChunks = 0
  private readonly prior: { local?: Pace; cloud?: Pace }
  private readonly live: { local?: Pace; cloud?: Pace } = {}
  private readonly firstWaitS: number
  private start: (Msg & { profile: string; args: string[] }) | null = null
  private compiled: unknown
  private readonly forwarded = new Set<string>()
  private reaped = 0
  private note: string | undefined
  private stopped = false
  private finished = false
  private dead = false

  constructor(
    private readonly req: SimRequest,
    private readonly plan: Plan,
    private readonly engineDir: string,
    private readonly variant: EngineVariant,
    private readonly dir: string | undefined,
    private readonly options: HybridOptions,
    capacity: Capacity | null,
  ) {
    this.clock = options.now ?? (() => performance.now())
    this.t0 = this.clock()
    this.queue = plan.names.map((_, i) => i)
    this.cloudAlive = capacity?.state !== 'none'
    if (!this.cloudAlive) this.note = 'Frostsim Cloud cannot take runs right now, so this one runs on this PC.'
    this.prior = priorPaces(req, options.cloudThreads, capacity, options.speedStore)
    this.firstWaitS = (capacity?.waitS ?? 0) + SUBMIT_S
  }

  private get now(): number {
    return (this.clock() - this.t0) / 1000
  }

  postMessage(data: unknown): void {
    const msg = data as Msg
    if (msg?.type === 'cancel') {
      this.stopped = true
      for (const c of this.running) c.worker.postMessage(msg)
      // Nothing of this run left on this PC: confirm at once, or the controller waits out its grace and blocks the tab.
      if (!this.localEngine) {
        this.shutdownPosted = false
        this.shutdown('cancelled')
      }
      return
    }
    this.start = msg as Msg & { profile: string; args: string[] }
    this.schedule()
  }

  terminate(): void {
    this.dead = true
    for (const c of this.running) c.worker.terminate()
    this.localEngine?.worker.terminate()
  }

  private post(msg: Msg): void {
    if (!this.dead) this.onmessage?.({ data: { protocol: WORKER_PROTOCOL, jobId: this.start?.jobId, ...msg } } as MessageEvent)
  }

  private threads(side: Side): number {
    return Math.max(1, side === 'local' ? this.req.settings.threads : this.options.cloudThreads)
  }

  /** A side's pace: measured in this run, else from past runs, else scaled from the other side's by threads. Only the first two
   *  are seconds a decision can compare against the other side's; `known` says so. */
  private pace(side: Side): Pace & { known: boolean } {
    const own = this.live[side] ?? this.prior[side]
    if (own) return { ...own, known: true }
    const theirs = this.live[other(side)] ?? this.prior[other(side)]
    const scale = this.threads(other(side)) / this.threads(side)
    return theirs ? { piece: theirs.piece * scale, chunk: 0, known: false } : { piece: 1 / this.threads(side), chunk: 0, known: false }
  }

  private live_(): Chunk[] {
    return [...this.running].filter((c) => !c.done && !c.cancelled)
  }

  private busy(side: Side): boolean {
    return side === 'local' ? this.localEngine !== null : this.live_().some((c) => c.side === 'cloud')
  }

  /** Seconds until a chunk finishes: at its own pace once its progress says enough, else from its side's pace. */
  private left(c: Chunk): number {
    const f = runFraction(c.progress, this.req.accuracy)
    const paced = c.firstAt === undefined ? undefined : remainingSeconds(f, this.now - c.firstAt)
    if (paced !== undefined) return paced
    const p = this.pace(c.side)
    return Math.max(0, c.startAt + c.waitS + p.chunk + c.pieces.length * p.piece - this.now)
  }

  /** When a side can start something new. */
  private freeAt(side: Side): number {
    const mine = this.live_().filter((c) => c.side === side)
    return this.now + (mine.length ? Math.max(...mine.map((c) => this.left(c))) : 0)
  }

  /** Pieces a side should take so both sides finish together: its start-up (the cloud's first wait, engine start, shared pieces)
   *  against the other side's time until it is free and started, over their summed paces. Without measured paces for both, by
   *  thread share. */
  private balanced(side: Side): number {
    const left = this.queue.length
    if (!this.cloudAlive) return side === 'local' ? left : 0
    const me = this.pace(side)
    const them = this.pace(other(side))
    if (!me.known || !them.known) return Math.round((left * (1 / me.piece)) / (1 / me.piece + 1 / them.piece))
    const wait = (s: Side) => (s === 'cloud' && this.cloudChunks === 0 ? this.firstWaitS : 0)
    const mine = wait(side) + me.chunk
    const theirs = Math.max(wait(other(side)), this.freeAt(other(side)) - this.now) + them.chunk
    return Math.max(0, Math.min(left, Math.round((theirs + left * them.piece - mine) / (me.piece + them.piece))))
  }

  /** The next chunk for a side: half its balanced share, so later chunks shrink and the split keeps correcting itself, unless the
   *  halves would be only a few start-ups long; the whole share for the cloud's last allowed job. 0: this side should wait. */
  private chunkSize(side: Side): number {
    // Alone, every extra chunk only repeats start-up.
    if (!this.cloudAlive) return side === 'local' ? this.queue.length : 0
    const share = this.balanced(side)
    if (share <= 0) return 0
    const me = this.pace(side)
    const least = me.known ? Math.ceil((CHUNK_OVER_STARTUP * me.chunk) / me.piece) : 1
    const last = side === 'cloud' && this.cloudChunks >= MAX_CLOUD_CHUNKS - 1
    return last || share < 2 * least ? share : Math.ceil(share / 2)
  }

  private schedule(): void {
    if (this.stopped || this.finished || !this.start) return
    for (const side of ['local', 'cloud'] as const) {
      if (!this.queue.length || this.busy(side) || (side === 'cloud' && (!this.cloudAlive || this.cloudChunks >= MAX_CLOUD_CHUNKS))) continue
      const k = this.chunkSize(side)
      if (!k) continue
      this.launch(side, side === 'local' ? this.queue.splice(0, k) : this.queue.splice(-k))
    }
    // An exact tie can make both sides decline; something must run.
    if (this.queue.length && !this.live_().length && !this.localEngine) this.launch('local', this.queue.splice(0, Math.max(1, this.chunkSize('local'))))
    if (!this.queue.length) this.tail()
    this.place()
  }

  /** Nothing left to hand out: an idle side takes back a cloud chunk no server has claimed, or races the other side's chunk when
   *  it would finish it clearly sooner. */
  private tail(): void {
    const faster = (side: Side, c: Chunk) => {
      const me = this.pace(side)
      const wait = side === 'cloud' && this.cloudChunks === 0 ? this.firstWaitS : 0
      return me.known && (wait + me.chunk + c.pieces.length * me.piece) * RACE_MARGIN < this.left(c)
    }
    if (!this.localEngine) {
      const c = this.live_().find((x) => x.side === 'cloud' && !x.twin)
      // An unclaimed cloud chunk means no server is free yet: with no pace to compare, taking it back is the safe bet.
      if (c && (faster('local', c) || (!c.claimed && !this.pace('local').known))) {
        if (!c.claimed) this.cancel(c)
        this.launch('local', c.pieces, c.claimed ? c : undefined)
      }
    }
    if (this.cloudAlive && !this.busy('cloud') && this.cloudChunks < MAX_CLOUD_CHUNKS) {
      const c = this.live_().find((x) => x.side === 'local' && !x.twin)
      if (c && faster('cloud', c)) this.launch('cloud', c.pieces, c)
    }
  }

  private launch(side: Side, pieces: number[], twinOf?: Chunk): void {
    const start = this.start!
    const c: Chunk = {
      side, pieces, startAt: this.now, progress: null, claimed: side === 'local',
      waitS: side === 'cloud' && this.cloudChunks === 0 ? this.firstWaitS : 0, worker: null as unknown as Worker,
    }
    if (twinOf) {
      c.twin = twinOf
      c.racer = true
      twinOf.twin = c
    }
    if (side === 'local') {
      this.localChunks++
      c.worker = new Worker(engineWorkerUrl(this.variant, this.dir))
      this.localEngine = c
    } else {
      this.cloudChunks++
      // A declined cloud job would replay here; this run hands its pieces back to the queue instead.
      const decline = (reason: string) => { c.cancelled = true; this.declined(c, reason) }
      let reason = 'the cloud did not take the run'
      c.worker = createRemoteEngine({
        ...this.options, onreplay: (why) => { reason = why }, replayWorker: () => new Declined(() => decline(reason)) as unknown as Worker,
      })(this.plan.request(pieces), this.engineDir)!(this.variant, this.dir)
    }
    c.worker.onmessage = (e) => this.from(c, e.data as Msg)
    c.worker.onerror = (e) => (side === 'local' ? this.onerror?.(e) : this.declined(c, 'the cloud run failed'))
    c.worker.onmessageerror = (e) => this.onmessageerror?.(e)
    this.running.add(c)
    const own = side === 'local' ? this.plan.localStart(start, pieces) : { profile: start.profile, args: start.args }
    // simc's html reports cannot be merged; later engines reuse the first one's compiled module.
    c.worker.postMessage({ ...start, ...own, htmlPath: undefined, compiledModule: start.compiledModule ?? this.compiled })
  }

  private cancel(c: Chunk): void {
    if (c.cancelled || c.done) return
    c.cancelled = true
    c.worker.postMessage({ protocol: WORKER_PROTOCOL, jobId: this.start?.jobId, type: 'cancel' })
    // A cloud job needs nothing more from this run; a local engine is waited for until it shuts down.
    if (c.side === 'cloud') this.running.delete(c)
  }

  private declined(c: Chunk, reason: string): void {
    this.running.delete(c)
    if (!this.cloudAlive) return
    this.cloudAlive = false
    this.note = `Frostsim Cloud: ${reason}. The rest runs on this PC.`
    // Its pieces go back unless a race already has them on this PC.
    if (!c.twin || c.twin.cancelled || c.twin.done) this.queue.push(...c.pieces.filter((i) => !this.done.has(i)))
    this.schedule()
  }

  private from(c: Chunk, msg: Msg): void {
    if (msg?.protocol !== WORKER_PROTOCOL || this.dead) return
    switch (msg.type) {
      case 'done':
        return this.chunkDone(c, msg.report as ArrayBuffer)
      case 'shutdown':
        if (c.side !== 'local') return
        this.reaped += Number(msg.threads) || 0
        this.running.delete(c)
        if (this.localEngine === c) this.localEngine = null
        if (this.stopped) return this.shutdown('cancelled')
        this.schedule()
        return this.end()
      case 'log': {
        if (msg.stream === 'err') return this.post(msg)
        const lines = Array.isArray(msg.lines) ? (msg.lines as string[]) : []
        const text: string[] = []
        for (const line of lines) {
          const p = parseProgressLine(line)
          if (!p) text.push(line)
          else if (!c.cancelled) {
            c.progress = p
            c.firstAt ??= this.now
          }
        }
        this.progress(text)
        // Live paces move the estimates: a side that looked too slow to be worth a chunk may be worth one now.
        return this.schedule()
      }
      case 'compiled':
        this.compiled ??= msg.module
        return this.post(msg)
      case 'ready':
        if (c.side === 'cloud') c.claimed = true
        return this.lifecycle(msg)
      case 'error':
        if (c.side === 'cloud') return this.declined(c, 'the cloud run failed')
        return this.post(msg)
      case 'replaying':
        return
      default:
        return this.lifecycle(msg)
    }
  }

  private lifecycle(msg: Msg): void {
    const type = String(msg.type)
    if (!ONCE.has(type) || !this.forwarded.has(type)) {
      this.forwarded.add(type)
      return this.post(msg)
    }
    this.post({ type: 'heartbeat' })
  }

  private chunkDone(c: Chunk, report: ArrayBuffer): void {
    if (c.cancelled || c.done) return
    c.done = true
    if (c.side === 'cloud') this.running.delete(c)
    const fresh = c.pieces.filter((i) => !this.done.has(i))
    if (fresh.length === c.pieces.length) {
      this.results.push({ pieces: c.pieces, report, side: c.side })
      for (const i of c.pieces) this.done.add(i)
    }
    // This run's own pace for the side, which from now on outranks past runs.
    const firstAt = c.firstAt ?? c.startAt
    const piece = Math.max(1e-3, (this.now - firstAt) / (c.pieces.length + this.plan.shared))
    this.live[c.side] = { piece, chunk: firstAt - c.startAt - c.waitS + this.plan.shared * piece }
    if (c.side === 'local') recordRawReport(this.plan.request(c.pieces), report, this.options.speedStore)
    if (c.twin) this.cancel(c.twin)
    this.progress([])
    this.schedule()
    this.end()
  }

  /** The whole run's progress as one record: finished pieces plus each running chunk's share (cost.ts runFraction). */
  private progress(text: string[]): void {
    const total = this.plan.names.length
    let pieces = this.done.size
    const seen = new Set<Chunk>()
    for (const c of this.live_()) {
      if (seen.has(c)) continue
      const pair = c.twin && !c.twin.cancelled && !c.twin.done ? [c, c.twin] : [c]
      pair.forEach((x) => seen.add(x))
      pieces += Math.max(...pair.map((x) => {
        const f = runFraction(x.progress, this.req.accuracy) ?? 0
        return Math.max(0, Math.min(x.pieces.length, f * (x.pieces.length + this.plan.shared) - this.plan.shared))
      }))
    }
    const fraction = Math.min(1, pieces / total)
    // A progressbar_type=1 record (progress.ts): phase "done of total", work as iterations out of 10000.
    const record = `Hybrid\t${this.done.size} of ${total}\t1\t1\t${Math.round(fraction * 10_000)}\t10000\t0\t0`
    this.post({ type: 'log', stream: 'out', lines: [...text, record] })
  }

  private place(): void {
    const count = (side: Side) => {
      const mine = new Set<number>()
      for (const r of this.results) if (r.side === side) r.pieces.forEach((i) => mine.add(i))
      for (const c of this.live_()) if (c.side === side && !c.racer) c.pieces.forEach((i) => mine.add(i))
      return [...mine].sort((a, b) => a - b)
    }
    const here = count('local')
    const there = count('cloud')
    const named = this.plan.kind !== 'candidates'
    const note = this.note ?? (!this.cloudChunks && this.cloudAlive && this.localChunks
      ? 'Going by measured speeds, this PC finishes this run before Frostsim Cloud would. It uses none of your allowance.'
      : !this.localChunks && this.cloudChunks ? 'Going by measured speeds, Frostsim Cloud alone finishes this run sooner.' : undefined)
    const place: RunPlace = {
      mode: 'hybrid', kind: this.plan.kind, here: here.length, there: there.length,
      ...(named ? { hereNames: here.map((i) => this.plan.names[i]), thereNames: there.map((i) => this.plan.names[i]) } : {}),
      ...(this.plan.both?.length ? { both: this.plan.both } : {}), ...(note ? { note } : {}),
    }
    const key = JSON.stringify(place)
    if (key === this.shown) return
    this.shown = key
    this.options.onplace?.(place)
  }
  private shown = ''

  /** Posts the merged report once every piece is in, and the shutdown once no engine of this run is left on this PC. */
  private end(): void {
    if (this.stopped) return
    if (!this.finished && this.done.size === this.plan.names.length) {
      this.finished = true
      for (const c of this.live_()) this.cancel(c)
      const ordered = [...this.results].sort((a, b) => Math.min(...a.pieces) - Math.min(...b.pieces)).map((r) => r.report)
      const stats = [...(this.plan.both ?? []), ...this.plan.names]
      let report: ArrayBuffer
      try {
        report = ordered.reduce((all, r) => (this.plan.kind === 'candidates' ? mergeProfilesets(all, r)
          : this.plan.kind === 'characters' ? mergeCharacters(all, r) : mergeStats(all, r, stats)))
      } catch {
        this.post({ type: 'error', code: 'report-missing', message: 'the parts of a hybrid run could not be merged' })
        return
      }
      // No placement: job.ts then keeps this browser's own assembly of the whole request as the effective profile.
      this.post({ type: 'done', report })
    }
    if (this.finished && !this.localEngine) this.shutdown('complete')
  }

  private shutdownPosted = false
  private shutdown(reason: string): void {
    if (this.shutdownPosted) return
    this.shutdownPosted = true
    this.post({ type: 'shutdown', reason, threads: this.reaped })
  }
}

/** Stands in for the browser engine a declined cloud job would replay on: it runs nothing and tells the run instead. */
class Declined {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  constructor(private readonly tell: () => void) {}
  postMessage(msg: unknown): void {
    if ((msg as Msg)?.type !== 'cancel') queueMicrotask(this.tell)
  }
  terminate(): void {}
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
