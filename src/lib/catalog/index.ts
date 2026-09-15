// GemOption exported deliberately to prevent hand-copies of the type (D1).
export { Catalog, type CatalogPayloads, type GemOption, type SearchQuery } from './catalog';
export { CatalogClient, inlineTransport, type CatalogHandleResult } from './client';
export {
  CATALOG_PROTOCOL_VERSION, NotLoadedError, UnclonableRequestError, handleRequest,
  newState, toPlainRequest,
  type CatalogRequest, type CatalogResponse, type DropSourceCounts,
  type WorkerPlanOptions, type WorkerState,
} from './protocol';
export { loadCatalog, loadTalentTree, checkCompatibility, SUPPORTED_CATALOG_SCHEMA } from './load';
export type { CatalogLoadResult, CompatWarning, EngineIdentity, LoadOptions } from './load';
export { serializeItem, serializeEmptySlot, serializeGear, itemToken, SerializeError } from './serialize';
export { checkItemForSlot, checkGearSet, checkSockets, isLegal, raceAllowed } from './legality';
export type { CharacterConstraints, LegalityIssue, LegalityCode } from './legality';
export { buildItem, scaledStat, sortBonusIds, ScalingTables, bonusTables } from './item-build';
export type { BaseItem, BuildInput, BuiltItem, BonusTables } from './item-build';
export * from './types';
export * as enums from './enums';
export {
  NODE_TYPE, TALENT_TREE, TalentModel, checkLoadout, decodeLoadout, encodeLoadout, peekSpecId,
} from './talents';
export type {
  DecodeResult, PointsSpent, TalentBudget, TalentIssue, TalentIssueCode, TalentNodeGroup,
  TalentNodeStatus, TalentPick, TalentSelection, TalentValidation,
} from './talents';
