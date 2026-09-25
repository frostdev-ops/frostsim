// Hybrid runs (Avalanche, CLAUDE.md D14): a run made of independent sims splits between this browser and Frostsim Cloud at once,
// merged into one report. Three kinds split: profileset candidates (Top Gear, Droptimizer, Crest, Compare), characters in a
// multi-character Quick Sim (single_actor_batch=1: each character is its own sim) and stat weights (one sim per stat). Every merge
// is a concatenation of results the two engines computed whole, never a statistical combine (D3). A single-character Quick Sim
// has nothing independent to split and runs whole in the cloud.

import { WORKER_PROTOCOL, engineWorkerUrl, type RemoteEngine, type SimRequest } from './job'
import { createRemoteEngine, type RemoteOptions } from './remote'
import { assembleRun } from './assemble'
import { profilesetLines } from './options'
import { candidatesDone, parseProgressLine } from './progress'
import { characterBlocks, mergeCharacters } from './multi-actor'
import type { EngineVariant } from './capability'

export { characterBlocks, mergeCharacters }

export interface HybridOptions extends Omit<RemoteOptions, 'replayWorker' | 'onreplay'> {
  /** Threads a cloud job runs on (the plan's width); with the browser's own threads it sets each side's share. */
  cloudThreads: number
  /** Where each run goes, for the run panel: called when a run starts, and again if the cloud hands work back to this browser. */
  onplace?: (place: RunPlace) => void
  /** Where measured speeds persist on this device (localStorage by default). */
  speedStore?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Clock in milliseconds, for the speed measurements. */
  now?: () => number
}

/** What this device measured of its hybrid runs at one thread setting, as moving averages over recent runs. */
export interface HybridSpeed {
  /** This browser's seconds per piece over the cloud's, on pieces of the same run: above 1, the cloud is faster. */
  rel: number
  /** Seconds from the start until each side's engine reported progress: engine load here; queue, worker boot and upload there. */
  localWait: number
  cloudWait: number
  /** Seconds the cloud took to show progress beyond the server's own capacity estimate: upload, assembly, simc start-up. */
  cloudOverhead?: number
  /** This browser's seconds per piece, by split kind: sizes the waits against the run. */
  perPiece: Partial<Record<SplitKind, number>>
}

/** The account server's answer to "where would a job start now" (GET /api/v1/compute/capacity, queue.ts capacityView). */
export interface Capacity { state: 'warm' | 'booting' | 'cold' | 'queued' | 'none'; waitS?: number }

const CAPACITY = '/api/v1/compute/capacity'
/** A split waits at most this long for the capacity answer, then decides from past runs alone. */
const CAPACITY_TIMEOUT_MS = 1500
/** The cloud's own start-up beyond the server's estimate, until a run has measured it. */
const DEFAULT_OVERHEAD_S = 5

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

/** Seconds until the cloud share shows progress: the server's estimate plus the measured overhead, else the measured average. */
export function cloudWaitOf(speed: HybridSpeed | null | undefined, capacity: Capacity | null): number | undefined {
  if (capacity?.waitS !== undefined) return capacity.waitS + (speed?.cloudOverhead ?? DEFAULT_OVERHEAD_S)
  return speed?.cloudWait
}

/** One side of one finished hybrid run, in seconds: `wait` until its first progress, `run` from there to its report. */
export interface SideTiming { wait: number; run: number; pieces: number }

const SPEED_KEY = 'frostsim.hybrid.speed'
/** Weight of the newest run in the moving averages. */
const ALPHA = 0.4
/** Shorter runs are mostly polling and start-up noise, so they teach nothing. */
const MIN_RUN_S = 2

const speedKey = (localThreads: number, cloudThreads: number) => `${Math.max(1, localThreads)}/${cloudThreads}`

function readSpeeds(store: HybridOptions['speedStore']): Record<string, HybridSpeed> {
  try {
    return JSON.parse(store?.getItem(SPEED_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

/** The speed model after one more run, or `prev` when the run was too short to measure. `serverWait`: the capacity estimate the run
 *  started with, so the overhead beyond it is learned apart from boot and queue time. */
export function learnSpeed(prev: HybridSpeed | null, kind: SplitKind, local: SideTiming, cloud: SideTiming, serverWait?: number): HybridSpeed | null {
  if (!(local.run >= MIN_RUN_S && cloud.run >= MIN_RUN_S && local.pieces > 0 && cloud.pieces > 0)) return prev
  const here = local.run / local.pieces
  const rel = Math.min(50, Math.max(0.02, here / (cloud.run / cloud.pieces)))
  const mix = (was: number | undefined, now: number) => (was === undefined ? now : was + ALPHA * (now - was))
  return {
    rel: mix(prev?.rel, rel),
    localWait: mix(prev?.localWait, Math.max(0, local.wait)),
    cloudWait: mix(prev?.cloudWait, Math.max(0, cloud.wait)),
    ...(serverWait !== undefined ? { cloudOverhead: mix(prev?.cloudOverhead, Math.max(0, cloud.wait - serverWait)) }
      : prev?.cloudOverhead !== undefined ? { cloudOverhead: prev.cloudOverhead } : {}),
    perPiece: { ...prev?.perPiece, [kind]: mix(prev?.perPiece[kind], here) },
  }
}

/** What a run was split into. */
export type SplitKind = 'candidates' | 'characters' | 'stats'

/** Where a run is going, as the run panel says it. */
export interface RunPlace {
  mode: 'hybrid' | 'cloud' | 'browser'
  kind?: SplitKind
  /** Hybrid: each side's share, by count and, for characters and stats, by name. */
  here?: number
  there?: number
  hereNames?: string[]
  thereNames?: string[]
  /** Stat weights: stats both sides run, so each side's weights are normalized against its own measurement. */
  both?: string[]
  /** Why a hybrid choice runs whole in the cloud, or why the cloud handed work to this browser. */
  note?: string
}

const PRIMARY = new Set(['strength', 'agility', 'intellect'])
const SCALE_ONLY = /^\s*scale_only\s*=\s*(.*)$/

/** A stat weights run's stats (`scale_only`), and the ones both sides must run: the primary stats when weights are normalized. */
function scaleStats(extraOptions: readonly string[]): { stats: string[]; both: string[] } | null {
  if (!extraOptions.some((o) => /^\s*calculate_scale_factors\s*=\s*1\s*$/.test(o))) return null
  const listed = extraOptions.map((o) => SCALE_ONLY.exec(o)?.[1]).filter((v) => v !== undefined).at(-1)
  if (!listed) return null
  // Engine splits on ",:;/|" (scale_factor_control.cpp).
  const all = listed.split(/[,:;/|]/).map((v) => v.trim()).filter(Boolean)
  const normalized = extraOptions.some((o) => /^\s*normalize_scale_factors\b/.test(o))
  const both = normalized ? all.filter((v) => PRIMARY.has(v.toLowerCase())) : []
  return { stats: all.filter((v) => !both.includes(v)), both }
}

/** How a request splits into independent pieces, or null when it has fewer than two. Candidates win over characters. */
export function splitOf(req: SimRequest): { kind: SplitKind; pieces: number } | null {
  if ((req.profilesets?.length ?? 0) >= 2) return { kind: 'candidates', pieces: req.profilesets!.length }
  if (req.mode === 'raw' || req.profilesets?.length) return null
  const stats = scaleStats(req.extraOptions ?? [])
  if (stats) return stats.stats.length >= 2 ? { kind: 'stats', pieces: stats.stats.length } : null
  const characters = characterBlocks(req.profile).length
  return characters >= 2 ? { kind: 'characters', pieces: characters } : null
}

interface Sides {
  kind: SplitKind
  /** Pieces both sides run: a candidate run's baseline, or a normalized stat weights run's baseline and primary stat. */
  shared: number
  local: SimRequest
  cloud: SimRequest
  place: RunPlace
  /** This browser's start message from the controller's: the local share's profile and args. */
  localStart: (start: { profile: string; args: string[] }) => { profile: string; args: string[] }
}

/** The two halves of a split request: the browser gets the first `count - share` pieces, the cloud the rest. Either half can be
 *  empty when the measured speeds say one side alone finishes sooner. */
export function splitRequest(req: SimRequest, cloudThreads: number, speed?: HybridSpeed | null, cloudWait = speed?.cloudWait): Sides | null {
  const split = splitOf(req)
  if (!split) return null
  const shared = split.kind === 'candidates' ? 1 : split.kind === 'stats' ? 1 + scaleStats(req.extraOptions ?? [])!.both.length : 0
  const n = split.pieces - cloudShare(split.pieces, cloudThreads, req.settings.threads, speed, split.kind, shared, cloudWait)
  const sides = cut(req, split.kind, n)
  if (speed?.perPiece[split.kind]) sides.place.note = measuredNote(speed, cloudWait ?? speed.cloudWait)
  return { ...sides, shared }
}

function measuredNote(speed: HybridSpeed, cloudWait: number): string {
  const rel = speed.rel >= 1 ? `${speed.rel.toFixed(1)}× as fast as this PC` : `${(1 / speed.rel).toFixed(1)}× slower than this PC`
  return `Split by measured speed: Frostsim Cloud runs ${rel} and should start in about ${Math.round(cloudWait)} s.`
}

function cut(req: SimRequest, kind: SplitKind, n: number): Omit<Sides, 'shared'> {
  if (kind === 'candidates') {
    const sets = req.profilesets!
    const [mine, theirs] = [sets.slice(0, n), sets.slice(n)]
    const drop = new Set(profilesetLines(theirs))
    return {
      kind: 'candidates', local: { ...req, profilesets: mine }, cloud: { ...req, profilesets: theirs },
      place: { mode: 'hybrid', kind: 'candidates', here: mine.length, there: theirs.length },
      localStart: (start) => ({ ...start, profile: start.profile.split('\n').filter((l) => !drop.has(l)).join('\n') }),
    }
  }
  if (kind === 'characters') {
    const blocks = characterBlocks(req.profile)
    const [mine, theirs] = [blocks.slice(0, n), blocks.slice(n)]
    const local = { ...req, profile: mine.map((b) => b.text).join('\n') }
    return {
      kind: 'characters', local, cloud: { ...req, profile: theirs.map((b) => b.text).join('\n') },
      place: { mode: 'hybrid', kind: 'characters', here: mine.length, there: theirs.length, hereNames: mine.map((b) => b.name), thereNames: theirs.map((b) => b.name) },
      // The profile is independent of the thread ceiling; args stay the controller's own.
      localStart: (start) => ({ ...start, profile: assembleRun(local, Math.max(1, req.settings.threads)).profile }),
    }
  }
  const { stats, both } = scaleStats(req.extraOptions ?? [])!
  const [mine, theirs] = [stats.slice(0, n), stats.slice(n)]
  const withStats = (list: string[]) => (req.extraOptions ?? []).map((o) => (SCALE_ONLY.test(o) ? `scale_only=${[...both, ...list].join(',')}` : o))
  const localOptions = withStats(mine)
  return {
    kind: 'stats', local: { ...req, extraOptions: localOptions }, cloud: { ...req, extraOptions: withStats(theirs) },
    place: { mode: 'hybrid', kind: 'stats', here: mine.length, there: theirs.length, hereNames: mine, thereNames: theirs, both },
    // extraOptions become args in order (buildArgs), so the local args swap the one scale_only argument.
    localStart: (start) => ({ ...start, args: start.args.map((a) => (SCALE_ONLY.test(a) ? localOptions.find((o) => SCALE_ONLY.test(o))! : a)) }),
  }
}

/** How many of `count` pieces go to the cloud. Without measurements: by thread share, at least one each side. With them: the count
 *  with the earliest predicted finish, where `shared` pieces run on both sides; 0 when this browser alone is sooner, `count` when
 *  the cloud alone is. */
export function cloudShare(count: number, cloudThreads: number, localThreads: number, speed?: HybridSpeed | null, kind?: SplitKind, shared = 0,
  cloudWait = speed?.cloudWait): number {
  const p = kind ? speed?.perPiece[kind] : undefined
  if (!speed || !p) {
    const n = Math.round((count * cloudThreads) / (cloudThreads + Math.max(1, localThreads)))
    return Math.min(count - 1, Math.max(1, n))
  }
  // ponytail: one seconds-per-piece per kind, whatever the run's iterations or fight length.
  const wait = cloudWait ?? speed.cloudWait
  const finish = (n: number) => Math.max(
    n < count ? speed.localWait + (count - n + shared) * p : 0,
    n > 0 ? wait + ((n + shared) * p) / speed.rel : 0,
  )
  let best = 0
  for (let n = 1; n <= count; n++) if (finish(n) < finish(best)) best = n
  return best
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

/** A candidate run's progress record renumbered to the whole run: phase 1 is the baseline, then one per finished candidate. */
function renumber(line: string, done: number, total: number): string {
  const f = line.split('\t')
  const offset = f[1]?.trim() !== '' && Number.isFinite(Number(f[1])) ? 0 : 1
  f[offset + 1] = String(1 + done)
  f[offset + 2] = String(1 + total)
  return f.join('\t')
}

const WHOLE = 'Hybrid splits runs with two or more candidates, characters or stat weights; this one runs whole on Frostsim Cloud.'

/** Runs that split (splitOf) go both ways at once; everything else the cloud engine would take runs whole in the cloud. */
export function createHybridEngine(options: HybridOptions): RemoteEngine {
  const place = (p: RunPlace) => options.onplace?.(p)
  const store = options.speedStore === undefined ? globalThis.localStorage : options.speedStore
  const cloud = createRemoteEngine({
    ...options,
    onreplay: (reason) => place({ mode: 'browser', note: `Frostsim Cloud: ${reason}. This run moved to this PC.` }),
  })
  return (req, engineDir) => {
    const whole = cloud(req, engineDir)
    if (!whole) return whole
    const split = splitOf(req)
    // Asked as soon as the run is known, so the answer is usually in before the start message.
    const capacity = split ? fetchCapacity(options.fetch) : null
    const key = speedKey(req.settings.threads, options.cloudThreads)
    return (variant, dir) => {
      // The fallback build has no profilesets for a local share, and a run with one piece has nothing to split.
      if (!split || !capacity || (variant === 'fallback' && split.kind === 'candidates')) {
        place({ mode: 'cloud', note: split ? 'This browser cannot run profilesets, so the whole run is on Frostsim Cloud.' : WHOLE })
        return whole(variant, dir)
      }
      let answer: Capacity | null = null
      const decide = (cap: Capacity | null) => {
        const speed = readSpeeds(store)[key]
        const learn = (kind: SplitKind, local: SideTiming, cloud: SideTiming) => {
          const all = readSpeeds(store)
          const next = learnSpeed(all[key] ?? null, kind, local, cloud, cap?.waitS)
          if (!next) return
          try {
            store?.setItem(SPEED_KEY, JSON.stringify({ ...all, [key]: next }))
          } catch { /* Storage blocked: this run teaches nothing. */ }
        }
        if (cap?.state === 'none') {
          place({ mode: 'browser', note: 'Frostsim Cloud cannot take runs right now, so this one runs on this PC.' })
          return new Worker(engineWorkerUrl(variant, dir))
        }
        const sides = splitRequest(req, options.cloudThreads, speed, cloudWaitOf(speed, cap))!
        if (!sides.place.here) {
          place({ mode: 'cloud', note: 'Going by past runs, Frostsim Cloud alone finishes this run sooner than splitting it.' })
          return whole(variant, dir)
        }
        if (!sides.place.there) {
          place({ mode: 'browser', note: `Going by past runs, this PC alone finishes this run before Frostsim Cloud would start${cap?.state === 'cold' ? ' a server' : ''}. It uses none of your allowance.` })
          return new Worker(engineWorkerUrl(variant, dir))
        }
        place(sides.place)
        return new HybridWorker(req, sides, engineDir, variant, dir, options, learn) as unknown as Worker
      }
      // The start message waits (at most CAPACITY_TIMEOUT_MS) for the split; a cancel before then ends the run with nothing started.
      return new Later(() => decide(answer), (go) => void capacity.then((cap) => { answer = cap; go() })) as unknown as Worker
    }
  }
}

type Msg = Record<string, unknown> & { type?: string }

class HybridWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null

  private readonly local: Worker
  private readonly cloud: Worker
  /** Pieces each side runs, for renumbering candidate progress. */
  private readonly own: { local: number; cloud: number }
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
  private readonly now: () => number
  /** Milliseconds: the start, each side's first progress and its report. `cloudRan`: the cloud share ran there, not replayed here. */
  private t0 = 0
  private first: { local?: number; cloud?: number } = {}
  private ended: { local?: number; cloud?: number } = {}
  private cloudRan = false

  constructor(
    private readonly req: SimRequest,
    private readonly sides: Sides,
    engineDir: string,
    variant: EngineVariant,
    dir: string | undefined,
    options: HybridOptions,
    private readonly learn: (kind: SplitKind, local: SideTiming, cloud: SideTiming) => void,
  ) {
    this.now = options.now ?? (() => performance.now())
    this.own = { local: sides.place.here ?? 0, cloud: sides.place.there ?? 0 }
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
    const onreplay = (reason: string) => options.onplace?.({ ...sides.place,
      note: `Frostsim Cloud: ${reason}. Its share runs on this PC after this PC's share.` })
    this.cloud = createRemoteEngine({ ...options, replayWorker, onreplay })(sides.cloud, engineDir)!(variant, dir)
    this.cloud.onmessage = (e) => this.fromCloud(e.data as Msg)
    this.cloud.onerror = (e) => this.onerror?.(e)
  }

  postMessage(data: unknown): void {
    if ((data as Msg)?.type === 'cancel') {
      // Both engines already gone (both shares finished): confirm at once, or the controller waits out its grace and blocks the tab.
      if (!this.holding.size) return this.post({ protocol: WORKER_PROTOCOL, jobId: this.jobId, type: 'shutdown', reason: 'cancelled', threads: 0 })
      this.local.postMessage(data)
      this.cloud.postMessage(data)
      return
    }
    // The controller's start message: this browser runs its own share; the cloud assembles its share from its sub-request, and
    // its start message is kept only for a replay here, so it carries the cloud share's profile and args.
    const start = data as Msg & { profile: string; args: string[] }
    this.jobId = start.jobId
    this.t0 = this.now()
    this.local.postMessage(this.sides.localStart(start))
    const cloud = assembleRun(this.sides.cloud, Math.max(1, this.req.settings.threads))
    this.cloud.postMessage({ ...start, profile: cloud.profile, args: this.sides.kind === 'stats' ? cloudArgs(start.args, this.sides.cloud) : start.args })
  }

  terminate(): void {
    this.dead = true
    this.local.terminate()
    this.cloud.terminate()
  }

  private post(msg: Msg): void {
    if (!this.dead) this.onmessage?.({ data: msg } as MessageEvent)
  }

  /** Progress lines from the side still running (the browser first); a candidate run's are renumbered to the whole run. */
  private progress(side: 'local' | 'cloud', msg: Msg): Msg | null {
    const lines = Array.isArray(msg.lines) ? (msg.lines as string[]) : []
    if (this.first[side] === undefined && lines.some((l) => parseProgressLine(l))) this.first[side] = this.now()
    const own = this.own[side]
    const shown = side === 'local' || this.reports.local !== undefined
    if (this.sides.kind !== 'candidates') return shown ? msg : null
    const out: string[] = []
    for (const line of lines) {
      const p = parseProgressLine(line)
      if (!p) {
        if (side === 'local') out.push(line)
        continue
      }
      this.done[side] = candidatesDone(p, own)
      if (shown && line.includes('\t')) out.push(renumber(line, this.done.local + this.done.cloud, this.own.local + this.own.cloud))
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
        this.ended.local = this.now()
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
        this.ended.cloud = this.now()
        this.cloudRan = msg.placement === 'cloud'
        // The report first, then the shutdown, as every engine answers: a role sequence starts its next group on both.
        this.finish(msg)
        // A cloud run holds no browser engine; a replay here confirms its own shutdown after done.
        if (msg.placement === 'cloud') this.release('cloud', 0)
        return
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
      report = this.sides.kind === 'candidates' ? mergeProfilesets(local, cloud)
        : this.sides.kind === 'characters' ? mergeCharacters(local, cloud)
          : mergeStats(local, cloud, [...(this.sides.place.both ?? []), ...(this.sides.place.hereNames ?? []), ...(this.sides.place.thereNames ?? [])])
    } catch {
      return this.post({ ...msg, type: 'error', code: 'report-missing', message: 'the two halves of a hybrid run could not be merged' })
    }
    if (this.cloudRan) this.learn(this.sides.kind, this.timing('local'), this.timing('cloud'))
    // No placement: job.ts then keeps this browser's own assembly of the whole request as the effective profile.
    this.post({ protocol: WORKER_PROTOCOL, jobId: msg.jobId, type: 'done', report })
  }

  /** One side's measured run; a side that showed no progress counts as having started at once. */
  private timing(side: 'local' | 'cloud'): SideTiming {
    const first = this.first[side] ?? this.t0
    return { wait: (first - this.t0) / 1000, run: ((this.ended[side] ?? first) - first) / 1000, pieces: this.own[side] + this.sides.shared }
  }
}

/** The controller's args with the cloud share's scale_only in place of the whole run's. */
function cloudArgs(args: string[], cloud: SimRequest): string[] {
  const own = (cloud.extraOptions ?? []).find((o) => SCALE_ONLY.test(o))
  return own ? args.map((a) => (SCALE_ONLY.test(a) ? own : a)) : args
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
