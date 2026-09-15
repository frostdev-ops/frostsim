// Main-thread entry point for running a simulation. Public surface; implementation in modules below.

export {
  FIGHT_STYLES,
  DEFAULT_SETTINGS,
  DEFAULT_ACCURACY,
  ITEM_SLOTS,
  LIMITS,
  PROTECTED_OPTIONS,
  clampThreads,
  itemLineProblem,
  maxUsefulThreads,
  sanitizeProfile,
  validateSettings,
  validateExtraOptions,
  validateExtraProfileLines,
  type Accuracy,
  type FightStyle,
  type ProfilesetSpec,
  type RunMode,
  type SimSettings,
  type ValidationIssue,
} from './options'

export {
  runJob,
  loadPlayerDetail,
  engineBusy,
  engineStopping,
  engineAvailability,
  cancelActiveJob,
  clearCompiledEngine,
  lastThreadReap,
  type EngineAvailability,
  type ThreadReap,
  validateRequest,
  cancellation,
  SimEngineError,
  SimTimeoutError,
  SimValidationError,
  WORKER_PROTOCOL,
  ENGINE_WORKER_URL,
  DEFAULT_LIMITS,
  type JobDeps,
  type JobEvent,
  type JobLimits,
  type JobProgress,
  type JobState,
  type RunHandle,
  type SimOutcome,
  type SimRequest,
} from './job'

export {
  FIGHT_PRESETS,
  advancedCapability,
  findPreset,
  presetForStyle,
  type AdvancedCapability,
  type FightPreset,
  type PresetSupport,
} from './presets'

export {
  parseProgressLine,
  latestProgress,
  candidatesDone,
  type EngineProgress,
} from './progress'

export {
  acquireEngineSlot,
  engineSlotStatus,
  engineSlotSupported,
  type EngineSlot,
  type EngineSlotScope,
} from '../engine-budget'

export {
  runComparison,
  type CandidateResult,
  type ComparisonEvent,
  type ComparisonHandle,
  type ComparisonOutcome,
} from './compare'

export {
  detectEngineCapability,
  fetchManifest,
  engineIdentity,
  precisionKey,
  cacheKey,
  canShareMemory,
  hasWasmExceptions,
  ENGINE_DIRS,
  type CacheKeyParts,
  type CapabilityFailure,
  type EngineCapability,
  type EngineManifest,
  type EngineVariant,
} from './capability'

export {
  type NoticeKind,
  type ReportLog,
  type Timeline,
  type ScaleFactor,
  type ScalingOptions,
  type PlayerResult,
  type ProfilesetResult,
  type SimReport,
  type Distribution,
  type ConfidenceInterval,
  parseReport,
  profilesetStatus,
  rankProfilesets,
  ReportFormatError,
} from './report'

export {
  parsePlayerDetail,
  PlayerNotInReportError,
  type AbilityRow,
  type BuffRow,
  type PetDetail,
  type PlayerDetail,
  type SequenceStep,
} from './detail'
