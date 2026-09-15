// P08.10: does the staged search keep the actually best candidate? Real runStagedSearch against known-truth noise model; trial counts are regression gate.

import { describe, expect, it } from 'vitest';
import { DEFAULT_STAGE_PLAN } from './runner';
import { unresolvedTie } from './statistics';
import {
  ENGINE_MIN_ITERATIONS, MEASURED_CV, Z_95, clearWinner, exhaustiveSearch, flippingLeader,
  mixedVolatility, nearTie, normal, mulberry32, runTrial, sampleFor, validateAdaptive,
  validateSelection, volatileLeader, wilson,
} from './validation';
import type { AdaptiveOptions } from './adaptive';
import type { StagePlan } from './types';

/** Smaller ladder so a hundred trials finish in a test run. */
const PLAN: StagePlan = {
  ...DEFAULT_STAGE_PLAN,
  stages: [
    { label: 'Survey', accuracy: { mode: 'targetError', targetError: 1, maxIterations: 10_000 }, maxSurvivors: 20, batchSize: 10 },
    { label: 'Narrow', accuracy: { mode: 'targetError', targetError: 0.5, maxIterations: 12_000 }, maxSurvivors: 8, batchSize: 8 },
    { label: 'Finalists', accuracy: { mode: 'targetError', targetError: 0.2, maxIterations: 20_000 }, maxSurvivors: 8, batchSize: 8 },
  ],
};

describe('the noise model matches the engine stopping rule', () => {
  it('needs four times the samples for half the target error', () => {
    const c = { id: 'c', trueMean: 200_000, cv: 0.3 };
    const loose = sampleFor(c, { mode: 'targetError', targetError: 1, maxIterations: 1e9 });
    const tight = sampleFor(c, { mode: 'targetError', targetError: 0.5, maxIterations: 1e9 });
    expect(tight.iterations / loose.iterations).toBeCloseTo(4, 1);
  });

  it('hits the target margin when it converges, and a wider one when capped', () => {
    const c = { id: 'c', trueMean: 200_000, cv: 0.3 };
    const converged = sampleFor(c, { mode: 'targetError', targetError: 1, maxIterations: 1e9 });
    expect(converged.targetReached).toBe(true);
    // Margin as a percentage of the mean lands on the target.
    expect((converged.margin / c.trueMean) * 100).toBeCloseTo(1, 3);

    const capped = sampleFor({ ...c, cv: 2 }, { mode: 'targetError', targetError: 0.2, maxIterations: 5_000 });
    expect(capped.targetReached).toBe(false);
    expect((capped.margin / c.trueMean) * 100).toBeGreaterThan(0.2);
  });

  // Re-basing pinned: at measured cv, the floor (not target error) decides cost; harness without floor gives ~9x wider margins.
  it('floors a target-error run at the engine minimum, and overshoots the target there', () => {
    const c = { id: 'c', trueMean: 200_000, cv: MEASURED_CV };
    // Populations built at this cv by default; changes here cascade below.
    expect(clearWinner(4)[0].cv).toBe(MEASURED_CV);

    for (const targetError of [1, 0.7, 0.5]) {
      const run = sampleFor(c, { mode: 'targetError', targetError, maxIterations: 20_000 });
      // All three shipped defaults cost and achieve same ~0.33% (210-225 iterations, fifth browser measurement).
      expect(run.iterations).toBe(ENGINE_MIN_ITERATIONS);
      expect((run.margin / c.trueMean) * 100).toBeCloseTo(0.33, 2);
      expect(run.targetReached).toBe(true);
    }

    // Final precision is the first target that clears the floor.
    const fine = sampleFor(c, { mode: 'targetError', targetError: 0.2, maxIterations: 20_000 });
    expect(fine.iterations).toBeGreaterThan(ENGINE_MIN_ITERATIONS);
    expect((fine.margin / c.trueMean) * 100).toBeCloseTo(0.2, 3);

    // Raising the floor raises cost; ceiling still wins.
    expect(sampleFor(c, { mode: 'targetError', targetError: 1, maxIterations: 20_000 }, Z_95, 1_000).iterations).toBe(1_000);
    expect(sampleFor(c, { mode: 'targetError', targetError: 1, maxIterations: 50 }, Z_95, 1_000).iterations).toBe(50);
  });

  it('draws means whose spread matches the margin it reported', () => {
    const rng = mulberry32(7);
    const margin = 2_000;
    const draws = Array.from({ length: 4000 }, () => normal(rng, 200_000, margin / Z_95));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length);
    expect(mean).toBeGreaterThan(199_800);
    expect(mean).toBeLessThan(200_200);
    expect(sd).toBeCloseTo(margin / Z_95, -2);
  });
});

describe('a clear winner is never eliminated', () => {
  it('survives 100 searches over 40 candidates', async () => {
    const summary = await validateSelection(clearWinner(40, 3), PLAN, 100);
    expect(summary.falseEliminations).toBe(0);
    expect(summary.falseEliminationRate).toBe(0);
    // And it is actually named, not merely kept alive.
    expect(summary.wrongWinnersStated).toBe(0);
  });

  it('survives a lead smaller than the final stage precision', async () => {
    // 0.3% lead against a 0.2% final target error: separable, but not by much.
    const summary = await validateSelection(clearWinner(24, 0.3), PLAN, 100);
    expect(summary.falseEliminationRate).toBeLessThan(0.02);
  });
});

describe('near-ties are reported as ties rather than resolved by luck', () => {
  // A field this tight cannot be separated at a 0.2% target error: the margin on
  // the difference of two 0.2% measurements is 0.28%, and the whole spread is 0.1%.
  // So every elimination here is the rule claiming something it cannot know.
  const POPULATION = nearTie(12, 0.1);

  // Gate is the interval, not point estimate: union bound targets 5%, interval must not exceed it.
  it('holds the false-elimination rate under the bound the rule targets', async () => {
    const summary = await validateSelection(POPULATION, PLAN, 200);
    expect(summary.falseEliminationCI[1]).toBeLessThanOrEqual(0.08);
    expect(summary.falseEliminationRate).toBeLessThanOrEqual(0.05);
  });

  it('does not claim a winner it has not beaten', async () => {
    const summary = await validateSelection(POPULATION, PLAN, 200);
    expect(summary.wrongWinnerRate).toBeLessThanOrEqual(0.05);
  });

  it('reports the seeds behind a rate, so it is attributable', async () => {
    const summary = await validateSelection(POPULATION, PLAN, 50, 500);
    expect(summary.seeds).toEqual([500, 549]);
  });

  it('agrees on a disjoint holdout seed range', async () => {
    const calibration = await validateSelection(POPULATION, PLAN, 200, 1);
    const holdout = await validateSelection(POPULATION, PLAN, 200, 1_000_001);
    // The intervals must overlap; a rule whose behaviour depended on the seeds we
    // happened to look at would show up here and nowhere else.
    expect(holdout.falseEliminationCI[0]).toBeLessThanOrEqual(calibration.falseEliminationCI[1]);
    expect(calibration.falseEliminationCI[0]).toBeLessThanOrEqual(holdout.falseEliminationCI[1]);
  });

  it('separates the budget cost from the statistical one', async () => {
    // The survivor budget is 8 and the field is 12, so in a true tie the best
    // candidate falls outside the budget about a third of the time. That is not a
    // defect — the result reports it — but it must not be counted as one either.
    const summary = await validateSelection(POPULATION, PLAN, 100);
    expect(summary.droppedByBudgetRate).toBeGreaterThan(summary.falseEliminationRate);
  });

  // Regression protecting the multiplicity correction: without it, false-elimination rate rises several times.
  it('is several times worse without the multiple-comparison correction', async () => {
    const corrected = await validateSelection(POPULATION, PLAN, 100);
    const uncorrected = await validateSelection(
      POPULATION,
      { ...PLAN, correctForMultipleComparisons: false },
      100,
    );
    expect(uncorrected.falseEliminationRate).toBeGreaterThan(corrected.falseEliminationRate * 3);
    expect(uncorrected.wrongWinnerRate).toBeGreaterThan(corrected.wrongWinnerRate * 3);
  });
});

describe('dependence the correction does not assume away', () => {
  // Union bound holds under arbitrary dependence (claim about BOUND, not rule behavior); measure dependent cases.

  it('survives correlated batches, which is where independence would have been assumed', async () => {
    // Profilesets share fight length, target, RNG stream; differenceMargin assumes independence.
    for (const correlation of [0.5, 0.9]) {
      const summary = await validateSelection(nearTie(30, 0.05), PLAN, 200, 1, { correlation });
      expect(summary.falseEliminationRate).toBeLessThanOrEqual(0.05);
    }
  });

  it('survives a leader that changes between stages', async () => {
    // Top two differ 0.002%, leader decided by noise per stage, compared-against candidate varies.
    const summary = await validateSelection(flippingLeader(20), PLAN, 200);
    expect(summary.falseEliminationRate).toBeLessThanOrEqual(0.05);
  });

  it('survives unequal variances, where the ranking is not monotone in separability', async () => {
    const summary = await validateSelection(mixedVolatility(30, 0.2), PLAN, 200);
    expect(summary.falseEliminationRate).toBeLessThanOrEqual(0.05);
    expect(summary.wrongWinnerRate).toBeLessThanOrEqual(0.05);
  });

  it('puts an inseparable candidate in the tie group even when one above it is separated', () => {
    // Tie-group shortcut regression: quiet leader beats quiet rival but loses to noisy one.
    const m = (candidateId: string, mean: number, margin: number) =>
      ({ candidateId, mean, margin, confidence: 0.95, iterations: 20_000, stageIndex: 0 });
    const tie = unresolvedTie(
      [m('leader', 200_000, 200), m('quiet', 199_000, 200), m('noisy', 198_500, 5_000)],
      1,
      { correctForMultipleComparisons: false },
    ).map((x) => x.candidateId);
    expect(tie).toContain('leader');
    expect(tie).toContain('noisy');
    expect(tie).not.toContain('quiet');
  });
});

describe('a volatile leader is not thrown away for being noisy', () => {
  it('keeps a high-variance winner across 100 searches', async () => {
    const summary = await validateSelection(volatileLeader(20, 1.5), PLAN, 100);
    expect(summary.falseEliminationRate).toBe(0);
  });

  it('does not claim a quiet runner-up beat it', async () => {
    const summary = await validateSelection(volatileLeader(20, 1.5), PLAN, 100);
    expect(summary.wrongWinnersStated).toBe(0);
  });
});

describe('the staged search agrees with an exhaustive one', () => {
  it('reaches the same verdict on a small population', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const population = clearWinner(8, 2);
      const staged = await runTrial(population, PLAN, seed);
      const exhaustive = await exhaustiveSearch(population, PLAN, seed);

      // The exhaustive run measures everything; the staged run measures fewer.
      expect(exhaustive.rankedIds).toHaveLength(population.length);
      expect(staged.measuredCandidates).toBeLessThanOrEqual(population.length);

      // Neither loses the true best.
      expect(staged.falseElimination).toBe(false);
      expect(exhaustive.rankedIds[0]).toBe(staged.trueBestId);
      expect(staged.reportedBestId).toBe(staged.trueBestId);
    }
  });

  it('measures fewer candidates than the exhaustive run, which is the point', async () => {
    const population = clearWinner(40, 3);
    const staged = await runTrial(population, PLAN, 99);
    expect(staged.measuredCandidates).toBeLessThan(population.length);
  });
});

describe('the interval is a real interval', () => {
  it('brackets the point estimate and stays inside [0, 1]', () => {
    for (const [k, n] of [[0, 100], [1, 100], [50, 100], [100, 100], [3, 3000]] as [number, number][]) {
      const [lo, hi] = wilson(k, n);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
      // Tolerance: the Wilson form is not exact in floating point at p = 1.
      expect(lo).toBeLessThanOrEqual(k / n + 1e-12);
      expect(hi).toBeGreaterThanOrEqual(k / n - 1e-12);
    }
    // Zero successes still gives a non-zero upper bound: "we saw none" is not
    // "it never happens", and the interval is what says so.
    expect(wilson(0, 100)[1]).toBeGreaterThan(0.02);
    // More trials, tighter interval.
    expect(wilson(2, 100)[1]).toBeGreaterThan(wilson(20, 1000)[1]);
  });
});

describe('the rate is reported, not only asserted', () => {
  it('returns per-trial outcomes so a failure can be replayed', async () => {
    const summary = await validateSelection(nearTie(6, 0.05), PLAN, 10);
    expect(summary.outcomes).toHaveLength(10);
    for (const o of summary.outcomes) {
      expect(o.trueBestId).toBeTruthy();
      expect(Number.isFinite(o.trueMarginPercent)).toBe(true);
    }
  });
});


// P08.16: the adaptive racing search, measured against the SAME ground truth and
// the SAME noise model as the ladder above, so the two rates are comparable by
// construction. The full sweep and its table are in
// These are the regression gates for the adaptive search.

describe('the adaptive search is not worse than the ladder it replaces', () => {
  /** EXACTLY WHAT THE ROUTES PASS: equal final precision and iteration ceiling to PLAN only; no caller sets finalists:8,batchSize:8. */
  const ADAPT: AdaptiveOptions = { targetError: 0.2, maxIterations: 20_000 };

  it('never eliminates a clear winner, over 200 searches of a 40-candidate field', async () => {
    const summary = await validateAdaptive(clearWinner(40, 3), ADAPT, 200);
    expect(summary.falseEliminations).toBe(0);
    expect(summary.wrongWinnersStated).toBe(0);
  });

  it('holds the near-tie false-elimination rate at or under the ladder’s', async () => {
    const population = nearTie(12, 0.1);
    const fixed = await validateSelection(population, PLAN, 200);
    const adaptive = await validateAdaptive(population, ADAPT, 200);
    expect(adaptive.falseEliminationRate).toBeLessThanOrEqual(fixed.falseEliminationRate);
    expect(adaptive.falseEliminationCI[1]).toBeLessThanOrEqual(0.08);
    expect(adaptive.wrongWinnerRate).toBeLessThanOrEqual(0.05);
  });

  /** Re-calibrated 2026-09-15: adaptive trades ladder's truncation (20→174 survivors at 0.2%) for cost, but avoids budget-loss of true best. */
  it('trades the ladder\u2019s truncation for cost, on the typical case', async () => {
    // Real Top Gear field: hundreds of combos within 1%, winner ahead by one upgrade.
    const population = clearWinner(200, 0.3);
    const fixed = await validateSelection(population, PLAN, 40);
    const adaptive = await validateAdaptive(population, ADAPT, 40);
    expect(adaptive.meanSamples).toBeLessThan(fixed.meanSamples * 2.5);
    expect(adaptive.falseEliminations).toBe(0);
    expect(adaptive.droppedByBudgetRate).toBeLessThanOrEqual(fixed.droppedByBudgetRate);
  });

  /** CV is a parameter (claim is a curve); span half measured to 12x to check range. */
  it('keeps false eliminations at zero across an order of magnitude of noise', async () => {
    for (const cv of [0.0122, MEASURED_CV, 0.05, 0.1, 0.3]) {
      for (const population of [clearWinner(40, 0.3, { cv }), nearTie(12, 0.1, { cv }), volatileLeader(20, 0.3, { cv })]) {
        const summary = await validateAdaptive(population, ADAPT, 40);
        expect(summary.falseEliminations).toBe(0);
        expect(summary.wrongWinnerRate).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('keeps a volatile leader, and does not claim a quiet runner-up beat it', async () => {
    const summary = await validateAdaptive(volatileLeader(20, 1.5), ADAPT, 100);
    expect(summary.falseEliminationRate).toBe(0);
    expect(summary.wrongWinnersStated).toBe(0);
  });

  it('survives correlated batches, unequal variances and a flipping leader', async () => {
    for (const summary of [
      await validateAdaptive(nearTie(30, 0.05), ADAPT, 100, 1, { correlation: 0.9 }),
      await validateAdaptive(mixedVolatility(30, 0.2), ADAPT, 100),
      await validateAdaptive(flippingLeader(20), ADAPT, 100),
    ]) {
      expect(summary.falseEliminationRate).toBeLessThanOrEqual(0.05);
      expect(summary.wrongWinnerRate).toBeLessThanOrEqual(0.05);
    }
  });

  it('throws away fewer still-alive candidates on the survivor budget', async () => {
    // Ladder's budgets (200/25/8) vs racing's derived budgets; difference visible. */
    const population = nearTie(30, 0.05);
    const fixed = await validateSelection(population, PLAN, 100, 1, { correlation: 0.9 });
    const adaptive = await validateAdaptive(population, ADAPT, 100, 1, { correlation: 0.9 });
    expect(adaptive.droppedByBudgetRate).toBeLessThan(fixed.droppedByBudgetRate);
  });

  it('reports the samples it spent, so the comparison is checkable rather than claimed', async () => {
    const summary = await validateAdaptive(clearWinner(24, 0.3), ADAPT, 10);
    expect(summary.meanSamples).toBeGreaterThan(0);
    for (const o of summary.outcomes) expect(o.samples).toBeGreaterThan(0);
  });
});
