// Browser job controller: one sim, one state machine, one settlement (P01.1-P01.3, P01.12). All terminal paths go through finish().

import {
  PROFILE_PATH,
  REPORT_PATH,
  HTML_REPORT_PATH,
  type ValidationIssue,
} from './options'
import { assembleRun, validateRequest, type JobLimits, type SimRequest } from './assemble'
import { parseEngineNotice, profilesetStatus, type ReportLog, type SimReport } from './report'
import {
  detectEngineCapability,
  engineIdentity,
  type EngineCapability,
  type EngineVariant,
} from './capability'
import type { ReportWorkerRequest, ReportWorkerResponse } from './report-worker'
import type { PlayerDetail } from './detail'
import { candidatesDone, latestProgress, type EngineProgress } from './progress'
import { acquireEngineSlot, type EngineSlot } from '../engine-budget'
import { roleGroups, roleNote } from './role-share'
import { SequenceWorker } from './sequence-worker'

/** Engine worker message protocol; bump it and public/engine/sim-worker.js together. */
export const WORKER_PROTOCOL = 1

/** simc's own wording when a script declares no actor (sim.cpp:4363). */
const NOTHING_TO_SIM = 'Nothing to sim!'

/** simc calls setpriority which emscripten's stub always rejects with -EPERM; harmless noise matched by perror prefix (patches/0002-emscripten-no-process-priority.patch pending). */
const PRIORITY_NOISE = /^Could not set process priority\./

/** Served from public/engine; emscripten derives wasm and pthread worker paths from this URL (D10). */
export const ENGINE_WORKER_URL = '/engine/sim-worker.js'

/**
 * One worker file boots either artifact; the query string picks which, because
 * importScripts has to run before any message arrives.
 */
export function engineWorkerUrl(variant: EngineVariant, engineDir?: string): string {
  // Version the shim independently so a cached pre-update worker does not survive app reload.
  const base = engineDir?.replace(/fallback\/$/, '') ?? '/engine/'
  return `${base}sim-worker.js?${variant === 'fallback' ? 'variant=fallback&' : ''}worker=3`
}

export type JobState =
  | 'validating'
  /** Another tab holds the engine; waiting, not stuck. */
  | 'queued'
  | 'acquiring'
  | 'initializing'
  | 'running'
  | 'analyzing'
  | 'complete'
  | 'error'
  | 'cancelled'

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['complete', 'error', 'cancelled'])

/** Asset bytes, iteration counts and optimizer stages are distinct (P01.1). */
export interface JobProgress {
  kind: 'assets' | 'iterations' | 'stage'
  done: number
  total?: number
  label?: string
}

export interface JobEvent {
  jobId: string
  state: JobState
  /** Iteration progress within the current phase, or asset bytes while acquiring. */
  progress?: JobProgress
  /** Candidate progress across a profileset run: how many finished. */
  stage?: JobProgress
  /** The whole parsed progress line (running mean, error estimate, time remaining). */
  engineProgress?: EngineProgress
  /** Batched engine output, bounded frequency. */
  log?: string[]
  /** Never dropped, even when log lines are truncated. */
  warning?: string
}

// Request shape, validation and assembly live in assemble.ts so the account server can bundle them (CLAUDE.md D14).
export { validateRequest, type JobLimits, type SimRequest } from './assemble'

/** Grace period for engine worker to reap pthreads from inside print callback before blind terminate; generous to avoid orphaning threads. */
const THREAD_REAP_GRACE_MS = 15_000

export const DEFAULT_LIMITS: Required<JobLimits> = {
  initTimeoutMs: 180_000,
  deadlineMs: 30 * 60_000,
  stallTimeoutMs: 180_000,
}

/** A cloud run reaches `ready` only after queue and server boot, then may still replay here with its own 180 s load (remote.ts gives up waiting 150 s after the start message). */
const REMOTE_INIT_TIMEOUT_MS = 360_000

/** Cloud engine factory for one request on this engine folder (its pack id), or null to run in this browser; must not submit anything itself (CLAUDE.md D14). */
export type RemoteEngine = (req: SimRequest, engineDir: string) => ((variant: EngineVariant, engineDir?: string) => Worker) | null

let remoteEngine: RemoteEngine | null = null

/** Registered by account code after sign-in, so anonymous use never loads any of it (CLAUDE.md D14). */
export function setRemoteEngine(fn: RemoteEngine | null): void {
  remoteEngine = fn
}

export interface SimOutcome {
  jobId: string
  /** The frozen snapshot the run actually used. */
  request: SimRequest
  report: SimReport
  /** Which requested profileset ids came back vs were dropped. */
  profilesetStatus: { completed: string[]; missing: string[] }
  /** Options neutralised out of the pasted profile. */
  inputWarnings: string[]
  /** Wall clock for the whole job, kept apart from engine's elapsed time. */
  appElapsedSeconds: number
  /** Engine + game data identity for cache keys and provenance. */
  engineIdentity: string
  /** Everything engine wrote to stderr; only place profileset candidate problems appear (child sims keep own list). */
  engineNotices: ReportLog[]
  /** Exact profile text and arguments given to engine; not a reconstruction from MEMFS (reflects sanitizeProfile comments). */
  effectiveProfile: string
  effectiveArgs: readonly string[]
  /** Where the engine ran; a cloud run that replayed here says 'browser'. Optional because saved reports rebuild outcomes without it. */
  placement?: 'browser' | 'cloud'
  /** Raw report bytes, never parsed on main thread; export only. */
  getRawJson(): Blob
  /** simc's HTML report (null if not requested or engine failed to write); UNTRUSTED: unescaped user content, safe only for viewers. */
  getHtmlReport(): Blob | null
}

export class SimValidationError extends Error {
  readonly issues: ValidationIssue[]
  constructor(issues: ValidationIssue[]) {
    super(`invalid simulation request: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`)
    this.name = 'SimValidationError'
    this.issues = issues
  }
}

export class SimEngineError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SimEngineError'
    this.code = code
  }
}

export type TimeoutPhase = 'initializing' | 'deadline' | 'stalled'

const TIMEOUT_MESSAGE: Record<TimeoutPhase, (seconds: number, at: JobState) => string> = {
  initializing: (s) => `the engine did not finish loading within ${s}s`,
  deadline: (s) => `the run passed its ${s}s deadline and was stopped`,
  // Peak memory is 1.5-2.7 GB per instance regardless of iterations/threads; no setting lever exists.
  stalled: (s, at) =>
    `suspected stall while ${at}: nothing was heard from the engine for ${s}s, so the run was stopped and its worker released. The most likely cause is the browser ending the worker because the tab ran out of memory — one engine run needs 1.5-2.7 GB whatever its settings — but a stall is not proof of that. Closing other tabs, or running one simulation at a time, gives it more room.`,
}

export class SimTimeoutError extends Error {
  readonly phase: TimeoutPhase
  /** The job state the timeout fired in. */
  readonly at: JobState
  constructor(phase: TimeoutPhase, ms: number, at: JobState = 'running') {
    super(TIMEOUT_MESSAGE[phase](Math.round(ms / 1000), at))
    this.name = 'SimTimeoutError'
    this.phase = phase
    this.at = at
  }
}

/** Cancellation is an AbortError, so `err.name === 'AbortError'` is enough to detect it. */
export function cancellation(reason = 'The simulation was cancelled.'): DOMException {
  return new DOMException(reason, 'AbortError')
}

export interface RunHandle {
  readonly jobId: string
  /** Settles exactly once; rejects with AbortError when cancelled. */
  readonly result: Promise<SimOutcome>
  readonly state: JobState
  cancel(reason?: string): void
}

/** Injection seam for tests; nothing here reaches for a global worker constructor. */
export interface JobDeps {
  createEngineWorker?: (variant: EngineVariant, engineDir?: string) => Worker
  createReportWorker?: () => Worker
  capability?: EngineCapability | (() => Promise<EngineCapability>)
  now?: () => number
  /** Milliseconds engine worker gets to reap pthreads before blind terminate; 0 orphans threads (tests only). */
  threadReapGraceMs?: number
}

const defaultDeps: Required<Pick<JobDeps, 'createEngineWorker' | 'createReportWorker' | 'now'>> = {
  createEngineWorker: (variant, engineDir) => new Worker(engineWorkerUrl(variant, engineDir)),
  createReportWorker: () => new Worker(new URL('./report-worker.ts', import.meta.url), { type: 'module' }),
  now: () => Date.now(),
}

/** Compiled WebAssembly.Module cached between runs (D5); instance must be fresh per run (dbc::init is global). Bounded to one entry keyed by artifact sha256. */
let compiledEngine: { sha256: string; module: WebAssembly.Module } | null = null

/** Forget the compiled engine. For tests and for a deliberate engine change. */
export function clearCompiledEngine(): void {
  compiledEngine = null
}

/** What worker needs to fetch/verify/cache binary; omitted when manifest has no simc.wasm (emscripten does own fetch). */
function engineAsset(
  capability: Extract<EngineCapability, { ok: true }>,
): { wasmUrl: string; sha256?: string; bytes?: number } | undefined {
  const file = capability.manifest.files?.['simc.wasm']
  if (!file) return undefined
  return { wasmUrl: `${capability.engineDir}simc.wasm`, sha256: file.sha256, bytes: file.bytes }
}

/** One engine job at a time per tab: needs ~1.8 GB regardless of settings; second instance cannot fit. Fail fast, not queue. */
/** Opaque token (not jobId) to prevent teardown releasing wrong job's slot; unique per call by construction. */
let activeToken: object | null = null
let activeCancel: ((reason?: string) => void) | null = null

/** Last job's worker shutdown report: reapRequested (inside wasm frame) vs confirmed (outside callMain). confirmed:false means blind terminate, threads may orphan. */
export interface ThreadReap {
  jobId: string
  threads: number
  reapRequested: boolean
  confirmed: boolean
  /** The worker's own word for why it stopped, when it got far enough to say. */
  reason?: string
}

let lastReap: ThreadReap | null = null
let stoppingToken: object | null = null

/** A known job is releasing its workers; this is not an orphaned simulation. */
export function engineStopping(): boolean {
  return activeToken !== null && stoppingToken === activeToken
}

/** Whether runtime may start another engine; separate from engineBusy(). Blocks the ENGINE when teardown not confirmed (pthreads may orphan). Recoverable by reload only. */
export type EngineAvailability =
  | { available: true }
  | {
      available: false
      reason: 'reload-required'
      detail: string
      /** The job whose teardown could not be confirmed. */
      jobId: string
      /** When it was blocked, so a UI can say how long ago. */
      since: number
    }

let blocked: Extract<EngineAvailability, { available: false }> | null = null

export function engineAvailability(): EngineAvailability {
  return blocked ?? { available: true }
}

/** Only confirmed shutdown or fresh page clears this. Never on a timer (arbitrary delay is not proof of stop). */
/** Stands in for fresh page; NOT re-exported from client.ts to prevent clearing without new runtime. Tests use directly. */
export function __resetEngineRuntimeForTests(): void {
  blocked = null
  lastReap = null
  stoppingToken = null
  compiledEngine = null
}

function blockEngine(jobId: string, detail: string): void {
  blocked = { available: false, reason: 'reload-required', detail, jobId, since: Date.now() }
}

export function lastThreadReap(): ThreadReap | null {
  return lastReap
}

/** engineNotices of last completed run; answers whether engine's stderr reaches page in browser (only evidence: stream:err batches). */
export function lastEngineNotices(): readonly ReportLog[] {
  return lastNotices
}

let lastNotices: readonly ReportLog[] = []

// Expose reap/notices in DEV for console debugging (pthread workers invisible to page-level wrapper).
if (import.meta.env?.DEV) {
  Object.defineProperty(globalThis, '__frostsimEngine', {
    value: { lastThreadReap, lastEngineNotices, engineBusy, cancelActiveJob },
    configurable: true,
  })
}

/** Whether an engine job currently holds the tab's budget. */
export function engineBusy(): boolean {
  return activeToken !== null
}

/** Stop running sim without its handle (screen torn down, abandoned search); returns whether anything was cancelled. */
export function cancelActiveJob(reason = 'The running simulation was stopped.'): boolean {
  const cancel = activeCancel
  if (!cancel) return false
  cancel(reason)
  return true
}

function newJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `job-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

function freeze<T>(value: T): T {
  const clone = typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
  const seen = new WeakSet<object>()
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v as object)) return
    seen.add(v as object)
    Object.freeze(v)
    for (const key of Object.keys(v as object)) walk((v as Record<string, unknown>)[key])
  }
  walk(clone)
  return clone
}

export function runJob(request: SimRequest, onEvent?: (e: JobEvent) => void, deps: JobDeps = {}): RunHandle {
  const createReportWorker = deps.createReportWorker ?? defaultDeps.createReportWorker
  const now = deps.now ?? defaultDeps.now
  const graceMs = deps.threadReapGraceMs ?? THREAD_REAP_GRACE_MS

  const jobId = request?.jobId ?? newJobId()
  /** This call's claim on the tab's single engine slot. Never the jobId; see activeToken. */
  const token = {}
  const startedAt = now()
  /**
   * Shared with the engine worker so a cancel can reach it while `callMain`
   * blocks its event loop. Absent without cross-origin isolation — which is
   * also when there are no pthreads to orphan, since that build is
   * single-threaded.
   */
  const cancelFlag = typeof SharedArrayBuffer !== 'undefined' ? new Int32Array(new SharedArrayBuffer(4)) : null
  /** Set once the capability is known; only a threaded artifact has a pool to lose. */
  let threadedArtifact = false
  let shutdownConfirmed = false

  let state: JobState = 'validating'
  let settled = false
  let engineWorker: Worker | null = null
  let reportWorker: Worker | null = null
  let initTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let stallMs = DEFAULT_LIMITS.stallTimeoutMs
  let lastMessageAt = startedAt
  /** Held from just before the worker starts until the engine confirms it stopped. */
  let slot: EngineSlot | null = null
  const slotAbort = new AbortController()
  /** Set once the engine has emitted a progress line, proving this run talks. */
  let sawProgress = false
  /** simc's HTML report, when the run asked for one and the engine wrote it. */
  let htmlReportBytes: ArrayBuffer | null = null
  let placement: 'browser' | 'cloud' = 'browser'
  /** The engine said the script declared no actor. See the log handler. */
  let sawNothingToSim = false
  let lastEngineError = ''
  /** Exactly what went to the engine, kept for the outcome. */
  let effectiveProfile = ''
  let effectiveArgs: readonly string[] = []
  let finishing = false
  let resolveResult!: (outcome: SimOutcome) => void
  let rejectResult!: (err: unknown) => void
  let inputWarnings: string[] = []
  /** This browser's thread clamp notice; a cloud run picks its own threads, so it never applied there. */
  let clampWarning: string | undefined
  /** Classified notices from the engine's stderr, including ones the report drops. */
  const engineNotices: ReportLog[] = []

  const result = new Promise<SimOutcome>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  function emit(next: JobState, extra: Omit<JobEvent, 'jobId' | 'state'> = {}): void {
    if (TERMINAL.has(state) && next !== state) return
    const changed = state !== next
    state = next
    // Silence means different things per state; re-arm watchdog against the new one.
    if (changed && !settled) armStall()
    try {
      onEvent?.({ jobId, state: next, ...extra })
    } catch {
      // A listener that throws must not take the run down with it.
    }
  }

  /** How long silence is allowed per state, or null if silence is legitimate (deadline is only net). Stall is not death: armed only once progress seen in running. */
  function stallWindow(): number | null {
    switch (state) {
      case 'acquiring':
        return stallMs
      case 'initializing':
        return stallMs * 2
      case 'running':
        return sawProgress ? stallMs : null
      case 'analyzing':
        return stallMs
      default:
        return null
    }
  }

  /** Restarted by every worker message; silent death stops resetting it. Timers re-check elapsed time (background tabs throttle). */
  function heartbeat(): void {
    if (settled) return
    lastMessageAt = now()
    armStall()
  }

  function armStall(): void {
    clearTimeout(stallTimer)
    stallTimer = undefined
    const window = stallWindow()
    if (window === null) return
    const elapsed = now() - lastMessageAt
    if (elapsed >= window) {
      fail(new SimTimeoutError('stalled', window, state))
      return
    }
    stallTimer = setTimeout(armStall, window - elapsed)
  }

  /** Ask engine worker to reap pthreads before terminate (shared memory signal only channel to blocked callMain). Promise settles immediately. */
  function releaseBudget(): void {
    if (stoppingToken === token) stoppingToken = null
    if (activeToken === token) {
      activeToken = null
      activeCancel = null
    }
    // Cross-tab slot released here after engine confirms it stopped, not before promise; early release lets second engine start on top of still-held memory.
    slot?.release()
    slot = null
    slotAbort.abort()
  }

  /** Returns true when reap is in flight (owns releasing budget). Budget tracks ENGINE not promise; until really gone holds ~2 GB. */
  function reapThreads(): boolean {
    const worker = engineWorker
    // Only threaded artifact spawns pthreads and can orphan them; fallback has none.
    if (shutdownConfirmed || !threadedArtifact || !cancelFlag || !worker || graceMs <= 0) return false
    stoppingToken = token
    Atomics.store(cancelFlag, 0, 1)
    engineWorker = null // cleanup must not terminate it before the grace elapses
    worker.onerror = null
    worker.onmessageerror = null

    lastReap = { jobId, threads: 0, reapRequested: false, confirmed: false }

    let done = false
    const finish = () => {
      if (done) return
      done = true
      worker.onmessage = null
      worker.terminate()
      releaseBudget()
    }

    // Only shutdown ends wait; reaping is progress not completion (sent from inside callMain).
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (msg?.protocol !== WORKER_PROTOCOL || msg.jobId !== jobId) return
      if (msg.type === 'reaping') {
        lastReap = { jobId, threads: Number(msg.threads) || 0, reapRequested: true, confirmed: false }
        return
      }
      if (msg.type === 'shutdown') {
        // Confirmed shutdown clears block (only other thing that can: fresh runtime).
        if (blocked?.jobId === jobId) blocked = null
        lastReap = {
          jobId,
          threads: Number(msg.threads) || lastReap?.threads || 0,
          reapRequested: true,
          confirmed: true,
          reason: typeof msg.reason === 'string' ? msg.reason : undefined,
        }
        finish()
      }
    }

    // Wake async acquisition; during callMain shared flag read by worker's clock/print callbacks.
    try { worker.postMessage({ protocol: WORKER_PROTOCOL, jobId, type: 'cancel' }) } catch { /* retain bounded shutdown wait */ }

    // Bounded unknown: terminate blind but don't pretend clean or give next run slot while threads may be alive.
    setTimeout(() => {
      if (!done && !lastReap?.confirmed) {
        blockEngine(
          jobId,
          'A simulation could not be shut down cleanly, so parts of the engine may still be running in the background. Reload the page before simulating again — export anything you want to keep first.',
        )
      }
      finish()
    }, graceMs)
    return true
  }

  function cleanup(): void {
    // Reap in flight owns budget until worker really gone.
    if (!reapThreads()) releaseBudget()
    clearTimeout(initTimer)
    clearTimeout(deadlineTimer)
    clearTimeout(stallTimer)
    if (engineWorker) {
      engineWorker.onmessage = null
      engineWorker.onerror = null
      engineWorker.onmessageerror = null
      // simc has no in-process cancel; worker terminate is the cancel.
      engineWorker.terminate()
      engineWorker = null
    }
    if (reportWorker) {
      reportWorker.onmessage = null
      reportWorker.onerror = null
      reportWorker.terminate()
      reportWorker = null
    }
  }

  function fail(err: unknown, terminal: 'error' | 'cancelled' = 'error'): void {
    if (settled) return
    settled = true
    cleanup()
    emit(terminal)
    rejectResult(err)
  }

  function succeed(outcome: SimOutcome): void {
    if (settled) return
    settled = true
    cleanup()
    emit('complete')
    resolveResult(outcome)
  }

  // --- validate -----------------------------------------------------------

  const snapshot = (() => {
    try {
      return freeze({ ...request, jobId })
    } catch (err) {
      fail(new SimValidationError([{ field: 'request', message: `request is not cloneable: ${err}` }]))
      return null
    }
  })()

  if (snapshot) {
    const availability = engineAvailability()
    if (!availability.available) {
      // Before any worker is constructed: a second engine on top of threads we
      // could not account for is the accumulation this state exists to prevent.
      fail(new SimEngineError('engine-reload-required', availability.detail))
    } else if (activeToken !== null) {
      fail(
        new SimEngineError(
          'engine-busy',
          'Another simulation is already running in this tab. One engine run needs around 2 GB, so a second one cannot start alongside it — wait for it, or cancel it first.',
        ),
      )
    } else {
      activeToken = token
      activeCancel = (reason) => fail(cancellation(reason), 'cancelled')
      void start(snapshot)
    }
  }

  async function start(whole: SimRequest): Promise<void> {
    try {
      emit('validating')
      // A Dungeon Route compare with tanks or healers runs each role as its own sim (role-share.ts); one role group is just the
      // request with its route health scaled.
      const groups = roleGroups(whole)
      const req = groups?.length === 1 ? groups[0].request : whole

      const capability = await resolveCapability()
      if (settled) return
      if (!capability.ok) {
        throw new SimEngineError(capability.reason, capability.detail)
      }

      threadedArtifact = capability.artifact === 'threaded' && capability.manifest.capabilities.threads === true

      // On the frozen request after the local check; the cloud fake submits only on the start message, so refused runs cost nothing.
      const remote = deps.createEngineWorker ? null : remoteEngine?.(req, capability.engineDir) ?? null

      const issues = validateRequest(req, capability.maxThreads)
      if (issues.length) throw new SimValidationError(issues)

      const requestedIds = (req.profilesets ?? []).map((p) => p.id)
      // A cloud run has profilesets; remote.ts refuses them itself if it has to replay on this build.
      if (requestedIds.length && !capability.profilesets && !remote) {
        throw new SimEngineError(
          'profilesets-unsupported',
          'This engine build has no profileset support, so multi-candidate runs cannot run on it.',
        )
      }

      // Pool ceiling from artifact not request; warnings in one synchronous loop keep the old event order.
      const { profile: profileText, args, warnings, threads } = assembleRun(req, capability.maxThreads)
      inputWarnings = groups ? [...warnings, roleNote(groups)] : warnings
      // assembleRun puts the clamp first.
      if (threads !== req.settings.threads) clampWarning = warnings[0]
      for (const warning of inputWarnings) emit(state, { warning })
      const starts = groups && groups.length > 1 ? groups.map((g) => assembleRun(g.request, capability.maxThreads)) : null
      effectiveProfile = starts ? starts.map((g, i) => `# Frostsim role group ${i + 1} of ${starts.length}\n${g.profile}`).join('\n\n') : profileText
      effectiveArgs = args

      const limits = { ...DEFAULT_LIMITS, ...(remote ? { initTimeoutMs: REMOTE_INIT_TIMEOUT_MS } : {}), ...req.limits }
      stallMs = limits.stallTimeoutMs

      // Cross-tab exclusion after validation so invalid request never takes waiting slot.
      const acquired = await acquireEngineSlot({
        signal: slotAbort.signal,
        onWaiting: () => emit('queued'),
      })
      if (settled) {
        // Cancelled while queueing, acquisition won race.
        acquired.release()
        return
      }
      slot = acquired

      emit('acquiring')
      const engineFor = (r: SimRequest) => deps.createEngineWorker ?? (remote ? remoteEngine?.(r, capability.engineDir) : null) ?? defaultDeps.createEngineWorker
      engineWorker = starts
        ? new SequenceWorker(starts, (i) => engineFor(groups![i].request)(capability.artifact, capability.engineDir)) as unknown as Worker
        : (deps.createEngineWorker ?? remote ?? defaultDeps.createEngineWorker)(capability.artifact, capability.engineDir)
      wireEngineWorker(req, requestedIds, capability)
      armTimers(limits)

      // Stay in acquiring until worker says bytes in hand; download dominates cold start.
      heartbeat()
      engineWorker.postMessage({
        protocol: WORKER_PROTOCOL,
        jobId,
        profile: profileText,
        args,
        profilePath: PROFILE_PATH,
        reportPath: REPORT_PATH,
        htmlPath: req.htmlReport ? HTML_REPORT_PATH : undefined,
        engine: engineAsset(capability),
        cancelFlag: cancelFlag?.buffer,
        // Only when it is the same artifact: the key is the binary's own hash.
        compiledModule:
          compiledEngine && compiledEngine.sha256 === engineAsset(capability)?.sha256
            ? compiledEngine.module
            : undefined,
      })
    } catch (err) {
      fail(err)
    }
  }

  /** Load time and whole-run deadline for the engine starting now; a cloud replay starts this browser's engine afresh. */
  function armTimers(limits: Required<JobLimits>): void {
    clearTimeout(deadlineTimer)
    clearTimeout(initTimer)
    deadlineTimer = setTimeout(() => fail(new SimTimeoutError('deadline', limits.deadlineMs)), limits.deadlineMs)
    initTimer = setTimeout(() => fail(new SimTimeoutError('initializing', limits.initTimeoutMs)), limits.initTimeoutMs)
  }

  async function resolveCapability(): Promise<EngineCapability> {
    if (typeof deps.capability === 'function') return deps.capability()
    if (deps.capability) return deps.capability
    return detectEngineCapability()
  }

  function wireEngineWorker(
    req: SimRequest,
    requestedIds: string[],
    capability: Extract<EngineCapability, { ok: true }>,
  ): void {
    const worker = engineWorker!

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      // P01.3: ignore messages from other jobs.
      if (!msg || msg.protocol !== WORKER_PROTOCOL || msg.jobId !== jobId || settled) return
      heartbeat()

      switch (msg.type) {
        case 'shutdown':
          shutdownConfirmed = true
          lastReap = { jobId, threads: Number(msg.threads) || 0, reapRequested: true, confirmed: true, reason: typeof msg.reason === 'string' ? msg.reason : undefined }
          return
        case 'assets':
          emit(state, {
            progress: {
              kind: 'assets',
              done: Number(msg.loaded) || 0,
              // Absent under compression.
              total: typeof msg.total === 'number' ? msg.total : undefined,
              label: msg.cached ? 'cached' : 'downloading',
            },
          })
          return

        case 'compiled': {
          // Worker compiled binary; keep module so next run skips download and compile.
          const sha256 = engineAsset(capability)?.sha256
          if (sha256 && msg.module instanceof WebAssembly.Module) {
            compiledEngine = { sha256, module: msg.module }
          }
          return
        }

        case 'initializing':
          emit('initializing')
          return

        case 'replaying':
          // remote.ts handed the run to this browser's engine, however late: a local load and deadline from now, and only its own progress arms the running stall.
          sawProgress = false
          armTimers({ ...DEFAULT_LIMITS, ...req.limits })
          return

        case 'ready':
          clearTimeout(initTimer)
          initTimer = undefined
          emit('running')
          return

        case 'log': {
          const lines: string[] = Array.isArray(msg.lines) ? msg.lines : []
          for (const line of lines) if (line.startsWith('Error:')) lastEngineError = line.slice(0, 2000)
          if (msg.stream === 'err') {
            for (const line of lines) {
              // Dropped before classification; worker still posts so raw stream unchanged.
              if (PRIORITY_NOISE.test(line.trim())) continue
              const notice = parseEngineNotice(line)
              if (notice) engineNotices.push(notice)
              emit(state, { warning: line })
            }
            return
          }
          // Engine's words: "script declared no actor" (exits 0, no report written). Only signal besides missing file.
          if (lines.some((l) => l.includes(NOTHING_TO_SIM))) sawNothingToSim = true

          const engineProgress = latestProgress(lines) ?? undefined
          if (engineProgress) {
            // Run speaks; from here silence means something.
            sawProgress = true
            armStall()
          }
          emit(state, {
            log: lines,
            engineProgress,
            progress:
              engineProgress?.iterations === undefined
                ? undefined
                : {
                    kind: 'iterations',
                    done: engineProgress.iterations,
                    total: engineProgress.iterationTotal,
                    label: engineProgress.phase,
                  },
            stage:
              engineProgress && requestedIds.length
                ? {
                    kind: 'stage',
                    done: candidatesDone(engineProgress, requestedIds.length),
                    total: requestedIds.length,
                    label: engineProgress.phase,
                  }
                : undefined,
          })
          return
        }

        case 'done': {
          // Held here not passed through report worker; it's a document to read, not to parse (tens of MB round-trip is pure cost).
          htmlReportBytes = msg.html === undefined ? null : toArrayBuffer(msg.html)
          // The worker decides: remote.ts replays on this engine mid-run, and the real engine never says 'cloud'.
          placement = msg.placement === 'cloud' ? 'cloud' : 'browser'
          // The cloud server assembled its own run; this browser's assembly is only a fallback when it did not say what it ran.
          const ran = placement === 'cloud' ? msg.effective : undefined
          if (typeof ran?.profile === 'string' && Array.isArray(ran.args) && ran.args.every((a: unknown) => typeof a === 'string')) {
            effectiveProfile = ran.profile
            effectiveArgs = ran.args
          }
          if (placement === 'cloud') inputWarnings = inputWarnings.filter((w) => w !== clampWarning)
          void analyze(req, requestedIds, capability, msg.report)
          return
        }

        case 'error': {
          const code = typeof msg.code === 'string' ? msg.code : 'engine'
          if (code === 'report-missing' && sawNothingToSim) {
            fail(
              new SimEngineError(
                'no-actor',
                'the script ran but declared no character to simulate, so the engine had nothing to do and wrote no report. A profile needs an actor line such as `warlock="Name"` before its settings.',
              ),
            )
            return
          }
          fail(new SimEngineError(code, lastEngineError ? `${String(msg.message)}: ${lastEngineError}` : String(msg.message)))
          return
        }
      }
    }

    worker.onerror = (e: ErrorEvent) => {
      fail(
        new SimEngineError(
          'engine-worker',
          e.message || `the engine worker at ${ENGINE_WORKER_URL} failed to start`,
        ),
      )
    }

    worker.onmessageerror = () => {
      fail(new SimEngineError('engine-protocol', 'the engine worker sent a message that could not be read'))
    }
  }

  async function analyze(
    req: SimRequest,
    requestedIds: string[],
    capability: Extract<EngineCapability, { ok: true }>,
    report: unknown,
  ): Promise<void> {
    // One terminal completion per job, even if worker sends two.
    if (settled || finishing) return
    finishing = true
    emit('analyzing')

    const bytes = toArrayBuffer(report)
    if (!bytes) {
      fail(new SimEngineError('report-missing', 'the engine finished but produced no report'))
      return
    }

    // Engine worker work done; free heap before parse so peaks don't overlap.
    if (engineWorker) {
      engineWorker.onmessage = null
      engineWorker.onerror = null
      engineWorker.onmessageerror = null
      engineWorker.terminate()
      engineWorker = null
    }

    let parsed: ReportWorkerResponse
    try {
      parsed = await parseOffThread(bytes)
    } catch (err) {
      fail(err)
      return
    }
    if (settled) return

    if (!parsed.ok || parsed.kind !== 'summary') {
      fail(new SimEngineError('report-invalid', parsed.ok ? 'report parser answered the wrong question' : parsed.message))
      return
    }

    const raw = parsed.bytes
    // Kept for dev hook so stderr-reachability question can be asked from console.
    lastNotices = engineNotices
    succeed({
      jobId,
      request: req,
      report: parsed.report,
      profilesetStatus: profilesetStatus(requestedIds, parsed.report),
      inputWarnings,
      appElapsedSeconds: (now() - startedAt) / 1000,
      engineIdentity: engineIdentity(capability.manifest),
      engineNotices,
      effectiveProfile,
      effectiveArgs,
      placement,
      getRawJson: () => new Blob([raw], { type: 'application/json' }),
      getHtmlReport: () =>
        htmlReportBytes === null ? null : new Blob([htmlReportBytes], { type: 'text/html' }),
    })
  }

  function parseOffThread(bytes: ArrayBuffer): Promise<ReportWorkerResponse> {
    return new Promise<ReportWorkerResponse>((resolve, reject) => {
      let worker: Worker
      try {
        worker = createReportWorker()
      } catch (err) {
        reject(new SimEngineError('report-worker', `could not start the report parser: ${err}`))
        return
      }
      reportWorker = worker
      worker.onmessage = (e: MessageEvent<ReportWorkerResponse>) => {
        if (e.data?.jobId !== jobId) return
        heartbeat()
        resolve(e.data)
      }
      worker.onerror = (e: ErrorEvent) => {
        reject(new SimEngineError('report-worker', e.message || 'the report parser failed'))
      }
      const message: ReportWorkerRequest = { jobId, bytes }
      worker.postMessage(message, [bytes])
    })
  }

  return {
    jobId,
    result,
    get state() {
      return state
    },
    cancel(reason?: string) {
      fail(cancellation(reason), 'cancelled')
    },
  }
}

/** One player's ability/buff/action-sequence detail parsed off-thread from raw report (P06.5-P06.7); not part of SimOutcome (P01.11 on-demand). */
export async function loadReportSummary(raw: Blob): Promise<SimReport> {
  const bytes = await raw.arrayBuffer();
  const id = newJobId();
  const worker = defaultDeps.createReportWorker();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<SimReport>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Report took too long to read.')), 30000);
      worker.onmessage = (event: MessageEvent<ReportWorkerResponse>) => {
        const message = event.data;
        if (message?.jobId !== id) return;
        if (message.ok && message.kind === 'summary') resolve(message.report);
        else reject(new Error(message.ok ? 'Unexpected report response.' : message.message));
      };
      worker.onerror = () => reject(new Error('Could not read saved report.'));
      worker.postMessage({ jobId: id, bytes }, [bytes]);
    });
  } finally { clearTimeout(timeout); worker.terminate(); }
}

export async function loadPlayerDetail(
  raw: Blob,
  playerName: string,
  deps: Pick<JobDeps, 'createReportWorker'> = {},
): Promise<PlayerDetail> {
  const createReportWorker = deps.createReportWorker ?? defaultDeps.createReportWorker
  // Blob.arrayBuffer copies so blob stays usable for export and second detail request.
  const bytes = await raw.arrayBuffer()
  const requestId = newJobId()
  const worker = createReportWorker()

  try {
    return await new Promise<PlayerDetail>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ReportWorkerResponse>) => {
        const msg = e.data
        if (msg?.jobId !== requestId) return
        if (!msg.ok) {
          reject(new SimEngineError('report-invalid', msg.message))
        } else if (msg.kind !== 'detail') {
          reject(new SimEngineError('report-invalid', 'report parser answered the wrong question'))
        } else {
          resolve(msg.detail)
        }
      }
      worker.onerror = (e: ErrorEvent) => {
        reject(new SimEngineError('report-worker', e.message || 'the report parser failed'))
      }
      const message: ReportWorkerRequest = { jobId: requestId, kind: 'detail', bytes, playerName }
      worker.postMessage(message, [bytes])
    })
  } finally {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
  }
}

function toArrayBuffer(report: unknown): ArrayBuffer | null {
  if (report instanceof ArrayBuffer) return report
  if (ArrayBuffer.isView(report)) {
    const view = report as ArrayBufferView
    // FS.readFile allocates new Uint8Array(length) covering whole buffer, no copy needed; only partial/shared-memory views need copy.
    if (
      view.buffer instanceof ArrayBuffer &&
      view.byteOffset === 0 &&
      view.byteLength === view.buffer.byteLength
    ) {
      return view.buffer
    }
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  if (typeof report === 'string') return new TextEncoder().encode(report).buffer as ArrayBuffer
  return null
}
