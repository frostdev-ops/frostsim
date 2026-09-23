// Frostsim's Battle.net proxy: item data, media, tooltips, icons; credential-owning (P13.2-P13.3); never profiles, names, custom script, sim input.

import {
  ALLOWED_REGIONS, API_BASE, BATTLENET_CONTRACT_VERSION, BLIZZARD_ATTRIBUTION,
  DEFAULT_LOCALE, DEFAULT_REGION, isAllowedLocale, isAllowedRegion, isValidItemId, parseIdList,
  type BaseItem, type CharacterMedia, type ErrorCode, type ErrorResponse, type HealthResponse,
  type ItemMedia, type ItemTooltip, type Locale, type Region,
} from '../../src/lib/battlenet/contract';
import {
  ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, RateLimiter, TtlCache, cacheSeconds, credentialsFrom,
  isAllowedImageType, isAllowedMediaUrl, itemIdAllowlist, redact, safeMessage,
  withTimeout, type Credentials, type Env,
} from './_lib/security';
import { BlizzardClient, UpstreamError, buildTooltip, parseItem, parseMedia, parseSet, provenance } from './_lib/upstream';

import spellIcons from '../../src/lib/battlenet/generated/spell-icons.json';

/** One client per isolate, so the token, cache and limiter survive between requests. */
let client: BlizzardClient | null = null;
let clientKey = '';
const mediaLimiter = new RateLimiter(120, 20);
const raiderCache = new TtlCache<{ score: number | null; progression: { name: string; summary: string }[] }>(500);

function clientFor(credentials: Credentials, env: Env): BlizzardClient {
  // Rebuild only if the credential or cache policy actually changed.
  const key = `${credentials.clientId}:${cacheSeconds(env)}`;
  if (!client || clientKey !== key) {
    client = new BlizzardClient({ credentials, cacheSeconds: cacheSeconds(env) });
    clientKey = key;
  }
  return client;
}

export interface PagesContext {
  request: Request;
  env: Env;
  params?: Record<string, string | string[]>;
  data?: unknown;
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('invalid_request', 405, 'Only GET is supported.');
  }

  const url = new URL(request.url);
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  // ['api', 'wow', ...]
  if (segments[0] !== 'api' || segments[1] !== 'wow') {
    return errorResponse('not_found', 404, 'No such endpoint.');
  }
  const route = segments[2] ?? '';
  const idSegment = segments[3];
  const region = readRegion(url);
  if (region === null) return errorResponse('invalid_request', 400, 'Unsupported region.', 'region');
  const locale = readLocale(url);
  if (locale === null) return errorResponse('invalid_request', 400, 'Unsupported locale.', 'locale');

  const credentials = credentialsFrom(env);

  if (route === 'health') {
    const body: HealthResponse = {
      ok: true,
      contractVersion: BATTLENET_CONTRACT_VERSION,
      configured: credentials !== null,
      region,
      cacheSeconds: cacheSeconds(env),
      attribution: BLIZZARD_ATTRIBUTION,
    };
    return json(body, 200, cacheSeconds(env));
  }

  if (!credentials) {
    // Not user error; UI hides broken icons, needs distinguishing from failures.
    return errorResponse('not_configured', 503, safeMessage('not_configured'));
  }

  try {
    switch (route) {
      case 'item': return await handleItem(idSegment, region, locale, credentials, env);
      case 'item-media': return await handleMedia(idSegment, url, region, locale, credentials, env);
      case 'tooltip': return await handleTooltip(idSegment, url, region, locale, credentials, env);
      case 'icon': return await handleIcon(idSegment, region, credentials, env, 'item');
      case 'spell-icon': return await handleIcon(idSegment, region, credentials, env, 'spell');
      case 'raider-profile': return await handleRaiderProfile(segments);
      case 'character-media': return await handleCharacterMedia(segments, region, credentials, env);
      case 'character-render': return await handleCharacterRender(segments, credentials, env);
      case 'journal-tile': return await handleJournalTile(idSegment, region, credentials, env);
      default: return errorResponse('not_found', 404, 'No such endpoint.');
    }
  } catch (err) {
    return fromError(err, credentials);
  }
}

export default onRequest;

// --- Handlers ----------------------------------------------------------------

async function handleRaiderProfile(segments: string[]): Promise<Response> {
  const region = segments[3] ?? '';
  const realm = decodeURIComponent(segments[4] ?? '');
  const name = readCharacterName(segments[5]);
  if (!(ALLOWED_REGIONS as readonly string[]).includes(region) || typeof name !== 'string' || !realm || realm.length > 100 || /[/?#]/.test(realm)) return errorResponse('invalid_request', 400, 'Invalid character identity.');
  const key = [region, realm, name].join('/');
  const cached = raiderCache.get(key);
  if (cached) return json(cached, 200, 3600);
  const wait = mediaLimiter.take();
  if (wait !== null) return errorResponse('rate_limited', 429, 'Try again shortly.');
  try {
    const params = new URLSearchParams({ region, realm, name, fields: 'mythic_plus_scores_by_season:current,raid_progression' });
    const response = await fetch('https://raider.io/api/v1/characters/profile?' + params, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) return errorResponse('not_found', 404, 'Raider.IO profile unavailable.');
    const data = await response.json() as { mythic_plus_scores_by_season?: { scores?: { all?: number } }[]; raid_progression?: Record<string, { summary?: string }> };
    const score = data.mythic_plus_scores_by_season?.[0]?.scores?.all;
    const result = { score: typeof score === 'number' && Number.isFinite(score) ? score : null,
      progression: Object.entries(data.raid_progression ?? {}).filter(([, entry]) => typeof entry?.summary === 'string' && entry.summary).slice(0, 12).map(([name, entry]) => ({ name: name.slice(0, 100), summary: entry.summary!.slice(0, 30) })) };
    raiderCache.set(key, result, 3600);
    return json(result, 200, 3600);
  } catch { return errorResponse('upstream_unavailable', 502, 'Raider.IO profile unavailable.'); }
}

async function handleItem(
  idSegment: string | undefined, region: Region, locale: Locale, credentials: Credentials, env: Env,
): Promise<Response> {
  const itemId = readItemId(idSegment, env);
  if (typeof itemId !== 'number') return itemId;

  const body = await clientFor(credentials, env).get<unknown>(`/data/wow/item/${itemId}`, region, locale);
  const item: BaseItem = parseItem(body, itemId);
  return ok({ item }, region, locale, env);
}

async function handleMedia(
  idSegment: string | undefined, url: URL, region: Region, locale: Locale, credentials: Credentials, env: Env,
): Promise<Response> {
  const bn = clientFor(credentials, env);

  if (idSegment === undefined) {
    const parsed = parseIdList(url.searchParams.get('ids'));
    if ('error' in parsed) return errorResponse('invalid_request', 400, parsed.error, 'ids');
    const allowed = itemIdAllowlist(env);
    const media: ItemMedia[] = [];
    const failed: number[] = [];
    // Sequential: batch of 100 doesn't become 100 simultaneous upstream requests; client cache/in-flight handle repeats.
    for (const id of parsed.ids) {
      if (allowed && !allowed.has(id)) { failed.push(id); continue; }
      try {
        media.push(withProxiedIcon(parseMedia(await bn.get<unknown>(`/data/wow/media/item/${id}`, region, null), id), id, region));
      } catch {
        failed.push(id);
      }
    }
    return ok({ media, failed }, region, locale, env);
  }

  const itemId = readItemId(idSegment, env);
  if (typeof itemId !== 'number') return itemId;
  const parsedMedia = parseMedia(await bn.get<unknown>(`/data/wow/media/item/${itemId}`, region, null), itemId);
  return ok({ media: withProxiedIcon(parsedMedia, itemId, region) }, region, locale, env);
}

async function handleTooltip(
  idSegment: string | undefined, url: URL, region: Region, locale: Locale, credentials: Credentials, env: Env,
): Promise<Response> {
  const bn = clientFor(credentials, env);

  const build = async (id: number): Promise<ItemTooltip> => {
    const itemBody = await bn.get<unknown>(`/data/wow/item/${id}`, region, locale);
    // Image endpoint resolves availability independently; tooltip text must not wait for art.
    const iconUrl = proxiedIconUrl(id, region);
    // Source null: loot membership needs loot adapter configured; endpoint has no catalog access.
    const setId = parseSet(itemBody)?.id;
    const setBody = setId && Number.isSafeInteger(setId) && setId > 0
      ? await bn.get<unknown>(`/data/wow/item-set/${setId}`, region, locale).catch(() => null) : null;
    return buildTooltip(itemBody, id, null, null, iconUrl, setBody);
  };

  if (idSegment === undefined) {
    const parsed = parseIdList(url.searchParams.get('ids'));
    if ('error' in parsed) return errorResponse('invalid_request', 400, parsed.error, 'ids');
    const allowed = itemIdAllowlist(env);
    const tooltips: ItemTooltip[] = [];
    const failed: number[] = [];
    for (const id of parsed.ids) {
      if (allowed && !allowed.has(id)) { failed.push(id); continue; }
      try { tooltips.push(await build(id)); } catch { failed.push(id); }
    }
    return ok({ tooltips, failed }, region, locale, env);
  }

  const itemId = readItemId(idSegment, env);
  if (typeof itemId !== 'number') return itemId;
  return ok({ tooltip: await build(itemId) }, region, locale, env);
}

/** Icon bytes for item/spell; caller supplies ID never URL; url resolved then checked against allowlist; no redirects, type/size checked. */
async function handleIcon(
  idSegment: string | undefined, region: Region, credentials: Credentials, env: Env,
  kind: 'item' | 'spell',
): Promise<Response> {
  // Spell IDs not in item allowlist; range-checked independently.
  const id = kind === 'item' ? readItemId(idSegment, env) : readSpellId(idSegment);
  if (typeof id !== 'number') return id;

  const wait = mediaLimiter.take();
  if (wait !== null) return errorResponse('rate_limited', 429, safeMessage('rate_limited'), undefined, wait);

  // The media API only indexes player-learnable spells; consumables, enchants and pet or NPC
  // abilities have no record there. Every icon is on the render CDN by the file name the game data
  // gives it (scripts/generate-presentation.mjs), so a named spell goes straight there.
  if (kind === 'spell') {
    const index = (spellIcons.spells as Record<string, number>)[id];
    if (index !== undefined) {
      const named = await proxyImage(`https://render.worldofwarcraft.com/${region}/icons/56/${encodeURIComponent(spellIcons.names[index])}.jpg`, env);
      if (named.status !== 404) return named;
    }
  }

  const bn = clientFor(credentials, env);
  const media = parseMedia(await bn.get<unknown>(`/data/wow/media/${kind}/${id}`, region, null), id);
  if (media.status !== 'ok' || !media.iconUrl) {
    return errorResponse('not_found', 404, safeMessage('not_found'));
  }
  // Belt and braces: recheck at use point where being wrong costs (parseMedia already checked).
  if (!isAllowedMediaUrl(media.iconUrl)) {
    return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
  }

  return await proxyImage(media.iconUrl, env);
}

/** Fetch image bytes from resolved URL and serve from own origin; one impl for all image routes (allowlist recheck, no redirects, type/size bounds). */
async function proxyImage(target: string, env: Env): Promise<Response> {
  // Recheck at use point where being wrong costs.
  if (!isAllowedMediaUrl(target)) {
    return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
  }

  let upstream: Response;
  try {
    upstream = await withTimeout(fetch(target, { redirect: 'error' }), 6000, 'Blizzard media');
  } catch {
    return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
  }
  if (!upstream.ok) {
    // 403 and 404 both mean "picture doesn't exist" not "we failed" (15/212 journal instances are advertised but absent).
    return upstream.status === 404 || upstream.status === 403
      ? errorResponse('not_found', 404, safeMessage('not_found'))
      : errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
  }

  const contentType = upstream.headers.get('content-type');
  if (!isAllowedImageType(contentType)) {
    return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
  }
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
  }

  const ttl = cacheSeconds(env);
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': contentType!.split(';')[0].trim(),
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Data-Source': 'Blizzard Game Data API',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

// --- Character media (public profile namespace) -------
// Leaves origin: region, realm slug, char name (portrait only); no addon export, action list, bag, talents, gear, results, account OAuth, private data.

/** Official realm slugs, cached module-scope (once per process, not per request); not derivable from names, must not be guessed client-side. */
const realmSlugCache = new Map<Region, Map<string, string>>();

async function realmSlugs(
  region: Region, credentials: Credentials, env: Env,
): Promise<Map<string, string> | null> {
  const cached = realmSlugCache.get(region);
  if (cached) return cached;
  const body = await clientFor(credentials, env).get<unknown>('/data/wow/realm/index', region, null, 'dynamic');
  const realms = (body as { realms?: { name?: unknown; slug?: unknown }[] } | null)?.realms;
  if (!Array.isArray(realms)) return null;
  const map = new Map<string, string>();
  for (const r of realms) {
    if (typeof r?.slug !== 'string') continue;
    map.set(r.slug.toLowerCase(), r.slug);
    if (typeof r?.name === 'string') map.set(normalizeRealmKey(r.name), r.slug);
  }
  realmSlugCache.set(region, map);
  return map; // Cached.
}

/** Loose key for matching user-typed realm text against a real realm name. */
function normalizeRealmKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Character name willing to send upstream; deliberately narrow. */
function readCharacterName(raw: string | undefined): string | Response {
  if (!raw) return errorResponse('invalid_request', 400, 'A character name is required.', 'name');
  const name = decodeURIComponent(raw).trim();
  // Names: letters + marks, no slashes/dots/spaces; anything else isn't a name and must not reach upstream.
  if (name.length === 0 || name.length > 24 || /[/\\?#&.\s]/.test(name)) {
    return errorResponse('invalid_request', 400, 'That is not a valid character name.', 'name');
  }
  return name;
}

async function resolveCharacter(
  segments: string[], fallbackRegion: Region, credentials: Credentials, env: Env,
): Promise<{ region: Region; realmSlug: string; name: string } | { failure: CharacterMedia['status']; message: string }> {
  const regionSegment = (segments[3] ?? '').toLowerCase();
  const region = (ALLOWED_REGIONS as readonly string[]).includes(regionSegment)
    ? (regionSegment as Region)
    : fallbackRegion;

  const realmRaw = decodeURIComponent(segments[4] ?? '').trim();
  const name = readCharacterName(segments[5]);
  if (typeof name !== 'string') return { failure: 'no_character', message: 'That is not a valid character name.' };
  if (!realmRaw) return { failure: 'unknown_realm', message: 'A realm is required.' };

  const slugs = await realmSlugs(region, credentials, env);
  if (!slugs) return { failure: 'unavailable', message: safeMessage('upstream_unavailable') };

  // Exact slug or display name, never guessed slugification.
  const slug = slugs.get(realmRaw.toLowerCase()) ?? slugs.get(normalizeRealmKey(realmRaw)) ?? null;
  if (!slug) {
    return {
      failure: 'unknown_realm',
      message: 'That realm was not found in this region. Check the region and the spelling.',
    };
  }
  return { region, realmSlug: slug, name };
}

/** Asset keys we will serve, so no caller can name an arbitrary one. */
const CHARACTER_ASSETS = ['avatar', 'inset', 'main', 'main-raw'] as const;

async function characterAssets(
  region: Region, realmSlug: string, name: string, credentials: Credentials, env: Env,
): Promise<{ assets: Map<string, string>; status: 'ok' | 'no_character' | 'unavailable' }> {
  const path = `/profile/wow/character/${realmSlug}/${encodeURIComponent(name.toLowerCase())}/character-media`;
  let body: unknown;
  try {
    body = await clientFor(credentials, env).get<unknown>(path, region, null, 'profile');
  } catch (err) {
    // Unlookedat char, renamed char, wrong realm all 404; same to user: no portrait.
    if (err instanceof UpstreamError && err.code === 'not_found') {
      return { assets: new Map(), status: 'no_character' };
    }
    return { assets: new Map(), status: 'unavailable' };
  }
  const raw = (body as { assets?: { key?: unknown; value?: unknown }[] } | null)?.assets;
  const assets = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (typeof a?.key === 'string' && typeof a?.value === 'string' && isAllowedMediaUrl(a.value)) {
        assets.set(a.key, a.value);
      }
    }
  }
  return { assets, status: 'ok' };
}

async function handleCharacterMedia(
  segments: string[], fallbackRegion: Region, credentials: Credentials, env: Env,
): Promise<Response> {
  const resolved = await resolveCharacter(segments, fallbackRegion, credentials, env);
  const base = (status: CharacterMedia['status'], message: string | null): CharacterMedia => ({
    region: 'region' in resolved ? resolved.region : fallbackRegion,
    realmSlug: 'realmSlug' in resolved ? resolved.realmSlug : '',
    name: 'name' in resolved ? resolved.name : '',
    avatarUrl: null, insetUrl: null, mainUrl: null, assetKeys: [],
    status, message,
    // Rides with the data so a cached portrait cannot outlive its permission by
    // being stored somewhere the fetch TTL does not reach.
    expiresAt: new Date(Date.now() + cacheSeconds(env) * 1000).toISOString(),
    attribution: BLIZZARD_ATTRIBUTION,
  });

  if ('failure' in resolved) {
    // 200 with status not HTTP error: "no portrait" is normal outcome UI renders, not broken failure.
    return json(base(resolved.failure, resolved.message), 200, cacheSeconds(env));
  }

  const wait = mediaLimiter.take();
  if (wait !== null) return errorResponse('rate_limited', 429, safeMessage('rate_limited'), undefined, wait);

  const { assets, status } = await characterAssets(
    resolved.region, resolved.realmSlug, resolved.name, credentials, env,
  );
  if (status === 'no_character') {
    return json(base('no_character', 'No character by that name was found on that realm.'), 200, cacheSeconds(env));
  }
  if (status === 'unavailable') {
    return json(base('unavailable', safeMessage('upstream_unavailable')), 200, 0);
  }
  if (assets.size === 0) {
    return json(base('no_image', 'That character has no portrait yet.'), 200, cacheSeconds(env));
  }

  // Same-origin byte routes never Blizzard URL (CSP img-src 'self' data:; COEP blocks uncosted cross-origin).
  const renderUrl = (asset: string) =>
    `${API_BASE}/character-render/${resolved.region}/${encodeURIComponent(resolved.realmSlug)}` +
    `/${encodeURIComponent(resolved.name)}/${asset}`;

  const body: CharacterMedia = {
    ...base('ok', null),
    avatarUrl: assets.has('avatar') ? renderUrl('avatar') : null,
    insetUrl: assets.has('inset') ? renderUrl('inset') : null,
    mainUrl: assets.has('main') ? renderUrl('main') : null,
    assetKeys: [...assets.keys()],
  };
  return json(body, 200, cacheSeconds(env));
}

/** Portrait bytes. Re-resolves and re-checks; a caller never names a URL. */
async function handleCharacterRender(
  segments: string[], credentials: Credentials, env: Env,
): Promise<Response> {
  const asset = segments[6] ?? 'avatar';
  if (!(CHARACTER_ASSETS as readonly string[]).includes(asset)) {
    return errorResponse('invalid_request', 400, 'Unknown portrait asset.', 'asset');
  }
  const regionSegment = (segments[3] ?? '').toLowerCase();
  const region = (ALLOWED_REGIONS as readonly string[]).includes(regionSegment) ? (regionSegment as Region) : null;
  if (!region) return errorResponse('invalid_request', 400, 'Unsupported region.', 'region');

  const resolved = await resolveCharacter(segments, region, credentials, env);
  if ('failure' in resolved) return errorResponse('not_found', 404, safeMessage('not_found'));

  const { assets, status } = await characterAssets(
    resolved.region, resolved.realmSlug, resolved.name, credentials, env,
  );
  const target = status === 'ok' ? assets.get(asset) ?? null : null;
  if (!target) return errorResponse('not_found', 404, safeMessage('not_found'));
  return await proxyImage(target, env);
}

/** Instance art for a loot source card. Encounters carry no media; instances do. */
async function handleJournalTile(
  idSegment: string | undefined, region: Region, credentials: Credentials, env: Env,
): Promise<Response> {
  if (!idSegment || !/^\d{1,7}$/.test(idSegment)) {
    return errorResponse('invalid_request', 400, 'Instance id must be a positive integer.', 'instanceId');
  }
  const wait = mediaLimiter.take();
  if (wait !== null) return errorResponse('rate_limited', 429, safeMessage('rate_limited'), undefined, wait);

  let body: unknown;
  try {
    body = await clientFor(credentials, env).get<unknown>(
      `/data/wow/media/journal-instance/${Number(idSegment)}`, region, null,
    );
  } catch (err) {
    if (err instanceof UpstreamError && err.code === 'not_found') {
      return errorResponse('not_found', 404, safeMessage('not_found'));
    }
    return fromError(err, credentials);
  }
  const raw = (body as { assets?: { key?: unknown; value?: unknown }[] } | null)?.assets;
  const tile = Array.isArray(raw)
    ? raw.find((a) => typeof a?.value === 'string' && isAllowedMediaUrl(a.value as string))
    : null;
  if (!tile || typeof tile.value !== 'string') {
    return errorResponse('not_found', 404, safeMessage('not_found'));
  }
  return await proxyImage(tile.value, env);
}

// --- Helpers -----------------------------------------------------------------

function proxiedIconUrl(itemId: number, region: Region): string {
  return `/api/wow/icon/${itemId}?region=${region}`;
}

/** Replaces the upstream icon URL with our own, so no Blizzard host reaches the page. */
function withProxiedIcon(media: ItemMedia, itemId: number, region: Region): ItemMedia {
  return media.status === 'ok' ? { ...media, iconUrl: proxiedIconUrl(itemId, region) } : media;
}

function readRegion(url: URL): Region | null {
  const raw = url.searchParams.get('region');
  if (raw === null) return DEFAULT_REGION;
  return isAllowedRegion(raw) ? raw : null;
}

function readLocale(url: URL): Locale | null {
  const raw = url.searchParams.get('locale');
  if (raw === null) return DEFAULT_LOCALE;
  return isAllowedLocale(raw) ? raw : null;
}

/** Returns the id, or the Response to send instead. */
/**
 * A spell id for the media endpoint. No allowlist: spell ids are not user data and
 * every id in a talent tree is already public, so the bound is the format and the
 * range rather than a list.
 */
function readSpellId(segment: string | undefined): number | Response {
  if (segment === undefined) return errorResponse('invalid_request', 400, 'A spell id is required.', 'spellId');
  if (!/^\d{1,8}$/.test(segment)) {
    return errorResponse('invalid_request', 400, 'Spell id must be a positive integer.', 'spellId');
  }
  const spellId = Number(segment);
  if (spellId <= 0) return errorResponse('invalid_request', 400, 'Spell id is out of range.', 'spellId');
  return spellId;
}

function readItemId(segment: string | undefined, env: Env): number | Response {
  if (segment === undefined) return errorResponse('invalid_request', 400, 'An item id is required.', 'itemId');
  // Reject anything that is not a bare integer: no leading +, no exponent, no hex.
  if (!/^\d{1,7}$/.test(segment)) {
    return errorResponse('invalid_request', 400, 'Item id must be a positive integer.', 'itemId');
  }
  const itemId = Number(segment);
  if (!isValidItemId(itemId)) {
    return errorResponse('invalid_request', 400, 'Item id is out of range.', 'itemId');
  }
  const allowed = itemIdAllowlist(env);
  if (allowed && !allowed.has(itemId)) {
    // Indistinguishable from "no such item", on purpose: the allowlist's contents
    // are not something a caller should be able to enumerate.
    return errorResponse('not_found', 404, safeMessage('not_found'));
  }
  return itemId;
}

function ok(payload: object, region: Region, locale: Locale, env: Env): Response {
  const ttl = cacheSeconds(env);
  return json(
    {
      ok: true,
      contractVersion: BATTLENET_CONTRACT_VERSION,
      provenance: provenance(region, locale, Date.now(), ttl),
      ...payload,
    },
    200,
    ttl,
  );
}

function errorResponse(
  error: ErrorCode, status: number, message: string, field?: string, retryAfterSeconds?: number,
): Response {
  const body: ErrorResponse = {
    ok: false,
    contractVersion: BATTLENET_CONTRACT_VERSION,
    error,
    message,
    ...(field ? { field } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
  const headers: Record<string, string> = {};
  if (retryAfterSeconds) headers['Retry-After'] = String(retryAfterSeconds);
  return json(body, status, 0, headers);
}

/** Maps an upstream failure onto a safe response. No upstream body is ever forwarded. */
function fromError(err: unknown, credentials: Credentials | null): Response {
  if (err instanceof UpstreamError) {
    switch (err.code) {
      case 'not_found': return errorResponse('not_found', 404, safeMessage('not_found'));
      case 'rate_limited': return errorResponse('rate_limited', 429, safeMessage('rate_limited'), undefined, 5);
      case 'upstream_timeout': return errorResponse('upstream_timeout', 504, safeMessage('upstream_timeout'));
      case 'unauthorized':
        // Our credential is wrong or revoked. That is an operator problem, and the
        // caller must not be told which — it would confirm a credential exists.
        return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
      default: return errorResponse('upstream_unavailable', 502, safeMessage('upstream_unavailable'));
    }
  }
  // Redact always: stack traces can carry URLs; cost of redacting needlessly is nothing.
  void redact(err instanceof Error ? err.message : String(err), credentials);
  return errorResponse('internal_error', 500, safeMessage('internal_error'));
}

function json(body: unknown, status: number, ttlSeconds: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ttlSeconds > 0 ? `public, max-age=${ttlSeconds}` : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Data-Source': 'Blizzard Game Data API',
      ...extra,
    },
  });
}

export const __testing = { readItemId, readRegion, readLocale, proxiedIconUrl, withProxiedIcon, ALLOWED_IMAGE_TYPES };
