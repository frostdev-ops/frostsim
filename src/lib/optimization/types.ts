// Optimization contracts: candidates (deltas from baseline + profileset lines), stages, results. Candidate ids opaque and stable.

import type { GearSlot, ItemInstance, ResolvedItem } from '../catalog/types';

/** What a candidate changes relative to the baseline. */
export interface CandidateDelta {
  /** Replaced gear, keyed by the slot it occupies. A null value empties the slot. */
  gear?: Map<GearSlot, ItemInstance | null>;
  /** A talent string replacing the baseline's. */
  talents?: string;
  /** Consumable option overrides, e.g. { flask: 'flask_of_x_3' }. */
  consumables?: Record<string, string>;
  /** Free-form simc option lines. Validated before submission. */
  extraLines?: string[];
}

export interface CandidateCost {
  /** Currency costs by id; absent means unknown (catalog has no data), not 0. */
  currencies?: Record<number, number>;
  /** Catalyst charges this candidate consumes. */
  catalystCharges?: number;
  /** Fields whose cost could not be determined. */
  unknownCosts: string[];
}

export interface Candidate {
  /** Opaque, stable, and safe as a profileset key: [A-Za-z0-9_-] only. */
  id: string;
  /** Where this candidate came from, for the UI and for grouping in reports. */
  provenance: {
    kind: 'gear' | 'talent' | 'consumable' | 'gem' | 'enchant' | 'embellishment' | 'baseline' | 'mixed';
    /** Source items resolved for display; ALWAYS AN ARRAY, empty when no gear changes. Required, not optional, to prevent iteration throws. */
    items: ResolvedItem[];
    /** Free text describing the change, safe to render as text. */
    label: string;
    /** For Droptimizer: which source group produced this candidate, when known. */
    sourceId?: string;
    /** Great Vault reward used by this set; absent means no Vault reward claimed. */
    vaultRewardId?: string;
    /** Exact reward variant, including when its stats match already-equipped gear. */
    vaultItem?: ItemInstance;
  };
  delta: CandidateDelta;
  cost: CandidateCost;
  /** The profileset lines this candidate contributes. Order is preserved. */
  lines: string[];
  /**
   * Canonical form of the candidate's simulation-affecting input. Two candidates
   * with the same canonical form are the same simulation and share a cache entry.
   */
  canonical: string;
}

export type Accuracy =
  | { mode: 'iterations'; iterations: number }
  | { mode: 'targetError'; targetError: number; maxIterations: number };

export interface StageConfig {
  /** Shown to the user; also the key under which stage results are stored. */
  label: string;
  accuracy: Accuracy;
  /** Max survivors for next stage; interval rule eliminates, this bounds the budget. */
  maxSurvivors: number;
  /** Candidates per engine job; batch size is the cancellation checkpoint. */
  batchSize: number;
}

export interface StagePlan {
  version: number;
  stages: StageConfig[];
  /** Retention strictness; 1 = report's own confidence level. */
  retentionFactor: number;
  /** Below this iteration count a candidate is never eliminated. */
  minIterations: number;
  /** Correct for multiple comparisons across whole field (default true); false reproduces measured 26% false-elimination rate (P08.10). */
  correctForMultipleComparisons?: boolean;
}

/** One candidate's measured result at one stage. */
export interface CandidateMeasurement {
  candidateId: string;
  mean: number;
  /** Confidence margin on mean at confidence level; engine pre-multiplies by confidence estimator. */
  margin: number | null;
  confidence: number | null;
  iterations: number;
  stageIndex: number;
}

export type CandidateStatus = 'pending' | 'running' | 'measured' | 'eliminated' | 'missing' | 'failed';

export interface CandidateState {
  candidate: Candidate;
  status: CandidateStatus;
  /** Latest measurement, or null if never measured. */
  measurement: CandidateMeasurement | null;
  /** Every stage's measurement, newest last. */
  history: CandidateMeasurement[];
  /** Why the candidate left the search, when it did. */
  note?: string;
}

export interface OptimizationProgress {
  /** Zero-based stage index. For the adaptive search this is the pass index. */
  stageIndex: number;
  /** Stage count in plan; adaptive search reports estimate (can move as candidates resolve). */
  stageCount: number;
  stageLabel: string;
  /** Precision in force for the batch being run. */
  accuracy: Accuracy;
  batchIndex: number;
  batchCount: number;
  candidatesMeasured: number;
  /** Still to measure in THIS pass (counting down, not total). */
  candidatesRemaining: number;
  /** Candidates still inseparable from leader; optional for fixed ladder. */
  contendersRemaining?: number;
  /** Candidates in current batch; lets UI show progress ("running 54, 12 done"). */
  candidatesInBatch?: number;
  /** Engine-finished count in batch (resets per batch). */
  candidatesDoneInBatch?: number;
  /** Engine samples collected so far in this search. */
  samplesSpent?: number;
  /** Estimated samples remaining (estimate, not promise; early separation spends less). */
  estimatedSamplesRemaining?: number;
}

export interface OptimizationResult {
  baseline: CandidateMeasurement | null;
  /** Every candidate with its final state, ranked best first among the measured. */
  candidates: CandidateState[];
  /** Candidates whose intervals overlap the leader's; no winner can be declared. */
  unresolvedTie: string[];
  /** True when stage kept fewer than interval rule would have; dropped-but-alive ids listed. */
  truncated: boolean;
  droppedWhileAlive: string[];
  /** Stages actually executed, with what the engine really used. */
  stagesRun: {
    label: string; accuracy: Accuracy; targetReached: boolean | null; candidates: number;
    /** Engine samples consumed by this stage when reported. */
    samples?: number;
  }[];
  /** Non-fatal problems: missing candidates, unknown costs, advisory legality. */
  warnings: string[];
  /** Engine problems (moderate/severe notices) by batch, not per-candidate; simc merges only baseline actor's errors (P08.10, P08.16). */
  problems: string[];
  /** Set when the search stopped early. Partial results are never a complete search. */
  incomplete: { reason: 'cancelled' | 'budget' | 'error'; message: string } | null;
}
