// Bridge between optimization track's staged search and execution track's engine job; batch in, results out; folds batch progress into UI's active-job state.

import type { ProfilesetOutcome, ProfilesetRequest, RunBatch } from './optimization/runner'
import { sampleFloorOptions } from './optimization/engine-adapter'
import { runJob as defaultRunJob, type JobEvent, type RunHandle, type SimRequest, type SimOutcome } from './simc/client'
import type { SimSettings } from './simc/options'
import { app, type JobStatus } from './app.svelte'
import { ProgressBuffer } from './ui/progress'

export interface BatchContext {
  settings: SimSettings
  /** Scenario lines that must be part of base profile every candidate varies from (e.g. fixed target health); actor-scoped, silently ignored as sim arguments, so travel here. */
  extraProfileLines?: string[]
  /** Called for every engine event so run panel keeps updating between batches. */
  onEvent?: (event: JobEvent) => void
  /** Latest real baseline report for sharing after search. */
  onOutcome?: (outcome: SimOutcome) => void
  /** Engine log and warnings accumulate across whole search, not per batch. */
  buffer?: ProgressBuffer
  /** Injection seam; bridge already carried contract bug; it is tested. */
  runJob?: (req: SimRequest, onEvent?: (e: JobEvent) => void) => RunHandle
}

/** Builds RunBatch bound to one engine settings set; each batch is separate job (cancellation checkpoint, keeps one wasm instance D5, PLAN §3). */
export function makeRunBatch(ctx: BatchContext): RunBatch {
  const runJob = ctx.runJob ?? defaultRunJob
  return async (request: ProfilesetRequest): Promise<ProfilesetOutcome> => {
    // Candidate with no option lines IS unmodified base profile; optimizer includes baseline in every batch for same-run gain measurement; engine already simulates base, so answer from report's player not as profileset.
    const withLines = request.profilesets.filter((set) => set.lines.length > 0)
    const baselineIds = request.profilesets
      .filter((set) => set.lines.length === 0)
      .map((set) => set.id)

    const req: SimRequest = {
      schemaVersion: 1,
      profile: request.profile,
      // Results may be reactive UI state on re-run finalists; only plain values cross worker boundary including nested line arrays.
      settings: { ...ctx.settings },
      accuracy: { ...request.accuracy },
      extraOptions: sampleFloorOptions(request),
      extraProfileLines: ctx.extraProfileLines ? [...ctx.extraProfileLines] : undefined,
      profilesets: withLines.length ? withLines.map((set) => ({ id: set.id, lines: [...set.lines] })) : undefined,
    }

    const handle = runJob(req, (event) => {
      if (event.log?.length && ctx.buffer) for (const line of event.log) ctx.buffer.push(line)
      if (event.warning && ctx.buffer) ctx.buffer.push(event.warning)
      // event.stage: engine's count of finished profilesets, parsed from progress line; only live signal inside batch; 20s survey would report nothing without it.
      if (event.stage && request.onCandidateProgress) request.onCandidateProgress(event.stage.done)
      // Search owns stage counter; engine owns this batch's state.
      if (app.job && event.state !== 'complete') app.job.status = event.state as JobStatus
      ctx.onEvent?.(event)
    })

    // Optimizer cancels by aborting; abort must reach engine or dropped signal leaves unstoppable simulation; already-aborted case checked separately.
    const abort = () => handle.cancel('the search was cancelled')
    if (request.signal?.aborted) abort()
    else request.signal?.addEventListener('abort', abort, { once: true })

    try {
      const outcome = await handle.result
      ctx.onOutcome?.(outcome)
      const report = outcome.report
      const byId = new Map(report.profilesets.map((p) => [p.name, p]))
      const player = report.players[0]
      const baseline = player
        ? {
            mean: player.dps.mean,
            margin: player.dpsConfidence?.margin ?? null,
            iterations: report.actualIterations ?? player.dps.count,
          }
        : null

      return {
        results: request.profilesets.map((set) => {
          if (baselineIds.includes(set.id)) {
            return {
              id: set.id,
              mean: baseline?.mean ?? NaN,
              margin: baseline?.margin ?? null,
              iterations: baseline?.iterations ?? 0,
            }
          }
          const p = byId.get(set.id)
          return {
            id: set.id,
            // Profileset simc dropped produces no mean; NaN keeps it out of ranking without claiming zero score.
            mean: p ? p.mean : NaN,
            margin: p?.meanError ?? null,
            iterations: p?.iterations ?? 0,
          }
        }),
        baseline,
        confidence: report.options.confidence ?? null,
        targetReached: request.accuracy.mode === 'iterations' ? null : report.targetReached,
        engineIdentity: outcome.engineIdentity,
      }
    } finally {
      request.signal?.removeEventListener('abort', abort)
    }
  }
}
