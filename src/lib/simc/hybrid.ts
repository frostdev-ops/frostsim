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
import { CLASS_LABELS } from '../import/character'
import type { EngineVariant } from './capability'

export interface HybridOptions extends Omit<RemoteOptions, 'replayWorker' | 'onreplay'> {
  /** Threads a cloud job runs on (the plan's width); with the browser's own threads it sets each side's share. */
  cloudThreads: number
  /** Where each run goes, for the run panel: called when a run starts, and again if the cloud hands work back to this browser. */
  onplace?: (place: RunPlace) => void
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
const CLASS_LINE = /^\s*(\w+)\s*=\s*"?([^"\r\n]*)"?\s*$/

/** Character blocks of a guided profile, each from its class line to the next; lines before the first class line go with it. */
export function characterBlocks(profile: string): { name: string; text: string }[] {
  const blocks: { name: string; lines: string[] }[] = []
  let lead: string[] = []
  for (const line of profile.split('\n')) {
    const m = CLASS_LINE.exec(line)
    if (m && Object.hasOwn(CLASS_LABELS, m[1].toLowerCase())) {
      blocks.push({ name: m[2] || m[1], lines: [...lead, line] })
      lead = []
    } else if (blocks.length) blocks[blocks.length - 1].lines.push(line)
    else lead.push(line)
  }
  return blocks.map((b) => ({ name: b.name, text: b.lines.join('\n') }))
}

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
  local: SimRequest
  cloud: SimRequest
  place: RunPlace
  /** This browser's start message from the controller's: the local share's profile and args. */
  localStart: (start: { profile: string; args: string[] }) => { profile: string; args: string[] }
}

/** The two halves of a split request: the browser gets the first `count - share` pieces, the cloud the rest. */
export function splitRequest(req: SimRequest, cloudThreads: number): Sides | null {
  const split = splitOf(req)
  if (!split) return null
  const n = split.pieces - cloudShare(split.pieces, cloudThreads, req.settings.threads)
  if (split.kind === 'candidates') {
    const sets = req.profilesets!
    const [mine, theirs] = [sets.slice(0, n), sets.slice(n)]
    const drop = new Set(profilesetLines(theirs))
    return {
      kind: 'candidates', local: { ...req, profilesets: mine }, cloud: { ...req, profilesets: theirs },
      place: { mode: 'hybrid', kind: 'candidates', here: mine.length, there: theirs.length },
      localStart: (start) => ({ ...start, profile: start.profile.split('\n').filter((l) => !drop.has(l)).join('\n') }),
    }
  }
  if (split.kind === 'characters') {
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

/** How many of `count` candidates go to the cloud: by thread share, at least one each side. */
export function cloudShare(count: number, cloudThreads: number, localThreads: number): number {
  // ponytail: a fixed split by thread count ignores cloud queue/boot time; a cold server makes the browser side wait at the end.
  const n = Math.round((count * cloudThreads) / (cloudThreads + Math.max(1, localThreads)))
  return Math.min(count - 1, Math.max(1, n))
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

/** The local report with the cloud's characters appended after its own (the first character, the main one, is always local). */
export function mergeCharacters(local: ArrayBuffer, cloud: ArrayBuffer): ArrayBuffer {
  const merged = decode(local)
  merged.sim.players.push(...(decode(cloud).sim.players ?? []))
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
  const cloud = createRemoteEngine({
    ...options,
    onreplay: (reason) => place({ mode: 'browser', note: `Frostsim Cloud: ${reason}. This run moved to this PC.` }),
  })
  return (req, engineDir) => {
    const whole = cloud(req, engineDir)
    if (!whole) return whole
    const sides = splitRequest(req, options.cloudThreads)
    return (variant, dir) => {
      // The fallback build has no profilesets for a local share, and a run with one piece has nothing to split.
      if (!sides || (variant === 'fallback' && sides.kind === 'candidates')) {
        place({ mode: 'cloud', note: sides ? 'This browser cannot run profilesets, so the whole run is on Frostsim Cloud.' : WHOLE })
        return whole(variant, dir)
      }
      place(sides.place)
      return new HybridWorker(req, sides, engineDir, variant, dir, options) as unknown as Worker
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

  constructor(
    private readonly req: SimRequest,
    private readonly sides: Sides,
    engineDir: string,
    variant: EngineVariant,
    dir: string | undefined,
    options: HybridOptions,
  ) {
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
      this.local.postMessage(data)
      this.cloud.postMessage(data)
      return
    }
    // The controller's start message: this browser runs its own share; the cloud assembles its share from its sub-request, and
    // its start message is kept only for a replay here, so it carries the cloud share's profile and args.
    const start = data as Msg & { profile: string; args: string[] }
    this.jobId = start.jobId
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
      report = this.sides.kind === 'candidates' ? mergeProfilesets(local, cloud)
        : this.sides.kind === 'characters' ? mergeCharacters(local, cloud)
          : mergeStats(local, cloud, [...(this.sides.place.both ?? []), ...(this.sides.place.hereNames ?? []), ...(this.sides.place.thereNames ?? [])])
    } catch {
      return this.post({ ...msg, type: 'error', code: 'report-missing', message: 'the two halves of a hybrid run could not be merged' })
    }
    // No placement: job.ts then keeps this browser's own assembly of the whole request as the effective profile.
    this.post({ protocol: WORKER_PROTOCOL, jobId: msg.jobId, type: 'done', report })
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
