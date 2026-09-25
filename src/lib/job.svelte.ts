// Drives one simulation job for UI: state, progress, report saving. One active job per tab (PLAN §3).

import {
  runJob, SimEngineError, SimTimeoutError, SimValidationError,
  type JobEvent, type RunHandle, type SimOutcome, type SimRequest,
} from './simc/client'
import type { SimReport } from './simc/report'
import { app, pollEngineSlot, runCharacter, saveReport, toast, type JobStatus } from './app.svelte'
import { newId, type ReportSummary, type StoredReport, type ToolId } from './store/records'
import { ProgressBuffer, type EngineProgress } from './ui/progress'

export interface RunView {
  request: SimRequest | null
  outcome: SimOutcome | null
  /** Non-fatal input rewrites, e.g. a neutralised `target_error=` from pasted text. */
  inputWarnings: string[]
  log: string[]
  warnings: string[]
  progress: EngineProgress | null
  /** The accuracy target this run is converging toward, when it has one. */
  targetError: number | undefined
  /** The earliest error the engine reported, the baseline for convergence. */
  firstErrorPct: number | undefined
  assetProgress: { done: number; total?: number; cached?: boolean } | null
  /** Set when the last attempt failed; kept until the next run starts. */
  error: { message: string; detail?: string; fields?: string[] } | null
  savedReportId: string | null
}

export const run: RunView = $state({
  request: null,
  outcome: null,
  inputWarnings: [],
  log: [],
  warnings: [],
  progress: null,
  targetError: undefined,
  firstErrorPct: undefined,
  assetProgress: null,
  error: null,
  savedReportId: null,
})

// Marker for started-but-unsettled job for reload-mid-run detection (P11.3); localStorage for crash survival.
const INTERRUPTED_KEY = 'frostsim.activeJob'

export interface InterruptedJob {
  tool: ToolId
  title: string
  startedAt: number
}

export function markStarted(job: InterruptedJob): void {
  try { localStorage.setItem(INTERRUPTED_KEY, JSON.stringify(job)) } catch { /* ignore */ }
}

export function markSettled(): void {
  try { localStorage.removeItem(INTERRUPTED_KEY) } catch { /* ignore */ }
}

/** Reads and clears the marker. Returns a job only if one was left unfinished. */
export function takeInterrupted(): InterruptedJob | null {
  try {
    const raw = localStorage.getItem(INTERRUPTED_KEY)
    if (!raw) return null
    localStorage.removeItem(INTERRUPTED_KEY)
    const parsed = JSON.parse(raw) as Partial<InterruptedJob>
    if (typeof parsed?.title !== 'string' || typeof parsed?.startedAt !== 'number') return null
    return parsed as InterruptedJob
  } catch {
    return null
  }
}

// What screen may cancel on teardown: its own work. abort = normal path, forceCancel = fallback when handle lost.
export function teardownCancellation(o: {
  running: boolean
  ownedJobId: string | null
  activeJobId: string | null | undefined
  engineBusy: boolean
}): { abort: boolean; forceCancel: boolean } {
  if (!o.running) return { abort: false, forceCancel: false }
  return {
    abort: true,
    forceCancel: o.engineBusy && !!o.ownedJobId && o.activeJobId === o.ownedJobId,
  }
}

let handle: RunHandle | null = null
let buffer = new ProgressBuffer()
let flushTimer: ReturnType<typeof setTimeout> | null = null

// Engine output faster than screen repaints; batch updates (P01.12).
const FLUSH_MS = 120

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    run.log = [...buffer.lines]
    run.warnings = [...buffer.warnings]
    run.progress = buffer.progress ? { ...buffer.progress } : null
    if (run.firstErrorPct === undefined && buffer.progress?.errorPct !== undefined) {
      run.firstErrorPct = buffer.progress.errorPct
    }
  }, FLUSH_MS)
}

function flushNow(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  run.log = [...buffer.lines]
  run.warnings = [...buffer.warnings]
  run.progress = buffer.progress ? { ...buffer.progress } : null
}

export interface StartOptions {
  tool: ToolId
  title: string
  request: SimRequest
  /** Extra summary rows, e.g. candidate labels for Compare. */
  summarize?: (report: SimReport, outcome: SimOutcome) => Partial<ReportSummary>
  /** Save finished report to history. Off for throwaway probe runs. */
  save?: boolean
}

export interface StartResult {
  ok: boolean
  outcome?: SimOutcome
  report?: StoredReport
}

// Run one job. Every ending lands in run and app.job (P01.2); never throws.
export async function startRun(opts: StartOptions): Promise<StartResult> {
  if (app.job && !['complete', 'error', 'cancelled'].includes(app.job.status)) {
    toast('bad', 'A simulation is already running in this tab. Cancel it first.')
    return { ok: false }
  }

  buffer = new ProgressBuffer()
  run.outcome = null
  run.inputWarnings = []
  run.log = []
  run.warnings = []
  run.progress = null
  run.assetProgress = null
  run.error = null
  run.savedReportId = null
  run.firstErrorPct = undefined
  run.targetError =
    opts.request.accuracy.mode === 'targetError' ? opts.request.accuracy.targetError : undefined

  const started = Date.now()
  // Job id chosen here so app.job exists before first event. Rerun = new report even from saved request.
  const jobId = newId()
  const request: SimRequest = { ...opts.request, jobId }
  run.request = request
  // Fixed now: the user may switch characters while this runs.
  const character = runCharacter()
  app.job = {
    id: jobId,
    tool: opts.tool,
    title: opts.title,
    character,
    status: 'validating',
    startedAt: started,
  }
  markStarted({ tool: opts.tool, title: opts.title, startedAt: started })

  let current: RunHandle
  try {
    current = runJob(request, onEvent)
  } catch (err) {
    // Synchronous validation refusal — the request never reached the engine.
    setFailure('validating', err)
    markSettled()
    return { ok: false }
  }
  handle = current

  function onEvent(event: JobEvent): void {
    // Late event from replaced job must not touch UI.
    if (!app.job || event.jobId !== app.job.id) return
    app.job.status = event.state as JobStatus
    if (event.log?.length) { for (const line of event.log) buffer.push(line) }
    if (event.warning) buffer.push(event.warning)
    if (event.progress?.kind === 'assets') {
      run.assetProgress = {
        done: event.progress.done,
        total: event.progress.total,
        // 'cached' when bytes did not cross network; completed bar for cache hit signals no wait.
        cached: event.progress.label === 'cached',
      }
    }
    if (event.progress?.kind === 'stage' && app.job) {
      app.job.stage = {
        index: event.progress.done,
        total: event.progress.total ?? 0,
        label: event.progress.label ?? '',
      }
    }
    scheduleFlush()
  }

  try {
    const outcome = await current.result
    if (!app.job || app.job.id !== jobId) return { ok: false }
    flushNow()
    run.outcome = outcome
    run.inputWarnings = outcome.inputWarnings
    for (const w of outcome.report.warnings) buffer.push(w)
    run.warnings = [...new Set([...buffer.warnings, ...outcome.report.warnings])]
    app.job.status = 'complete'

    if (opts.save === false) return { ok: true, outcome }
    const summary = buildSummary(outcome.report, opts.summarize?.(outcome.report, outcome))
    const record = await saveReport({
      tool: opts.tool,
      title: opts.title,
      summary,
      requestSnapshot: outcome.request,
      completion: outcome.profilesetStatus.missing.length ? 'partial' : 'complete',
      rawJson: await outcome.getRawJson().text(),
      character,
    })
    run.savedReportId = record.id
    return { ok: true, outcome, report: record }
  } catch (err) {
    flushNow()
    setFailure(app.job?.status ?? 'error', err)
    return { ok: false }
  } finally {
    if (handle === current) handle = null
    markSettled()
    // A run ending is exactly when availability can change, so read it now
    // rather than leaving the user up to a poll interval without the banner.
    pollEngineSlot()
  }
}

function setFailure(at: JobStatus, err: unknown): void {
  const cancelled = err instanceof DOMException && err.name === 'AbortError'
  if (app.job) app.job.status = cancelled ? 'cancelled' : 'error'
  if (cancelled) {
    run.error = { message: 'Cancelled. Nothing was saved.' }
    return
  }
  // The engine budget is one run per tab, and it is held until the previous
  // engine's threads are actually reaped — terminating the worker does not stop
  // them. That window is short and it is a wait, not a failure, so it must not
  // read like one. The run controls gate on `engineBusy()` so this should be
  // unreachable from the UI; if a user does see it, retrying is the right move.
  // The engine could not be shut down cleanly, so it refuses to build another
  // worker until the page is reloaded. The banner in App.svelte carries the
  // remedy and the export; this only has to avoid calling it a simulation
  // failure, because the simulation is not what failed.
  if (err instanceof SimEngineError && err.code === 'engine-reload-required') {
    run.error = {
      message: 'Frostsim needs to be reloaded before it can simulate again.',
      detail: err.message,
    }
    if (app.job) app.job.error = run.error.detail
    return
  }

  if (err instanceof SimEngineError && err.code === 'engine-busy') {
    run.error = {
      message: 'The previous simulation is still shutting down.',
      detail: 'Only one simulation can run in a tab at a time, and stopping one takes a moment. Try again shortly.',
    }
    if (app.job) app.job.error = run.error.detail
    return
  }

  if (err instanceof SimValidationError) {
    run.error = {
      message: 'These settings cannot be run.',
      detail: err.issues.map((i) => i.message).join(' '),
      fields: err.issues.map((i) => i.field),
    }
  } else if (err instanceof SimTimeoutError) {
    // Engine's own wording: distinguishes suspected cause from proven one.
    run.error = {
      message: err.phase === 'initializing'
        ? 'The engine did not finish loading.'
        : err.phase === 'stalled'
          ? 'The engine stopped responding and the run was stopped.'
          : 'The run passed its deadline and was stopped.',
      detail: err.message,
    }
  } else {
    run.error = {
      message: at === 'acquiring'
        ? 'The engine could not be downloaded.'
        : 'The simulation failed.',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  if (app.job) app.job.error = run.error.detail ?? run.error.message
}

export function cancelRun(reason?: string): void {
  if (handle) { handle.cancel(reason); return }
  if (app.job && app.job.status !== 'complete') {
    // Nothing to cancel but the UI thinks otherwise; settle it rather than hang.
    app.job.status = 'cancelled'
    run.error = { message: 'Cancelled. Nothing was saved.' }
  }
}

/** Compact history row. Undefined stays undefined; zero is never substituted. */
export function buildSummary(report: SimReport, extra?: Partial<ReportSummary>): ReportSummary {
  const player = report.players[0]
  return {
    dps: player?.dps.mean,
    confidenceMargin: player?.dpsConfidence?.margin,
    confidenceLevel: player?.dpsConfidence?.level,
    standardError: player?.dps.meanStdDev,
    actualIterations: report.actualIterations,
    targetReached: report.targetReached,
    elapsedSeconds: report.timings.engineElapsedSeconds,
    playerName: player?.name,
    specialization: player?.specialization,
    candidateCount: report.profilesets.length || undefined,
    warnings: report.warnings.length ? report.warnings.slice(0, 20) : undefined,
    ...extra,
  }
}

/** Human label for a job state, used by the header indicator and the run panel. */
export const STATUS_LABELS: Record<JobStatus, string> = {
  idle: 'Idle',
  validating: 'Checking settings',
  queued: 'Waiting for the engine',
  acquiring: 'Downloading engine',
  initializing: 'Starting engine',
  running: 'Simulating',
  analyzing: 'Reading report',
  complete: 'Complete',
  error: 'Failed',
  cancelled: 'Cancelled',
}
