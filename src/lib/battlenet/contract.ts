// Contract between the browser and Frostsim's own Battle.net endpoints: types only, no secrets.
// Server holds Blizzard OAuth credential; browser talks to own origin. API returns BASE item data before bonus ids; engine catalog resolves actual instance stats.
// Tooltip.basis prevents showing API ilevel next to simmed results.

export const BATTLENET_CONTRACT_VERSION = 1;

/** Blizzard API regions only. */
export const ALLOWED_REGIONS = ['us', 'eu', 'kr', 'tw'] as const;
export type Region = (typeof ALLOWED_REGIONS)[number];

/** Closed locale set to prevent injection. */
export const ALLOWED_LOCALES = [
  'en_US', 'es_MX', 'pt_BR', 'en_GB', 'es_ES', 'fr_FR', 'ru_RU', 'de_DE',
  'pt_PT', 'it_IT', 'ko_KR', 'zh_TW',
] as const;
export type Locale = (typeof ALLOWED_LOCALES)[number];

export const DEFAULT_REGION: Region = 'us';
export const DEFAULT_LOCALE: Locale = 'en_US';

/** Item ids bounded to prevent credential abuse via unbounded id walks. */
export const MAX_ITEM_ID = 1_000_000;

export function isValidItemId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_ITEM_ID;
}

export function isAllowedRegion(value: unknown): value is Region {
  return typeof value === 'string' && (ALLOWED_REGIONS as readonly string[]).includes(value);
}

export function isAllowedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (ALLOWED_LOCALES as readonly string[]).includes(value);
}

// --- Responses ---------------------------------------------------------------

/** Attribution and 30-day retention per Blizzard API terms, on every response. */
export interface DataProvenance {
  source: 'blizzard-game-data';
  attribution: string;
  /** When this was fetched from Blizzard. */
  fetchedAt: string;
  /** After this instant the data must not be used or served. Never beyond 30 days. */
  expiresAt: string;
  region: Region;
  locale: Locale;
}

export const BLIZZARD_ATTRIBUTION =
  'Item data from the Blizzard Game Data API. Blizzard Entertainment is the source of this data and does not endorse Frostsim.';

/** Blizzard API 30-day retention maximum. */
export const MAX_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Base item data; upstream response shape, fields optional. */
export interface BaseItem {
  id: number;
  name: string | null;
  /** Quality as Blizzard names it (e.g. "EPIC"), not the catalog's numeric form. */
  quality: { type: string | null; name: string | null } | null;
  /** BASE item level before bonus ids, not the level of any owned instance. */
  baseItemLevel: number | null;
  requiredLevel: number | null;
  itemClass: { id: number | null; name: string | null } | null;
  itemSubclass: { id: number | null; name: string | null } | null;
  inventoryType: { type: string | null; name: string | null } | null;
  isEquippable: boolean | null;
  isStackable: boolean | null;
  /** Flavour and set text; display only. */
  description: string | null;
/** Unmodelled upstream fields for diagnostics. */
  unmodelledFields: string[];
}

export interface ItemMedia {
  id: number;
  /** Same-origin proxied icon URL; set when status is ok. */
  iconUrl: string | null;
  fileDataId: number | null;
  /** All asset keys from the response, so new ones are visible. */
  assetKeys: string[];
  /** ok: available, absent: no media exists, unavailable: lookup failed. */
  status: 'ok' | 'absent' | 'unavailable';
}

/** Equip/use/proc text (engine owns coefficients). Numbers are BASE values for base level; render as flavour only. */
export interface ItemSpellEffect {
  /** "EQUIP", "USE", "CHANCE_ON_HIT". Derived from the description prefix. */
  trigger: string | null;
  description: string | null;
}

export interface ItemSetBonusLine {
  /** Pieces required for this bonus, when stated. */
  requiredCount: number | null;
  /** Line as upstream wrote it, e.g. "(2) Set: Arcane Missiles fires…". */
  text: string;
  /** Whether the previewed copy had this bonus active; display only. */
  isActive: boolean | null;
}

export interface ItemSetInfo {
  id: number | null;
  name: string | null;
  /** Bonus lines in upstream order. */
  bonuses: ItemSetBonusLine[];
  /** Item ids in the set when listed. */
  itemIds: number[];
}

/** Tooltip from base data; basis='base' means numbers don't describe the user's instance. Use catalog values when available. */
export interface ItemTooltip {
  itemId: number;
  basis: 'base';
  name: string | null;
  quality: { type: string | null; name: string | null } | null;
  iconUrl: string | null;
  /** BASE item level; prefer catalog's ResolvedItem.itemLevel when available. */
  baseItemLevel: number | null;
  inventoryTypeName: string | null;
  itemSubclassName: string | null;
  requiredLevel: number | null;
  /** Flavour text; display only. */
  description: string | null;
  /** Bind type as text, e.g. "Binds when picked up"; absent when upstream didn't state. */
  bindingText: string | null;
  isUniqueEquipped: boolean | null;
  /** Equip/use/proc lines as text. */
  spells: ItemSpellEffect[];
  set: ItemSetInfo | null;
  /** Loot source when adapter knows; never guessed from item id. */
  sourceLine: string | null;
  /** Human-readable statement of what this tooltip does and does not know (no stats field: API has generic values, not instance values resolved by catalog). */
  caveat: string;
}

export const BASE_ITEM_CAVEAT =
  'These are the item’s base values. The item level, stats and sockets of a specific copy come ' +
  'from its bonus ids and are resolved by the simulation engine’s own data, not by this API.';

export type OkResponse<T> = { ok: true; contractVersion: number; provenance: DataProvenance } & T;

/** Error codes closed set; upstream bodies never forwarded (may echo request parts). */
export type ErrorCode =
  | 'invalid_request'
  | 'not_configured'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'internal_error';

export interface ErrorResponse {
  ok: false;
  contractVersion: number;
  error: ErrorCode;
  /** Safe, human-readable, never contains credentials, tokens, or upstream bodies. */
  message: string;
  /** Rejected input field, for invalid_request only. */
  field?: string;
  retryAfterSeconds?: number;
}

export type ItemResponse = OkResponse<{ item: BaseItem }> | ErrorResponse;
export type MediaResponse = OkResponse<{ media: ItemMedia }> | ErrorResponse;
export type TooltipResponse = OkResponse<{ tooltip: ItemTooltip }> | ErrorResponse;

/** Batch lookups (picker renders dozens at once); partial success normal, bad ids don't fail batch. */
export type BatchMediaResponse =
  | OkResponse<{ media: ItemMedia[]; failed: number[] }>
  | ErrorResponse;

export type BatchTooltipResponse =
  | OkResponse<{ tooltips: ItemTooltip[]; failed: number[] }>
  | ErrorResponse;

/** Max ids per batch request; beyond this rejected, not truncated. */
export const MAX_BATCH_IDS = 100;

/** Parse and validate comma-separated id list; return null if unusable. */
export function parseIdList(raw: string | null): { ids: number[] } | { error: string } {
  if (!raw) return { error: 'ids is required' };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return { error: 'ids is empty' };
  if (parts.length > MAX_BATCH_IDS) return { error: `at most ${MAX_BATCH_IDS} ids per request` };
  const ids: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!isValidItemId(n)) return { error: `${part} is not a valid item id` };
    if (!ids.includes(n)) ids.push(n);
  }
  return { ids };
}

/** Whether deployment has credentials; let UI hide broken icons. Carries no secrets. */
export interface HealthResponse {
  ok: true;
  contractVersion: number;
  configured: boolean;
  region: Region;
  /** Deployment cache seconds; never above MAX_RETENTION_SECONDS. */
  cacheSeconds: number;
  attribution: string;
}

// Route helpers (public profile data only); only region/realm/name leave browser for portrait lookup via public namespace.
export interface CharacterMedia {
  /** Echoed back to match response to request. */
  region: Region;
  /** Official realm slug used, not the text the caller supplied. */
  realmSlug: string;
  /** Name as requested, unchanged, never logged. */
  name: string;
  /** Same-origin avatar URL, or null unless status is ok. */
  avatarUrl: string | null;
  insetUrl: string | null;
  mainUrl: string | null;
  /** All asset keys; new ones visible, not vanished. */
  assetKeys: string[];
  /** ok: available, no_character: none found, unknown_realm: realm didn't resolve, no_image: character has no render, unavailable: lookup failed. Never substitute another face. */
  status: 'ok' | 'no_character' | 'unknown_realm' | 'no_image' | 'unavailable';
  /** Plain sentence for non-ok states, safe to show. */
  message: string | null;
  /** When data must stop being used per API terms; travels with data to prevent cached outliving permission. */
  expiresAt: string;
  attribution: string;
}

export const API_BASE = '/api/wow';

export function itemPath(itemId: number, opts: { region?: Region; locale?: Locale } = {}): string {
  return `${API_BASE}/item/${itemId}${query(opts)}`;
}

export function mediaPath(itemId: number, opts: { region?: Region; locale?: Locale } = {}): string {
  return `${API_BASE}/item-media/${itemId}${query(opts)}`;
}

export function tooltipPath(itemId: number, opts: { region?: Region; locale?: Locale } = {}): string {
  const params = query(opts);
  return `${API_BASE}/tooltip/${itemId}${params}${params ? '&' : '?'}details=sets-v2`;
}

/** Icon bytes proxied by item id, not URL (server resolves asset). */
export function iconPath(itemId: number, opts: { region?: Region } = {}): string {
  return `${API_BASE}/icon/${itemId}${query(opts)}`;
}

/** Many icons in one request; ids only, bounded, deduplicated, validated. */
export function batchMediaPath(itemIds: number[], opts: { region?: Region } = {}): string {
  return `${API_BASE}/item-media?ids=${itemIds.join(',')}${query(opts).replace('?', '&')}`;
}

export function batchTooltipPath(itemIds: number[], opts: { region?: Region; locale?: Locale } = {}): string {
  return `${API_BASE}/tooltip?ids=${itemIds.join(',')}${query(opts).replace('?', '&')}`;
}

/** Portrait lookup path; realm normalized server-side (slugs not derivable from names). Identifiers as path segments, encoded here. */
export function characterMediaPath(
  region: Region, realm: string, name: string,
): string {
  return `${API_BASE}/character-media/${region}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;
}

/** Armory lookup: `{ profile }`, simc profile text of the character's equipped gear and active talents. */
export function characterProfilePath(region: Region, realm: string, name: string): string {
  return `${API_BASE}/character-profile/${region}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;
}

/** `{ realms: { name, slug }[] }`, the region's realms sorted by display name. */
export function realmsPath(region: Region): string {
  return `${API_BASE}/realms${query({ region })}`;
}

/** Instance art for loot source card; image bytes same-origin to <img src>. No JSON form. */
export function journalTilePath(instanceId: number, opts: { region?: Region } = {}): string {
  return `${API_BASE}/journal-tile/${instanceId}${query(opts)}`;
}

export const healthPath = `${API_BASE}/health`;

function query(opts: { region?: Region; locale?: Locale }): string {
  const params = new URLSearchParams();
  if (opts.region) params.set('region', opts.region);
  if (opts.locale) params.set('locale', opts.locale);
  const s = params.toString();
  return s ? `?${s}` : '';
}
