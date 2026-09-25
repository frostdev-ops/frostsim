// Battle.net proxy: parsers, safety rails, routing; no network/credentials; fixtures synthetic (Blizzard retains 30 days max).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BATTLENET_CONTRACT_VERSION, MAX_BATCH_IDS, MAX_RETENTION_SECONDS,
  isAllowedLocale, isAllowedRegion, isValidItemId, parseIdList,
} from '../../../src/lib/battlenet/contract';
import {
  InFlight, MAX_IMAGE_BYTES, RateLimiter, TtlCache, cacheSeconds, credentialsFrom,
  isAllowedImageType, isAllowedMediaUrl, itemIdAllowlist, redact, safeMessage,
} from './security';
import { BlizzardClient, UpstreamError, buildTooltip, parseItem, parseMedia, parseSet, parseSpells, parseUniqueEquipped } from './upstream';
import { onRequest } from '../[[path]]';

const FIX = 'tests/fixtures/battlenet';
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'));

const CREDS = { clientId: 'test-client-id-value', clientSecret: 'test-client-secret-value' };
const CONFIGURED = { BLIZZARD_CLIENT_ID: CREDS.clientId, BLIZZARD_CLIENT_SECRET: CREDS.clientSecret };

// Contract validation.

describe('contract validation', () => {
  it('accepts only the four documented regions', () => {
    for (const r of ['us', 'eu', 'kr', 'tw']) expect(isAllowedRegion(r)).toBe(true);
    for (const r of ['cn', 'US', '', 'us;drop', undefined]) expect(isAllowedRegion(r)).toBe(false);
  });

  it('accepts only listed locales, so locale is not an injection surface', () => {
    expect(isAllowedLocale('en_US')).toBe(true);
    expect(isAllowedLocale('en_US&namespace=x')).toBe(false);
    expect(isAllowedLocale('../../etc')).toBe(false);
  });

  it('bounds item ids', () => {
    expect(isValidItemId(271564)).toBe(true);
    for (const bad of [0, -1, 1.5, NaN, Infinity, 2_000_000, '5']) expect(isValidItemId(bad)).toBe(false);
  });

  it('rejects an oversized or malformed id list rather than truncating it', () => {
    expect(parseIdList(null)).toEqual({ error: 'ids is required' });
    expect(parseIdList('')).toEqual({ error: 'ids is required' });
    expect(parseIdList('1,abc')).toEqual({ error: 'abc is not a valid item id' });
    const tooMany = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => i + 1).join(',');
    expect(parseIdList(tooMany)).toEqual({ error: `at most ${MAX_BATCH_IDS} ids per request` });
  });

  it('deduplicates ids in a batch', () => {
    expect(parseIdList('5,5,7')).toEqual({ ids: [5, 7] });
  });
});

// Secret handling.

describe('secret handling', () => {
  it('removes the credential from any text that could be logged', () => {
    const text = `failed with ${CREDS.clientSecret} for ${CREDS.clientId}`;
    const out = redact(text, CREDS);
    expect(out).not.toContain(CREDS.clientSecret);
    expect(out).not.toContain(CREDS.clientId);
    expect(out).toBe('failed with [redacted] for [redacted]');
  });

  it('removes bearer and basic credentials whatever their origin', () => {
    expect(redact('Authorization: Bearer abc.def-ghi123', null)).toBe('Authorization: Bearer [redacted]');
    expect(redact('Authorization: Basic YWJjOmRlZg==', null)).toBe('Authorization: Basic [redacted]');
    expect(redact('{"access_token":"xyz789abc"}', null)).toContain('[redacted]');
    expect(redact('{"access_token":"xyz789abc"}', null)).not.toContain('xyz789abc');
  });

  it('is absent rather than empty when credentials are not configured', () => {
    expect(credentialsFrom({})).toBeNull();
    expect(credentialsFrom({ BLIZZARD_CLIENT_ID: 'a' })).toBeNull();
    expect(credentialsFrom({ BLIZZARD_CLIENT_ID: ' ', BLIZZARD_CLIENT_SECRET: ' ' })).toBeNull();
    expect(credentialsFrom(CONFIGURED)).toEqual(CREDS);
  });

  it('returns a fixed message per failure class, never an upstream body', () => {
    for (const code of ['not_configured', 'not_found', 'rate_limited', 'upstream_timeout', 'upstream_unavailable']) {
      expect(safeMessage(code)).toMatch(/^[A-Z]/);
      expect(safeMessage(code)).not.toMatch(/http|token|secret/i);
    }
  });
});

// SSRF.

describe('media host allowlist', () => {
  it('accepts the real Blizzard render hosts over https', () => {
    expect(isAllowedMediaUrl('https://render.worldofwarcraft.com/us/icons/56/inv_x.jpg')).toBe(true);
    expect(isAllowedMediaUrl('https://render-eu.worldofwarcraft.com/eu/icons/56/inv_x.jpg')).toBe(true);
  });

  it('refuses every shape of somewhere else', () => {
    const bad = [
      'https://attacker.example.com/payload.jpg',
      'http://render.worldofwarcraft.com/x.jpg',              // plaintext
      'https://render.worldofwarcraft.com.attacker.dev/x.jpg', // suffix trick
      'https://user:pass@render.worldofwarcraft.com/x.jpg',    // credentials in URL
      'https://render.worldofwarcraft.com:8080/x.jpg',         // odd port
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data/',              // cloud metadata
      'not a url',
    ];
    for (const url of bad) expect(isAllowedMediaUrl(url), url).toBe(false);
  });

  it('passes only image content types', () => {
    expect(isAllowedImageType('image/jpeg')).toBe(true);
    expect(isAllowedImageType('image/png; charset=utf-8')).toBe(true);
    for (const bad of ['text/html', 'application/json', 'image/svg+xml', null, '']) {
      expect(isAllowedImageType(bad)).toBe(false);
    }
  });

  it('refuses an off-host asset when parsing media, before it can be fetched', () => {
    const media = parseMedia(fixture('item-media-offhost'), 900004);
    expect(media.status).toBe('unavailable');
    expect(media.iconUrl).toBeNull();
  });
});

// Rate limiting, deduplication, cache.

describe('rate limiting', () => {
  it('allows a burst up to capacity then asks the caller to wait', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1, () => now);
    expect(limiter.take()).toBeNull();
    expect(limiter.take()).toBeNull();
    expect(limiter.take()).toBeNull();
    expect(limiter.take()).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1, () => now);
    expect(limiter.take()).toBeNull();
    expect(limiter.take()).toBeGreaterThan(0);
    now = 2000;
    expect(limiter.take()).toBeNull();
  });
});

describe('request deduplication', () => {
  it('collapses concurrent identical requests into one call', async () => {
    const inFlight = new InFlight<number>();
    const task = vi.fn(async () => 42);
    const [a, b, c] = await Promise.all([
      inFlight.run('k', task), inFlight.run('k', task), inFlight.run('k', task),
    ]);
    expect([a, b, c]).toEqual([42, 42, 42]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('releases the key so a later request runs again', async () => {
    const inFlight = new InFlight<number>();
    const task = vi.fn(async () => 1);
    await inFlight.run('k', task);
    await inFlight.run('k', task);
    expect(task).toHaveBeenCalledTimes(2);
    expect(inFlight.size).toBe(0);
  });
});

describe('cache', () => {
  it('expires entries and never exceeds the retention limit', () => {
    let now = 0;
    const cache = new TtlCache<string>(10, () => now);
    cache.set('a', 'v', 10);
    expect(cache.get('a')).toBe('v');
    now = 11_000;
    expect(cache.get('a')).toBeUndefined();

    // A caller asking for a year gets Blizzard's 30-day ceiling.
    now = 0;
    cache.set('b', 'v', 365 * 24 * 3600);
    now = (MAX_RETENTION_SECONDS + 1) * 1000;
    expect(cache.get('b')).toBeUndefined();
  });

  it('evicts least-recently-used entries past the bound', () => {
    const cache = new TtlCache<number>(2);
    cache.set('a', 1, 60); cache.set('b', 2, 60);
    cache.get('a');                 // 'a' becomes most recent
    cache.set('c', 3, 60);          // evicts 'b'
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('clamps the configured cache lifetime to the retention limit', () => {
    expect(cacheSeconds({ BLIZZARD_CACHE_SECONDS: '99999999' })).toBe(MAX_RETENTION_SECONDS);
    expect(cacheSeconds({ BLIZZARD_CACHE_SECONDS: '600' })).toBe(600);
    expect(cacheSeconds({})).toBe(86_400);
  });

  it('reads an optional item id allowlist', () => {
    expect(itemIdAllowlist({})).toBeNull();
    expect(itemIdAllowlist({ BLIZZARD_ITEM_ID_ALLOWLIST: ' 1, 2 ,3 ' })).toEqual(new Set([1, 2, 3]));
  });
});

// Parsers.

describe('item parsing', () => {
  it('reads the fields the tooltip needs', () => {
    const item = parseItem(fixture('item-set-piece'), 900002);
    expect(item.name).toBe('Fixture Crown');
    expect(item.quality).toEqual({ type: 'EPIC', name: 'Epic' });
    expect(item.baseItemLevel).toBe(219);
    expect(item.inventoryType).toEqual({ type: 'HEAD', name: 'Head' });
    expect(item.isEquippable).toBe(true);
  });

  it('lists unmodelled fields instead of dropping them silently', () => {
    // `appearances` is real and unmodelled; upstream adding a field must be visible.
    expect(parseItem(fixture('item-set-piece'), 900002).unmodelledFields).toContain('appearances');
  });

  it('returns nulls rather than defaults for a body it does not understand', () => {
    const item = parseItem({}, 5);
    expect(item.id).toBe(5);
    expect(item.name).toBeNull();
    expect(item.baseItemLevel).toBeNull();
    expect(item.quality).toBeNull();
  });

  it('survives a hostile body without throwing', () => {
    for (const body of [null, 'a string', 42, [], { quality: 'not an object' }]) {
      expect(() => parseItem(body, 1)).not.toThrow();
    }
  });

  it('handles a locale map as well as a plain string', () => {
    expect(parseItem({ name: { en_US: 'Mapped', de_DE: 'Anders' } }, 1).name).toBe('Mapped');
    expect(parseItem({ name: 'Plain' }, 1).name).toBe('Plain');
  });
});

describe('media parsing', () => {
  it('accepts an icon on an allowlisted host', () => {
    const media = parseMedia(fixture('item-media'), 900002);
    expect(media.status).toBe('ok');
    expect(media.iconUrl).toContain('render.worldofwarcraft.com');
    expect(media.fileDataId).toBe(7807656);
    expect(media.assetKeys).toEqual(['icon']);
  });

  it('reports an item with no media as absent, distinct from a failure', () => {
    const media = parseMedia({ id: 7, assets: [] }, 7);
    expect(media.status).toBe('absent');
    expect(media.iconUrl).toBeNull();
  });
});

describe('tooltip composition', () => {
  it('fills absent preview bonuses from the matching item-set endpoint', () => {
    const body = { preview_item: { set: { item_set: { id: 25, name: 'Set' }, display_string: 'Set (0/5)' } } };
    const detail = { id: 25, effects: [{ required_count: 2, display_string: 'Set: bonus.' }] };
    expect(parseSet(body, detail)?.bonuses).toEqual([{ requiredCount: 2, text: 'Set: bonus.', isActive: null }]);
    expect(parseSet(body, { ...detail, id: 26 })?.bonuses).toEqual([]);
    expect(parseSet(body, detail)?.name).toBe('Set');
  });
  it('carries the base-data caveat and never a stats field', () => {
    const tooltip = buildTooltip(fixture('item-set-piece'), 900002, null, null, '/api/wow/icon/900002');
    expect(tooltip.basis).toBe('base');
    expect(tooltip.caveat).toMatch(/bonus ids/);
    expect('stats' in tooltip).toBe(false);
  });

  it('reads binding, set name and set bonus lines', () => {
    const tooltip = buildTooltip(fixture('item-set-piece'), 900002, null, null, null);
    expect(tooltip.bindingText).toBe('Binds when picked up');
    expect(tooltip.set?.name).toBe('Fixture Regalia');
    expect(tooltip.set?.itemIds).toEqual([900002, 900003]);
  });

  // The piece count is the information in a set bonus, so it is carried separately
  // rather than left embedded in the display string for a caller to parse back out.
  it('separates the required piece count from the bonus text', () => {
    const set = parseSet(fixture('item-set-piece'));
    expect(set?.bonuses).toEqual([
      { requiredCount: 2, text: '(2) Set: A fixture bonus.', isActive: true },
      { requiredCount: 4, text: '(4) Set: A larger fixture bonus.', isActive: null },
    ]);
  });

  it('keeps a bonus line whose piece count upstream omitted', () => {
    const set = parseSet({ preview_item: { set: { effects: [{ display_string: 'Set: something.' }] } } });
    expect(set?.bonuses).toEqual([{ requiredCount: null, text: 'Set: something.', isActive: null }]);
  });

  it('reads use effects and derives the trigger from the description prefix', () => {
    // Verified live: entries have no trigger_type field, the trigger is the prefix.
    const spells = parseSpells(fixture('item-trinket'));
    expect(spells).toHaveLength(1);
    expect(spells[0].trigger).toBe('USE');
    expect(spells[0].description).toMatch(/^Use: /);
  });

  it('reads unique-equipped, which upstream sends as a bare string', () => {
    expect(parseUniqueEquipped(fixture('item-trinket'))).toBe(true);
    expect(parseUniqueEquipped(fixture('item-set-piece'))).toBeNull();
  });

  it('has no set for an item that is not part of one', () => {
    expect(parseSet(fixture('item-trinket'))).toBeNull();
  });

  it('never invents a source line', () => {
    expect(buildTooltip(fixture('item-trinket'), 900001, null, null, null).sourceLine).toBeNull();
  });
});

// --- Token lifecycle ----------------------------------------------------------

describe('token lifecycle', () => {
  function stubFetch(handlers: { token?: () => Response; data?: (url: string) => Response }) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth.battle.net')) {
        return handlers.token?.() ?? new Response(JSON.stringify({ access_token: 't1', expires_in: 3600 }), { status: 200 });
      }
      return handlers.data?.(url) ?? new Response(JSON.stringify({ id: 1 }), { status: 200 });
    });
  }

  it('mints one token for a burst of concurrent requests', async () => {
    const fetchImpl = stubFetch({});
    const client = new BlizzardClient({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([
      client.get('/data/wow/item/1', 'us', 'en_US'),
      client.get('/data/wow/item/2', 'us', 'en_US'),
      client.get('/data/wow/item/3', 'us', 'en_US'),
    ]);
    const tokenCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes('oauth')).length;
    expect(tokenCalls).toBe(1);
  });

  it('renews once on a 401 and does not loop', async () => {
    let dataCalls = 0;
    const fetchImpl = stubFetch({
      data: () => {
        dataCalls++;
        return dataCalls === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify({ id: 9 }), { status: 200 });
      },
    });
    const client = new BlizzardClient({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.get('/data/wow/item/9', 'us', 'en_US')).resolves.toEqual({ id: 9 });
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('oauth')).length).toBe(2);
  });

  it('gives up rather than looping when the credential is rejected twice', async () => {
    const fetchImpl = stubFetch({ data: () => new Response('', { status: 401 }) });
    const client = new BlizzardClient({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.get('/data/wow/item/9', 'us', 'en_US')).rejects.toThrow(UpstreamError);
  });

  it('maps upstream statuses onto codes without forwarding the body', async () => {
    for (const [status, code] of [[404, 'not_found'], [429, 'rate_limited'], [500, 'upstream_unavailable']] as const) {
      const fetchImpl = stubFetch({ data: () => new Response('SECRET UPSTREAM BODY', { status }) });
      const client = new BlizzardClient({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
      await client.get('/data/wow/item/1', 'us', 'en_US').then(
        () => { throw new Error('should have rejected'); },
        (err: UpstreamError) => {
          expect(err.code).toBe(code);
          expect(err.message).not.toContain('SECRET UPSTREAM BODY');
        },
      );
    }
  });

  it('serves a repeat request from cache without touching upstream', async () => {
    const fetchImpl = stubFetch({});
    const client = new BlizzardClient({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch, cacheSeconds: 600 });
    await client.get('/data/wow/item/1', 'us', 'en_US');
    await client.get('/data/wow/item/1', 'us', 'en_US');
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/data/wow/item/1')).length).toBe(1);
  });

  it('never puts the credential in a URL', async () => {
    const fetchImpl = stubFetch({});
    const client = new BlizzardClient({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.get('/data/wow/item/1', 'us', 'en_US');
    for (const [url] of fetchImpl.mock.calls) {
      expect(String(url)).not.toContain(CREDS.clientSecret);
      expect(String(url)).not.toContain(CREDS.clientId);
    }
  });
});

// Routing.

const req = (path: string) => new Request(`https://frostsim.test${path}`);

describe('routing and validation', () => {
  it('reports health without credentials and without leaking anything', async () => {
    const res = await onRequest({ request: req('/api/wow/health'), env: {} });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, configured: false, contractVersion: BATTLENET_CONTRACT_VERSION });
    expect(body.attribution).toMatch(/Blizzard/);
    expect(JSON.stringify(body)).not.toMatch(/secret|token/i);
  });

  it('says "not configured" rather than failing when no credential exists', async () => {
    const res = await onRequest({ request: req('/api/wow/item/271564'), env: {} });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('not_configured');
  });

  it('rejects a bad region, locale or id before any upstream call', async () => {
    const cases: [string, string][] = [
      ['/api/wow/item/1?region=cn', 'region'],
      ['/api/wow/item/1?locale=xx_XX', 'locale'],
      ['/api/wow/item/abc', 'itemId'],
      ['/api/wow/item/0x10', 'itemId'],
      ['/api/wow/item/99999999', 'itemId'],
      ['/api/wow/item/', 'itemId'],
    ];
    for (const [path, field] of cases) {
      const res = await onRequest({ request: req(path), env: CONFIGURED });
      expect(res.status, path).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
      expect(body.field).toBe(field);
    }
  });

  it('refuses a method other than GET', async () => {
    const res = await onRequest({
      request: new Request('https://frostsim.test/api/wow/item/1', { method: 'POST' }),
      env: CONFIGURED,
    });
    expect(res.status).toBe(405);
  });

  it('404s an unknown route', async () => {
    expect((await onRequest({ request: req('/api/wow/nope'), env: CONFIGURED })).status).toBe(404);
    expect((await onRequest({ request: req('/api/other'), env: CONFIGURED })).status).toBe(404);
  });

  it('rejects a batch larger than the cap', async () => {
    const ids = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => i + 1).join(',');
    const res = await onRequest({ request: req(`/api/wow/item-media?ids=${ids}`), env: CONFIGURED });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('ids');
  });

  it('lets icon bytes live for half the retention limit, whatever the deployment TTL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })));
    const res = await onRequest({ request: req('/api/wow/spell-icon/17'), env: { ...CONFIGURED, BLIZZARD_CACHE_SECONDS: '600' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${MAX_RETENTION_SECONDS / 2}`);
    vi.unstubAllGlobals();
  });

  it('sets no-store on errors and a bounded max-age on success', async () => {
    const err = await onRequest({ request: req('/api/wow/item/abc'), env: CONFIGURED });
    expect(err.headers.get('Cache-Control')).toBe('no-store');
    const health = await onRequest({ request: req('/api/wow/health'), env: { BLIZZARD_CACHE_SECONDS: '600' } });
    expect(health.headers.get('Cache-Control')).toBe('public, max-age=600');
  });

  it('names Blizzard as the data source on every response', async () => {
    const res = await onRequest({ request: req('/api/wow/health'), env: {} });
    expect(res.headers.get('X-Data-Source')).toBe('Blizzard Game Data API');
  });
});

// Character media: privacy boundary.

describe('character media', () => {
  const REALMS = {
    realms: [
      { name: 'Azjol-Nerub', slug: 'azjolnerub' },
      { name: 'Grizzly Hills', slug: 'grizzly-hills' },
      { name: "Drak'Tharon", slug: 'draktharon' },
      // What the index sends without a locale.
      { name: { en_US: 'Area 52', de_DE: 'Area 52', ko_KR: '에어리어 52' }, slug: 'area-52' },
    ],
  };

  // Each test uses distinct character name since router caches responses module-wide.
  let n = 0;
  const uniqueName = () => `Tester${++n}`;

  /** Stubs global fetch and records every upstream URL, so a test can assert what left. */
  function spyFetch(over: { media?: () => Response; image?: () => Response } = {}) {
    const seen: string[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('oauth.battle.net')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('/data/wow/realm/index')) {
        return new Response(JSON.stringify(REALMS), { status: 200 });
      }
      if (url.includes('character-media')) {
        return over.media?.() ?? new Response(JSON.stringify({
          assets: [
            { key: 'avatar', value: 'https://render.worldofwarcraft.com/us/character/a.jpg' },
            { key: 'inset', value: 'https://render.worldofwarcraft.com/us/character/b.jpg' },
          ],
        }), { status: 200 });
      }
      if (url.includes('render.worldofwarcraft.com')) {
        return over.image?.() ?? new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', impl);
    return { impl, seen };
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  // Distinct credential per test forces fresh client to avoid reading another test's cache.
  let cred = 0;
  const call = (path: string) => onRequest({
    request: req(path),
    env: {
      BLIZZARD_CLIENT_ID: `character-media-test-client-${++cred}`,
      BLIZZARD_CLIENT_SECRET: 'character-media-test-secret-value',
    },
  });

  it('resolves a display realm name to its official slug rather than guessing', async () => {
    const { seen } = spyFetch();
    const name = uniqueName();
    const res = await call(`/api/wow/character-media/us/Grizzly%20Hills/${name}`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    // Space becomes hyphen; Azjol-Nerub drops hyphen below; no single rule produces both.
    expect(body.realmSlug).toBe('grizzly-hills');
    expect(seen.some((u) => u.includes(`/profile/wow/character/grizzly-hills/${name.toLowerCase()}/character-media`))).toBe(true);
  });

  it('handles the realm whose slug DROPS a hyphen, which a rule would get wrong', async () => {
    spyFetch();
    const res = await call(`/api/wow/character-media/us/Azjol-Nerub/${uniqueName()}`);
    expect((await res.json()).realmSlug).toBe('azjolnerub');
  });

  it('returns same-origin URLs, never a Blizzard host', async () => {
    spyFetch();
    const res = await call(`/api/wow/character-media/us/Grizzly%20Hills/${uniqueName()}`);
    const body = await res.json();
    // COEP require-corp + CSP img-src 'self' data: means Blizzard URL is broken image.
    expect(body.avatarUrl).toMatch(/^\/api\/wow\/character-render\//);
    expect(body.insetUrl).toMatch(/^\/api\/wow\/character-render\//);
    expect(JSON.stringify(body)).not.toMatch(/worldofwarcraft\.com/);
  });

  it('sends ONLY region, realm and name upstream, and nothing else about the user', async () => {
    const { seen } = spyFetch();
    await call(`/api/wow/character-media/us/Grizzly%20Hills/${uniqueName()}`);
    const profileCalls = seen.filter((u) => u.includes('/profile/wow/'));
    expect(profileCalls).toHaveLength(1);
    for (const forbidden of ['talent', 'equipment', 'apl', 'actions', 'gear', 'bag', 'statistic']) {
      expect(profileCalls[0].toLowerCase()).not.toContain(forbidden);
    }
  });

  it('distinguishes an unknown realm from a missing character, both as 200 states', async () => {
    spyFetch();
    const unknownRealm = await call(`/api/wow/character-media/us/NotARealm/${uniqueName()}`);
    expect(unknownRealm.status).toBe(200);
    expect((await unknownRealm.json()).status).toBe('unknown_realm');
    vi.unstubAllGlobals();

    spyFetch({ media: () => new Response('{}', { status: 404 }) });
    const missing = await call(`/api/wow/character-media/us/Grizzly%20Hills/${uniqueName()}`);
    expect(missing.status).toBe(200);
    const body = await missing.json();
    expect(body.status).toBe('no_character');
    // Normal outcome the UI renders; not a failure.
    expect(body.avatarUrl).toBeNull();
    expect(body.message).toBeTruthy();
  });

  it('reports no_image separately from no_character', async () => {
    spyFetch({ media: () => new Response(JSON.stringify({ assets: [] }), { status: 200 }) });
    const res = await call(`/api/wow/character-media/us/Grizzly%20Hills/${uniqueName()}`);
    expect((await res.json()).status).toBe('no_image');
  });

  it('carries an expiry and attribution with the data', async () => {
    spyFetch();
    const res = await call(`/api/wow/character-media/us/Grizzly%20Hills/${uniqueName()}`);
    const body = await res.json();
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(body.attribution).toMatch(/Blizzard/);
  });

  it('refuses a name that is not a name, before any upstream character call', async () => {
    for (const bad of ['a%2Fb', 'name.with.dots', 'has%20space']) {
      const { seen } = spyFetch();
      const res = await call(`/api/wow/character-media/us/Grizzly%20Hills/${bad}`);
      const body = await res.json();
      expect(body.status).not.toBe('ok');
      expect(seen.some((u) => u.includes('/profile/wow/'))).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('serves portrait bytes from our origin with the image bounds applied', async () => {
    spyFetch();
    const res = await call(`/api/wow/character-render/us/grizzly-hills/${uniqueName()}/avatar`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  it('refuses an asset name it does not serve', async () => {
    spyFetch();
    const res = await call(`/api/wow/character-render/us/grizzly-hills/${uniqueName()}/secrets`);
    expect(res.status).toBe(400);
  });

  it('refuses an oversized portrait rather than streaming it', async () => {
    spyFetch({
      image: () => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), {
        status: 200, headers: { 'content-type': 'image/jpeg' },
      }),
    });
    const res = await call(`/api/wow/character-render/us/grizzly-hills/${uniqueName()}/avatar`);
    expect(res.status).toBe(502);
  });

  it('refuses a non-image content type', async () => {
    spyFetch({
      image: () => new Response('<script>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const res = await call(`/api/wow/character-render/us/grizzly-hills/${uniqueName()}/avatar`);
    expect(res.status).toBe(502);
  });

  it('answers an Armory lookup with profile text, resolving a realm typed without spaces', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('oauth.battle.net')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/data/wow/realm/index')) return new Response(JSON.stringify(REALMS));
      const path = new URL(url).pathname;
      if (path.endsWith('/equipment')) {
        return new Response(JSON.stringify({ equipped_items: [{ slot: { type: 'HEAD' }, item: { id: 5 }, bonus_list: [1, 2] }] }));
      }
      if (path.endsWith('/specializations')) return new Response(JSON.stringify({ specializations: [] }));
      if (path.endsWith('/profile/wow/character/grizzly-hills/armorytest')) {
        return new Response(JSON.stringify({ name: 'Armorytest', level: 90, character_class: { id: 8 }, race: { id: 1 },
          active_spec: { id: 64, name: 'Frost' }, realm: { name: 'Grizzly Hills', slug: 'grizzly-hills' } }));
      }
      return new Response('{}', { status: 404 });
    }));
    const res = await call('/api/wow/character-profile/us/grizzlyhills/Armorytest');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.profile).toMatch(/^mage="Armorytest"$/m);
    expect(body.profile).toMatch(/^head=,id=5,bonus_id=1\/2$/m);
    expect(seen.filter((u) => u.includes('/profile/')).every((u) => u.includes('namespace=profile-us&locale=en_US'))).toBe(true);

    const missing = await call('/api/wow/character-profile/us/Grizzly%20Hills/Nobody');
    expect(missing.status).toBe(404);
    expect((await missing.json()).message).toMatch(/logged in recently/);
    for (const typed of ['Area%2052', 'area52', '%EC%97%90%EC%96%B4%EB%A6%AC%EC%96%B4%2052']) {
      expect((await call(`/api/wow/character-profile/us/${typed}/Nobody`)).status, typed).toBe(404);
    }
    const realm = await call('/api/wow/character-profile/us/NotARealm/Armorytest');
    expect(realm.status).toBe(400);
    expect((await realm.json()).field).toBe('realm');
  });

  it('lists realms by display name, reading a locale map by its en_US spelling', async () => {
    spyFetch();
    const res = await call('/api/wow/realms?region=us');
    expect(res.status).toBe(200);
    expect((await res.json()).realms).toEqual([
      { name: 'Area 52', slug: 'area-52' }, { name: 'Azjol-Nerub', slug: 'azjolnerub' },
      { name: "Drak'Tharon", slug: 'draktharon' }, { name: 'Grizzly Hills', slug: 'grizzly-hills' },
    ]);
  });

  it('searches the shared index as a name is typed, checks an exact name once the realm is known, and remembers a miss', async () => {
    const seen: string[] = [];
    const summary = (name: string) => ({ name, level: 90, equipped_item_level: 712, character_class: { id: 4 },
      active_spec: { name: 'Subtlety' }, realm: { name: 'Grizzly Hills', slug: 'grizzly-hills' } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('oauth.battle.net')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/data/wow/realm/index')) return new Response(JSON.stringify(REALMS));
      const path = new URL(url).pathname;
      if (path.endsWith('/grizzly-hills/searchme')) return new Response(JSON.stringify(summary('Searchme')));
      if (path.endsWith('/grizzly-hills/lookedup')) return new Response(JSON.stringify(summary('Lookedup')));
      if (path.endsWith('/lookedup/equipment')) return new Response(JSON.stringify({ equipped_items: [{ slot: { type: 'HEAD' }, item: { id: 5 } }] }));
      if (path.endsWith('/lookedup/specializations')) return new Response('{}');
      return new Response('{}', { status: 404 });
    }));
    const search = async (query: string) => {
      const res = await call(`/api/wow/character-search?region=us&${query}`);
      return { status: res.status, body: await res.json() };
    };
    const profiles = () => seen.filter((u) => u.includes('/profile/wow/character/')).length;

    const exact = await search('q=Searchme&realm=Grizzly%20Hills');
    expect(exact.body.matches).toEqual([expect.objectContaining({ name: 'Searchme', realm: 'Grizzly Hills', className: 'rogue', itemLevel: 712 })]);
    expect(profiles()).toBe(1);

    // Anyone typing a prefix now finds it, in any realm of the region, without asking Blizzard.
    expect((await search('q=sea')).body.matches.map((m: { name: string }) => m.name)).toEqual(['Searchme']);
    expect(profiles()).toBe(1);

    // A lookup indexes the character too.
    expect((await call('/api/wow/character-profile/us/grizzlyhills/Lookedup')).status).toBe(200);
    expect((await search('q=looked')).body.matches.map((m: { name: string }) => m.name)).toEqual(['Lookedup']);

    const before = profiles();
    expect((await search('q=Nobodyhere&realm=grizzly-hills')).body.matches).toEqual([]);
    expect((await search('q=Nobodyhere&realm=grizzly-hills')).body.matches).toEqual([]);
    expect(profiles()).toBe(before + 1);

    expect((await search('q=a')).status).toBe(400);
    expect((await search('q=two%20words')).status).toBe(400);
  });
});
