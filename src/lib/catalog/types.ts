// Catalog contracts from pinned SimulationCraft via scripts/catalog/build-catalogs.mjs. No hardcoded items, spells, coefficients.

/** Gear slots, matching the simc profile option names. */
export const GEAR_SLOTS = [
  'head', 'neck', 'shoulder', 'back', 'chest', 'shirt', 'tabard', 'wrist',
  'hands', 'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2',
  'main_hand', 'off_hand',
] as const;

export type GearSlot = (typeof GEAR_SLOTS)[number];

/**
 * One equipped or owned item, exactly as the importer read it.
 * Two copies of the same item id with different bonus ids are two instances.
 */
export interface ItemInstance {
  instanceId: string;
  source?: 'equipped' | 'bag' | 'vault' | 'catalog' | 'hypothetical';
  /** Stable physical item identity across simulated upgrade and slot variants. */
  originalInstanceId?: string;
  /** All variants of one Great Vault reward retain this identity. */
  vaultRewardId?: string;
  /** The user chose a track different from the imported one, or for an unknown item. */
  upgradeTrackHypothetical?: boolean;
  slot: GearSlot;
  itemId: number;
  bonusIds: number[];
  /** REQUIRED, always present (empty when none); prevents .filter() guards and contract disagreement. */
  gemIds: number[];
  enchantId?: number;
  craftedStats?: number[];
  craftingQuality?: number;
  redirectedBaseStats?: number;
  contentTuning?: number;
  dropLevel?: number;
  /** The `ilevel=` option: overrides the computed item level without changing the base row. */
  itemLevel?: number;
  /** Importer-unmodelled option keys, preserved verbatim. */
  extra?: Record<string, string>;
  line?: string;
  addonName?: string;
  addonItemLevel?: number;
}

export interface ItemStat {
  /** item_mod_type from the engine enum. */
  type: number;
  /** Human label for the stat type, or null when the engine enum has no name for it. */
  label: string | null;
  /** Scaled value at this item's level, or null when it could not be computed. */
  value: number | null;
  allocation: number;
}

export interface ResolvedItem {
  instanceId: string;
  itemId: number;
  name: string;
  slot: GearSlot;
  /** Slots item can occupy (finger/trinket/weapons resolve to multiple). */
  eligibleSlots: GearSlot[];
  /** Effective item level (ilevel= override when present, else computed). */
  itemLevel: number;
  /** Item level after bonus ids, before any `ilevel=` override. */
  computedItemLevel: number;
  baseItemLevel: number;
  quality: number;
  qualityLabel: string;
  itemClass: number;
  itemSubclass: number;
  inventoryType: number;
  bindType: number;
  /** Socket colors after bonus ids (one per socket). */
  sockets: number[];
  gemIds: number[];
  /** Gem colors by position; 0 when unknown. */
  gemColors: number[];
  /** Unique-equipped per gem by position. */
  gemUnique: boolean[];
  /** True when only one copy may be equipped across the character. */
  uniqueEquipped: boolean;
  enchantId: number | null;
  setId: number;
  craftingQuality: number;
  stats: ItemStat[];
  /** Labels from ItemNameDescription via ITEM_BONUS_DESC (e.g. "Champion Equipment"). */
  descriptors: string[];
  /** Upgrade identity from pinned DB2 bonus groups; unknown stays null, item levels don't infer. */
  track: { label: string | null; step: number | null; max: number | null; id?: number;
    seasonId?: number; currentSeason?: boolean; extended?: boolean; hypothetical?: boolean };
  bonusIds: number[];
  weapon: { delay: number; damageRange: number } | null;
  classMask: number;
  raceMask: string;
  /** Unresolved fields; UI must show, not hide. */
  unresolved: string[];
  /** Instance resolved from (for exact candidate re-serialization). */
  instance: ItemInstance;
}

export interface CatalogIdentity {
  schemaVersion: number;
  catalogId: string;
  generatedAt: string;
  engine: {
    simcVersion: string | null;
    upstreamCommit: string | null;
    clientDataVersion: string;
    simcWowVersion: string;
    hotfixDate: string;
    hotfixBuild: number;
    hotfixHash: string;
    ptr: boolean;
  };
}

export interface CoverageEntry {
  field: string;
  status: 'verified' | 'partial' | 'unavailable';
  source: string;
  count?: number;
  notes?: string;
}

export interface CatalogManifest extends CatalogIdentity {
  counts: Record<string, number>;
  files: { path: string; bytes: number; brotliBytes: number; sha256: string }[];
  totals: { bytes: number; brotliBytes: number; fileCount: number };
  coverage: CoverageEntry[];
  /** Present when loot adapter configured AND produced usable sources. */
  loot?: { path: string; expiresAt: string | null; sources: number; providers: string[] } | null;
  lootAdaptersAttempted?: string[];
  warnings?: string[];
}

/** One activity that can award items. Absent entirely when no adapter is configured. */
export interface LootSource {
  id: string;
  /** Verified membership in the catalog's active Blizzard season. */
  seasonId?: number;
  kind: 'raid' | 'dungeon' | 'delve' | 'pvp' | 'profession' | 'vault' | 'other';
  name: string;
  instanceName?: string;
  instanceId?: number;
  difficulties?: string[];
  /** Journal instance media id when present (encounters have no media; card falls back to icons). */
  mediaId?: number;
  itemIds: number[];
  provider: string;
}

export interface LootProvenance {
  provider: string;
  description: string;
  /** Plain-language retention obligation (e.g. Blizzard API's 30-day TTL). */
  retention: string;
  /** Text UI must display with anything from this source. */
  attribution: string;
  limitations: string[];
  sourceCount: number;
  itemCount: number;
}

export interface LootCatalog {
  schemaVersion: number;
  season?: { id: number; name: string };
  generatedAt: string;
  /** Data must not be used after this instant; null means no expiry. */
  expiresAt: string | null;
  provenance: LootProvenance[];
  sources: LootSource[];
  warnings: string[];
}

// Raw catalog payloads (shapes build-catalogs.mjs writes)

export interface ItemColumns {
  count: number;
  id: number[];
  name: string[];
  level: number[];
  reqLevel: number[];
  quality: number[];
  invType: number[];
  itemClass: number[];
  itemSubclass: number[];
  bindType: number[];
  delay: number[];
  dmgRange: number[];
  classMask: number[];
  raceMask: (number | string)[];
  /** 0 if no sockets, else 3-entry color array. */
  socketColor: (number | number[])[];
  gemProperties: number[];
  socketBonusId: number[];
  setId: number[];
  curveId: number[];
  craftingQuality: number[];
  flags1: number[];
  flags2: number[];
  typeFlags: number[];
  /** 0 if no stats, else [type, alloc, socketMul] triples. */
  stats: (number | number[])[];
}

/** [type, value_1, value_2, value_3, value_4, index] per entry, ordered by index. */
export type BonusEntry = [number, number, number, number, number, number];

export interface BonusPayload {
  byBonusId: Record<string, BonusEntry[]>;
  nameDescriptions: Record<string, string>;
}

export interface ScalingPayload {
  squishCurveMidnight: number;
  /** curveId -> flat [primary1, primary2, ...] sorted ascending by primary1. */
  curves: Record<string, number[]>;
  /** [id, itemOffsetCurveId, itemLevel, playerLevel, squishEraId] */
  scalingConfigs: [number, number, number, number, number][];
  /** [id, curveId, offset] */
  offsetCurves: [number, number, number][];
  /** [ilevel, pEpic[5], pRare[5], pUncommon[5]] */
  randProp: [number, number[], number[], number[]][];
  socketCostPerLevel: number[];
  combatRatingMultByIlvl: number[][];
  staminaMultByIlvl: number[][];
}

export interface EnchantOption {
  enchantId: number;
  rank: number;
  name: string | null;
  option: string;
  itemClass?: number;
  invTypeMask?: number;
  subclassMask?: number;
  spellId?: number;
  effects: { statType: number | 'bonus_armor'; amount: number; coeff: number }[];
}

export interface EnchantsPayload {
  permanent: EnchantOption[];
  temporary: EnchantOption[];
  enchantments: {
    id: number; name: string | null; gemId: number; spellId: number;
    scalingId: number; minScalingLevel: number; maxScalingLevel: number;
    minIlevel: number; maxIlevel: number;
    type: number[]; amount: number[]; prop: number[]; coeff: number[];
  }[];
}

export interface GemsPayload {
  properties: { id: number; enchantId: number; color: number; descId: number }[];
}

export interface SetBonus {
  name: string; option: string; tier: string; enumId: number; setId: number;
  pieces: number; classId: number; specId: number; traitSubTree: number;
  spellId: number; itemIds: number[];
}

export interface Consumable {
  itemId: number; name: string; kind: 'potion' | 'elixir' | 'flask' | 'food';
  option: string; craftingQuality: number; level: number; reqLevel: number;
}

export interface TalentNode {
  treeIndex: number; entryId: number; nodeId: number; maxRanks: number; reqPoints: number;
  definitionId: number; spellId: number; replacesSpellId: number; overriddenBySpellId: number;
  row: number; col: number; selectionIndex: number; name: string;
  specIds: number[]; starterSpecIds: number[]; subTreeId: number; nodeType: number;
}

/** One embellishment, from `embellishment_data.inc`. */
export interface Embellishment {
  name: string;
  /** `util::tokenize` of the name, as simc matches it. */
  option: string;
  bonusId: number;
  effectId: number;
  spellId: number;
}

/**
 * One specialization. `name` comes from `util::specialization_string` when upstream
 * states one; `nameFromEngine` is false when it was derived from the enum token
 * instead, so a consumer can tell the two apart.
 */
export interface SpecEntry {
  id: number;
  token: string;
  name: string;
  nameFromEngine: boolean;
}

/** One hero sub-tree. Named so the model and the tree cannot describe it differently. */
export interface SubTree {
  id: number;
  name: string;
}

export interface TalentLayout {
  schemaVersion: 1;
  classId: number;
  build: string;
  engineCommit: string;
  expiresAt: string;
  nodes: Record<number, { x: number; y: number; flags: number; shape: string; entryType: number }>;
  descriptions: Record<number, { text: string; castTime?: string }>;
  edges: { from: number; to: number; type: number; visual: number }[];
  grants: Record<number, number>;
  budgetSources: Record<'class' | 'spec' | 'hero', { level: number; amount: number }[]>;
}

export interface TalentTree {
  layout?: TalentLayout;
  classId: number;
  nodes: TalentNode[];
  subTrees: SubTree[];
}
