// Selection validation (P08.10): tests the decision rule via a known-truth noise model; re-based 2026-09-15 to use real cv=0.0244 and min iterations floor instead of guesses.

import { runStagedSearch, type ProfilesetOutcome, type ProfilesetRequest } from './runner';
import { runAdaptiveSearch, type AdaptiveOptions } from './adaptive';
import type { Accuracy, Candidate, OptimizationResult, StagePlan } from './types';

/** simc's `confidence_estimator` at the default 95% confidence. */
export const Z_95 = 1.96;

/** Per-iteration cv measured on the reference profile: 0.0244. Sweep cv to test noisier specs. */
export const MEASURED_CV = 0.0244;

/** Engine's iteration floor at 210-225 from minIterations=200 and convergence checks; modeled from fifth browser run. */
export const ENGINE_MIN_ITERATIONS = 210;

/** Field spread from real upgrade decisions, measured at 0.1-0.3% apart; default 1.5%. */
export const DEFAULT_FIELD_SPREAD_PERCENT = 1.5;

/** Volatility ratio (noisy to stable candidates) in heteroskedastic tests; 5x ratio. */
export const VOLATILE_CV_MULTIPLE = 5;

/** Reference DPS; exact value cancels out since separations are percentages. */
const BASE_DPS = 200_000;

/** Shape knobs shared by every population builder. */
export interface PopulationOptions {
  /**
   * Per-iteration cv of a typical candidate in the field. Defaults to
   * `MEASURED_CV`; pass 0.3 to reproduce the pre-2026-09-15 harness, or sweep it to
   * cover specs noisier than the reference profile.
   */
  cv?: number;
  /** Leader-to-last spread of the tail. Defaults to `DEFAULT_FIELD_SPREAD_PERCENT`. */
  fieldSpreadPercent?: number;
}

/** Evenly spaced descending tail from leader to spread; shared shape across all populations. */
function tail(n: number, spreadPercent: number): (i: number) => number {
  const step = n > 1 ? spreadPercent / 100 / (n - 1) : 0;
  return (i) => BASE_DPS * (1 - i * step);
}

export interface SyntheticCandidate {
  id: string;
  /** The mean this candidate would converge to given unlimited samples. */
  trueMean: number;
  /**
   * Per-iteration coefficient of variation (stddev / mean). Drives how many
   * samples the candidate needs and how wide its margin ends up.
   *
   * `MEASURED_CV` (0.0244) is what the engine reports on the reference profile.
   * The figure that used to be here — "0.2-0.5 for a stable spec" — was an
   * estimate, and the browser run refuted it by an order of magnitude.
   */
  cv: number;
}

export interface TrialOutcome {
  /** The candidate with the highest true mean. */
  trueBestId: string;
  /** Whom the search ranked first. */
  reportedBestId: string | null;
  /**
   * True when the STATISTICAL RULE eliminated the true best — it claimed the
   * leader was separated from it. This is a defect: the rule made a confident
   * claim that was false.
   */
  falseElimination: boolean;
  /**
   * True when the true best was still statistically alive but fell outside the
   * stage's survivor budget. NOT a defect: the result reports `truncated` and
   * names the dropped ids, so the search says it was not exhaustive. Measured
   * separately because it is the honest cost of the budget, and a user choosing
   * a budget deserves to know it.
   */
  droppedByBudget: boolean;
  /**
   * True when a different candidate was ranked first, no tie was declared, and the
   * true best was not budget-dropped — so the search really did claim a winner it
   * had not beaten.
   */
  wrongWinnerStated: boolean;
  /**
   * True when the true best was not ranked first but WAS named in the unresolved
   * tie. The search did not pick it, but it did not claim to have beaten it either.
   */
  coveredByTie: boolean;
  /** How far ahead the true best really was, as a percentage of the runner-up. */
  trueMarginPercent: number;
  measuredCandidates: number;
  /**
   * Engine samples the whole search consumed. The comparison that decides whether
   * the adaptive search is worth having: it must not be worse on false
   * eliminations, and it should cost materially less here.
   */
  samples: number;
}

export interface ValidationSummary {
  trials: number;
  /** Inclusive seed range these trials used, so a rate is attributable. */
  seeds: [number, number];
  falseEliminations: number;
  /** The number that matters: eliminations of the true best, as a rate. */
  falseEliminationRate: number;
  /** 95% Wilson interval on the false-elimination rate. */
  falseEliminationCI: [number, number];
  droppedByBudget: number;
  /** How often the survivor budget, not the statistics, cost the search its winner. */
  droppedByBudgetRate: number;
  wrongWinnersStated: number;
  wrongWinnerRate: number;
  /** 95% Wilson interval on the wrong-winner rate. */
  wrongWinnerCI: [number, number];
  coveredByTie: number;
  /** Mean engine samples per trial. */
  meanSamples: number;
  outcomes: TrialOutcome[];
}

/**
 * 95% Wilson score interval for a proportion.
 *
 * Reported alongside every rate because a rate from 200 trials is an estimate, and
 * "1.0%" from 200 trials is consistent with anything from roughly 0.2% to 4%. Wilson
 * rather than the normal approximation because these proportions sit near zero,
 * where the normal interval runs below zero and stops meaning anything.
 */
export function wilson(successes: number, n: number, z = Z_95): [number, number] {
  if (n <= 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / denom), Math.min(1, (centre + spread) / denom)];
}

/** Deterministic RNG, seeded so failing trials replay exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: one normal per call, second value discarded. */
export function normal(rng: () => number, mean: number, sd: number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Samples to reach precision, bounded by ceiling (maxIterations) and floor (minIterations=ENGINE_MIN_ITERATIONS). */
export function sampleFor(
  candidate: SyntheticCandidate,
  accuracy: Accuracy,
  z = Z_95,
  minIterations = ENGINE_MIN_ITERATIONS,
): { iterations: number; margin: number; targetReached: boolean } {
  if (accuracy.mode === 'iterations') {
    const n = Math.max(1, accuracy.iterations);
    return { iterations: n, margin: (z * candidate.cv * candidate.trueMean) / Math.sqrt(n), targetReached: true };
  }
  const needed = Math.ceil(((100 * z * candidate.cv) / accuracy.targetError) ** 2);
  const floor = Math.min(Math.max(1, minIterations), accuracy.maxIterations);
  const n = Math.max(floor, Math.min(needed, accuracy.maxIterations));
  return {
    iterations: n,
    margin: (z * candidate.cv * candidate.trueMean) / Math.sqrt(n),
    targetReached: needed <= accuracy.maxIterations,
  };
}

/** RunBatch from noise model: baseline on every batch, matching real reports. */
export function syntheticRunBatch(
  candidates: SyntheticCandidate[],
  rng: () => number,
  opts: {
    baseline?: SyntheticCandidate;
    engineIdentity?: string;
    z?: number;
    /** Correlation between same-batch candidates (0-1); common-mode shock per batch. */
    correlation?: number;
  } = {},
) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const z = opts.z ?? Z_95;
  const rho = Math.min(1, Math.max(0, opts.correlation ?? 0));
  return async (request: ProfilesetRequest): Promise<ProfilesetOutcome> => {
    let targetReached = true;
    // Floor is max of runner's request and ENGINE_MIN_ITERATIONS.
    const floor = Math.max(request.minIterations ?? 0, ENGINE_MIN_ITERATIONS);
    // Common-mode shock for the whole batch before any candidate.
    const shared = rho > 0 ? normal(rng, 0, 1) : 0;
    const draw = (mean: number, sd: number) =>
      rho > 0
        ? mean + sd * (Math.sqrt(rho) * shared + Math.sqrt(1 - rho) * normal(rng, 0, 1))
        : normal(rng, mean, sd);

    const results = request.profilesets.map(({ id }) => {
      const c = byId.get(id);
      if (!c) return { id, mean: 0, margin: null, iterations: 0 };
      const { iterations, margin, targetReached: ok } = sampleFor(c, request.accuracy, z, floor);
      if (!ok) targetReached = false;
      return { id, mean: draw(c.trueMean, margin / z), margin, iterations };
    });

    let baseline: ProfilesetOutcome['baseline'] = null;
    if (opts.baseline) {
      const { iterations, margin } = sampleFor(opts.baseline, request.accuracy, z, floor);
      baseline = { mean: draw(opts.baseline.trueMean, margin / z), margin, iterations };
    }

    return {
      results, baseline, confidence: 0.95, targetReached,
      engineIdentity: opts.engineIdentity ?? 'synthetic',
      problems: [],
    };
  };
}

/** Candidate objects for the runner from synthetic population. */
export function syntheticCandidates(population: SyntheticCandidate[]): Candidate[] {
  return population.map((c) => ({
    id: c.id,
    provenance: { kind: 'gear' as const, items: [], label: c.id },
    delta: {},
    cost: { unknownCosts: [] },
    // Real option line to exercise runner validation; synthetic adapter ignores it.
    lines: [`head=,id=${1000 + Number(c.id.replace(/\D/g, '') || 0)}`],
    canonical: c.id,
  }));
}

/** Scores search against known-truth population; shared by staged and adaptive trials. */
export function scoreTrial(population: SyntheticCandidate[], result: OptimizationResult): TrialOutcome {
  const sorted = [...population].sort((a, b) => b.trueMean - a.trueMean);
  const trueBest = sorted[0];
  const runnerUp = sorted[1] ?? sorted[0];

  const best = result.candidates.find((s) => s.candidate.id === trueBest.id);
  const reportedBestId = result.candidates.find((s) => s.status === 'measured')?.candidate.id ?? null;
  const droppedByBudget = result.droppedWhileAlive.includes(trueBest.id);
  // Budget-dropped also marked eliminated for next stage; distinguish by list membership.
  const falseElimination = best?.status === 'eliminated' && !droppedByBudget;
  const coveredByTie = result.unresolvedTie.includes(trueBest.id);

  return {
    trueBestId: trueBest.id,
    reportedBestId,
    falseElimination,
    droppedByBudget,
    wrongWinnerStated: reportedBestId !== trueBest.id && !coveredByTie && !droppedByBudget,
    coveredByTie,
    trueMarginPercent: ((trueBest.trueMean - runnerUp.trueMean) / runnerUp.trueMean) * 100,
    measuredCandidates: result.candidates.filter((s) => s.status === 'measured').length,
    samples: result.stagesRun.reduce((n, stage) => n + (stage.samples ?? 0), 0),
  };
}

/** Runs one staged search against noise model, reports outcome for true best. */
export async function runTrial(
  population: SyntheticCandidate[],
  plan: StagePlan,
  seed: number,
  opts: { correlation?: number } = {},
): Promise<TrialOutcome> {
  return scoreTrial(population, await runStagedSearch(syntheticCandidates(population), {
    profile: 'synthetic',
    plan,
    catalogId: 'synthetic',
    engineIdentity: 'synthetic',
    runBatch: syntheticRunBatch(population, mulberry32(seed), { correlation: opts.correlation }),
  }));
}

/** The same trial, run by the adaptive racing search instead of the fixed ladder. */
export async function runAdaptiveTrial(
  population: SyntheticCandidate[],
  adaptive: AdaptiveOptions,
  seed: number,
  opts: { correlation?: number } = {},
): Promise<TrialOutcome> {
  return scoreTrial(population, await runAdaptiveSearch(
    syntheticCandidates(population),
    {
      profile: 'synthetic',
      catalogId: 'synthetic',
      engineIdentity: 'synthetic',
      runBatch: syntheticRunBatch(population, mulberry32(seed), { correlation: opts.correlation }),
    },
    adaptive,
  ));
}

/** Repeats `runTrial` across seeds and reports the rates. */
export async function validateSelection(
  population: SyntheticCandidate[],
  plan: StagePlan,
  trials: number,
  firstSeed = 1,
  opts: { correlation?: number } = {},
): Promise<ValidationSummary> {
  const outcomes: TrialOutcome[] = [];
  for (let i = 0; i < trials; i++) outcomes.push(await runTrial(population, plan, firstSeed + i, opts));
  return summarize(outcomes, trials, firstSeed);
}

/** The same sweep, run by the adaptive racing search. */
export async function validateAdaptive(
  population: SyntheticCandidate[],
  adaptive: AdaptiveOptions,
  trials: number,
  firstSeed = 1,
  opts: { correlation?: number } = {},
): Promise<ValidationSummary> {
  const outcomes: TrialOutcome[] = [];
  for (let i = 0; i < trials; i++) outcomes.push(await runAdaptiveTrial(population, adaptive, firstSeed + i, opts));
  return summarize(outcomes, trials, firstSeed);
}

function summarize(outcomes: TrialOutcome[], trials: number, firstSeed: number): ValidationSummary {
  const falseEliminations = outcomes.filter((o) => o.falseElimination).length;
  const droppedByBudget = outcomes.filter((o) => o.droppedByBudget).length;
  const wrongWinnersStated = outcomes.filter((o) => o.wrongWinnerStated).length;
  return {
    trials,
    seeds: [firstSeed, firstSeed + trials - 1],
    falseEliminations,
    falseEliminationRate: falseEliminations / trials,
    falseEliminationCI: wilson(falseEliminations, trials),
    droppedByBudget,
    droppedByBudgetRate: droppedByBudget / trials,
    wrongWinnersStated,
    wrongWinnerRate: wrongWinnersStated / trials,
    wrongWinnerCI: wilson(wrongWinnersStated, trials),
    coveredByTie: outcomes.filter((o) => o.coveredByTie).length,
    meanSamples: outcomes.reduce((n, o) => n + o.samples, 0) / Math.max(1, trials),
    outcomes,
  };
}

/** Exhaustive reference: all candidates at final precision, no elimination; tests staged search approximation. */
export async function exhaustiveSearch(
  population: SyntheticCandidate[],
  plan: StagePlan,
  seed: number,
): Promise<{ rankedIds: string[]; unresolvedTie: string[] }> {
  const final = plan.stages[plan.stages.length - 1];
  const single: StagePlan = { ...plan, stages: [{ ...final, maxSurvivors: population.length, batchSize: population.length }] };
  const result = await runStagedSearch(syntheticCandidates(population), {
    profile: 'synthetic',
    plan: single,
    catalogId: 'synthetic',
    engineIdentity: 'synthetic',
    runBatch: syntheticRunBatch(population, mulberry32(seed)),
  });
  return {
    rankedIds: result.candidates.filter((s) => s.status === 'measured').map((s) => s.candidate.id),
    unresolvedTie: result.unresolvedTie,
  };
}

// --- Populations worth testing ---------------------------------------------

/** Clear winner: leader ahead by more than tail spacing, not eliminated except by defect; 0.3% lead. */
export function clearWinner(n: number, leadPercent = 0.3, opts: PopulationOptions = {}): SyntheticCandidate[] {
  const cv = opts.cv ?? MEASURED_CV;
  const rest = tail(n - 1, opts.fieldSpreadPercent ?? DEFAULT_FIELD_SPREAD_PERCENT);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    // leadPercent is the TRUE gap to runner-up; default 0.3% matches real upgrades.
    trueMean: i === 0 ? BASE_DPS * (1 + leadPercent / 100) : rest(i - 1),
    cv,
  }));
}

/** Near-ties: all candidates within whisker of leader; honest outcome is unresolved tie. */
export function nearTie(n: number, spreadPercent = 0.1, opts: PopulationOptions = {}): SyntheticCandidate[] {
  const cv = opts.cv ?? MEASURED_CV;
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    trueMean: BASE_DPS * (1 + ((n - 1 - i) * spreadPercent) / 100 / Math.max(1, n - 1)),
    cv,
  }));
}

/** Heteroskedastic: quiet leader, noisy rivals; broke tie-group assumption about ranking monotonicity. */
export function mixedVolatility(n: number, leadPercent = 0.2, opts: PopulationOptions = {}): SyntheticCandidate[] {
  const cv = opts.cv ?? MEASURED_CV;
  const rest = tail(n - 1, opts.fieldSpreadPercent ?? DEFAULT_FIELD_SPREAD_PERCENT);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    trueMean: i === 0 ? BASE_DPS * (1 + leadPercent / 100) : rest(i - 1),
    // Alternating noise so noisy sits below quiet; ratio tests heteroskedasticity.
    cv: i !== 0 && i % 2 === 0 ? cv * VOLATILE_CV_MULTIPLE : cv,
  }));
}

/** Flipping leader: top two so close order flips between stages; tests cross-stage dependence. */
export function flippingLeader(n: number, opts: PopulationOptions = {}): SyntheticCandidate[] {
  const cv = opts.cv ?? MEASURED_CV;
  const rest = tail(n - 2, opts.fieldSpreadPercent ?? DEFAULT_FIELD_SPREAD_PERCENT);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    // Top two differ by 0.002%: noise decides order every time, deliberately unresolvable.
    trueMean: i === 0 ? BASE_DPS * 1.00002 : i === 1 ? BASE_DPS : rest(i - 2),
    cv,
  }));
}

/** Volatile leader: genuinely ahead but VOLATILE_CV_MULTIPLE noisier; tests margin-aware rules. */
export function volatileLeader(n: number, leadPercent = 0.3, opts: PopulationOptions = {}): SyntheticCandidate[] {
  const cv = opts.cv ?? MEASURED_CV;
  const rest = tail(n - 1, opts.fieldSpreadPercent ?? DEFAULT_FIELD_SPREAD_PERCENT);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    trueMean: i === 0 ? BASE_DPS * (1 + leadPercent / 100) : rest(i - 1),
    cv: i === 0 ? cv * VOLATILE_CV_MULTIPLE : cv,
  }));
}
