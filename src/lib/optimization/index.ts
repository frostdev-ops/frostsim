export * from './types';
export { compareCandidates, differenceMargin, gainOverBaseline, indistinguishable, multiplicityFactor, probit, retain, unresolvedTie } from './statistics';
export type { Gain, MultiplicityOptions, RetentionOptions, RetentionOutcome, Separation, SeparationInput } from './statistics';
export { canonicalize, candidateId, collect, deltaToLines, generate, growthDrivers, upperBound } from './candidates';
export type { Dimension, DimensionOption, GenerateOptions, GenerationReport, SetBonusRequirement } from './candidates';
export {
  DEFAULT_MAX_ITERATIONS, DEFAULT_STAGE_PLAN, InvalidCandidateError, cacheKey, emptyLedger,
  memoryCache, planForTargetError, runPassSearch, runStagedSearch, validateCandidateLines,
} from './runner';
export type {
  PassContext, PassPlan, PassSource, ProfilesetOutcome, ProfilesetRequest, ResultCache, RunBatch,
  SearchLedger, SearchOptions,
} from './runner';
export {
  MAX_TARGET_ERROR, NOMINAL_CV, SURVEY_FLOOR_TARGET_ERROR, SURVEY_SAMPLE_BUDGET, accuracyFor, achievedTargetError,
  affordableSurvivors, allocatePrecision, coarseTargetError, cvOf, estimateCv, projectedSamples,
  quantizeTargetError, requiredTargetError, runAdaptiveSearch, samplesForTargetError,
} from './adaptive';
export type { AdaptiveContext, AdaptiveOptions, AdaptivePass, AdaptiveResult, Allocation } from './adaptive';
export {
  DEFAULT_WORK_CAP, estimateWork, iterationCeiling, perCandidateSamples, recommendation,
  search, selectionToDimensions, verifyFinalists,
} from './topgear';
export { ConcurrentSearchError, EngineReloadRequiredError, NoActorError, engineRunBatch, outcomeToProfilesetOutcome, stageIterations, threadsForIterations } from './engine-adapter';
export type { AdapterOptions } from './engine-adapter';
export type { RunOptions, SearchHandle, Selection, TopGearOptions, TopGearResult, WorkEstimate } from './topgear';
export * as droptimizer from './droptimizer';
// P08.10 validation exported so sweep script and calibration use runner's code.
export * as validation from './validation';
