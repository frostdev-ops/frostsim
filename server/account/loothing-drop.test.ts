// Loothing droptimizer (loothing-drop.ts) against the real catalog in public/catalogs and a sanitized addon export: the pack catalog
// read from disk, the source listing, candidate building with the web Droptimizer's rules, selector validation, and the result rows.

import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Catalog } from '../../src/lib/catalog/catalog';
import { parseAddonExport } from '../../src/lib/import/character';
import { cloudRun } from './compute/queue';
import { DropProblem, candidateCap, droptimizerRequest, droptimizerResult, dropSources, packCatalog, parseSelector } from './loothing-drop';

const CATALOG = resolve('public/catalogs/12.1.0.69814-dca34b3038a3-c015720');
const PACK = 'c97e14c7a5ad-dc0508afe741';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const RAID = 1320;
const character = parseAddonExport(readFileSync('tests/fixtures/addon-export-demonology.simc', 'utf8'));
const REPORT = JSON.parse(readFileSync('tests/fixtures/simc-report-affliction.json', 'utf8'));

let catalog: Catalog;
beforeAll(async () => {
  // The layout scripts/update-engines.mjs publishes: <index dir>/engine/versions/<pack>/catalog.
  const root = mkdtempSync(join(tmpdir(), 'drop-'));
  mkdirSync(join(root, 'engine/versions', PACK), { recursive: true });
  symlinkSync(CATALOG, join(root, 'engine/versions', PACK, 'catalog'));
  catalog = await packCatalog(PACK, { ENGINE_INDEX_PATH: join(root, 'engine-versions.json') });
});

const problem = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    return err instanceof DropProblem ? err.code : `not a DropProblem: ${err}`;
  }
  return 'no error';
};

describe('sources', () => {
  it('lists raids with verified difficulties and this season\'s dungeons with key levels', () => {
    const { instances } = dropSources(catalog, NOW);
    const raid = instances.find((i) => i.instanceId === RAID)!;
    expect(raid).toMatchObject({ kind: 'raid', rewards: { difficulties: ['raid-finder', 'normal', 'heroic', 'mythic'] } });
    expect(raid.encounters.length).toBeGreaterThan(1);
    expect(raid.encounters.every((e) => Number.isInteger(e.encounterId) && e.itemCount > 0)).toBe(true);
    expect(instances.find((i) => i.kind === 'dungeon')?.rewards).toEqual({ keyLevels: { min: 2 } });
  });
});

describe('request', () => {
  it('builds one profileset per usable drop and slot, at the verified heroic level, with the bosses each drops from', () => {
    const { request, meta } = droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], difficulty: 'heroic' }), 'patchwerk', NOW);
    expect(meta.candidates.length).toBeGreaterThan(0);
    expect(request.profilesets!.map((p) => p.id)).toEqual(meta.candidates.map((c) => c.id));
    expect(new Set(meta.candidates.map((c) => c.id)).size).toBe(meta.candidates.length);
    expect(request.accuracy).toMatchObject({ mode: 'targetError', targetError: 0.2 });
    expect(request.profile).toContain('warlock=');
    for (const [i, c] of meta.candidates.entries()) {
      // A warlock wears cloth: no other armor type survives the usability filter.
      const item = catalog.resolve({ instanceId: 'x', source: 'hypothetical', slot: c.slot, itemId: c.itemId, bonusIds: c.bonusIds, gemIds: [] });
      if (item?.itemClass === 4 && [2, 3, 4].includes(item.itemSubclass)) throw new Error(`${c.name} is not cloth`);
      expect(request.profilesets![i].lines.some((l) => l.startsWith(`${c.slot}=`) && l.includes(`id=${c.itemId}`))).toBe(true);
      expect(c.bonusIds.length).toBeGreaterThan(0);
      expect(c.sources.length).toBeGreaterThan(0);
      expect(c.sources.every((s) => s.instanceId === RAID && Number.isInteger(s.encounterId))).toBe(true);
    }
    // Rings and trinkets are tried in both slots.
    const ring = meta.candidates.find((c) => c.slot === 'finger1');
    if (ring) expect(meta.candidates.some((c) => c.itemId === ring.itemId && c.slot === 'finger2')).toBe(true);
    // Mythic drops are a higher item level than heroic ones.
    const mythic = droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], difficulty: 'mythic' }), 'patchwerk', NOW).meta;
    const heroicLevel = meta.candidates.find((c) => c.slot === 'head')?.itemLevel;
    const mythicLevel = mythic.candidates.find((c) => c.slot === 'head')?.itemLevel;
    if (heroicLevel) expect(mythicLevel).toBeGreaterThan(heroicLevel);
  });

  it('builds a request the cloud accepts, with the web search\'s sample floor', () => {
    const { request } = droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], difficulty: 'heroic' }), 'patchwerk', NOW);
    expect(request.extraOptions).toEqual(['analyze_error_interval=200']);
    const prepared = cloudRun(request, 16);
    expect('problem' in prepared ? prepared.problem : null).toBeNull();
  });

  it('offers candidates to a leather wearer whose cloak is cloth, as every cloak is', () => {
    // Upstream's MID2_Demon_Hunter_Havoc gear (vendor/simc/profiles/MID2 at the locked commit).
    const havoc = parseAddonExport(['demonhunter=Testchar', 'level=90', 'race=blood_elf', 'spec=havoc',
      'chest=vest_of_reverent_adoration,id=239048,bonus_id=12854/13662,enchant_id=7987',
      'back=silken_voodoo_drape,id=268253,bonus_id=13662/13848',
      'legs=abyssal_doomhounds_legwraps,id=271536,bonus_id=13693/13698/13848,enchant_id=8159,redirected_base_stats=268225',
      'hands=abyssal_doomhounds_studded_gauntlets,id=271538,bonus_id=13691/13697,ilevel=334',
      'main_hand=amanmuso_warlords_vengeance,id=268209,bonus_id=13662/13848,enchant_id=8689'].join('\n'));
    const { meta } = droptimizerRequest(catalog, havoc, parseSelector({ instanceIds: [RAID], difficulty: 'heroic' }), 'patchwerk', NOW);
    expect(meta.candidates.length).toBeGreaterThan(0);
  });

  it('narrows to the chosen encounters', () => {
    const { instances } = dropSources(catalog, NOW);
    const boss = instances.find((i) => i.instanceId === RAID)!.encounters[0].encounterId!;
    const { meta } = droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], encounterIds: [boss], difficulty: 'normal' }), 'patchwerk', NOW);
    expect(meta.candidates.every((c) => c.sources.every((s) => s.encounterId === boss))).toBe(true);
    // A boss of another instance is a mistake to report, not to drop silently.
    expect(problem(() => droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], encounterIds: [boss, 2142], difficulty: 'normal' }), 'patchwerk', NOW))).toBe('unavailable');
  });

  it('runs a dungeon at a key level and refuses a difficulty for it, an unknown instance, or expired loot data', () => {
    const dungeon = dropSources(catalog, NOW).instances.find((i) => i.kind === 'dungeon')!.instanceId;
    const { meta } = droptimizerRequest(catalog, character, parseSelector({ instanceIds: [dungeon], keyLevel: 10 }), 'patchwerk', NOW);
    expect(meta.candidates.length).toBeGreaterThan(0);
    expect(problem(() => droptimizerRequest(catalog, character, parseSelector({ instanceIds: [dungeon], difficulty: 'heroic' }), 'patchwerk', NOW))).toBe('unavailable');
    expect(problem(() => droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], keyLevel: 10 }), 'patchwerk', NOW))).toBe('unavailable');
    expect(problem(() => droptimizerRequest(catalog, character, parseSelector({ instanceIds: [999999], difficulty: 'heroic' }), 'patchwerk', NOW))).toBe('unavailable');
    expect(problem(() => droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], difficulty: 'heroic' }), 'patchwerk', Date.parse('2027-01-01')))).toBe('unavailable');
  });

  it('refuses a malformed selector', () => {
    for (const bad of [{}, { instanceIds: [] }, { instanceIds: ['1320'] }, { instanceIds: [RAID] }, { instanceIds: [RAID], difficulty: 'heroic', keyLevel: 10 },
      { instanceIds: [RAID], difficulty: 'lfr' }, { instanceIds: [RAID], keyLevel: 1 }, { instanceIds: [RAID], difficulty: 'heroic', bonusRoll: 'yes' },
      { instanceIds: [RAID], difficulty: 'heroic', encounterIds: [0] }, { instanceIds: Array.from({ length: 13 }, (_, i) => i + 1), difficulty: 'heroic' },
      { instanceIds: [RAID], difficulty: ['heroic'] }, { instanceIds: [RAID], difficulty: 'heroic', encounterIds: Array.from({ length: 101 }, (_, i) => i + 1) }]) {
      expect(problem(() => parseSelector(bad)), JSON.stringify(bad)).toBe('invalid');
    }
  });
});

describe('candidate cap', () => {
  it('allows 20 candidates a plan thread, at least 20 and at most 200, and refuses a selection past it', () => {
    expect([0, 1, 8, 16, 64].map(candidateCap)).toEqual([20, 20, 160, 200, 200]);
    const selector = parseSelector({ instanceIds: [RAID], difficulty: 'heroic' });
    const count = droptimizerRequest(catalog, character, selector, 'patchwerk', NOW).meta.candidates.length;
    expect(problem(() => droptimizerRequest(catalog, character, selector, 'patchwerk', NOW, count - 1))).toBe('too-many-candidates');
  });
});

describe('result', () => {
  it('rows each candidate against the baseline, best gain first, and marks one simc left out as missing', () => {
    const { meta } = droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], difficulty: 'heroic' }), 'patchwerk', NOW);
    const [a, b, c] = meta.candidates;
    const base = REPORT.sim.players[0].collected_data.dps.mean as number;
    const set = (name: string, mean: number) => ({ name, mean, min: mean - 100, max: mean + 100, iterations: 1000, mean_error: 50 });
    const raw = { ...REPORT, sim: { ...REPORT.sim, profilesets: { metric: 'dps', results: [set(a.id, base - 500), set(b.id, base + 1000)] } } };
    const out = droptimizerResult(raw, { ...meta, candidates: [a, b, c] });
    expect(out.baseline.dps).toBe(Math.round(base));
    expect(out.droptimizer).toMatchObject({ instanceIds: [RAID], difficulty: 'heroic', bonusRoll: false, maxUpgrade: false });
    expect(out.candidates.map((r) => [r.itemId, r.slot, r.status, r.delta])).toEqual([
      [b.itemId, b.slot, 'measured', 1000], [a.itemId, a.slot, 'measured', -500], [c.itemId, c.slot, 'missing', undefined]]);
    expect(out.candidates[0]).toMatchObject({ difficulty: 'heroic', error95: 50, iterations: 1000, deltaPct: Number((100000 / base).toFixed(2)) });
    // The margin of the difference: both sides' margins in quadrature.
    const baseMargin = REPORT.sim.players[0].collected_data.dps.mean_std_dev * 1.96;
    expect(out.candidates[0].deltaError95).toBeGreaterThan(50);
    expect(Math.abs(out.candidates[0].deltaError95! - Math.sqrt(50 ** 2 + baseMargin ** 2))).toBeLessThan(Math.max(2, baseMargin * 0.05));
    expect(out.candidates[0].significant).toBe(1000 > out.candidates[0].deltaError95!);
    expect(out.candidates[0]).not.toHaveProperty('id');
  });
});
