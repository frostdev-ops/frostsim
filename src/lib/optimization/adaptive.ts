// Adaptive racing search (P08.16): coarse survey → precision-matched re-measuring → verification, stopping when leader is separated or budget exhausted.

import {
  DEFAULT_MAX_ITERATIONS, memoryCache, runPassSearch,
  type PassPlan, type PassSource, type ResultCache, type RunBatch, type SearchLedger,
} from './runner';
import { multiplicityFactor } from './statistics';
import type {
  Accuracy, Candidate, CandidateMeasurement, OptimizationProgress, OptimizationResult,
} from './types';

/** Everything the search needs to reach the engine. Stable: A3 depends on it. */
export interface AdaptiveContext {
  /** Baseline profile text. Never edited. */
  profile: string;
  catalogId: string;
  /** From the engine manifest. Without it nothing is cached across runs. */
  engineIdentity?: string | null;
  runBatch: RunBatch;
  cache?: ResultCache;
  ledger?: SearchLedger;
  onProgress?: (p: OptimizationProgress) => void;
  batchTimeoutMs?: number;
  abortGraceMs?: number;
}

/** What the user asked for, plus the knobs the loop is allowed to spend. */
export interface AdaptiveOptions {
  /** Final precision, percent of DPS. This is the user's accuracy setting. */
  targetError: number;
  /** Hard per-candidate iteration ceiling at any precision. */
  maxIterations?: number;
  /**
   * Total engine samples the whole search may spend. When it is reached the loop
   * stops and the result says `budgetExhausted`, rather than quietly finishing.
   */
  iterationBudget?: number;
  /** Wall-clock ceiling, same honesty rule as `iterationBudget`. */
  timeBudgetMs?: number;
  /** Candidates re-measured in the independent verification pass. 0 disables it. */
  finalists?: number;
  /** Precision for the verification pass. Defaults to `targetError`. */
  verifyTargetError?: number;
  /** Run only the verification pass, over the candidates given. */
  verifyOnly?: boolean;
  /** Below this iteration count a candidate is never eliminated. */
  minIterations?: number;
  retentionFactor?: number;
  correctForMultipleComparisons?: boolean;
  /**
   * Hard cap on survivors carried into the next pass. Unbounded by default: the
   * separation rule decides who lives, and a budget that overrides it makes the
   * result non-exhaustive, which is reported but is not something to do by default.
   */
  maxSurvivors?: number;
  /** Candidates per engine job — the cancellation checkpoint. */
  batchSize?: number;
  /** Passes the loop may run before it gives up and reports what it has. */
  maxPasses?: number;
}

export interface AdaptivePass {
  label: string;
  /** Tightest precision this pass ran at, percent of DPS. */
  targetError: number;
  candidates: number;
  /** Engine samples this pass consumed. */
  samples: number;
}

/** Extends `OptimizationResult`; never replaces a field of it. */
export interface AdaptiveResult extends OptimizationResult {
  passes: AdaptivePass[];
  /** True when the loop stopped on the iteration or time budget, not on an answer. */
  budgetExhausted: boolean;
  /** True when the finalists were re-measured independently at the final precision. */
  verified: boolean;
  /** Total engine samples the search consumed. */
  samplesSpent: number;
}


// --- Precision allocation (pure, testable decisions the loop makes) ---

/** Engine samples for first pass: ~1,400 iter/s on 16 threads means 400k samples ≈ 5 min survey. */
export const SURVEY_SAMPLE_BUDGET = 400_000;

/** Survey floor: 1% separates candidates ~2.5% behind leader (with multiplicity correction). */
export const SURVEY_FLOOR_TARGET_ERROR = 1;

/** A target error looser than this measures nothing useful. */
export const MAX_TARGET_ERROR = 5;

/** simc's `confidence_estimator` at the default 95% confidence. */
const Z_95 = 1.96;

/** Seed CV: 0.03 (measured 0.0244-0.031); too loose avoids over-pricing first pass. */
export const NOMINAL_CV = 0.03;

/** Samples for target error: n = (100*z*cv/targetError)² per simc's stopping rule, capped. */
export function samplesForTargetError(
  targetError: number,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  cv = NOMINAL_CV,
): number {
  if (!(targetError > 0)) return maxIterations;
  return Math.min(maxIterations, Math.ceil(((100 * Z_95 * cv) / targetError) ** 2));
}

/** The precision the shipped ladder ends at, used only as a default. */
const REFERENCE_TARGET_ERROR = 0.2;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Ceiling does not scale with target error: prevents volatile candidates from triggering noise on ties. */
export function accuracyFor(targetError: number, maxIterations = DEFAULT_MAX_ITERATIONS): Accuracy {
  return { mode: 'targetError', targetError, maxIterations };
}

/** First pass precision: budget / N samples per candidate inverted into target error. */
export function coarseTargetError(
  count: number,
  finalTargetError: number,
  opts: { surveySamples?: number; cv?: number; floor?: number; maxIterations?: number } = {},
): number {
  const budget = opts.surveySamples ?? SURVEY_SAMPLE_BUDGET;
  const perCandidate = Math.max(1, budget / Math.max(1, count));
  // Test iterations not predicted target error: budget arithmetic is stable vs. seed drift.
  if (perCandidate >= (opts.maxIterations ?? DEFAULT_MAX_ITERATIONS)) return finalTargetError;
  const te = (100 * Z_95 * (opts.cv ?? NOMINAL_CV)) / Math.sqrt(perCandidate);
  // Floor prevents wasting precision on soon-discarded candidates; cap respects budget.
  return clamp(Math.max(te, opts.floor ?? SURVEY_FLOOR_TARGET_ERROR), finalTargetError, MAX_TARGET_ERROR);
}

/** Affordable survivors: same budget per pass, so precision-doubled field falls fourfold. */
export function affordableSurvivors(
  targetError: number,
  opts: { budget?: number; maxIterations?: number; floor?: number; cv?: number } = {},
): number {
  const budget = opts.budget ?? SURVEY_SAMPLE_BUDGET;
  const perCandidate = samplesForTargetError(targetError, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS, opts.cv);
  return Math.max(opts.floor ?? 8, Math.floor(budget / Math.max(1, perCandidate)));
}

/** The precision a measurement actually achieved, as a percentage of its mean. */
export function achievedTargetError(m: { mean: number; margin: number | null }): number {
  if (m.margin === null || !Number.isFinite(m.margin) || !(m.mean > 0)) return Infinity;
  return (m.margin / m.mean) * 100;
}

/** CV from measurement: invert simc's rule margin = z*stddev/sqrt(n) → cv = (margin/mean)*sqrt(n)/z. */
export function cvOf(m: { mean: number; margin: number | null; iterations: number }): number | null {
  const achieved = achievedTargetError(m);
  if (!Number.isFinite(achieved) || !(m.iterations > 0)) return null;
  return (achieved * Math.sqrt(m.iterations)) / (100 * Z_95);
}

/** Field CV from measurements (median, not mean): self-corrects cost model after first pass. */
export function estimateCv(
  measurements: readonly { mean: number; margin: number | null; iterations: number }[],
  fallback = NOMINAL_CV,
): number {
  const cvs = measurements
    .map(cvOf)
    .filter((cv): cv is number => cv !== null && cv > 0)
    .sort((a, b) => a - b);
  return cvs.length ? cvs[Math.floor(cvs.length / 2)] : fallback;
}

/** Required precision to separate: gap / (factor*sqrt(2)) with safety divisor; clamped to final. */
export function requiredTargetError(
  candidate: { mean: number },
  leader: { mean: number },
  opts: { factor: number; finalTargetError: number; safety?: number },
): number {
  const gap = leader.mean - candidate.mean;
  if (!(gap > 0) || !(candidate.mean > 0)) return opts.finalTargetError;
  const k = Math.SQRT2 * Math.max(1e-6, opts.factor) * (opts.safety ?? 1.15);
  return clamp((100 * (gap / k)) / candidate.mean, opts.finalTargetError, MAX_TARGET_ERROR);
}

/** Quantize precision: snap to power-of-2 steps, so similar needs share one job (always tighter). */
export function quantizeTargetError(targetError: number, finalTargetError: number): number {
  if (!(targetError > finalTargetError)) return finalTargetError;
  const steps = Math.floor(Math.log2(targetError / finalTargetError));
  return finalTargetError * 2 ** Math.max(0, steps);
}

export interface Allocation {
  /** Target error per candidate id. */
  byId: Map<string, number>;
  /** The tightest precision in the allocation; the leader and baseline run at it. */
  tightest: number;
  /** False when all contenders at final precision and still inseparable (honest tie, no more passes). */
  progresses: boolean;
}

/** Allocate precision: each contender gets required precision for its gap, tightened ≥2x (D12). */
export function allocatePrecision(
  survivors: CandidateMeasurement[],
  opts: {
    finalTargetError: number;
    retentionFactor?: number;
    correctForMultipleComparisons?: boolean;
    confidence?: number;
    looks?: number;
    safety?: number;
    /** Iteration ceiling: candidate at it cannot tighten (would rerun for same margin). */
    maxIterations?: number;
    /** Comparison group (Great Vault rewards): missing this prices all candidates against global leader. */
    groupOf?: (candidateId: string) => string;
  },
): Allocation {
  const byId = new Map<string, number>();
  const ranked = [...survivors].filter((m) => Number.isFinite(m.mean)).sort((a, b) => b.mean - a.mean);
  const leader = ranked[0];
  if (!leader) return { byId, tightest: opts.finalTargetError, progresses: false };

  const correction = opts.correctForMultipleComparisons === false
    ? 1
    : multiplicityFactor(ranked.length - 1, opts.confidence ?? leader.confidence ?? 0.95, opts.looks ?? 1);
  const factor = (opts.retentionFactor ?? 1) * correction;

  // Ranked is sorted: first of each group is that group's leader.
  const groupLeaders = new Map<string, CandidateMeasurement>();
  if (opts.groupOf) {
    for (const m of ranked) {
      const key = opts.groupOf(m.candidateId);
      if (!groupLeaders.has(key)) groupLeaders.set(key, m);
    }
  }

  let progresses = false;
  /** Precision `m` needs, given everything it still has to be separated from. */
  const precisionFor = (m: CandidateMeasurement): number => {
    const rivals = [leader, opts.groupOf ? groupLeaders.get(opts.groupOf(m.candidateId)) : undefined]
      .filter((r): r is CandidateMeasurement => !!r && r !== m);
    // Tightest requirement wins (candidate vs group leader & global leader).
    const required = rivals.length
      ? Math.min(...rivals.map((r) => requiredTargetError(m, r, { factor, finalTargetError: opts.finalTargetError, safety: opts.safety })))
      : opts.finalTargetError;
    const achieved = achievedTargetError(m);
    // At least 2x tighten: every pass quadruples samples asked for (loop terminates).
    const tighten = Number.isFinite(achieved) ? achieved / 2 : required;
    return quantizeTargetError(
      clamp(Math.min(required, tighten), opts.finalTargetError, MAX_TARGET_ERROR),
      opts.finalTargetError,
    );
  };

  for (const m of ranked) {
    if (m === leader) continue; // Priced last, off what the contenders need.
    const te = precisionFor(m);
    byId.set(m.candidateId, te);
    const capped = opts.maxIterations !== undefined && m.iterations >= opts.maxIterations;
    if (!capped && te < achievedTargetError(m) * 0.99) progresses = true;
  }

  // Leader priced last (off contenders, not vice versa): tightest matches what contenders need.
  const contenderIds = [...byId.keys()];
  const tightest = byId.size ? Math.min(...byId.values()) : opts.finalTargetError;
  const leaderAchieved = achievedTargetError(leader);
  // Never ask leader for looser target (widens margin, unseparates). Keep quantized. Three-way min.
  const leaderCap = Number.isFinite(leaderAchieved) ? leaderAchieved : tightest;
  byId.set(
    leader.candidateId,
    Math.min(tightest, leaderCap, quantizeTargetError(leaderCap, opts.finalTargetError)),
  );

  mergeUnprofitableBuckets(byId, ranked, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);

  // Recomputed over contenders only (leader excluded: must not pin pass precision).
  const merged = contenderIds.map((id) => byId.get(id)!);
  return { byId, tightest: merged.length ? Math.min(...merged) : tightest, progresses };
}

/** Fold buckets: each job costs m+1 simulations (m candidates + base actor). Merges priced by projectedSamples. */
function mergeUnprofitableBuckets(
  byId: Map<string, number>,
  ranked: CandidateMeasurement[],
  maxIterations: number,
): void {
  // Loosest first: each bucket offered to next tighter, so chains collapse in one sweep.
  const levels = [...new Set(byId.values())].sort((a, b) => b - a);
  for (let i = 0; i < levels.length - 1; i++) {
    const loose = levels[i];
    const tight = levels[i + 1];
    const members = ranked.filter((m) => byId.get(m.candidateId) === loose);
    if (members.length === 0) continue;
    const extra = members.reduce(
      (n, m) => n + projectedSamples(m, tight, maxIterations) - projectedSamples(m, loose, maxIterations),
      0,
    );
    // Separate job costs: one more base-actor simulation (conservative: unpriced wasm instantiation).
    if (extra <= projectedSamples(ranked[0], loose, maxIterations)) {
      for (const m of members) byId.set(m.candidateId, tight);
    }
  }
}

/** Projected samples: from real data (candidate reaching 1% in 3k needs 4x for 0.5%), or ceiling. */
export function projectedSamples(
  m: { iterations: number; mean: number; margin: number | null },
  targetError: number,
  maxIterations = DEFAULT_MAX_ITERATIONS,
): number {
  const ceiling = maxIterations;
  const achieved = achievedTargetError(m);
  if (!Number.isFinite(achieved) || !(m.iterations > 0)) return ceiling;
  return Math.min(ceiling, Math.ceil(m.iterations * (achieved / targetError) ** 2));
}

// --- The loop (races candidates, verifies finalists) ---
export async function runAdaptiveSearch(
  candidates: Candidate[],
  ctx: AdaptiveContext,
  opts: AdaptiveOptions,
  signal?: AbortSignal,
): Promise<AdaptiveResult> {
  const finalTargetError = clamp(
    Number.isFinite(opts.targetError) ? opts.targetError : REFERENCE_TARGET_ERROR,
    0.01,
    MAX_TARGET_ERROR,
  );
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const finalists = opts.finalists ?? 5;
  const verifyTargetError = clamp(opts.verifyTargetError ?? finalTargetError, 0.01, MAX_TARGET_ERROR);
  const batchSize = Math.max(1, opts.batchSize ?? 25);
  const coarse = coarseTargetError(candidates.length, finalTargetError, { maxIterations: opts.maxIterations });
  // Every pass same budget: precision doubles → survivors fall fourfold (hence derived, not written).
  const passBudget = opts.iterationBudget !== undefined
    ? Math.max(1, opts.iterationBudget / 4)
    : SURVEY_SAMPLE_BUDGET;
  // Every pass at least halves target error (race is bounded).
  const racePasses = Math.max(1, Math.ceil(Math.log2(Math.max(2, coarse / finalTargetError))));
  const maxPasses = Math.max(2, opts.maxPasses ?? racePasses + 2);
  // Union bound counts maxPasses (honest ceiling): first pass may open at final precision.
  const looks = maxPasses;

  const plan = {
    version: 1,
    retentionFactor: opts.retentionFactor ?? 1,
    minIterations: opts.minIterations ?? 200,
    correctForMultipleComparisons: opts.correctForMultipleComparisons,
    stages: [],
  };

  // First pass: precision from seed CV, cost from survey budget (caps seed under-pricing ceiling runs).
  const surveyMaxIterations = clamp(
    Math.floor(passBudget / Math.max(1, candidates.length)),
    Math.min(plan.minIterations, maxIterations),
    maxIterations,
  );

  const baselineIds = candidates.filter((c) => c.lines.length === 0).map((c) => c.id);
  // Great Vault per-reward retention must match precision grouping or allocation never refines.
  const vaultGroups = new Map(candidates.map((c) => [c.id, c.provenance.vaultRewardId ?? '']));
  const groupOf = candidates.some((c) => c.provenance.vaultRewardId)
    ? (id: string) => vaultGroups.get(id) ?? ''
    : undefined;
  const warnings: string[] = [];
  let budgetExhausted = false;
  let verified = false;

  /** Verify cost (for progress bar to include upfront). */
  const verifyCost = (chosen: CandidateMeasurement[]): number =>
    chosen.reduce((n, m) => n + projectedSamples(m, verifyTargetError, maxIterations), 0);

  const verifyPass = (ids: string[], stageCount: number, estimatedSamplesRemaining?: number): PassPlan => ({
    estimatedSamplesRemaining,
    label: 'Verify',
    accuracy: accuracyFor(verifyTargetError, maxIterations),
    maxSurvivors: ids.length,
    batchSize: Math.max(1, Math.min(batchSize, ids.length)),
    restrictTo: ids,
    // Measure and report (eliminating would recreate the selection bias being removed).
    noElimination: true,
    // Fresh samples (cache hit would only repeat the measurement that got here).
    noCache: true,
    stageCount,
    looks,
  });

  /** Independent verification pass, or null if nothing left. */
  const finalPass = (survivors: CandidateMeasurement[]): PassPlan | null => {
    if (finalists <= 0) return null;
    const ranked = [...survivors].sort((a, b) => b.mean - a.mean);
    const ids = new Set(ranked.slice(0, finalists).map((m) => m.candidateId));
    for (const id of baselineIds) ids.add(id);
    if (ids.size === 0) return null;
    if (ranked.length > finalists) {
      warnings.push(
        `${ranked.length} candidates were still inseparable, so only the top ${finalists} were re-measured independently; the rest keep their measurement from the racing passes`,
      );
    }
    verified = true;
    // maxPasses (not stageIndex+1): planned ceiling is stable; shows as "up to N".
    return verifyPass([...ids], maxPasses, verifyCost(ranked.slice(0, finalists)));
  };

  const source: PassSource = ({ stageIndex, measured, active, samplesSpent, elapsedMs }) => {
    const overBudget =
      (opts.iterationBudget !== undefined && samplesSpent >= opts.iterationBudget) ||
      (opts.timeBudgetMs !== undefined && elapsedMs >= opts.timeBudgetMs);

    if (opts.verifyOnly) {
      if (stageIndex > 0) return null;
      verified = true;
      return verifyPass(active.map((c) => c.id), 1, active.length * samplesForTargetError(verifyTargetError, maxIterations));
    }

    if (stageIndex === 0) {
      return {
        label: 'Survey',
        accuracy: accuracyFor(coarse, surveyMaxIterations),
        // What next pass can afford (this budget bounds it).
        maxSurvivors: opts.maxSurvivors ?? affordableSurvivors(coarse / 2, { budget: passBudget, maxIterations }),
        // Survey is the one pass with whole field; larger job, trade later for tighter cancellation.
        batchSize: Math.max(batchSize, 100),
        stageCount: maxPasses,
        looks,
        // Nothing measured yet: seed-CV planning figure, bounded by pass's iteration cap.
        estimatedSamplesRemaining: candidates.length * samplesForTargetError(coarse, surveyMaxIterations),
      };
    }

    const aliveIds = new Set(active.map((c) => c.id));
    const survivors = measured.filter((m) => aliveIds.has(m.candidateId) && Number.isFinite(m.mean));
    // Engine reported: survivor budget priced off field's own noise (not seed).
    const cv = estimateCv(measured);

    // Stopping conditions in order: answer (leader separated) before budget exhausted.

    // (i) Leader separated from everything: nothing left to race.
    if (survivors.length <= 1) return finalPass(survivors);

    const allocation = allocatePrecision(survivors, {
      finalTargetError,
      retentionFactor: opts.retentionFactor,
      correctForMultipleComparisons: opts.correctForMultipleComparisons,
      looks,
      maxIterations,
      groupOf,
    });
    // (ii) All survivors at final precision, still inseparable (honest unresolved tie).
    if (!allocation.progresses) return finalPass(survivors);

    // (iii) Work remains and budget gone (now true, after (i) and (ii) checked).
    if (overBudget) {
      budgetExhausted = true;
      warnings.push(
        'the search stopped on its iteration or time budget before the leader was separated from every rival; ' +
        'the ranking below is what had been measured when it ran out',
      );
      return null;
    }

    // (iv) Pass ceiling: reached when field cannot resolve within precision budget.
    if (stageIndex >= maxPasses - 1) {
      budgetExhausted = true;
      warnings.push(
        `the search reached its ${maxPasses}-pass ceiling with ${survivors.length} candidates still inseparable`,
      );
      return finalPass(survivors);
    }

    // Candidate at iteration ceiling: keeps measurement, stops being paid for (2.2x savings on volatile).
    const racing = survivors.filter((m) => m.iterations < maxIterations);
    const estimated = racing.reduce(
      (n, m) => n + projectedSamples(m, allocation.byId.get(m.candidateId) ?? allocation.tightest, maxIterations),
      0,
    );
    return {
      label: `Race ${stageIndex}`,
      restrictTo: [...new Set([...racing.map((m) => m.candidateId), ...baselineIds])],
      // Pass nominal precision is tightest; candidates run looser per their gap to leader.
      accuracy: accuracyFor(allocation.tightest, maxIterations),
      accuracyFor: (id) => accuracyFor(allocation.byId.get(id) ?? allocation.tightest, maxIterations),
      maxSurvivors: opts.maxSurvivors ?? affordableSurvivors(allocation.tightest / 2, { budget: passBudget, maxIterations, cv }),
      batchSize,
      stageCount: maxPasses,
      looks,
      // Verification counted here (not discovered later), so progress bar doesn't go backward.
      estimatedSamplesRemaining: estimated + verifyCost([...survivors].sort((a, b) => b.mean - a.mean).slice(0, finalists)),
    };
  };

  const result = await runPassSearch(
    candidates,
    {
      profile: ctx.profile,
      plan,
      catalogId: ctx.catalogId,
      engineIdentity: ctx.engineIdentity,
      runBatch: ctx.runBatch,
      cache: ctx.cache ?? memoryCache(),
      ledger: ctx.ledger,
      signal,
      onProgress: ctx.onProgress,
      batchTimeoutMs: ctx.batchTimeoutMs,
      abortGraceMs: ctx.abortGraceMs,
    },
    source,
  );

  // Some rows not at user's precision (racing stops paying separated candidates); each row shows its own margin.
  const belowRequested = result.candidates.filter((state) => {
    const m = state.measurement;
    return m && Number.isFinite(m.mean) && achievedTargetError(m) > finalTargetError * 1.05;
  }).length;
  if (belowRequested > 0) {
    warnings.push(
      `${belowRequested} of ${result.candidates.length} candidates were separated before reaching ${finalTargetError}% ` +
      'and keep the wider measurement from the pass that eliminated them; each row states its own margin',
    );
  }

  return {
    ...result,
    warnings: [...new Set([...result.warnings, ...warnings])],
    passes: result.stagesRun.map((s) => ({
      label: s.label,
      targetError: s.accuracy.mode === 'targetError' ? s.accuracy.targetError : 0,
      candidates: s.candidates,
      samples: s.samples ?? 0,
    })),
    budgetExhausted,
    verified,
    samplesSpent: result.stagesRun.reduce((n, s) => n + (s.samples ?? 0), 0),
  };
}
