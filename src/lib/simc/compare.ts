// Rank candidates on either engine: threaded uses profilesets; SC_NO_THREADING fallback uses sequential jobs ranked side-by-side (PLAN P02.7).

import { cancellation, runJob, SimEngineError, type JobDeps, type JobEvent, type JobState, type RunHandle, type SimOutcome, type SimRequest } from './job'
import { rankProfilesets, SEQUENTIAL_COMPARISON_WARNING, verifyReportIdentity, withSequentialComparison, type ConfidenceInterval } from './report'
import { LIMITS, withPlayerScopedLines, type ProfilesetSpec } from './options'

export interface CandidateResult {
  id: string
  /** complete has numbers; missing and failed do not. */
  status: 'complete' | 'missing' | 'failed'
  mean?: number
  min?: number
  max?: number
  iterations?: number
  /** Standard error of the mean, kept apart from the confidence margin. */
  meanStdDev?: number
  confidence?: ConfidenceInterval
  /** Why this candidate has no numbers. */
  error?: string
}

export interface ComparisonOutcome {
  /** How the candidates were actually run. Show it: the two are not equivalent. */
  strategy: 'profilesets' | 'sequential'
  /** Ranked, highest mean first. Candidates without a result sort last. */
  candidates: CandidateResult[]
  /** One outcome for profileset run, or one per candidate in sequential mode. */
  outcomes: SimOutcome[]
  /** True when stopped early; finished candidates still here so optimizer doesn't lose batch. */
  cancelled: boolean
}

export interface ComparisonHandle {
  readonly result: Promise<ComparisonOutcome>
  cancel(reason?: string): void
}

export interface ComparisonEvent extends JobEvent {
  /** Which candidate this event belongs to, in sequential mode. */
  candidateId?: string
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function fromProfilesets(outcome: SimOutcome, requested: readonly string[]): CandidateResult[] {
  const level = outcome.report.options.confidence
  const byId = new Map(rankProfilesets(outcome.report).map((p) => [p.name, p]))
  const results = requested.map<CandidateResult>((id) => {
    const p = byId.get(id)
    if (!p) {
      return {
        id,
        status: 'missing',
        // simc omits zero-mean profileset; omission signals no result.
        error: 'the engine returned no result for this candidate',
      }
    }
    return {
      id,
      status: 'complete',
      mean: p.mean,
      min: p.min,
      max: p.max,
      iterations: p.iterations,
      meanStdDev: p.meanStdDev,
      confidence:
        p.meanError === undefined
          ? undefined
          : {
              level,
              margin: p.meanError,
              relativePct: p.mean !== 0 ? (p.meanError / Math.abs(p.mean)) * 100 : 0,
            },
    }
  })
  return rank(results)
}

function fromRun(id: string, outcome: SimOutcome): CandidateResult {
  const player = outcome.report.players[0]
  if (!player) return { id, status: 'failed', error: 'the run produced no actor' }
  return {
    id,
    status: 'complete',
    mean: player.dps.mean,
    min: player.dps.min,
    max: player.dps.max,
    iterations: player.dps.count,
    meanStdDev: player.dps.meanStdDev,
    confidence: player.dpsConfidence,
  }
}

function rank(results: CandidateResult[]): CandidateResult[] {
  return [...results].sort((a, b) => (b.mean ?? -Infinity) - (a.mean ?? -Infinity))
}

/**
 * Runs `candidates` against the base request and ranks them. `strategy` is
 * chosen from the engine's own capability, not guessed: an artifact without
 * profilesets gets the sequential path.
 */
export function runComparison(
  base: SimRequest,
  candidates: readonly ProfilesetSpec[],
  onEvent?: (e: ComparisonEvent) => void,
  deps: JobDeps & { profilesets?: boolean; retainRawReports?: boolean } = {},
): ComparisonHandle {
  const ids = candidates.map((c) => c.id)
  let cancelled = false
  let cancelReason: string | undefined
  let active: { cancel(reason?: string): void } | null = null

  const result = (async (): Promise<ComparisonOutcome> => {
    const capability = typeof deps.capability === 'function' ? await deps.capability() : deps.capability
    const supportsProfilesets = deps.profilesets ?? (capability?.ok ? capability.profilesets : true)

    if (cancelled) return { strategy: supportsProfilesets ? 'profilesets' : 'sequential', candidates: [], outcomes: [], cancelled: true }

    if (supportsProfilesets) {
      const handle = runJob({ ...base, profilesets: [...candidates] }, onEvent, { ...deps, capability })
      active = handle
      try {
        const outcome = await handle.result
        return { strategy: 'profilesets', candidates: fromProfilesets(outcome, ids), outcomes: [outcome], cancelled: false }
      } catch (err) {
        if (isAbort(err)) {
          return { strategy: 'profilesets', candidates: [], outcomes: [], cancelled: true }
        }
        throw err
      } finally {
        active = null
      }
    }

    // Sequential: one job per candidate, independent runs; ranked, never merged.
    const outcomes: SimOutcome[] = []
    const results: CandidateResult[] = []

    for (let i = 0; i < candidates.length; i++) {
      if (cancelled) break
      const candidate = candidates[i]
      const handle = runJob(
        {
          ...base,
          jobId: undefined,
          profilesets: undefined,
          // Candidate lines go into PROFILE ahead of actor declarations. Scope is positional; profileset path is not. Both orderings tested on real engine (P07.4).
          extraProfileLines: withPlayerScopedLines(base.extraProfileLines ?? [], candidate.lines),
        },
        (event) =>
          onEvent?.({
            ...event,
            candidateId: candidate.id,
            progress:
              event.progress ?? { kind: 'stage', done: i, total: candidates.length, label: candidate.id },
          }),
        deps,
      )
      active = handle
      try {
        const outcome = await handle.result
        // Managed tools save one compact envelope; retaining every full engine JSON would grow with the batch size.
        outcomes.push(deps.retainRawReports === false ? { ...outcome, getRawJson: () => new Blob(), getHtmlReport: () => null } : outcome)
        results.push(fromRun(candidate.id, outcome))
      } catch (err) {
        if (isAbort(err)) {
          cancelled = true
          break
        }
        // One bad candidate doesn't lose batch (unlike profilesets where bad option cancels whole run).
        results.push({ id: candidate.id, status: 'failed', error: err instanceof Error ? err.message : String(err) })
      } finally {
        active = null
      }
    }

    for (const id of ids) {
      if (!results.some((r) => r.id === id)) {
        results.push({ id, status: 'missing', error: cancelled ? (cancelReason ?? 'cancelled before this candidate ran') : 'not run' })
      }
    }

    return { strategy: 'sequential', candidates: rank(results), outcomes, cancelled }
  })()

  return {
    result,
    cancel(reason?: string) {
      cancelled = true
      cancelReason = reason
      active?.cancel(reason)
    },
  }
}

/** Managed tools keep their usual outcome/history shape while fallback measures every candidate independently. */
export function runSequentialComparison(base: SimRequest, onEvent?: (event: JobEvent) => void, deps: JobDeps = {}): RunHandle {
  const jobId = base.jobId ?? globalThis.crypto.randomUUID()
  const candidates = base.profilesets ?? []
  const started = (deps.now ?? Date.now)()
  let state: JobState = 'validating'
  let cancelled = false
  let reason: string | undefined
  let active: { cancel(reason?: string): void } | null = null

  const emit = (event: JobEvent): void => {
    state = event.state
    try { onEvent?.({ ...event, jobId }) } catch { /* observers cannot stop the sequence */ }
  }
  const forward = (index: number, label: string) => (event: JobEvent): void => {
    // A child ending is a checkpoint, not the end of this managed request.
    const next = ['complete', 'error', 'cancelled'].includes(event.state) ? 'running' : event.state
    emit({ ...event, state: next, progress: event.progress ?? { kind: 'stage', done: index, total: candidates.length + 1, label } })
  }

  const result = (async (): Promise<SimOutcome> => {
    try {
      emit({ jobId, state: 'validating', warning: SEQUENTIAL_COMPARISON_WARNING })
      const baselineHandle = runJob({ ...base, jobId: undefined, profilesets: undefined }, forward(0, 'Baseline'), deps)
      active = baselineHandle
      if (cancelled) baselineHandle.cancel(reason)
      const baseline = await baselineHandle.result
      if (cancelled) throw cancellation(reason)

      const comparison = runComparison({ ...base, jobId: undefined, profilesets: undefined }, candidates, event => {
        const index = candidates.findIndex(candidate => candidate.id === event.candidateId)
        forward(index + 1, event.candidateId ?? 'Candidate')(event)
      }, { ...deps, profilesets: false, retainRawReports: false })
      active = comparison
      if (cancelled) comparison.cancel(reason)
      const compared = await comparison.result
      if (cancelled || compared.cancelled) throw cancellation(reason)

      const outcomes = [baseline, ...compared.outcomes]
      const capability = typeof deps.capability === 'function' ? await deps.capability() : deps.capability
      if (!capability?.ok) throw new SimEngineError('engine-identity-mismatch', 'The comparison has no frozen engine identity.')
      for (const outcome of outcomes) {
        verifyReportIdentity(outcome.report, capability.manifest)
        if (outcome.engineIdentity !== baseline.engineIdentity || outcome.report.options.confidence !== baseline.report.options.confidence) {
          throw new SimEngineError('engine-identity-mismatch', 'The comparison runs used different engine identities or confidence levels.')
        }
      }
      const completed = compared.candidates.filter(candidate => candidate.status === 'complete')
      const boundedMessages = (messages: string[]) => [...new Set(messages)].slice(0, LIMITS.extraOptions).map(message => message.slice(0, LIMITS.optionLineChars))
      const relativeErrors = outcomes.flatMap(outcome => outcome.report.worstRelativeErrorPct === undefined ? [] : [outcome.report.worstRelativeErrorPct])
      const envelope = {
        schemaVersion: 1,
        strategy: 'sequential',
        results: completed.map(candidate => ({
          name: candidate.id, mean: candidate.mean, min: candidate.min, max: candidate.max, iterations: candidate.iterations,
          ...(candidate.meanStdDev === undefined ? {} : { mean_stddev: candidate.meanStdDev }),
          ...(candidate.confidence === undefined ? {} : { mean_error: candidate.confidence.margin }),
        })),
        warnings: boundedMessages([
          ...outcomes.flatMap(outcome => outcome.report.warnings),
          ...compared.candidates.flatMap(candidate => candidate.status === 'complete' ? [] : [`${candidate.id}: ${candidate.error ?? 'no result'}`]),
        ]),
        problems: boundedMessages(outcomes.flatMap(outcome => outcome.report.problems)),
        targetReached: completed.length === candidates.length && outcomes.every(outcome => outcome.report.targetReached),
        ...(relativeErrors.length ? { worstRelativeErrorPct: Math.max(...relativeErrors) } : {}),
      }
      const report = withSequentialComparison(baseline.report, envelope)
      // Add only an explicitly application-owned envelope; keep every baseline engine field verbatim, without parsing raw JSON here.
      const text = await baseline.getRawJson().text()
      if (cancelled) throw cancellation(reason)
      const brace = text.indexOf('{')
      if (brace < 0) throw new SimEngineError('report-invalid', 'The baseline report is not a JSON object.')
      const raw = new Blob([text.slice(0, brace + 1), '"frostsim_comparison":', JSON.stringify(envelope), ',', text.slice(brace + 1)], { type: 'application/json' })
      emit({ jobId, state: 'complete', progress: { kind: 'stage', done: candidates.length + 1, total: candidates.length + 1, label: 'Complete' } })
      return {
        ...baseline, jobId, request: base, report,
        profilesetStatus: { completed: completed.map(candidate => candidate.id), missing: compared.candidates.filter(candidate => candidate.status !== 'complete').map(candidate => candidate.id) },
        inputWarnings: [...new Set(outcomes.flatMap(outcome => outcome.inputWarnings))],
        engineNotices: outcomes.flatMap(outcome => outcome.engineNotices),
        appElapsedSeconds: ((deps.now ?? Date.now)() - started) / 1000,
        effectiveProfile: outcomes.map((outcome, index) => `# Frostsim sequential run ${index + 1} (${index === 0 ? 'baseline' : 'candidate'})\n${outcome.effectiveProfile}`).join('\n\n'),
        getRawJson: () => raw,
        getHtmlReport: () => null,
      }
    } catch (error) {
      emit({ jobId, state: isAbort(error) ? 'cancelled' : 'error' })
      throw error
    } finally { active = null }
  })()

  return {
    jobId, result, get state() { return state },
    cancel(why?: string) { cancelled = true; reason = why; active?.cancel(why) },
  }
}
