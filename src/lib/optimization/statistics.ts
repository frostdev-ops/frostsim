// Selection statistics: candidates separated when their difference's CI excludes zero (P08.9); eliminated when separated from leader, never by rank.

import type { CandidateMeasurement } from './types';

export interface SeparationInput {
  mean: number;
  margin: number | null;
  iterations: number;
}

/** Margin on the difference of two independent means, at the same confidence. */
export function differenceMargin(a: SeparationInput, b: SeparationInput): number | null {
  if (a.margin === null || b.margin === null) return null;
  if (!Number.isFinite(a.margin) || !Number.isFinite(b.margin)) return null;
  return Math.sqrt(a.margin * a.margin + b.margin * b.margin);
}

export type Separation = 'a_better' | 'b_better' | 'indistinguishable' | 'unknown';

/** @param factor Widen (>1) or narrow (<1) the separation threshold; 1 uses engine's confidence. */
export function compareCandidates(a: SeparationInput, b: SeparationInput, factor = 1): Separation {
  if (!Number.isFinite(a.mean) || !Number.isFinite(b.mean)) return 'unknown';
  const margin = differenceMargin(a, b);
  if (margin === null) return 'unknown';
  const diff = a.mean - b.mean;
  const threshold = margin * factor;
  if (diff > threshold) return 'a_better';
  if (-diff > threshold) return 'b_better';
  return 'indistinguishable';
}

/** Shared by retain and unresolvedTie: must agree to prevent a candidate being kept as inseparable and then reported as beaten. */
export interface MultiplicityOptions {
  /**
   * Widen the threshold to account for comparing every candidate against a leader
   * that was CHOSEN for being the highest. Defaults to true; see
   * `multiplicityFactor`. Turn it off only to reproduce the old behaviour.
   */
  correctForMultipleComparisons?: boolean;
  /** Confidence the margins are stated at. Only used by the multiplicity correction. */
  confidence?: number;
  /**
   * How many stages of the plan perform an elimination. Each is another look at the
   * same candidates, so it enters the union bound. Defaults to 1, which
   * under-corrects rather than silently assuming a ladder length.
   */
  looks?: number;
}

export interface RetentionOptions extends MultiplicityOptions {
  /** Separation strictness. */
  retentionFactor: number;
  /** A candidate below this iteration count is never eliminated. */
  minIterations: number;
  /** Hard cap on survivors carried into the next stage. */
  maxSurvivors: number;
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Bonferroni multiplicity factor: how much wider the threshold when one leader is compared against many rivals across stages. Uses union bound, holds under arbitrary dependence. @param comparisons rivals vs leader in one stage. @param looks elimination stages; each is another union-bound chance. */
export function multiplicityFactor(comparisons: number, confidence = 0.95, looks = 1): number {
  if (!Number.isFinite(comparisons) || comparisons <= 0) return 1;
  if (!(confidence > 0 && confidence < 1)) return 1;
  const m = Math.max(1, Math.round(comparisons)) * Math.max(1, Math.round(looks));
  if (m <= 1) return 1;
  const alpha = 1 - confidence;
  const z = probit(1 - alpha / m / 2); // two-sided, union bound over m comparisons
  const z0 = probit(1 - alpha / 2);
  return z / z0;
}

export interface RetentionOutcome {
  /** Candidates to carry forward, best first. */
  survivors: CandidateMeasurement[];
  /** Separated from the leader at the configured confidence. */
  eliminated: { measurement: CandidateMeasurement; reason: string }[];
  /** Statistically alive but beyond `maxSurvivors`. The result is not exhaustive. */
  droppedWhileAlive: CandidateMeasurement[];
  /** Not eliminable because the sample was too small or the margin was missing. */
  retainedForInsufficientEvidence: CandidateMeasurement[];
}

/** Advances the leader (highest mean) and candidates not separated from it. */
export function retain(measurements: CandidateMeasurement[], opts: RetentionOptions): RetentionOutcome {
  const usable = measurements.filter((m) => Number.isFinite(m.mean));
  if (usable.length === 0) {
    return { survivors: [], eliminated: [], droppedWhileAlive: [], retainedForInsufficientEvidence: [] };
  }

  const ranked = [...usable].sort((x, y) => y.mean - x.mean);
  const leader = ranked[0];

  // Every non-leader: one comparison vs a leader chosen for being highest.
  const correction = opts.correctForMultipleComparisons === false
    ? 1
    : multiplicityFactor(ranked.length - 1, opts.confidence ?? leader.confidence ?? 0.95, opts.looks ?? 1);
  const factor = opts.retentionFactor * correction;

  const survivors: CandidateMeasurement[] = [];
  const eliminated: RetentionOutcome['eliminated'] = [];
  const weak: CandidateMeasurement[] = [];

  for (const m of ranked) {
    if (m === leader) { survivors.push(m); continue; }
    const tooFewSamples = m.iterations < opts.minIterations || leader.iterations < opts.minIterations;
    const verdict = compareCandidates(leader, m, factor);
    if (tooFewSamples || verdict === 'unknown') {
      survivors.push(m);
      weak.push(m);
      continue;
    }
    if (verdict === 'a_better') {
      eliminated.push({
        measurement: m,
        reason: separationReason(m, leader, ranked.length - 1, correction),
      });
      continue;
    }
    survivors.push(m);
  }

  const kept = survivors.slice(0, Math.max(1, opts.maxSurvivors));
  const droppedWhileAlive = survivors.slice(kept.length);
  return {
    survivors: kept,
    eliminated,
    droppedWhileAlive,
    retainedForInsufficientEvidence: weak.filter((m) => kept.includes(m)),
  };
}

/** Candidates indistinguishable from the leader: unresolved tie, not winner. Uses same multiplicity correction as retain to prevent inconsistency. */
export function unresolvedTie(
  measurements: CandidateMeasurement[],
  factor = 1,
  opts: MultiplicityOptions = {},
): CandidateMeasurement[] {
  const usable = measurements.filter((m) => Number.isFinite(m.mean));
  if (usable.length === 0) return [];
  const ranked = [...usable].sort((x, y) => y.mean - x.mean);
  const leader = ranked[0];
  const correction = opts.correctForMultipleComparisons === false
    ? 1
    : multiplicityFactor(ranked.length - 1, opts.confidence ?? leader.confidence ?? 0.95, opts.looks ?? 1);
  const tied = [leader];
  // Test EVERY candidate, not just until first separation: margins differ, so a narrow-margin candidate can separate while a noisier lower-ranked one doesn't.
  for (const m of ranked.slice(1)) {
    if (compareCandidates(leader, m, factor * correction) !== 'a_better') tied.push(m);
  }
  return tied.length > 1 ? tied : [];
}

/** Explains why a candidate was eliminated: states the mechanism (gap exceeds combined uncertainty, bar raised for comparisons), not confidence claims. */
function separationReason(
  m: CandidateMeasurement,
  leader: CandidateMeasurement,
  comparisons: number,
  correction: number,
): string {
  const numbers = `${m.mean.toFixed(0)} vs ${leader.mean.toFixed(0)}`;
  const widened = correction > 1 && comparisons > 1
    ? `, with the bar raised for ${comparisons} comparisons`
    : '';
  return `the leader is ahead by more than both measurements' combined uncertainty${widened} (${numbers})`;
}

/** Gain over baseline with margin on the difference; null margin means uncertainty unknown. */
export interface Gain {
  absolute: number;
  percent: number | null;
  /** Margin on the DIFFERENCE of the two means, not either one's own. */
  margin: number | null;
  /** Null when the uncertainty is unknown; the gain must not be shown as real. */
  significant: boolean | null;
}

/** Convert Gain.significant (three-state bool|null|undefined) to indistinguishable flag the table renders; must preserve three-state to avoid collapsing true into undefined. */
export function indistinguishable(significant: boolean | null | undefined): boolean | undefined {
  return significant === null || significant === undefined ? undefined : !significant;
}

export function gainOverBaseline(
  candidate: SeparationInput,
  baseline: SeparationInput,
): Gain {
  const absolute = candidate.mean - baseline.mean;
  const percent = baseline.mean > 0 ? (absolute / baseline.mean) * 100 : null;
  const margin = differenceMargin(candidate, baseline);
  const significant = margin === null ? null : Math.abs(absolute) > margin;
  return { absolute, percent, margin, significant };
}
