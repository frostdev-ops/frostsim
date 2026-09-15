// Battle.net client: API data must never overwrite engine-resolved instance data (API=219 Intellect, catalog=344/207).

import { describe, expect, it, vi } from 'vitest';

import { BattleNetClient, mergeWithCatalog } from './client';
import { MAX_BATCH_IDS, isValidItemId, type ItemTooltip } from './contract';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const provenance = {
  source: 'blizzard-game-data',
  attribution: 'Item data from the Blizzard Game Data API.',
  fetchedAt: '2026-09-14T00:00:00.000Z',
  expiresAt: '2026-10-14T00:00:00.000Z',
  region: 'us',
  locale: 'en_US',
};

function clientWith(handler: (path: string) => Response) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => handler(String(input)));
  return { client: new BattleNetClient({ fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

describe('icon urls', () => {
  it('is a same-origin path, so no Blizzard host reaches the page', () => {
    const { client } = clientWith(() => jsonResponse({}));
    const url = client.iconUrl(271564);
    expect(url).toBe('/api/wow/icon/271564');
    expect(url).not.toContain('://');
  });

  it('refuses an id that is not a valid item id', () => {
    const { client } = clientWith(() => jsonResponse({}));
    for (const bad of [0, -1, 1.5, NaN, 2_000_000]) expect(client.iconUrl(bad)).toBeNull();
  });
});

describe('three distinguishable outcomes', () => {
  it('reports ok with the attribution and expiry attached to the data', async () => {
    const { client } = clientWith(() => jsonResponse({ ok: true, contractVersion: 1, provenance, item: { id: 1, name: 'X' } }));
    const result = await client.item(1);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.name).toBe('X');
      // Data and attribution inseparable by design.
      expect(result.attribution).toMatch(/Blizzard/);
      expect(result.expiresAt).toBe('2026-10-14T00:00:00.000Z');
    }
  });

  it('reports a 404 as absent, not as an error', async () => {
    const { client } = clientWith(() => jsonResponse({ ok: false, contractVersion: 1, error: 'not_found', message: 'no' }, 404));
    expect((await client.item(1)).status).toBe('absent');
  });

  it('marks transient failures retryable and permanent ones not', async () => {
    for (const [code, retryable] of [['rate_limited', true], ['upstream_timeout', true], ['not_configured', false], ['invalid_request', false]] as const) {
      const { client } = clientWith(() => jsonResponse({ ok: false, contractVersion: 1, error: code, message: 'm' }, 503));
      const result = await client.item(1);
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.retryable, code).toBe(retryable);
    }
  });

  it('turns a network failure into an error rather than throwing at the caller', async () => {
    const client = new BattleNetClient({ fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    const result = await client.item(1);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.retryable).toBe(true);
  });
});

describe('batching', () => {
  it('chunks past the server cap so a caller need not know the limit', async () => {
    const seen: string[] = [];
    const { client } = clientWith((path) => {
      seen.push(path);
      const ids = new URL(path, 'https://x').searchParams.get('ids')!.split(',').map(Number);
      return jsonResponse({ ok: true, contractVersion: 1, provenance, media: ids.map((id) => ({ id, status: 'ok' })), failed: [] });
    });
    const ids = Array.from({ length: MAX_BATCH_IDS + 25 }, (_, i) => i + 1);
    const result = await client.mediaBatch(ids);
    expect(seen).toHaveLength(2);
    expect(result.media.size).toBe(ids.length);
    expect(result.failed).toEqual([]);
  });

  it('keeps partial success: one bad id does not fail the batch', async () => {
    const { client } = clientWith(() => jsonResponse({
      ok: true, contractVersion: 1, provenance,
      media: [{ id: 1, status: 'ok' }], failed: [2],
    }));
    const result = await client.mediaBatch([1, 2]);
    expect(result.media.has(1)).toBe(true);
    expect(result.failed).toEqual([2]);
  });

  it('rejects invalid ids locally instead of spending a request on them', async () => {
    const { client, fetchImpl } = clientWith(() => jsonResponse({ ok: true, contractVersion: 1, provenance, media: [], failed: [] }));
    const result = await client.mediaBatch([-1, 0, 1.5]);
    expect(result.failed).toEqual([-1, 0, 1.5]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deduplicates ids before asking', async () => {
    const { client } = clientWith((path) => {
      expect(new URL(path, 'https://x').searchParams.get('ids')).toBe('5,7');
      return jsonResponse({ ok: true, contractVersion: 1, provenance, media: [], failed: [] });
    });
    await client.mediaBatch([5, 5, 7, 5]);
  });
});

describe('configuration', () => {
  it('reports unconfigured so the UI can hide item art rather than show failures', async () => {
    const { client } = clientWith(() => jsonResponse({ ok: true, contractVersion: 1, configured: false, region: 'us', cacheSeconds: 0, attribution: 'a' }));
    expect(await client.isConfigured()).toBe(false);
  });

  it('asks once and remembers', async () => {
    const { client, fetchImpl } = clientWith(() => jsonResponse({ ok: true, contractVersion: 1, configured: true, region: 'us', cacheSeconds: 60, attribution: 'a' }));
    await client.isConfigured();
    await client.isConfigured();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends no credentials, so this endpoint can never see a user', async () => {
    const { client, fetchImpl } = clientWith(() => jsonResponse({ ok: true, contractVersion: 1, configured: true, region: 'us', cacheSeconds: 60, attribution: 'a' }));
    await client.isConfigured();
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  });
});

describe('merging with the catalog', () => {
  const tooltip: ItemTooltip = {
    itemId: 271564, basis: 'base', name: 'Crown of the Primal Leywarden',
    quality: { type: 'EPIC', name: 'Epic' }, iconUrl: '/api/wow/icon/271564',
    baseItemLevel: 219, inventoryTypeName: 'Head', itemSubclassName: 'Cloth',
    requiredLevel: 80, description: 'Flavour.', bindingText: 'Binds when picked up',
    isUniqueEquipped: null, spells: [{ trigger: 'EQUIP', description: 'Equip: something.' }],
    set: { id: 1, name: 'Set (1/5)', bonuses: [{ requiredCount: 2, text: '(2) Set: x', isActive: true }], itemIds: [1, 2] },
    sourceLine: null, caveat: 'base values',
  };

  // The catalog's 344 comes from this instance's bonus ids; the API's 219 is a
  // different copy of the item. The catalog must win.
  const resolved = { itemId: 271564, itemLevel: 344, name: 'Crown of the Primal Leywarden', quality: 4 };

  it('never lets base item level overwrite the resolved instance level', () => {
    const merged = mergeWithCatalog(resolved, tooltip);
    expect(merged.itemLevel).toBe(344);
    expect(merged.baseItemLevel).toBe(219);
    expect(merged.itemLevel).not.toBe(merged.baseItemLevel);
  });

  it('adds only what the catalog cannot derive', () => {
    const merged = mergeWithCatalog(resolved, tooltip);
    expect(merged.iconUrl).toBe('/api/wow/icon/271564');
    expect(merged.description).toBe('Flavour.');
    expect(merged.spells).toHaveLength(1);
    expect(merged.bindingText).toBe('Binds when picked up');
    expect(merged.setName).toBe('Set (1/5)');
    // Catalog fields survive untouched.
    expect(merged.name).toBe(resolved.name);
    expect(merged.quality).toBe(resolved.quality);
  });

  it('leaves the resolved item intact when there is no tooltip at all', () => {
    const merged = mergeWithCatalog(resolved, null);
    expect(merged.itemLevel).toBe(344);
    expect(merged.iconUrl).toBeNull();
    expect(merged.spells).toEqual([]);
    expect(merged.baseItemLevel).toBeNull();
  });

  it('carries no stats from the API, because the contract has none to carry', () => {
    expect('stats' in tooltip).toBe(false);
    expect('stats' in mergeWithCatalog(resolved, tooltip)).toBe(false);
  });
});

// Module-scope client captured fetch at import time; binding must defer to call.
describe('fetch binding', () => {
  it('resolves globalThis.fetch at call time, not at construction', async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => jsonResponse({ ok: true, contractVersion: 1, configured: false, region: 'us', cacheSeconds: 0, attribution: 'a' })) as typeof fetch;
      const client = new BattleNetClient();           // constructed first
      const replaced = vi.fn(async () => jsonResponse({ ok: true, contractVersion: 1, configured: true, region: 'us', cacheSeconds: 60, attribution: 'a' }));
      globalThis.fetch = replaced as unknown as typeof fetch; // replaced after
      expect(await client.isConfigured()).toBe(true);
      expect(replaced).toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('id validation is shared with the server', () => {
  it('agrees with the contract validator the router uses', () => {
    expect(isValidItemId(271564)).toBe(true);
    expect(isValidItemId(0)).toBe(false);
  });
});
