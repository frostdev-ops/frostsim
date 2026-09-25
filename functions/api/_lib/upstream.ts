// Blizzard Game Data upstream: token lifecycle, fetching, parsing; credential from caller, never logged/in-URL; parsers defensive.

import {
  BASE_ITEM_CAVEAT, BLIZZARD_ATTRIBUTION, type BaseItem, type DataProvenance,
  type ItemMedia, type ItemSetInfo, type ItemSpellEffect, type ItemTooltip,
  type Locale, type Region,
} from '../../../src/lib/battlenet/contract';
import {
  InFlight, RateLimiter, TimeoutError, TtlCache, type Credentials,
  isAllowedMediaUrl, redact, withTimeout,
} from './security';

const OAUTH_URL = 'https://oauth.battle.net/token';
const DEFAULT_TIMEOUT_MS = 8000;

export class UpstreamError extends Error {
  constructor(
    readonly code: 'not_found' | 'unauthorized' | 'rate_limited' | 'upstream_unavailable' | 'upstream_timeout',
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamOptions {
  credentials: Credentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  rateLimiter?: RateLimiter;
  cacheSeconds?: number;
}

interface Token {
  value: string;
  expiresAt: number;
}

/** One client per deployment; holds token, rate limiter, in-flight map, response cache. */
export class BlizzardClient {
  private token: Token | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly inFlight = new InFlight<unknown>();
  private readonly cache: TtlCache<unknown>;
  private readonly cacheSeconds: number;
  /** Serialises token minting so a burst does not request several tokens. */
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly options: UpstreamOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.limiter = options.rateLimiter ?? new RateLimiter(60, 8, this.now);
    this.cacheSeconds = options.cacheSeconds ?? 24 * 60 * 60;
    this.cache = new TtlCache<unknown>(2000, this.now);
  }

  /** Client-credentials token, minted once and renewed a minute before expiry. */
  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;

    this.tokenRequest = (async () => {
      const { clientId, clientSecret } = this.options.credentials;
      const auth = base64(`${clientId}:${clientSecret}`);
      let res: Response;
      try {
        res = await withTimeout(
          this.fetchImpl(OAUTH_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${auth}`,
            },
            body: 'grant_type=client_credentials',
          }),
          this.timeoutMs,
          'Blizzard OAuth',
        );
      } catch (err) {
        if (err instanceof TimeoutError) throw new UpstreamError('upstream_timeout', null, 'oauth timeout');
        throw new UpstreamError('upstream_unavailable', null, this.scrub(err));
      }
      if (!res.ok) {
        // Don't read body: OAuth error can echo the request.
        throw new UpstreamError(
          res.status === 401 || res.status === 403 ? 'unauthorized' : 'upstream_unavailable',
          res.status,
          `oauth returned ${res.status}`,
        );
      }
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new UpstreamError('upstream_unavailable', res.status, 'oauth returned no token');
      const lifetime = Number.isFinite(body.expires_in) ? Number(body.expires_in) : 3600;
      // Renew a minute early to prevent in-flight request from racing expiry.
      this.token = { value: body.access_token, expiresAt: this.now() + Math.max(60, lifetime - 60) * 1000 };
      return this.token.value;
    })().finally(() => { this.tokenRequest = null; });

    return this.tokenRequest;
  }

  /** One GET against Game Data API, cached, deduplicated, rate limited; path built by module. */
  async get<T>(path: string, region: Region, locale: Locale | null, namespace = 'static', ttlSeconds = this.cacheSeconds): Promise<T> {
    const url = `https://${region}.api.blizzard.com${path}`
      + `?namespace=${namespace}-${region}${locale ? `&locale=${locale}` : ''}`;
    const key = url;

    const cached = this.cache.get(key);
    if (cached !== undefined) return cached as T;

    return this.inFlight.run(key, async () => {
      // Re-check: concurrent caller may have filled cache while we queued.
      const late = this.cache.get(key);
      if (late !== undefined) return late;

      const wait = this.limiter.take();
      if (wait !== null) throw new UpstreamError('rate_limited', null, `rate limited, retry in ${wait}s`);

      const body = await this.fetchJson(url, await this.accessToken());
      this.cache.set(key, body, ttlSeconds);
      return body;
    }) as Promise<T>;
  }

  private async fetchJson(url: string, token: string, retriedAfter401 = false): Promise<unknown> {
    let res: Response;
    try {
      res = await withTimeout(
        this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } }),
        this.timeoutMs,
        'Blizzard Game Data',
      );
    } catch (err) {
      if (err instanceof TimeoutError) throw new UpstreamError('upstream_timeout', null, 'request timeout');
      throw new UpstreamError('upstream_unavailable', null, this.scrub(err));
    }

    if (res.status === 401 && !retriedAfter401) {
      // Token expired/revoked earlier than advertised; mint again.
      return this.fetchJson(url, await this.accessToken(true), true);
    }
    if (res.status === 404) throw new UpstreamError('not_found', 404, 'not found');
    if (res.status === 429) throw new UpstreamError('rate_limited', 429, 'upstream rate limited');
    if (!res.ok) throw new UpstreamError('upstream_unavailable', res.status, `upstream returned ${res.status}`);

    try {
      return await res.json();
    } catch (err) {
      throw new UpstreamError('upstream_unavailable', res.status, this.scrub(err));
    }
  }

  /** Redact every message leaving this class. */
  private scrub(err: unknown): string {
    return redact(err instanceof Error ? err.message : String(err), this.options.credentials);
  }

  get cacheSize(): number { return this.cache.size; }
  get hasToken(): boolean { return this.token !== null; }
}

function base64(text: string): string {
  if (typeof btoa === 'function') return btoa(text);
  // Node before a global btoa, and any runtime without one.
  return Buffer.from(text, 'utf8').toString('base64');
}

// Parsers: take unknown body; upstream changes are null + note, never crash/fabrication.

const MODELLED_ITEM_FIELDS = new Set([
  '_links', 'id', 'name', 'quality', 'level', 'required_level', 'media', 'item_class',
  'item_subclass', 'inventory_type', 'purchase_price', 'sell_price', 'max_count',
  'is_equippable', 'is_stackable', 'preview_item', 'purchase_quantity',
]);

export function parseItem(body: unknown, itemId: number): BaseItem {
  const o = asObject(body);
  const preview = asObject(o.preview_item);
  return {
    id: num(o.id) ?? itemId,
    name: localized(o.name),
    quality: o.quality
      ? { type: str(asObject(o.quality).type), name: localized(asObject(o.quality).name) }
      : null,
    baseItemLevel: num(o.level) ?? num(asObject(preview.level).value),
    requiredLevel: num(o.required_level) ?? num(asObject(preview.requirements).level && asObject(asObject(preview.requirements).level).value),
    itemClass: o.item_class
      ? { id: num(asObject(o.item_class).id), name: localized(asObject(o.item_class).name) }
      : null,
    itemSubclass: o.item_subclass
      ? { id: num(asObject(o.item_subclass).id), name: localized(asObject(o.item_subclass).name) }
      : null,
    inventoryType: o.inventory_type
      ? { type: str(asObject(o.inventory_type).type), name: localized(asObject(o.inventory_type).name) }
      : null,
    isEquippable: bool(o.is_equippable),
    isStackable: bool(o.is_stackable),
    description: localized(preview.description) ?? localized(o.description),
    unmodelledFields: Object.keys(o).filter((k) => !MODELLED_ITEM_FIELDS.has(k)),
  };
}

/** Parse media; icon URL validated against allowlist here so bad URLs never reach caller. */
export function parseMedia(body: unknown, itemId: number): ItemMedia {
  const o = asObject(body);
  const assets = Array.isArray(o.assets) ? o.assets.map(asObject) : [];
  const icon = assets.find((a) => str(a.key) === 'icon') ?? assets[0];
  const rawUrl = icon ? str(icon.value) : null;
  const usable = rawUrl !== null && isAllowedMediaUrl(rawUrl);
  return {
    id: num(o.id) ?? itemId,
    iconUrl: usable ? rawUrl : null,
    fileDataId: icon ? num(icon.file_data_id) : null,
    assetKeys: assets.map((a) => str(a.key)).filter((k): k is string => k !== null),
    status: usable ? 'ok' : assets.length === 0 ? 'absent' : 'unavailable',
  };
}

/** Parse equip/use/proc lines; trigger extracted from description prefix (no trigger_type field); numbers are base values only. */
export function parseSpells(body: unknown): ItemSpellEffect[] {
  const preview = asObject(asObject(body).preview_item);
  const spells = Array.isArray(preview.spells) ? preview.spells.map(asObject) : [];
  return spells
    .map((s) => {
      const description = localized(s.description);
      return { trigger: triggerFrom(description) ?? str(s.trigger_type), description };
    })
    .filter((s) => s.description !== null || s.trigger !== null);
}

/** The API writes the trigger as an English prefix on the description. */
function triggerFrom(description: string | null): string | null {
  if (!description) return null;
  const match = /^(Equip|Use|Chance on hit|On Equip|On Use)\s*:/i.exec(description.trim());
  if (!match) return null;
  return match[1].toUpperCase().replace(/\s+/g, '_').replace(/^ON_/, '');
}

export function parseSet(body: unknown, setBody?: unknown): ItemSetInfo | null {
  const preview = asObject(asObject(body).preview_item);
  const set = asObject(preview.set);
  if (!set || Object.keys(set).length === 0) return null;
  const items = Array.isArray(set.items) ? set.items.map(asObject) : [];
  const detail = asObject(setBody);
  const setId = num(asObject(set.item_set).id);
  const effectSource = Array.isArray(set.effects) && set.effects.length ? set.effects : num(detail.id) === setId ? detail.effects : [];
  const effects = Array.isArray(effectSource) ? effectSource.map(asObject) : [];
  return {
    id: num(asObject(set.item_set).id),
    name: localized(asObject(set.item_set).name) ?? localized(set.display_string),
    // Verified live: each effect is { display_string, required_count, is_active }.
    // The piece count is the information in a set bonus, so it is carried out of
    // the display string rather than left for a caller to parse back out of it.
    bonuses: effects
      .map((e) => ({
        requiredCount: num(e.required_count),
        text: localized(e.display_string),
        isActive: bool(e.is_active),
      }))
      .filter((b): b is { requiredCount: number | null; text: string; isActive: boolean | null } => b.text !== null),
    itemIds: items.map((i) => num(asObject(i.item).id)).filter((n): n is number => n !== null),
  };
}

export function parseBinding(body: unknown): string | null {
  const preview = asObject(asObject(body).preview_item);
  return localized(asObject(preview.binding).name);
}

export function parseUniqueEquipped(body: unknown): boolean | null {
  const preview = asObject(asObject(body).preview_item);
  const text = localized(asObject(preview.unique_equipped).display_string) ?? localized(preview.unique_equipped);
  if (text === null) return null;
  return text.length > 0;
}

/** Composes a tooltip from an item body plus already-parsed media. */
export function buildTooltip(
  body: unknown,
  itemId: number,
  media: ItemMedia | null,
  sourceLine: string | null,
  iconUrl: string | null,
  setBody?: unknown,
): ItemTooltip {
  const item = parseItem(body, itemId);
  return {
    itemId: item.id,
    basis: 'base',
    name: item.name,
    quality: item.quality,
    iconUrl: iconUrl ?? (media?.status === 'ok' ? media.iconUrl : null),
    baseItemLevel: item.baseItemLevel,
    inventoryTypeName: item.inventoryType?.name ?? null,
    itemSubclassName: item.itemSubclass?.name ?? null,
    requiredLevel: item.requiredLevel,
    description: item.description,
    bindingText: parseBinding(body),
    isUniqueEquipped: parseUniqueEquipped(body),
    spells: parseSpells(body),
    set: parseSet(body, setBody),
    sourceLine,
    caveat: BASE_ITEM_CAVEAT,
  };
}

export function provenance(region: Region, locale: Locale, now: number, ttlSeconds: number): DataProvenance {
  return {
    source: 'blizzard-game-data',
    attribution: BLIZZARD_ATTRIBUTION,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    region,
    locale,
  };
}

// --- Tolerant readers --------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Localized field: string if locale sent, locale map otherwise; both handled. */
function localized(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>;
    const preferred = map.en_US ?? Object.values(map).find((v) => typeof v === 'string');
    return typeof preferred === 'string' && preferred.length > 0 ? preferred : null;
  }
  return null;
}
