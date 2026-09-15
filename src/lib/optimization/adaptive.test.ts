// Adaptive racing search: precision allocation and loop. No wasm; fake RunBatch converges exactly (see validation.test.ts for noisy version).

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TARGET_ERROR, NOMINAL_CV, SURVEY_SAMPLE_BUDGET, accuracyFor, achievedTargetError, allocatePrecision,
  coarseTargetError, cvOf, estimateCv, projectedSamples, quantizeTargetError, requiredTargetError,
  runAdaptiveSearch, samplesForTargetError,
} from './adaptive';
import { DEFAULT_MAX_ITERATIONS, runPassSearch, type ProfilesetOutcome, type RunBatch } from './runner';
import type { Candidate, CandidateMeasurement, StagePlan } from './types';

/** Reviewer findings F1, F3-F7. One test per finding, named by it. */

const Z = 1.96;

function candidate(id: string): Candidate {
  return {
    id,
    provenance: { kind: 'gear', items: [], label: id },
    delta: {},
    cost: { unknownCosts: [] },
    lines: id === 'baseline' ? [] : [`head=,id=${1000 + id.length}`],
    canonical: id,
  };
}

function measurement(candidateId: string, mean: number, targetError: number, iterations = 5_000): CandidateMeasurement {
  return { candidateId, mean, margin: (mean * targetError) / 100, confidence: 0.95, iterations, stageIndex: 0 };
}

/** Engine converges exactly to requested error; records every job to check batching-by-precision. */
function fakeEngine(means: Record<string, number>, cv = 0.3) {
  const jobs: { targetError: number; ids: string[]; iterations: number }[] = [];
  const runBatch: RunBatch = async (req) => {
    const te = req.accuracy.mode === 'targetError' ? req.accuracy.targetError : 1;
    const ceiling = req.accuracy.mode === 'targetError' ? req.accuracy.maxIterations : req.accuracy.iterations;
    const iterations = Math.min(ceiling, Math.ceil(((100 * Z * cv) / te) ** 2));
    jobs.push({ targetError: te, ids: req.profilesets.map((p) => p.id), iterations });
    const at = (id: string): ProfilesetOutcome['results'][number] =>
      ({ id, mean: means[id], margin: (means[id] * te) / 100, iterations });
    return {
      results: req.profilesets.filter((p) => means[p.id] !== undefined).map((p) => at(p.id)),
      baseline: { mean: means.baseline ?? 100_000, margin: ((means.baseline ?? 100_000) * te) / 100, iterations },
      confidence: 0.95,
      targetReached: true,
      engineIdentity: 'test-engine',
    };
  };
  return { runBatch, jobs };
}

const CTX = (runBatch: RunBatch) => ({ profile: 'p', catalogId: 'cat', engineIdentity: 'test-engine', runBatch });

// --- precision allocation --------------------------------------------------

describe('the first pass is sized from the field and the engine', () => {
  it('opens at the final precision for a single candidate', () => {
    expect(coarseTargetError(1, 0.2)).toBe(0.2);
  });

  it('opens looser the more candidates there are, because each gets fewer samples', () => {
    // Named cv to show budget scaling; seed's survey floor covers standard fields.
    const few = coarseTargetError(250, 0.2, { cv: 0.3 });
    const many = coarseTargetError(2_000, 0.2, { cv: 0.3 });
    expect(many).toBeGreaterThan(few);
    expect(few).toBeGreaterThanOrEqual(0.2);
  });

  it('skips the survey on an iteration count, not on a target error the seed predicted', () => {
    // 20 candidates at 20k ceiling leaves no cheaper pass; 21 candidates triggers survey.
    expect(coarseTargetError(20, 0.2, { maxIterations: 20_000 })).toBe(0.2);
    expect(coarseTargetError(21, 0.2, { maxIterations: 20_000 })).toBe(1);
  });

  it('never buys precision for candidates it is about to discard', () => {
    // 40 candidates: 1% survey removes losers cheaper than 0.59% exhaustive.
    expect(coarseTargetError(40, 0.2)).toBe(1);
  });

  it('follows the 1/targetError-squared cost model: four times the field, twice the error', () => {
    // Both above the floor, so neither is clamped.
    expect(coarseTargetError(1_000, 0.2, { cv: 0.3 }) / coarseTargetError(250, 0.2, { cv: 0.3 })).toBeCloseTo(2, 5);
  });

  it('never loosens past the point where a measurement says nothing', () => {
    expect(coarseTargetError(10_000_000, 0.2)).toBe(MAX_TARGET_ERROR);
  });

  it('leaves the iteration ceiling to the safety cap rather than scaling it by precision', () => {
    // A ceiling that shrank with a looser target would stop volatile candidates
    // early and hand the racing loop a wide margin it cannot tell from a tie.
    expect(accuracyFor(0.5)).toEqual({ mode: 'targetError', targetError: 0.5, maxIterations: DEFAULT_MAX_ITERATIONS });
    expect(accuracyFor(0.05, 1_000)).toEqual({ mode: 'targetError', targetError: 0.05, maxIterations: 1_000 });
  });
});

describe('the cost model is calibrated from the engine, not from the seed', () => {
  it('recovers the per-iteration cv from a report the engine already sent', () => {
    // Fifth browser run phase-1: 181,569 DPS ±178 over 2,411 iterations recovers cv=0.0246.
    expect(cvOf({ mean: 181_569, margin: 178, iterations: 2_411 })).toBeCloseTo(0.0246, 4);
    expect(samplesForTargetError(0.1, 30_000, 0.0246)).toBeCloseTo(2_326, -2);
    expect(samplesForTargetError(0.1, 30_000, 0.3)).toBe(30_000); // the old seed: the ceiling
  });

  it('takes the median, so one volatile candidate does not re-price the field', () => {
    const quiet = (id: string) => ({ candidateId: id, mean: 200_000, margin: 200, iterations: 10_000 });
    const loud = { candidateId: 'trinket', mean: 200_000, margin: 2_000, iterations: 10_000 };
    expect(estimateCv([quiet('a'), quiet('b'), loud])).toBeCloseTo(cvOf(quiet('a'))!, 10);
  });

  it('falls back to the seed only while nothing has been measured', () => {
    expect(estimateCv([])).toBe(NOMINAL_CV);
    expect(estimateCv([{ mean: 200_000, margin: null, iterations: 0 }])).toBe(NOMINAL_CV);
  });

  it('bounds the first pass by the survey budget, whatever the seed turns out to be', async () => {
    // 100x noisier spec: without cap, survey would run 40*40k against 400k budget.
    const N = 40;
    const { runBatch, jobs } = fakeEngine(
      Object.fromEntries(Array.from({ length: N }, (_, i) => [`c${i}`, 200_000 - i * 100])),
      3,
    );
    await runAdaptiveSearch(
      Array.from({ length: N }, (_, i) => candidate(`c${i}`)),
      CTX(runBatch),
      { targetError: 0.2, finalists: 0 },
    );
    expect(jobs[0].iterations).toBe(SURVEY_SAMPLE_BUDGET / N);
    expect(jobs[0].iterations).toBeLessThan(DEFAULT_MAX_ITERATIONS);
  });
});

describe('a contender is measured as precisely as its gap demands', () => {
  it('asks for a half-width of about the gap over factor x sqrt(2)', () => {
    const leader = { mean: 200_000 };
    const te = requiredTargetError({ mean: 198_000 }, leader, { factor: 1, finalTargetError: 0.01, safety: 1 });
    // gap 2000, k = sqrt(2), so half-width 1414 on a mean of 198,000.
    expect(te).toBeCloseTo((100 * (2_000 / Math.SQRT2)) / 198_000, 6);
  });

  it('asks for more precision the closer the candidate is', () => {
    const leader = { mean: 200_000 };
    const near = requiredTargetError({ mean: 199_900 }, leader, { factor: 1, finalTargetError: 0.01 });
    const far = requiredTargetError({ mean: 195_000 }, leader, { factor: 1, finalTargetError: 0.01 });
    expect(near).toBeLessThan(far);
  });

  it('stops at the user’s final precision rather than chasing a tie forever', () => {
    const te = requiredTargetError({ mean: 200_000 }, { mean: 200_000 }, { factor: 1, finalTargetError: 0.2 });
    expect(te).toBe(0.2);
  });
});

describe('required precisions are snapped to shared levels', () => {
  it('snaps down, never up, so a job is never looser than a candidate asked for', () => {
    for (const te of [0.21, 0.39, 0.4, 0.79, 1.6, 3.3]) {
      expect(quantizeTargetError(te, 0.2)).toBeLessThanOrEqual(te);
    }
  });

  it('puts nearby requirements in the same bucket, which is what shares an engine job', () => {
    expect(quantizeTargetError(0.45, 0.2)).toBe(quantizeTargetError(0.79, 0.2));
    expect(quantizeTargetError(0.45, 0.2)).toBe(0.4);
    expect(quantizeTargetError(0.1, 0.2)).toBe(0.2);
  });
});

describe('allocating precision across a pass', () => {
  const survivors = [
    measurement('lead', 200_000, 1),
    measurement('near', 199_800, 1),
    measurement('far', 196_000, 1),
  ];

  it('gives the distant contender a looser target than the close one', () => {
    // A ceiling loose enough not to bind: when both targets run to the SAME
    // capped iteration count the looser one saves nothing, and the bucket merge
    // below correctly folds them into one job. That is the next test.
    const { byId } = allocatePrecision(survivors, { finalTargetError: 0.05, correctForMultipleComparisons: false, maxIterations: 4_000_000 });
    expect(byId.get('far')!).toBeGreaterThan(byId.get('near')!);
  });

  it('folds a looser bucket into the tighter one when the iteration ceiling makes it free', () => {
    // 0.1% and 0.05% both hit 20k cap; splitting costs extra base actor, buys nothing.
    const { byId } = allocatePrecision(survivors, { finalTargetError: 0.05, correctForMultipleComparisons: false, maxIterations: 20_000 });
    expect(new Set(byId.values()).size).toBe(1);
    // Folded TIGHTER: nobody measured looser than gap demands.
    expect(byId.get('far')).toBe(0.05);
  });

  it('runs the leader at the tightest precision in the pass, because it is in every comparison', () => {
    const { byId, tightest } = allocatePrecision(survivors, { finalTargetError: 0.05, correctForMultipleComparisons: false });
    expect(byId.get('lead')).toBe(tightest);
    expect(tightest).toBe(Math.min(...byId.values()));
  });

  it('always at least halves the precision, so a pass cannot fail to make progress', () => {
    const { byId, progresses } = allocatePrecision(survivors, { finalTargetError: 0.05, correctForMultipleComparisons: false });
    for (const m of survivors) expect(byId.get(m.candidateId)!).toBeLessThanOrEqual(achievedTargetError(m) / 2);
    expect(progresses).toBe(true);
  });

  it('reports no progress once everything is at the final precision — that is the tie', () => {
    const atFinal = survivors.map((m) => measurement(m.candidateId, m.mean, 0.2));
    const { progresses } = allocatePrecision(atFinal, { finalTargetError: 0.2, correctForMultipleComparisons: false });
    expect(progresses).toBe(false);
  });

  it('survives an empty field instead of returning NaN', () => {
    expect(allocatePrecision([], { finalTargetError: 0.2 })).toEqual({ byId: new Map(), tightest: 0.2, progresses: false });
  });
});

describe('projected samples come from what was actually measured', () => {
  it('quadruples the samples for half the target error', () => {
    const m = { iterations: 3_000, mean: 200_000, margin: 2_000 }; // achieved 1%
    expect(projectedSamples(m, 0.5, 1e9)).toBe(12_000);
  });

  it('falls back to the ceiling when there is nothing to project from', () => {
    expect(projectedSamples({ iterations: 0, mean: 200_000, margin: null }, 0.2)).toBe(DEFAULT_MAX_ITERATIONS);
  });
});

// --- the loop --------------------------------------------------------------

describe('one engine job carries one target error', () => {
  it('splits a pass into a job per distinct precision', async () => {
    const { runBatch, jobs } = fakeEngine({ baseline: 100_000, a: 100, b: 200, c: 300 });
    const plan: StagePlan = { version: 1, retentionFactor: 1, minIterations: 0, stages: [] };
    const byId: Record<string, number> = { a: 1, b: 1, c: 0.25 };
    await runPassSearch(['a', 'b', 'c'].map(candidate), { profile: 'p', plan, catalogId: 'cat', runBatch }, ({ stageIndex }) =>
      stageIndex > 0 ? null : {
        label: 'Race', accuracy: accuracyFor(0.25), maxSurvivors: 10, batchSize: 10,
        accuracyFor: (id) => accuracyFor(byId[id]), noElimination: true,
      });
    expect(jobs).toHaveLength(2);
    // Cheapest job first, so the baseline the pass keeps is the precise one.
    expect(jobs.map((j) => j.targetError)).toEqual([1, 0.25]);
    expect(jobs[0].ids.sort()).toEqual(['a', 'b']);
    expect(jobs[1].ids).toEqual(['c']);
  });

  // Pass bounded by quantization (power-of-two buckets) and profitability (D5), not one-per-contender.
  it('keeps a pass to a handful of jobs however spread out the field is', async () => {
    const N = 40;
    const means: Record<string, number> = { baseline: 100_000 };
    // Gaps 0.01%-5% behind leader: tests every quantization level.
    for (let i = 0; i < N; i++) means[`c${i}`] = 200_000 * (1 - 0.0001 * 1.18 ** i);
    const { runBatch, jobs } = fakeEngine(means);

    const jobsPerPass = new Map<number, number>();
    await runAdaptiveSearch(
      [candidate('baseline'), ...Array.from({ length: N }, (_, i) => candidate(`c${i}`))],
      { ...CTX(runBatch), onProgress: (p) => jobsPerPass.set(p.stageIndex, Math.max(jobsPerPass.get(p.stageIndex) ?? 0, p.batchCount)) },
      // Batch larger than field; job count > 1 is precision split, not cancellation checkpoint.
      { targetError: 0.2, maxIterations: 20_000, batchSize: N + 1, finalists: 0 },
    );

    expect(jobsPerPass.size).toBeGreaterThan(1); // it really did race, not just survey
    for (const [pass, count] of jobsPerPass) {
      expect(`pass ${pass}: ${count} jobs`).toBe(`pass ${pass}: ${Math.min(count, 3)} jobs`);
    }
    expect(jobs.length).toBeLessThan(N / 4);
  });
});

describe('the adaptive search stops when it has an answer', () => {
  // Leader, close rival, obvious losers.
  const population = (): Record<string, number> => {
    const means: Record<string, number> = { baseline: 190_000, lead: 200_000, near: 199_800 };
    for (let i = 0; i < 57; i++) means[`far${i}`] = 190_000 - i * 10;
    return means;
  };
  const ids = () => Object.keys(population()).filter((id) => id !== 'baseline');

  it('eliminates the distant candidates in the first pass and never pays for them again', async () => {
    const means = population();
    const { runBatch, jobs } = fakeEngine(means);
    const result = await runAdaptiveSearch(
      [candidate('baseline'), ...ids().map(candidate)],
      CTX(runBatch),
      { targetError: 0.2, finalists: 5 },
    );
    const firstPassIds = new Set(jobs.filter((j) => j.targetError === jobs[0].targetError).flatMap((j) => j.ids));
    expect(firstPassIds.has('far0')).toBe(true);
    // Distant candidates never submitted again after survey.
    const later = jobs.slice(jobs.findIndex((j) => j.targetError !== jobs[0].targetError));
    expect(later.flatMap((j) => j.ids).filter((id) => id.startsWith('far'))).toEqual([]);
    expect(result.candidates.find((s) => s.candidate.id === 'far0')?.status).toBe('eliminated');
    expect(result.candidates.find((s) => s.candidate.id === 'lead')?.status).toBe('measured');
  });

  it('ranks the true leader first and reports the close rival as an unresolved tie', async () => {
    const { runBatch } = fakeEngine(population());
    const result = await runAdaptiveSearch(
      [candidate('baseline'), ...ids().map(candidate)],
      CTX(runBatch),
      { targetError: 0.2, finalists: 5 },
    );
    expect(result.candidates[0].candidate.id).toBe('lead');
    // 0.1% apart at a 0.2% target error is not separable, and the result says so.
    expect(result.unresolvedTie).toContain('lead');
    expect(result.unresolvedTie).toContain('near');
  });

  it('verifies the finalists independently, with the cache disabled', async () => {
    const { runBatch, jobs } = fakeEngine(population());
    const cache = { get: vi.fn(() => undefined), set: vi.fn() };
    const result = await runAdaptiveSearch(
      [candidate('baseline'), ...ids().map(candidate)],
      { ...CTX(runBatch), cache },
      { targetError: 0.2, finalists: 3 },
    );
    expect(result.verified).toBe(true);
    expect(result.passes.at(-1)!.label).toBe('Verify');
    const verify = jobs.at(-1)!;
    expect(verify.targetError).toBe(0.2);
    expect(verify.ids.length).toBeLessThanOrEqual(3);
    // The verification pass re-measured rather than reading a cached number.
    expect(result.passes.at(-1)!.samples).toBeGreaterThan(0);
  });

  it('spends far fewer samples than measuring the whole field at the final precision', async () => {
    const { runBatch } = fakeEngine(population());
    const result = await runAdaptiveSearch(
      [candidate('baseline'), ...ids().map(candidate)],
      CTX(runBatch),
      { targetError: 0.2, finalists: 5 },
    );
    const exhaustive = ids().length * Math.min(DEFAULT_MAX_ITERATIONS, Math.ceil(((100 * Z * 0.3) / 0.2) ** 2));
    expect(result.samplesSpent).toBeLessThan(exhaustive / 2);
    expect(result.budgetExhausted).toBe(false);
  });

  it('skips the verification when the caller asked for none', async () => {
    const { runBatch } = fakeEngine(population());
    const result = await runAdaptiveSearch(
      [candidate('baseline'), ...ids().map(candidate)],
      CTX(runBatch),
      { targetError: 0.2, finalists: 0 },
    );
    expect(result.verified).toBe(false);
    expect(result.passes.some((p) => p.label === 'Verify')).toBe(false);
  });
});

describe('the budget is reported truthfully', () => {
  it('stops on the iteration budget and says so instead of claiming a finished search', async () => {
    const means: Record<string, number> = { baseline: 190_000 };
    for (let i = 0; i < 40; i++) means[`c${i}`] = 200_000 - i; // all within a whisker
    const { runBatch } = fakeEngine(means);
    const result = await runAdaptiveSearch(
      Object.keys(means).filter((id) => id !== 'baseline').map(candidate),
      CTX(runBatch),
      { targetError: 0.01, finalists: 0, iterationBudget: 1 },
    );
    expect(result.budgetExhausted).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/iteration or time budget/);
  });

  it('does not claim exhaustion when it simply finished', async () => {
    const { runBatch } = fakeEngine({ baseline: 100_000, a: 200_000, b: 100_000 });
    const result = await runAdaptiveSearch([candidate('a'), candidate('b')], CTX(runBatch), { targetError: 0.2 });
    expect(result.budgetExhausted).toBe(false);
  });
});

describe('cancellation still loses only the batch in flight', () => {
  it('stops at the next batch boundary and reports the search as incomplete', async () => {
    const means: Record<string, number> = { baseline: 100_000 };
    for (let i = 0; i < 60; i++) means[`c${i}`] = 200_000 - i * 100;
    const controller = new AbortController();
    let jobs = 0;
    const runBatch: RunBatch = async (req) => {
      if (++jobs >= 1) controller.abort();
      return {
        results: req.profilesets.map((p) => ({ id: p.id, mean: means[p.id], margin: 100, iterations: 1_000 })),
        baseline: { mean: 100_000, margin: 100, iterations: 1_000 },
        confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
      };
    };
    const result = await runAdaptiveSearch(
      Object.keys(means).filter((id) => id !== 'baseline').map(candidate),
      CTX(runBatch),
      { targetError: 0.2, batchSize: 10 },
      controller.signal,
    );
    expect(result.incomplete?.reason).toBe('cancelled');
  });
});

describe('verifyOnly re-measures exactly what it was given', () => {
  it('runs one pass, at the requested precision, and eliminates nothing', async () => {
    const { runBatch, jobs } = fakeEngine({ baseline: 100_000, a: 200_000, b: 100_000 });
    const result = await runAdaptiveSearch(
      [candidate('a'), candidate('b')],
      CTX(runBatch),
      { targetError: 0.2, verifyTargetError: 0.05, verifyOnly: true },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].targetError).toBe(0.05);
    expect(result.verified).toBe(true);
    expect(result.candidates.every((s) => s.status === 'measured')).toBe(true);
  });
});


// --- reviewer findings -----------------------------------------------------

describe('F3: the pass runs at the precision its contenders need', () => {
  it('does not pin the pass to the final precision through the leader', () => {
    // Distant field needs looser than final 0.2%; tightest matches contenders not final.
    const survivors = [
      measurement('lead', 200_000, 2),
      measurement('a', 190_000, 2),
      measurement('b', 185_000, 2),
    ];
    const { tightest, byId } = allocatePrecision(survivors, { finalTargetError: 0.2, correctForMultipleComparisons: false });
    expect(tightest).toBeGreaterThan(0.2);
    expect(tightest).toBe(Math.min(byId.get('a')!, byId.get('b')!));
    // Leader matches pass, not vice versa.
    expect(byId.get('lead')).toBeLessThanOrEqual(tightest);
  });

  it('never asks the leader for a looser target than it already reached', () => {
    const survivors = [measurement('lead', 200_000, 0.1), measurement('a', 190_000, 2)];
    const { byId } = allocatePrecision(survivors, { finalTargetError: 0.2, correctForMultipleComparisons: false });
    expect(byId.get('lead')!).toBeLessThanOrEqual(0.1);
  });
});

describe('F4: each reward group is refined against its own leader', () => {
  it('gives a group runner-up the precision its group gap needs, not the global one', () => {
    // 'b' is 5% behind global leader but 0.05% behind its own; tests Great Vault grouping.
    const survivors = [
      measurement('globalLead', 200_000, 1),
      measurement('a', 190_000, 1),
      measurement('b', 189_905, 1),
    ];
    const group = (id: string) => (id === 'globalLead' ? 'none' : 'rewardA');
    const global = allocatePrecision(survivors, { finalTargetError: 0.05, correctForMultipleComparisons: false });
    const grouped = allocatePrecision(survivors, { finalTargetError: 0.05, correctForMultipleComparisons: false, groupOf: group });
    expect(grouped.byId.get('b')!).toBeLessThan(global.byId.get('b')!);
    expect(grouped.byId.get('b')!).toBe(0.05);
  });

  it('names the candidates left coarser than the precision the user asked for', async () => {
    const means: Record<string, number> = { baseline: 100_000, lead: 200_000 };
    for (let i = 0; i < 40; i++) means[`far${i}`] = 150_000 - i * 10;
    const { runBatch } = fakeEngine(means);
    const result = await runAdaptiveSearch(
      Object.keys(means).filter((id) => id !== 'baseline').map(candidate),
      CTX(runBatch),
      { targetError: 0.2 },
    );
    expect(result.warnings.join(' ')).toMatch(/keep the wider measurement from the pass that eliminated them/);
  });
});

describe('F5: the unmodified profile is a reference, not a competitor', () => {
  it('keeps the empty-lines baseline alive and re-measures it in the verification', async () => {
    const means: Record<string, number> = { baseline: 100_000, lead: 200_000 };
    for (let i = 0; i < 30; i++) means[`far${i}`] = 150_000 - i * 10;
    const { runBatch } = fakeEngine(means);
    const result = await runAdaptiveSearch(
      [candidate('baseline'), ...Object.keys(means).filter((id) => id !== 'baseline').map(candidate)],
      CTX(runBatch),
      { targetError: 0.2, finalists: 3 },
    );
    const base = result.candidates.find((s) => s.candidate.id === 'baseline')!;
    expect(base.status).toBe('measured');
    // Measured in last pass (verification), not left at survey precision.
    expect(base.measurement!.stageIndex).toBe(result.passes.length - 1);
  });
});

describe('F6: a resolved search is not reported as out of budget', () => {
  it('finishes, verifies and reports budgetExhausted false even with the budget spent', async () => {
    // Budget exhausted by survey but survey resolved search; having answer beats budget check.
    const means: Record<string, number> = { baseline: 100_000, lead: 200_000 };
    for (let i = 0; i < 30; i++) means[`far${i}`] = 150_000 - i * 10;
    const { runBatch } = fakeEngine(means);
    const result = await runAdaptiveSearch(
      Object.keys(means).filter((id) => id !== 'baseline').map(candidate),
      CTX(runBatch),
      { targetError: 0.2, iterationBudget: 1, finalists: 3 },
    );
    expect(result.budgetExhausted).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.warnings.join(' ')).not.toMatch(/iteration or time budget/);
  });
});

describe('F1: a coarse number never outranks a refined one', () => {
  it('keeps a survey-eliminated candidate out of the top of the ranking', async () => {
    // Survey-eliminated candidate ranks below final-stage ones by construction.
    const means: Record<string, number> = { baseline: 100_000, lead: 200_000 };
    for (let i = 0; i < 30; i++) means[`far${i}`] = 150_000 - i * 10;
    const { runBatch } = fakeEngine(means);
    const result = await runAdaptiveSearch(
      Object.keys(means).filter((id) => id !== 'baseline').map(candidate),
      CTX(runBatch),
      { targetError: 0.2, finalists: 3 },
    );
    const lastPass = result.passes.length - 1;
    expect(result.candidates[0].candidate.id).toBe('lead');
    expect(result.candidates[0].measurement!.stageIndex).toBe(lastPass);
    // Eliminated rows always below last-pass rows.
    const firstEliminated = result.candidates.findIndex((s) => s.status === 'eliminated');
    const lastRefined = result.candidates.map((s) => s.measurement?.stageIndex ?? -1).lastIndexOf(lastPass);
    expect(firstEliminated).toBeGreaterThan(lastRefined);
  });
});


describe('B3: the planned pass count never shrinks', () => {
  it('reports one stable ceiling from the first pass to the verification', async () => {
    const means: Record<string, number> = { baseline: 100_000, lead: 200_000 };
    for (let i = 0; i < 40; i++) means[`far${i}`] = 150_000 - i * 10;
    const { runBatch } = fakeEngine(means);
    const counts: number[] = [];
    await runAdaptiveSearch(
      Object.keys(means).filter((id) => id !== 'baseline').map(candidate),
      { ...CTX(runBatch), onProgress: (p) => counts.push(p.stageCount) },
      { targetError: 0.2, finalists: 3 },
    );
    expect(new Set(counts).size).toBe(1);
    // Stable ceiling that passes fit inside.
    expect(counts[0]).toBeGreaterThanOrEqual(2);
  });
});

describe('B4: progress moves while a batch is running', () => {
  it('folds the engine’s in-batch count into candidatesMeasured, bounded by the batch', async () => {
    const seen: { measured: number; inBatch: number | undefined }[] = [];
    const runBatch: RunBatch = async (req) => {
      req.onCandidateProgress?.(1);
      req.onCandidateProgress?.(2);
      req.onCandidateProgress?.(999); // an adapter cannot push past the batch
      return {
        results: req.profilesets.map((p) => ({ id: p.id, mean: 1_000, margin: 2, iterations: 5_000 })),
        baseline: { mean: 900, margin: 2, iterations: 5_000 },
        confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
      };
    };
    await runAdaptiveSearch(
      ['a', 'b', 'c'].map(candidate),
      { ...CTX(runBatch), onProgress: (p) => seen.push({ measured: p.candidatesMeasured, inBatch: p.candidatesInBatch }) },
      { targetError: 0.2, finalists: 0 },
    );
    expect(seen[0]).toEqual({ measured: 0, inBatch: 3 });
    expect(seen.slice(1, 4).map((x) => x.measured)).toEqual([1, 2, 3]);
    // Progress monotone within batch.
    const first = seen.slice(0, 4).map((x) => x.measured);
    expect([...first].sort((x, y) => x - y)).toEqual(first);
  });
});


describe('F4/F5: the pass counters actually count', () => {
  it('counts candidatesRemaining down across batches instead of repeating the pass total', async () => {
    // 250 candidates in 100-candidate batches = 3 batches.
    const means: Record<string, number> = { baseline: 100_000 };
    for (let i = 0; i < 250; i++) means[`c${i}`] = 200_000 - i;
    const { runBatch } = fakeEngine(means);
    const seen: { remaining: number; batch: number }[] = [];
    await runAdaptiveSearch(
      Object.keys(means).filter((id) => id !== 'baseline').map(candidate),
      {
        ...CTX(runBatch),
        onProgress: (p) => { if (p.stageIndex === 0) seen.push({ remaining: p.candidatesRemaining, batch: p.batchIndex }); },
      },
      { targetError: 0.2, finalists: 0 },
    );
    const perBatch = seen.filter((x, i) => i === 0 || x.batch !== seen[i - 1].batch).map((x) => x.remaining);
    expect(perBatch).toEqual([250, 150, 50]);
  });

  it('reports the in-batch completed count, which is what moves a single-batch bar', async () => {
    const seen: { inBatch?: number; done?: number }[] = [];
    const runBatch: RunBatch = async (req) => {
      req.onCandidateProgress?.(1);
      req.onCandidateProgress?.(2);
      return {
        results: req.profilesets.map((p) => ({ id: p.id, mean: 1_000, margin: 2, iterations: 5_000 })),
        baseline: { mean: 900, margin: 2, iterations: 5_000 },
        confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
      };
    };
    await runAdaptiveSearch(
      ['a', 'b', 'c'].map(candidate),
      { ...CTX(runBatch), onProgress: (p) => seen.push({ inBatch: p.candidatesInBatch, done: p.candidatesDoneInBatch }) },
      { targetError: 0.2, finalists: 0 },
    );
    expect(seen.slice(0, 3)).toEqual([
      { inBatch: 3, done: 0 }, { inBatch: 3, done: 1 }, { inBatch: 3, done: 2 },
    ]);
  });
});
