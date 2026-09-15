import { describe, expect, it } from 'vitest';
import { journalMembers, selectSeason } from './raiderio-season.mjs';
import { fetchLootCatalog } from './blizzard-journal.mjs';
import { mergeLootCatalogs } from './loot-schema.mjs';

// Synthetic API-shaped data. No real loot data is retained in these fixtures.
const now = Date.parse('2026-09-14T12:00:00Z');
const dates = { starts: { us: '2026-08-01', eu: '2026-09-15' }, ends: { us: '2026-10-01', eu: '2026-10-02' } };
const season = { ...dates, blizzard_season_id: 18, is_main_season: true, dungeons: [{ name: 'Returning Keep' }] };
const raid = { ...dates, name: 'Current Raid' };

describe('current-season membership', () => {
  it('uses regional dates, Blizzard season id and main-season status, excluding old and future content', () => {
    const selected = selectSeason({ seasons: [
      { ...season, blizzard_season_id: 17 }, { ...season, is_main_season: false }, season,
    ] }, { raids: [raid,
      { ...raid, name: 'Old Raid', ends: { us: '2026-09-01' } },
      { ...raid, name: 'Future Raid', starts: { us: '2026-09-20' } },
      { name: 'Undated Raid' },
    ] }, 18, 'us', now);
    expect(selected.dungeons).toEqual(season.dungeons);
    expect(selected.raids).toEqual([raid]);
    expect(selected.expiresAt).toBe('2026-09-20T00:00:00.000Z');
    expect(() => selectSeason({ seasons: [season] }, { raids: [raid] }, 18, 'eu', now)).toThrow(/no unique active/);
    expect(() => selectSeason({ seasons: [season] }, { raids: [raid] }, 18, 'us', Date.parse(dates.ends.us))).toThrow();
    expect(() => selectSeason({ seasons: [season, season] }, { raids: [] }, 18, 'us', now)).toThrow();
    expect(() => selectSeason({ seasons: [season] }, { raids: [] }, 19, 'us', now)).toThrow();
  });

  it('matches journal names without confusing provider ids, rejecting absent and ambiguous entries', () => {
    expect(() => journalMembers([{ id: 999, name: 'King’s Rest' }], [{ id: 4, name: "Kings' Rest" }])).toThrow();
    expect(journalMembers([{ id: 999, name: ' King’s Rest ' }], [{ id: 4, name: "King's Rest" }])).toEqual([{ id: 4, name: "King's Rest" }]);
    expect(() => journalMembers([{ name: 'Missing' }], [])).toThrow(/Cannot uniquely match/);
    expect(() => journalMembers([{ name: 'Keep' }], [{ id: 1, name: 'Keep' }, { id: 2, name: 'Keep' }])).toThrow();
  });

  it('fetches only active instances, stamps membership, and never sends Blizzard credentials to Raider.IO', async () => {
    const always = { starts: { us: '2020-01-01' }, ends: { us: '2099-01-01' } };
    const calls = [];
    const responses = {
      '/token': { access_token: 'test-token' },
      '/data/wow/journal-expansion/index': { tiers: [{ id: 5, name: 'Current Season' }] },
      '/data/wow/journal-expansion/5': {
        dungeons: [{ id: 1, name: 'Returning Keep' }, { id: 3, name: 'Keystone Guide' }],
        raids: [{ id: 2, name: 'Current Raid' }, { id: 4, name: 'Old Raid' }],
      },
      '/data/wow/mythic-keystone/season/index': { current_season: { id: 18 } },
      '/data/wow/mythic-keystone/season/18': { id: 18, season_name: 'Test season' },
      '/api/v1/mythic-plus/static-data': { seasons: [{ ...season, ...always }] },
      '/api/v1/raiding/static-data': { raids: [{ ...raid, ...always }] },
      '/data/wow/journal-instance/1': { id: 1, name: 'Returning Keep', category: { type: 'DUNGEON' }, encounters: [{ id: 10 }] },
      '/data/wow/journal-instance/2': { id: 2, name: 'Current Raid', category: { type: 'RAID' }, encounters: [{ id: 20 }, { id: 21 }] },
      '/data/wow/journal-encounter/10': { id: 10, name: 'Keep Boss', instance: { id: 1 }, items: [100, 101, 102, 103, 104, 105].map((id) => ({ item: { id } })) },
      '/data/wow/journal-encounter/20': { id: 20, name: 'Raid Boss', instance: { id: 2 }, items: [{ item: { id: 200 } }] },
      '/data/wow/journal-encounter/21': { id: 21, name: 'Wrong Parent', instance: { id: 4 }, items: [{ item: { id: 300 } }] },
      '/data/wow/item/101': { id: 101, is_equippable: false, inventory_type: { type: 'NON_EQUIP' } },
      '/data/wow/item/102': { id: 102, is_equippable: true, inventory_type: { type: 'HEAD' } },
      '/data/wow/item/103': { id: 103 },
      '/data/wow/item/105': { id: 999, is_equippable: false, inventory_type: { type: 'NON_EQUIP' } },
    };
    const fetchImpl = async (url, options) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.host === 'raider.io') expect(options.headers).toBeUndefined();
      if (u.pathname.includes('mythic-keystone')) expect(u.searchParams.get('namespace')).toBe('dynamic-us');
      if (u.pathname.includes('journal-expansion')) expect(u.searchParams.get('locale')).toBe('en_US');
      if (!(u.pathname in responses)) throw new Error(`Unexpected request ${u.pathname}`);
      return new Response(JSON.stringify(responses[u.pathname]));
    };
    const catalog = await fetchLootCatalog({ config: { clientId: 'id', clientSecret: 'secret', region: 'us', locale: 'fr_FR', requestsPerSecond: 1e9 }, fetchImpl, knownItemIds: new Set([100, 200]) });
    expect(catalog.sources.map((s) => [s.instanceId, s.seasonId])).toEqual([[1, 18], [2, 18]]);
    expect(catalog.sources[0].itemIds).toEqual([100, 102, 103, 104, 105]);
    expect(catalog.warnings.join(' ')).toMatch(/104.*retained/);
    expect(calls).not.toContain('/data/wow/item/100');
    expect(catalog.warnings.join(' ')).toMatch(/21.*omitted/);
    expect(calls).not.toContain('/data/wow/journal-instance/4');
    expect(calls).not.toContain('/data/wow/journal-instance/3');
    expect(calls).not.toContain('/data/wow/journal-encounter/index');
    expect(mergeLootCatalogs([catalog]).season).toEqual({ id: 18, name: 'Test season' });
    expect(() => mergeLootCatalogs([catalog, { ...catalog, season: { id: 19 } }])).toThrow(/different seasons/);
  });
});
