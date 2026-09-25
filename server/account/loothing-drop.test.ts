// Loothing droptimizer (loothing-drop.ts) against the real catalog in public/catalogs and a sanitized addon export: the pack catalog
// read from disk, the source listing, candidate building with the web Droptimizer's rules, selector validation, and the result rows.

import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Catalog } from '../../src/lib/catalog/catalog';
import { parseAddonExport } from '../../src/lib/import/character';
import { DropProblem, droptimizerRequest, droptimizerResult, dropSources, packCatalog, parseSelector } from './loothing-drop';

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

  it('narrows to the chosen encounters', () => {
    const { instances } = dropSources(catalog, NOW);
    const boss = instances.find((i) => i.instanceId === RAID)!.encounters[0].encounterId!;
    const { meta } = droptimizerRequest(catalog, character, parseSelector({ instanceIds: [RAID], encounterIds: [boss], difficulty: 'normal' }), 'patchwerk', NOW);
    expect(meta.candidates.every((c) => c.sources.every((s) => s.encounterId === boss))).toBe(true);
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
      { instanceIds: [RAID], difficulty: 'heroic', encounterIds: [0] }, { instanceIds: Array.from({ length: 13 }, (_, i) => i + 1), difficulty: 'heroic' }]) {
      expect(problem(() => parseSelector(bad)), JSON.stringify(bad)).toBe('invalid');
    }
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
    expect(out.candidates[0]).toMatchObject({ difficulty: 'heroic', error95: 50, deltaPct: Number((100000 / base).toFixed(2)) });
    expect(out.candidates[0]).not.toHaveProperty('id');
  });
});
