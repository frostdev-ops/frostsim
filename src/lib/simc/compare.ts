// Rank candidates on either engine: threaded uses profilesets; SC_NO_THREADING fallback uses sequential jobs ranked side-by-side (PLAN P02.7).

import { runJob, type JobDeps, type JobEvent, type SimOutcome, type SimRequest } from './job'
import { rankProfilesets, type ConfidenceInterval } from './report'
import { withPlayerScopedLines, type ProfilesetSpec } from './options'

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
  deps: JobDeps & { profilesets?: boolean } = {},
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
        outcomes.push(outcome)
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
