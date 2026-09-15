// Staged-precision search runner (P08.8, P08.11, P08.12). Batch size is the checkpoint; zero-mean candidates are silently dropped; one invalid option line fails the whole job.

import type {
  Accuracy, Candidate, CandidateMeasurement, CandidateState, OptimizationProgress,
  OptimizationResult, StageConfig, StagePlan,
} from './types';
import { multiplicityFactor, retain, unresolvedTie } from './statistics';

// Engine port: narrow interface so this module is testable without wasm.

export interface ProfilesetRequest {
  /** Baseline profile text, never edited by runner. */
  profile: string;
  accuracy: Accuracy;
  /** Minimum samples before target-error run may converge. */
  minIterations?: number;
  /** MAY BE EMPTY. Base profile must still run even if this is empty; adapter must not skip the engine. */
  profilesets: { id: string; lines: string[] }[];
  signal?: AbortSignal;
  /** Called as the engine finishes candidates within batch, with the count completed so far. */
  onCandidateProgress?: (completedInBatch: number) => void;
}

export interface ProfilesetOutcome {
  results: { id: string; mean: number; margin: number | null; iterations: number }[];
  /** Unmodified baseline's result when the engine reported one. */
  baseline: { mean: number; margin: number | null; iterations: number } | null;
  /** Confidence level the margins are stated at. */
  confidence: number | null;
  /** False when target-accuracy run hit its iteration ceiling first. */
  targetReached: boolean | null;
  engineIdentity: string | null;
  /** Engine logs classified as moderate or severe; all numbers in batch are suspect when non-empty. */
  problems?: string[];
}

export type RunBatch = (request: ProfilesetRequest) => Promise<ProfilesetOutcome>;

// --- Line validation -------------------------------------------------------

const OPTION_LINE = /^[A-Za-z0-9_.]+\+?=/;

export class InvalidCandidateError extends Error {
  constructor(readonly candidateId: string, readonly line: string, reason: string) {
    super(`candidate ${candidateId}: ${reason} in ${JSON.stringify(line)}`);
  }
}

/** Syntactic guard rejects lines that would cancel the whole job; engine is authoritative for option existence. */
export function validateCandidateLines(candidate: Candidate): void {
  for (const line of candidate.lines) {
    if (line.includes('\n') || line.includes('\r')) {
      throw new InvalidCandidateError(candidate.id, line, 'line break');
    }
    if (line.includes('"')) throw new InvalidCandidateError(candidate.id, line, 'double quote');
    if (!OPTION_LINE.test(line)) throw new InvalidCandidateError(candidate.id, line, 'not an option assignment');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(candidate.id)) {
    throw new InvalidCandidateError(candidate.id, candidate.id, 'unsafe profileset id');
  }
}

// Result cache: measurement is reusable only when engine, catalog, input and precision all match.
export function cacheKey(parts: {
  engineIdentity: string;
  catalogId: string;
  canonical: string;
  accuracy: Accuracy;
}): string {
  const acc = parts.accuracy.mode === 'iterations'
    ? `i${parts.accuracy.iterations}`
    : `e${parts.accuracy.targetError}:${parts.accuracy.maxIterations}`;
  return [parts.engineIdentity, parts.catalogId, acc, parts.canonical].join('\u0000');
}

export interface ResultCache {
  get(key: string): CandidateMeasurement | undefined;
  set(key: string, value: CandidateMeasurement): void;
}

export function memoryCache(): ResultCache {
  const m = new Map<string, CandidateMeasurement>();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
}

// Ledger: per-candidate completion record allows interrupted search to resume; plain data.
export interface SearchLedger {
  stageIndex: number;
  completed: Record<string, CandidateMeasurement>;
  eliminated: Record<string, string>;
}

export function emptyLedger(): SearchLedger {
  return { stageIndex: 0, completed: {}, eliminated: {} };
}

// Runner

export interface SearchOptions {
  profile: string;
  plan: StagePlan;
  catalogId: string;
  /** Engine identity for cache keys from manifest; supply it or cache never warms. */
  engineIdentity?: string | null;
  runBatch: RunBatch;
  cache?: ResultCache;
  ledger?: SearchLedger;
  signal?: AbortSignal;
  onProgress?: (p: OptimizationProgress) => void;
  /** Fails a batch not settled in this long; prevents hangs from adapters that never settle. */
  batchTimeoutMs?: number;
  /** Grace period to wait after cancelling for adapter to actually settle. Defaults to 5s. */
  abortGraceMs?: number;
}

/** Iteration ceiling for any stage bounds TIME not MEMORY; footprint is fixed, unbounded finalist is a defect. */
export const DEFAULT_MAX_ITERATIONS = 40_000;

/** Default ladder (P08.8, VERSION 4 with multiple-comparison correction). Ends at 0.2% as interactive search budget, not because 0.05% is impossible. */
export const DEFAULT_STAGE_PLAN: StagePlan = {
  version: 4,
  retentionFactor: 1,
  minIterations: 200,
  // Version 4 turns this on. Measured with it off: a thirty-candidate near-tie lost
  // its true winner to a confident elimination in 36% of searches. The method is
  // Bonferroni — the union bound — because the comparisons share a leader and repeat
  // across stages, so the tighter Šidák bound is not established here. See
  // `multiplicityFactor` and `validation.test.ts`.
  correctForMultipleComparisons: true,
  stages: [
    { label: 'Survey', accuracy: { mode: 'targetError', targetError: 1, maxIterations: 10_000 }, maxSurvivors: 200, batchSize: 100 },
    { label: 'Narrow', accuracy: { mode: 'targetError', targetError: 0.5, maxIterations: 12_000 }, maxSurvivors: 25, batchSize: 25 },
    { label: 'Finalists', accuracy: { mode: 'targetError', targetError: 0.2, maxIterations: 20_000 }, maxSurvivors: 8, batchSize: 8 },
  ],
};

/** Builds stage plan from one target error (user's input); ceilings scale as 1/targetError² then cap at DEFAULT_MAX_ITERATIONS. */
export function planForTargetError(
  finalTargetError: number,
  opts: { maxSurvivors?: number; base?: StagePlan } = {},
): StagePlan {
  const base = opts.base ?? DEFAULT_STAGE_PLAN;
  const target = Math.min(5, Math.max(0.01, Number.isFinite(finalTargetError) ? finalTargetError : 0.2));
  const finalSurvivors = opts.maxSurvivors ?? base.stages[base.stages.length - 1].maxSurvivors;

  // Reference: shipped ladder's final stage reproduces default ceilings exactly at default target error.
  const reference = base.stages[base.stages.length - 1];
  const referenceError = reference.accuracy.mode === 'targetError' ? reference.accuracy.targetError : 0.2;
  const referenceMax = iterationsFor(reference.accuracy);

  const ceiling = (stageError: number): number => {
    const scaled = referenceMax * (referenceError / stageError) ** 2;
    return Math.min(DEFAULT_MAX_ITERATIONS, Math.max(1_000, Math.round(scaled)));
  };

  const stages: StageConfig[] = [
    { label: 'Survey', error: target * 5, maxSurvivors: base.stages[0].maxSurvivors, batchSize: base.stages[0].batchSize },
    { label: 'Narrow', error: target * 2.5, maxSurvivors: base.stages[1].maxSurvivors, batchSize: base.stages[1].batchSize },
    { label: 'Finalists', error: target, maxSurvivors: finalSurvivors, batchSize: finalSurvivors },
  ].map(({ label, error, maxSurvivors, batchSize }) => ({
    label,
    accuracy: { mode: 'targetError', targetError: error, maxIterations: ceiling(error) },
    maxSurvivors,
    batchSize,
  }));

  return { ...base, stages };
}

function iterationsFor(accuracy: Accuracy): number {
  return accuracy.mode === 'iterations' ? accuracy.iterations : accuracy.maxIterations;
}

// Pass source: loop doesn't care where next pass comes from. Ledger, cache, retention, abort handling unified here.
/** One pass the loop is about to run. A `StageConfig` plus what adaptivity needs. */
export interface PassPlan extends StageConfig {
  /** Per-candidate precision; candidates with same accuracy share one job and one `target_error`. */
  accuracyFor?: (candidateId: string) => Accuracy;
  /** Passes expected in total for progress; defaults to plan's stage count. */
  stageCount?: number;
  /** Comparisons-per-candidate looks entering the Bonferroni bound. */
  looks?: number;
  /** Measure only, no elimination after this pass (last ladder stage sets it). */
  noElimination?: boolean;
  /** Ignore result cache; verification run must take fresh samples. */
  noCache?: boolean;
  /** Measure only these candidates; verification pass uses it to re-measure finalists. */
  restrictTo?: string[];
  /** Planner's estimate of engine samples still to come, for progress. */
  estimatedSamplesRemaining?: number;
}

export interface PassContext {
  stageIndex: number;
  /** Latest measurement of every candidate still measured, newest pass first. */
  measured: CandidateMeasurement[];
  /** Candidates that survived the previous pass. */
  active: Candidate[];
  baseline: CandidateMeasurement | null;
  /** Engine samples consumed by the search so far. */
  samplesSpent: number;
  /** Milliseconds since the search started. */
  elapsedMs: number;
}

/** Returns the next pass, or null when the search is finished. */
export type PassSource = (ctx: PassContext) => PassPlan | null;

export async function runStagedSearch(
  candidates: Candidate[],
  opts: SearchOptions,
): Promise<OptimizationResult> {
  const looks = Math.max(1, opts.plan.stages.length - 1);
  return runPassSearch(candidates, opts, ({ stageIndex }) => {
    const stage = opts.plan.stages[stageIndex];
    if (!stage) return null;
    // Last stage measures but does not eliminate — preserved exactly.
    return { ...stage, stageCount: opts.plan.stages.length, looks, noElimination: stageIndex === opts.plan.stages.length - 1 };
  });
}

/** Search loop driven by PassSource. opts.plan supplies retention knobs; plan.stages is fallback for stageCount and looks. */
export async function runPassSearch(
  candidates: Candidate[],
  opts: SearchOptions,
  source: PassSource,
): Promise<OptimizationResult> {
  const cache = opts.cache ?? memoryCache();
  const ledger = opts.ledger ?? emptyLedger();
  const warnings: string[] = [];
  const stagesRun: OptimizationResult['stagesRun'] = [];

  const states = new Map<string, CandidateState>();
  const compareVaultChoices = candidates.some((c) => c.provenance.vaultRewardId);
  for (const c of candidates) {
    try {
      validateCandidateLines(c);
    } catch (err) {
      states.set(c.id, { candidate: c, status: 'failed', measurement: null, history: [], note: String(err) });
      warnings.push(String(err));
      continue;
    }
    // Resume: ledger-measured candidates are restored rather than rerun.
    const done = ledger.completed[c.id];
    const eliminated = ledger.eliminated[c.id];
    if (eliminated) {
      states.set(c.id, { candidate: c, status: 'eliminated', measurement: done ?? null, history: done ? [done] : [], note: eliminated });
    } else if (done) {
      states.set(c.id, { candidate: c, status: 'measured', measurement: done, history: [done] });
    } else {
      states.set(c.id, { candidate: c, status: 'pending', measurement: null, history: [] });
    }
  }

  let active = [...states.values()]
    .filter((s) => s.status === 'pending' || s.status === 'measured')
    .map((s) => s.candidate);
  let baseline: CandidateMeasurement | null = null;
  const engineIdentity = opts.engineIdentity ?? null;
  let truncated = false;
  let samplesSpent = 0;
  let lastLooks = Math.max(1, opts.plan.stages.length - 1);
  let stageCount = opts.plan.stages.length;
  const startedAt = Date.now();
  let reportedMissingIdentity = false;
  const problems: string[] = [];
  const droppedWhileAlive: string[] = [];
  let incomplete: OptimizationResult['incomplete'] = null;

  outer:
  for (let stageIndex = ledger.stageIndex; ; stageIndex++) {
    const stage = source({
      stageIndex,
      measured: latestMeasurements(states),
      active,
      baseline,
      samplesSpent,
      elapsedMs: Date.now() - startedAt,
    });
    if (!stage) break;
    lastLooks = stage.looks ?? Math.max(1, opts.plan.stages.length - 1);
    stageCount = stage.stageCount ?? opts.plan.stages.length;
    const accuracyOf = (c: Candidate): Accuracy => stage.accuracyFor?.(c.id) ?? stage.accuracy;

    // Engine cannot separate from rival; every survivor is re-measured at next precision.
    const restricted = stage.restrictTo ? new Set(stage.restrictTo) : null;
    const toRun = active.filter((c) => {
      if (restricted && !restricted.has(c.id)) return false;
      const accuracy = accuracyOf(c);
      // Already measured at this stage's precision by ledger or earlier batch.
      const state = states.get(c.id)!;
      if (state.status === 'measured' && state.measurement?.stageIndex === stageIndex) {
        if (accuracy.mode !== 'targetError' || state.measurement.iterations >= opts.plan.minIterations) return false;
        // Older ledger may predate convergence floor; mark pending so baseline is also replaced.
        state.status = 'pending';
      }
      // Verification pass needs fresh samples; cache would repeat the number that put candidate here.
      if (stage.noCache) return true;
      // Unknown engine: cached number could come from another binary.
      if (engineIdentity === null) return true;
      const key = cacheKey({ engineIdentity, catalogId: opts.catalogId, canonical: c.canonical, accuracy });
      const hit = cache.get(key);
      if (!hit || (accuracy.mode === 'targetError' && hit.iterations < opts.plan.minIterations)) return true;
      state.measurement = { ...hit, candidateId: c.id, stageIndex };
      state.history.push(state.measurement);
      state.status = 'measured';
      return false;
    });

    // Candidate with no lines IS the unmodified baseline; produces no profileset, uses base actor result.
    const unmodified = toRun.filter((c) => c.lines.length === 0);
    const submittable = toRun.filter((c) => c.lines.length > 0);

    // Same precision shares one job with one `target_error`. Cheapest first; baseline from most precise job.
    const groups = new Map<string, { accuracy: Accuracy; members: Candidate[] }>();
    for (const c of submittable) {
      const accuracy = accuracyOf(c);
      const key = accuracyKey(accuracy);
      const group = groups.get(key) ?? { accuracy, members: [] };
      group.members.push(c);
      groups.set(key, group);
    }
    const batches = [...groups.values()]
      .sort((x, y) => iterationsFor(x.accuracy) - iterationsFor(y.accuracy))
      .flatMap((g) => chunk(g.members, Math.max(1, stage.batchSize)).map((members) => ({ accuracy: g.accuracy, members })));
    // Base profile still runs for unmodified candidate to be measured.
    if (batches.length === 0 && unmodified.length > 0) batches.push({ accuracy: stage.accuracy, members: [] });
    for (let b = 0; b < batches.length; b++) {
      if (opts.signal?.aborted) { incomplete = { reason: 'cancelled', message: 'search cancelled' }; break outer; }

      const { accuracy: batchAccuracy, members: batch } = batches[b];
      // Committed once before batch; in-flight count moves forward only within batch.
      const committed = [...states.values()].filter((s) => s.status === 'measured').length;
      // How much of THIS pass earlier batches finished; avoids displaying wrong remaining count.
      const passDone = toRun.filter((c) => {
        const state = states.get(c.id);
        return state?.status === 'measured' && state.measurement?.stageIndex === stageIndex;
      }).length;
      let lastReported = -1;
      const emitProgress = (completedInBatch: number) => {
        if (completedInBatch === lastReported) return;
        lastReported = completedInBatch;
        opts.onProgress?.({
          stageIndex, stageCount, stageLabel: stage.label,
          accuracy: batchAccuracy, batchIndex: b, batchCount: batches.length,
          candidatesMeasured: committed + completedInBatch,
          candidatesRemaining: Math.max(0, toRun.length - passDone - completedInBatch),
          contendersRemaining: active.length,
          candidatesInBatch: batch.length,
          candidatesDoneInBatch: completedInBatch,
          samplesSpent,
          estimatedSamplesRemaining: stage.estimatedSamplesRemaining,
        });
      };
      emitProgress(0);

      for (const c of batch) states.get(c.id)!.status = 'running';

      let outcome: ProfilesetOutcome;
      try {
        outcome = await runBatchAborting(opts, batchAccuracy, batch, emitProgress, {
          what: batch.length === 0
            ? 'the batch carried only the unmodified baseline, so its profileset list was empty; ' +
              'an adapter must still run the base profile for that case'
            : `batch of ${batch.length} candidates`,
          onAbandoned: (message) => warnings.push(message),
        });
      } catch (err) {
        // Whole batch lost; ledger keeps every earlier batch.
        for (const c of batch) states.get(c.id)!.status = 'pending';
        incomplete = {
          reason: opts.signal?.aborted ? 'cancelled' : 'error',
          message: `stage ${stage.label} batch ${b + 1}/${batches.length}: ${String(err)}`,
        };
        break outer;
      }

      // Wrong engine in cache serves numbers from another binary.
      if (outcome.engineIdentity && engineIdentity && outcome.engineIdentity !== engineIdentity) {
        incomplete = {
          reason: 'error',
          message: `engine identity changed mid-search: expected ${engineIdentity}, got ${outcome.engineIdentity}`,
        };
        break outer;
      }
      // Once per search, not once per batch; repeating is noise and duplicate key for {#each}.
      if (outcome.engineIdentity && !engineIdentity && !reportedMissingIdentity) {
        reportedMissingIdentity = true;
        warnings.push(
          `no engine identity was supplied, so results were not cached (engine reported ${outcome.engineIdentity})`,
        );
      }
      for (const problem of outcome.problems ?? []) {
        problems.push(`stage ${stage.label}: ${problem}`);
      }

      if (outcome.baseline) {
        baseline = {
          candidateId: 'baseline', mean: outcome.baseline.mean, margin: outcome.baseline.margin,
          confidence: outcome.confidence, iterations: outcome.baseline.iterations, stageIndex,
        };
        // Every batch runs same base profile; unmodified candidate measured by first batch only.
        for (const c of unmodified) {
          const state = states.get(c.id)!;
          if (state.status === 'measured' && state.measurement?.stageIndex === stageIndex) continue;
          const measurement: CandidateMeasurement = { ...baseline, candidateId: c.id };
          state.measurement = measurement;
          state.history.push(measurement);
          state.status = 'measured';
          ledger.completed[c.id] = measurement;
        }
      }

      const returned = new Set<string>();
      for (const r of outcome.results) {
        const state = states.get(r.id);
        if (!state) { warnings.push(`engine returned an unrequested profileset ${r.id}`); continue; }
        returned.add(r.id);
        const measurement: CandidateMeasurement = {
          candidateId: r.id, mean: r.mean, margin: r.margin,
          confidence: outcome.confidence, iterations: r.iterations, stageIndex,
        };
        state.measurement = measurement;
        state.history.push(measurement);
        state.status = 'measured';
        ledger.completed[r.id] = measurement;
        if (engineIdentity !== null) {
          cache.set(
            cacheKey({ engineIdentity, catalogId: opts.catalogId, canonical: state.candidate.canonical, accuracy: batchAccuracy }),
            measurement,
          );
        }
      }

      // Batch with no results is broken adapter, not search result.
      if (returned.size === 0 && !outcome.baseline) {
        incomplete = {
          reason: 'error',
          message:
            `stage ${stage.label} batch ${b + 1}/${batches.length} returned no candidate results and no baseline` +
            (batch.length === 0
              ? '; the batch carried only the unmodified baseline, so the adapter must run the base profile when the profileset list is empty'
              : ''),
        };
        for (const c of batch) states.get(c.id)!.status = 'pending';
        break outer;
      }

      for (const c of batch) {
        if (returned.has(c.id)) continue;
        const state = states.get(c.id)!;
        state.status = 'missing';
        // Upstream drops a zero-mean profileset from the report with no error, so
        // absence is the only signal and we do not guess which cause it was.
        state.note = 'not present in the engine report; it produced no result or did not run';
      }

      const batchSamples = outcome.results.reduce((n, r) => n + (Number.isFinite(r.iterations) ? r.iterations : 0), outcome.baseline?.iterations ?? 0);
      samplesSpent += batchSamples;
      if (stagesRun[stageIndex]) {
        stagesRun[stageIndex].targetReached = combineTargetReached(stagesRun[stageIndex].targetReached, outcome.targetReached);
        stagesRun[stageIndex].samples = (stagesRun[stageIndex].samples ?? 0) + batchSamples;
      } else {
        stagesRun[stageIndex] = { label: stage.label, accuracy: stage.accuracy, targetReached: outcome.targetReached, candidates: 0, samples: batchSamples };
      }
    }

    ledger.stageIndex = stageIndex + 1;

    const measuredAll = latestMeasurements(states);
    // ONLY WHAT IS STILL IN THE SEARCH; `active` is the authority on who is racing.
    const activeIds = new Set(active.map((c) => c.id));
    const measured = measuredAll.filter((m) => activeIds.has(m.candidateId));
    // This stage's measurements, not running total; otherwise narrowing looks unchanged.
    if (stagesRun[stageIndex]) {
      stagesRun[stageIndex].candidates = measuredAll.filter((m) => m.stageIndex === stageIndex).length;
    }

    if (stage.noElimination) break;

    const retentionOptions = {
      retentionFactor: opts.plan.retentionFactor,
      minIterations: opts.plan.minIterations,
      maxSurvivors: stage.maxSurvivors,
      correctForMultipleComparisons: opts.plan.correctForMultipleComparisons,
      // Every stage that eliminates is another look at the same candidates.
      looks: lastLooks,
    };
    let outcome = retain(measured, retentionOptions);
    if (compareVaultChoices) {
      // Each reward is a separate decision: a strong reward must not eliminate
      // all combinations for a weaker one, or the best owned-only alternative.
      const groups = new Map<string, CandidateMeasurement[]>();
      for (const m of measured) {
        if (!activeIds.has(m.candidateId)) continue;
        const key = states.get(m.candidateId)!.candidate.provenance.vaultRewardId ?? '';
        const group = groups.get(key) ?? [];
        group.push(m);
        groups.set(key, group);
      }
      const field = [...groups.values()].flat();
      const leader = [...field].sort((a, b) => b.mean - a.mean)[0];
      const correction = opts.plan.correctForMultipleComparisons === false ? 1 :
        multiplicityFactor(field.length - 1, leader?.confidence ?? 0.95, retentionOptions.looks);
      const outcomes = [...groups.values()].map((group) => retain(group, {
        ...retentionOptions,
        // Correction applies to entire field including all reward groups.
        retentionFactor: opts.plan.retentionFactor * correction,
        correctForMultipleComparisons: false,
        maxSurvivors: Infinity,
      }));
      const reserved = outcomes.flatMap((o) => o.survivors.slice(0, 1));
      const rest = outcomes.flatMap((o) => o.survivors.slice(1)).sort((a, b) => b.mean - a.mean);
      const budget = Math.max(stage.maxSurvivors, reserved.length);
      const remaining = Math.max(0, budget - reserved.length);
      const survivors = [...reserved, ...rest.slice(0, remaining)];
      const survivorIds = new Set(survivors.map((m) => m.candidateId));
      outcome = {
        survivors,
        eliminated: outcomes.flatMap((o) => o.eliminated),
        droppedWhileAlive: rest.slice(remaining),
        retainedForInsufficientEvidence: outcomes.flatMap((o) => o.retainedForInsufficientEvidence)
          .filter((m) => survivorIds.has(m.candidateId)),
      };
      if (budget > stage.maxSurvivors) warnings.push(
        `${stage.label}: survivor budget raised from ${stage.maxSurvivors} to ${budget} to compare every Great Vault choice and the no-Vault alternative`,
      );
    }

    // UNMODIFIED PROFILE IS NEVER ELIMINATED. No option lines IS the base profile, the reference for all gains.
    const isReference = (id: string) => states.get(id)?.candidate.lines.length === 0;
    const rescued = outcome.eliminated.filter((e) => isReference(e.measurement.candidateId));
    if (rescued.length) {
      outcome = {
        ...outcome,
        eliminated: outcome.eliminated.filter((e) => !isReference(e.measurement.candidateId)),
        // Reference appended past `maxSurvivors` costs no engine work.
        survivors: [...outcome.survivors, ...rescued.map((e) => e.measurement)].sort((a, b) => b.mean - a.mean),
      };
    }

    for (const e of outcome.eliminated) {
      const state = states.get(e.measurement.candidateId);
      if (!state) continue;
      state.status = 'eliminated';
      state.note = e.reason;
      ledger.eliminated[e.measurement.candidateId] = e.reason;
    }
    if (outcome.droppedWhileAlive.length) {
      truncated = true;
      for (const m of outcome.droppedWhileAlive) {
        droppedWhileAlive.push(m.candidateId);
        const state = states.get(m.candidateId);
        if (state) state.note = `still statistically alive, but beyond the ${stage.maxSurvivors}-candidate budget for ${stage.label}`;
      }
      warnings.push(
        `${outcome.droppedWhileAlive.length} candidates were still indistinguishable from the leader when the ${stage.label} budget ran out; this search is not exhaustive`,
      );
    }
    if (outcome.retainedForInsufficientEvidence.length) {
      warnings.push(
        `${stage.label}: ${outcome.retainedForInsufficientEvidence.length} candidates were carried forward because a comparison lacked the required ${opts.plan.minIterations} samples or a confidence estimate`,
      );
    }

    const survivorIds = new Set(outcome.survivors.map((m) => m.candidateId));
    active = active.filter((c) => survivorIds.has(c.id));
    if (active.length === 0) break;
  }

  const budgetDropped = new Set(droppedWhileAlive);
  const finalMeasured = [...states.values()]
    .filter((s) => s.status === 'measured' && s.measurement && !budgetDropped.has(s.candidate.id))
    .map((s) => s.measurement!);
  const tie = unresolvedTie(finalMeasured, opts.plan.retentionFactor, {
    correctForMultipleComparisons: opts.plan.correctForMultipleComparisons,
    looks: lastLooks,
  }).map((m) => m.candidateId);

  // RANKED BY REFINEMENT FIRST, THEN BY MEAN. stageIndex is the tier (how far search took it).
  // Candidates without measurement sort last. Everything downstream reads this order.
  const tierOf = (s: CandidateState): number => s.measurement ? s.measurement.stageIndex : -1;
  const ranked = [...states.values()].sort((a, b) => {
    const tier = tierOf(b) - tierOf(a);
    if (tier !== 0) return tier;
    return (b.measurement?.mean ?? -Infinity) - (a.measurement?.mean ?? -Infinity);
  });

  const missing = ranked.filter((s) => s.status === 'missing');
  if (missing.length) {
    warnings.push(`${missing.length} candidates were absent from the engine report and have no result`);
  }

  return {
    baseline,
    candidates: ranked,
    unresolvedTie: tie.length > 1 ? tie : [],
    truncated,
    droppedWhileAlive: [...new Set(droppedWhileAlive)],
    stagesRun: stagesRun.filter(Boolean),
    // Deduplicated; per-batch loop produces duplicates which are noise and duplicate keys for {#each}.
    warnings: [...new Set(warnings)],
    problems: [...new Set(problems)],
    incomplete,
  };
}

function combineTargetReached(a: boolean | null, b: boolean | null): boolean | null {
  if (a === null) return b;
  if (b === null) return a;
  return a && b;
}

/** Grace period after aborting for adapter to settle; bounds wait before concluding abort wasn't honored. */
const ABORT_GRACE_MS = 5_000;

export class BatchTimeoutError extends Error {
  constructor(what: string, ms: number, readonly abandoned: boolean) {
    super(
      `${what} did not settle within ${Math.round(ms / 1000)}s` +
      (abandoned ? ', and did not stop when cancelled — the engine may still be running' : ''),
    );
    this.name = 'BatchTimeoutError';
  }
}

/** Runs one batch so every way out cancels the engine, not just settles our promise. Abort is the mechanism, not a race. */
async function runBatchAborting(
  opts: SearchOptions,
  accuracy: Accuracy,
  batch: Candidate[],
  onCandidateProgress: (completedInBatch: number) => void,
  hooks: { what: string; onAbandoned: (message: string) => void },
): Promise<ProfilesetOutcome> {
  const controller = new AbortController();
  const ms = opts.batchTimeoutMs;
  const graceMs = opts.abortGraceMs ?? ABORT_GRACE_MS;

  // Chain caller's signal in so search cancel reaches engine.
  const outer = opts.signal;
  const relay = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', relay, { once: true });
  }

  let timedOut = false;
  let settled = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbortArmGrace: (() => void) | undefined;

  if (ms && Number.isFinite(ms) && ms > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort(new BatchTimeoutError(hooks.what, ms, false));
    }, ms);
  }

  // Grace clock starts when abort is issued (timeout or caller cancel); arms on abort for coherent policy.
  const graceExpired = new Promise<never>((_, reject) => {
    const arm = () => {
      if (settled) return;
      graceTimer = setTimeout(() => {
        // Race may be won between arm and fire; check settled to avoid false abandonment after teardown.
        if (settled) return;
        hooks.onAbandoned(
          `${hooks.what}: cancellation was not honoured within ${graceMs / 1000}s; ` +
          'the engine may still be running and the next batch will contend with it',
        );
        reject(new BatchTimeoutError(hooks.what, ms ?? graceMs, true));
      }, graceMs);
    };
    if (controller.signal.aborted) arm();
    else {
      onAbortArmGrace = arm;
      controller.signal.addEventListener('abort', arm, { once: true });
    }
  });
  // Rejection after race settles would be unhandled; settled gate prevents it.
  graceExpired.catch(() => {});

  try {
    const running = opts.runBatch({
      profile: opts.profile,
      accuracy,
      minIterations: opts.plan.minIterations,
      profilesets: batch.map((c) => ({ id: c.id, lines: c.lines })),
      signal: controller.signal,
      // Bounded by batch so adapter over-reporting doesn't push count past actual work.
      onCandidateProgress: (done) => onCandidateProgress(Math.max(0, Math.min(batch.length, done))),
    });

    // Await adapter settlement (engine stopping); grace branch detects adapters that ignore abort.
    return await Promise.race([running, graceExpired]);
  } catch (err) {
    // Adapter-honored timeout surfaces as AbortError; report as timeout, not user cancellation.
    if (timedOut && isAbortError(err)) throw new BatchTimeoutError(hooks.what, ms!, false);
    throw err;
  } finally {
    // Mark settled BEFORE clearing so queued callback sees flag and does nothing.
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (onAbortArmGrace) controller.signal.removeEventListener('abort', onAbortArmGrace);
    outer?.removeEventListener('abort', relay);
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'BatchTimeoutError');
}

/** Latest measurement of every candidate with one, for the pass source. */
function latestMeasurements(states: Map<string, CandidateState>): CandidateMeasurement[] {
  return [...states.values()]
    .filter((s) => s.status === 'measured' && s.measurement)
    .map((s) => s.measurement!);
}

/** Same key = same engine job. */
function accuracyKey(accuracy: Accuracy): string {
  return accuracy.mode === 'iterations'
    ? `i${accuracy.iterations}`
    : `e${accuracy.targetError}:${accuracy.maxIterations}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
