// Validates bonus-id and item-level-scaling port against engine output (mid2-raid-gear.json).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Catalog, type CatalogPayloads } from './catalog';
import { checkCompatibility } from './load';
import { NotLoadedError, handleRequest, newState, toPlainRequest } from './protocol';
import { CatalogClient } from './client';
import { serializeEmptySlot, serializeItem } from './serialize';
import { buildScenarios, sourceAvailability } from '../optimization/droptimizer';
import type { CatalogManifest, GearSlot, ItemInstance } from './types';
import { artifactGate } from '../../../tests/artifact-gate.js';

const CATALOG_ROOT = 'public/catalogs';
const FIXTURE = 'tests/fixtures/mid2-raid-gear.json';

interface GearFixture {
  engine: { clientDataVersion: string; hotfixHash: string; upstreamCommit: string };
  items: { player: string; level: number; slot: string; encoded: string; ilevel: number; stats: Record<string, number> }[];
}

function catalogRootId(): string {
  return JSON.parse(readFileSync(join(dir!, 'manifest.json'), 'utf8')).catalogId;
}

function catalogDir(): string | null {
  if (!existsSync(CATALOG_ROOT)) return null;
  const dirs = readdirSync(CATALOG_ROOT).filter((d) => existsSync(join(CATALOG_ROOT, d, 'manifest.json')));
  return dirs.length ? join(CATALOG_ROOT, dirs[0]) : null;
}

function loadCatalogFromDisk(dir: string): Catalog {
  const j = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return new Catalog({
    manifest: j('manifest.json'), items: j('items.json'), bonus: j('item-bonus.json'),
    scaling: j('scaling.json'), enchants: j('enchants.json'), gems: j('gems.json'),
    sets: j('sets.json'), embellishments: j('embellishments.json'), consumables: j('consumables.json'),
  } as CatalogPayloads);
}

/** Parse engine report format slot=name,key=value,... back into ItemInstance. */
function parseEncoded(slot: string, encoded: string): ItemInstance {
  const inst: ItemInstance = {
    instanceId: `${slot}:${encoded}`, slot: slot as GearSlot, itemId: 0, bonusIds: [], gemIds: [],
  };
  for (const part of encoded.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    switch (key) {
      case 'id': inst.itemId = Number(value); break;
      case 'bonus_id': inst.bonusIds = value.split(/[/:]/).map(Number); break;
      case 'gem_id': inst.gemIds = value.split(/[/:]/).map(Number); break;
      case 'enchant_id': inst.enchantId = Number(value); break;
      case 'crafted_stats': inst.craftedStats = value.split('/').map(Number); break;
      case 'crafting_quality': inst.craftingQuality = Number(value); break;
      case 'redirected_base_stats': inst.redirectedBaseStats = Number(value); break;
      case 'content_tuning': inst.contentTuning = Number(value); break;
      case 'drop_level': inst.dropLevel = Number(value); break;
      case 'ilevel': inst.itemLevel = Number(value); break;
      default: break;
    }
  }
  return inst;
}

// Engine's JSON overwrites repeated stat types (not sum); collapse before comparing.
const STAT_NAME: Record<number, string> = {
  3: 'agility', 4: 'strength', 5: 'intellect', 7: 'stamina', 32: 'crit_rating',
  36: 'haste_rating', 38: 'attack_power', 40: 'versatility_rating', 49: 'mastery_rating',
  50: 'bonus_armor', 61: 'speed_rating', 62: 'leech_rating', 63: 'avoidance_rating',
  // Combined primaries: engine names per spec resolved (agiint, strint, stragi, stragiint).
  71: 'stragiint', 72: 'stragi', 73: 'agiint', 74: 'strint',
};

/** Combined primary reported under resolved spec name: compare by value, not exact key. */
const PRIMARY_KEYS = ['stragiint', 'stragi', 'agiint', 'strint', 'strength', 'agility', 'intellect'];

const dir = catalogDir();
const hasFixture = existsSync(FIXTURE);
// Each catalog's manifest.json is tracked but the payloads beside it are not, so finding the
// directory is not the same as having a catalog to read.
const gate = artifactGate(join(dir ?? CATALOG_ROOT, 'items.json'), 'npm run catalog:build');

describe.skipIf(gate || !hasFixture)('catalog matches the engine' + gate, () => {
  // A skipped suite still runs its body, so nothing may be loaded eagerly behind the gate.
  const catalog = gate ? null! : loadCatalogFromDisk(dir!);
  const fixture: GearFixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it('was built from the same client data as the fixture', () => {
    expect(catalog.manifest.engine.clientDataVersion).toBe(fixture.engine.clientDataVersion);
    expect(catalog.manifest.engine.hotfixHash).toBe(fixture.engine.hotfixHash);
  });

  it('reproduces every reported item level', () => {
    const mismatches: string[] = [];
    for (const row of fixture.items) {
      const inst = parseEncoded(row.slot, row.encoded);
      const resolved = catalog.resolve(inst, row.level);
      if (!resolved) { mismatches.push(`${row.player} ${row.slot}: item ${inst.itemId} not in catalog`); continue; }
      if (resolved.itemLevel !== row.ilevel) {
        mismatches.push(`${row.player} ${row.slot} id=${inst.itemId}: engine ${row.ilevel}, catalog ${resolved.itemLevel}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('reproduces every reported item stat', () => {
    const mismatches: string[] = [];
    for (const row of fixture.items) {
      const inst = parseEncoded(row.slot, row.encoded);
      const resolved = catalog.resolve(inst, row.level);
      if (!resolved) continue;
      const mine: Record<string, number> = {};
      for (const s of resolved.stats) {
        const name = STAT_NAME[s.type];
        if (name && s.value !== null && s.value > 0) mine[name] = s.value;
      }
      // Primary stats are compared as one bucket: the engine reports the resolved
      // name for the character's spec, the catalog reports the unresolved set.
      const sumPrimary = (stats: Record<string, number>) =>
        PRIMARY_KEYS.reduce((n, k) => n + (stats[k] ?? 0), 0);
      const minePrimary = sumPrimary(mine);
      const theirsPrimary = sumPrimary(row.stats);
      if (minePrimary !== theirsPrimary) {
        mismatches.push(`${row.player} ${row.slot} id=${inst.itemId} primary: engine ${theirsPrimary}, catalog ${minePrimary}`);
      }

      for (const key of new Set([...Object.keys(mine), ...Object.keys(row.stats)])) {
        if (PRIMARY_KEYS.includes(key)) continue;
        if ((mine[key] ?? 0) !== (row.stats[key] ?? 0)) {
          mismatches.push(`${row.player} ${row.slot} id=${inst.itemId} ${key}: engine ${row.stats[key] ?? 0}, catalog ${mine[key] ?? 0}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('round-trips every fixture item back to a parseable option line', () => {
    for (const row of fixture.items) {
      const inst = parseEncoded(row.slot, row.encoded);
      const line = serializeItem(inst);
      const reparsed = parseEncoded(row.slot, line.slice(line.indexOf('=') + 1));
      expect(reparsed.itemId).toBe(inst.itemId);
      expect(reparsed.bonusIds).toEqual(inst.bonusIds);
      expect(reparsed.gemIds ?? []).toEqual(inst.gemIds ?? []);
      expect(reparsed.enchantId).toBe(inst.enchantId);
      expect(reparsed.craftedStats ?? []).toEqual(inst.craftedStats ?? []);
      expect(reparsed.itemLevel).toBe(inst.itemLevel);
    }
  });
});

describe.skipIf(gate)('surfaces the main thread can actually reach' + gate, () => {
  // Main thread never holds Catalog (U11): test via CatalogClient over in-process transport.
  const fetchJson = async (url: string) => {
    const path = join(dir!, url.replace(/^.*?catalog\//, ''));
    if (!existsSync(path)) throw new Error(`404 ${url}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  };

  async function client(): Promise<CatalogClient> {
    const state = newState();
    const c = CatalogClient.create({
      send: (request) => handleRequest(state, toPlainRequest(request), fetchJson),
      dispose: () => {},
    });
    const loaded = await c.load('catalog/', null);
    expect(loaded.ok).toBe(true);
    return c;
  }

  it('returns specs for a class, with names and a derived-name marker', async () => {
    const c = await client();
    const mage = await c.specs(8);
    expect(mage.length).toBeGreaterThan(0);
    for (const spec of mage) {
      expect(spec.id).toBeGreaterThan(0);
      expect(spec.name).toBeTruthy();
      expect(typeof spec.nameFromEngine).toBe('boolean');
    }
    expect(mage.map((spec) => spec.name)).toContain('Frost');

    const all = await c.specs();
    expect(all.length).toBeGreaterThan(mage.length);
  });

  it('returns every embellishment with the fields a selector needs', async () => {
    const list = await (await client()).embellishments();
    expect(list.length).toBeGreaterThan(0);
    for (const e of list.slice(0, 5)) {
      expect(e.name).toBeTruthy();
      expect(e.bonusId).toBeGreaterThan(0);
      expect(typeof e.spellId).toBe('number');
    }
  });

  const countItems = (r: { available: { items: unknown[] }[] }) =>
    r.available.reduce((n, s) => n + s.items.length, 0);

  it('returns drop sources the UI can pass straight to planDroptimizer', async () => {
    // P09.2: tests via CLIENT (not worker handler), so UI capability is verified.
    const c = await client();
    const all = await c.dropSources();
    if (all.unavailableReason) {
      // No loot adapter in this build; shape usable but empty.
      expect(all.available).toEqual([]);
      expect(all.removed).toEqual([]);
      return;
    }
    expect(all.available.length).toBeGreaterThan(0);
    expect(all.attribution.length).toBeGreaterThan(0);
    const first = all.available[0];
    expect(first.id).toBeTruthy();
    expect(first.provenance).toBe('catalog');
    expect(Array.isArray(first.items)).toBe(true);
    // Unfiltered: nothing removed, no criteria applied.
    expect(all.removed).toEqual([]);
  });

  it('filters drop sources to what a character can use, with reasons', async () => {
    const c = await client();
    const unfiltered = await c.dropSources();
    if (unfiltered.unavailableReason) return; // no loot in this build

    // Cloth-wearing, intellect-using: a mage.
    const filtered = await c.dropSources({ classId: 8, armorSubclass: 1, primaryStat: 5 });

    expect(countItems(filtered)).toBeLessThan(countItems(unfiltered));
    expect(filtered.removed.length).toBeGreaterThan(0);

    // Source losing every item kept, so UI can explain why.
    expect(filtered.available.length).toBe(unfiltered.available.length);

    // Every removal names a reason (class, armor_type, primary_stat, slot).
    const reasons = new Set(filtered.removed.flatMap((r) => r.reasons));
    for (const reason of reasons) {
      expect(['class', 'armor_type', 'primary_stat', 'slot']).toContain(reason);
    }
    expect(reasons.size).toBeGreaterThan(0);

    // Counts distinguish "no loot in build" from "nothing for you" (empty list cannot).
    expect(filtered.counts.filtered).toBe(true);
    expect(unfiltered.counts.filtered).toBe(false);
    expect(filtered.counts.itemsBefore).toBe(unfiltered.counts.itemsAfter);
    expect(filtered.counts.itemsAfter).toBeLessThan(filtered.counts.itemsBefore);
    expect(filtered.counts.itemsAfter).toBe(countItems(filtered));
  });

  it('gives every drop-source item a gemIds and bonusIds array, never undefined', async () => {
    // Contract: required array (not optional); disagreement cost filter() crashes. Required & empty is rule.
    const r = await (await client()).dropSources();
    if (r.unavailableReason) return;
    for (const source of r.available) {
      for (const instance of source.items) {
        expect(Array.isArray(instance.gemIds)).toBe(true);
        expect(Array.isArray(instance.bonusIds)).toBe(true);
      }
    }
  });

  it('carries the loot expiry so the refusal lives in one place', async () => {
    const c = await client();
    const r = await c.dropSources();
    if (r.unavailableReason) return;
    // Present and future-dated, or worker refuses the data.
    expect(r.expiresAt).toBeTruthy();
    expect(Date.parse(r.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('marks unique-equipped gems, so a picker can refuse a second one', async () => {
    const gems = await (await client()).gemsFor([0x2, 0x4, 0x8]);
    expect(gems.length).toBeGreaterThan(0);
    for (const g of gems.slice(0, 20)) expect(typeof g.uniqueEquipped).toBe('boolean');
  });
});

describe.skipIf(gate)('catalog worker protocol' + gate, () => {
  // Real handler over real catalog (fetch replaced by disk read); all but postMessage hop.
  const fetchJson = async (url: string) => {
    const path = join(dir!, url.replace(/^.*?catalog\//, ''));
    if (!existsSync(path)) throw new Error(`404 ${url}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const send = (request: Parameters<typeof handleRequest>[1], state = newState()) =>
    ({ state, response: handleRequest(state, request, fetchJson) });

  async function loaded() {
    const state = newState();
    const r = await handleRequest(state, { kind: 'load', baseUrl: 'catalog/', engine: null }, fetchJson);
    expect(r.kind === 'load' && r.ok).toBe(true);
    return state;
  }

  it('loads and reports an unknown engine identity as unknown', async () => {
    const state = newState();
    const r = await handleRequest(state, { kind: 'load', baseUrl: 'catalog/', engine: null }, fetchJson);
    expect(r).toMatchObject({ kind: 'load', ok: true });
    if (r.kind === 'load' && r.ok) {
      expect(r.warnings.map((w) => w.code)).toEqual(['engine_identity_unknown']);
      expect(r.manifest.counts.items).toBeGreaterThan(100_000);
    }
  });

  it('reports a missing catalog instead of throwing', async () => {
    const r = await handleRequest(newState(), { kind: 'load', baseUrl: 'catalog/nope', engine: null }, fetchJson);
    expect(r).toMatchObject({ kind: 'load', ok: false, reason: 'unavailable' });
  });

  it('refuses to answer before a catalog is loaded', async () => {
    await expect(handleRequest(newState(), { kind: 'search', query: { limit: 1 } }, fetchJson))
      .rejects.toBeInstanceOf(NotLoadedError);
    void send;
  });

  it('resolves known instances and names the ones it could not', async () => {
    const state = await loaded();
    const known: ItemInstance = { instanceId: 'a', slot: 'head', itemId: 271564, bonusIds: [13692, 13698, 13750, 13846, 13848], gemIds: [] };
    const unknown: ItemInstance = { instanceId: 'b', slot: 'head', itemId: 999_999_999, bonusIds: [], gemIds: [] };
    const r = await handleRequest(state, { kind: 'resolve', instances: [known, unknown], playerLevel: 90 }, fetchJson);
    expect(r.kind).toBe('resolve');
    if (r.kind === 'resolve') {
      expect(r.items.map(([id]) => id)).toEqual(['a']);
      expect(r.missing).toEqual(['b']);
      expect(r.items[0][1].itemLevel).toBe(344);
      expect(r.items[0][1].quality).toBeGreaterThan(0);
    }
  });

  it('searches by name and respects the limit', async () => {
    const state = await loaded();
    const r = await handleRequest(state, { kind: 'search', query: { text: 'crown', limit: 5 } }, fetchJson);
    expect(r.kind).toBe('search');
    if (r.kind === 'search') {
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items.length).toBeLessThanOrEqual(5);
      for (const item of r.items) expect(item.name.toLowerCase()).toContain('crown');
    }
  });

  it('returns consumables with the option token simc actually matches on', async () => {
    const state = await loaded();
    const r = await handleRequest(state, { kind: 'consumables', consumableKind: 'flask' }, fetchJson);
    expect(r.kind).toBe('consumables');
    if (r.kind === 'consumables') {
      expect(r.consumables.length).toBeGreaterThan(0);
      for (const c of r.consumables.slice(0, 20)) expect(c.option).toMatch(/^[a-z0-9_.%+]+$/);
      const ranked = r.consumables.filter((c) => c.craftingQuality > 0);
      expect(ranked.length).toBeGreaterThan(0);
      for (const c of ranked) expect(c.option.endsWith(`_${c.craftingQuality}`)).toBe(true);
      const knights = ranked.filter((c) => c.name === 'Flask of the Blood Knights');
      expect(knights.map((c) => c.option).sort()).toEqual(['flask_of_the_blood_knights_1', 'flask_of_the_blood_knights_2']);
    }
  });

  it('loads a talent tree on demand and caches it', async () => {
    const state = await loaded();
    const r = await handleRequest(state, { kind: 'talentTree', classId: 8 }, fetchJson);
    expect(r.kind).toBe('talentTree');
    if (r.kind === 'talentTree') {
      expect(r.tree?.classId).toBe(8);
      expect(r.tree?.nodes.length).toBeGreaterThan(0);
    }
    const again = await handleRequest(state, { kind: 'talentTree', classId: 8 }, fetchJson);
    expect(again.kind === 'talentTree' && again.tree?.classId).toBe(8);
  });

  it('plans a Top Gear search in the worker, so the item table is parsed once', async () => {
    const state = await loaded();
    const ring: ItemInstance = { instanceId: 'base-r', slot: 'finger1', itemId: 251136, bonusIds: [4786, 12854, 13750], gemIds: [] };
    const other: ItemInstance = { instanceId: 'alt-r', slot: 'finger1', itemId: 251136, bonusIds: [4786, 12854, 13750], gemIds: [], itemLevel: 360 };
    const options = {
      character: { classId: 8, raceMaskBit: null, armorSubclass: 1, canDualWield: false, canTitansGrip: false },
      baselineGear: [['finger1', ring]] as [GearSlot, ItemInstance | null][],
      playerLevel: 90,
    };
    const estimate = await handleRequest(state, { kind: 'estimateWork', selection: { slots: { finger1: [ring, other] } }, options }, fetchJson);
    expect(estimate.kind === 'estimateWork' && estimate.estimate.combinations).toBe(3);

    const planned = await handleRequest(state, { kind: 'planTopGear', selection: { slots: { finger1: [ring, other] } }, options }, fetchJson);
    expect(planned.kind).toBe('planTopGear');
    if (planned.kind === 'planTopGear') {
      expect(planned.candidates).toHaveLength(2);
      expect(planned.candidates[0].id).toBe('baseline');
      // Generated lines must carry the real catalog name, not a placeholder.
      const variant = planned.candidates.find((c) => c.lines.length > 0)!;
      expect(variant.lines[0]).toMatch(/^finger1=signet_of_snarling_servitude,id=251136,/);
      expect(planned.catalogId).toBe(catalogRootId());
    }
  });

  it('plans Vault variants with compatible equipped enchants through the real catalog worker', async () => {
    const state = await loaded();
    const catalog = loadCatalogFromDisk(dir!);
    const ring: ItemInstance = { instanceId: 'worn-ring', slot: 'finger1', itemId: 251136, bonusIds: [4786, 12854, 13750], gemIds: [] };
    const compatible = catalog.enchantsFor(catalog.resolve(ring, 90)!).find((e) => e.rank > 0)!;
    expect(compatible).toBeDefined();
    ring.extra = { enchant: `${compatible.option}_${compatible.rank}` };
    const reward: ItemInstance = { ...ring, instanceId: 'vault-ring', source: 'vault', vaultRewardId: 'reward', extra: undefined };
    const upgraded = { ...reward, instanceId: 'max-vault-ring', originalInstanceId: reward.instanceId, itemLevel: 334 };
    const options = {
      character: { classId: 8, raceMaskBit: null, armorSubclass: 1, canDualWield: false, canTitansGrip: false },
      baselineGear: [['finger1', ring]] as [GearSlot, ItemInstance | null][], playerLevel: 90,
    };
    const planned = await handleRequest(state, { kind: 'planTopGear', selection: { slots: { finger1: [reward, upgraded] } }, options }, fetchJson);
    expect(planned.kind).toBe('planTopGear');
    if (planned.kind === 'planTopGear') {
      const variants = planned.candidates.filter((c) => c.provenance.vaultRewardId === 'reward');
      expect(variants).toHaveLength(2);
      for (const candidate of variants) {
        expect(candidate.provenance.vaultItem?.enchantId).toBe(compatible.enchantId);
        expect(candidate.lines[0]).toContain(`enchant_id=${compatible.enchantId}`);
        expect(candidate.lines[0]).not.toContain(',enchant=');
      }
      expect(reward.enchantId).toBeUndefined();
    }
    // Weapon enchant cannot be inherited by same ring reward.
    const weapon = catalog.search({ slot: 'main_hand', limit: 1 })[0];
    const incompatible = catalog.enchantsFor(weapon).find((e) => !catalog.enchantsFor(catalog.resolve(ring, 90)!)
      .some((ringEnchant) => ringEnchant.enchantId === e.enchantId))!;
    expect(incompatible).toBeDefined();
    ring.extra = undefined;
    ring.enchantId = incompatible.enchantId;
    const rejected = await handleRequest(state, { kind: 'planTopGear', selection: { slots: { finger1: [reward] } }, options }, fetchJson);
    expect(rejected.kind === 'planTopGear' && rejected.candidates.find((c) => c.provenance.vaultRewardId)?.provenance.vaultItem?.enchantId).toBeUndefined();
  });

  it('plans Droptimizer scenarios in the worker and keeps every source association', async () => {
    const state = await loaded();
    const ring: ItemInstance = { instanceId: 'drop-r', slot: 'finger1', itemId: 251136, bonusIds: [4786, 12854, 13750], gemIds: [] };
    const options = {
      character: { classId: 8, raceMaskBit: null, armorSubclass: 1, canDualWield: false, canTitansGrip: false },
      baselineGear: [] as [GearSlot, ItemInstance | null][],
      playerLevel: 90,
    };
    const r = await handleRequest(state, {
      kind: 'planDroptimizer',
      sources: [
        { id: 'raid', label: 'Raid', provenance: 'user', items: [ring] },
        { id: 'vault', label: 'Vault', provenance: 'user', items: [ring] },
      ],
      options,
    }, fetchJson);
    expect(r.kind).toBe('planDroptimizer');
    if (r.kind === 'planDroptimizer') {
      // A ring is eligible in both finger slots, and the duplicate source collapses.
      expect(r.scenarios).toHaveLength(2);
      expect(new Map(r.sourcesFor).get(r.scenarios[0].candidate.id)).toEqual(['raid', 'vault']);
      expect(r.scenarios[0].candidate.cost.unknownCosts).toContain('upgrade currency');
    }
  });

  it('exposes the coverage matrix so features can be gated on real data', async () => {
    const state = await loaded();
    const r = await handleRequest(state, { kind: 'coverage' }, fetchJson);
    expect(r.kind).toBe('coverage');
    if (r.kind === 'coverage') {
      const loot = r.coverage.find((c) => c.field.startsWith('loot source membership'));
      // Both states valid (unavailable or partial); entry exists with explanation, never beyond partial.
      expect(['unavailable', 'partial']).toContain(loot?.status);
      expect(loot?.notes).toBeTruthy();
      if (loot?.status === 'partial') expect(loot.count).toBeGreaterThan(0);
      expect(r.coverage.some((c) => c.status === 'verified')).toBe(true);
    }
  });
});

describe('item option serialization', () => {
  const ring: ItemInstance = {
    instanceId: 'r', slot: 'finger1', itemId: 251136, bonusIds: [4786, 12854, 13750],
    gemIds: [240908], enchantId: 7967,
  };

  // simc item_t::parse_options: everything before first comma is item NAME; missing causes ~8% DPS loss.
  it('always emits a leading name token', () => {
    const line = serializeItem(ring);
    expect(line.startsWith('finger1=item_251136,id=251136,')).toBe(true);
    expect(line).not.toMatch(/^finger1=id=/);
  });

  it('uses the real item name when one is available', () => {
    expect(serializeItem(ring, { name: "Signet of Snarling Servitude" }))
      .toMatch(/^finger1=signet_of_snarling_servitude,id=251136,/);
  });

  it('falls back to the importer name before the id placeholder', () => {
    expect(serializeItem({ ...ring, addonName: 'Some Ring' })).toMatch(/^finger1=some_ring,id=/);
  });

  it('keeps bonus id order, which is part of the item identity', () => {
    expect(serializeItem({ ...ring, bonusIds: [13750, 4786, 12854] })).toContain('bonus_id=13750/4786/12854');
  });

  it('emits the ilevel override the engine needs to change an item level', () => {
    expect(serializeItem({ ...ring, itemLevel: 360 })).toContain(',ilevel=360');
  });

  it('refuses a passthrough option that would split the option list', () => {
    expect(() => serializeItem({ ...ring, extra: { context: 'a,b' } })).toThrow(/unsafe passthrough/);
  });

  it('writes an empty slot explicitly, so the baseline item does not stay equipped', () => {
    expect(serializeEmptySlot('off_hand')).toBe('off_hand=');
  });
});

describe.skipIf(gate)('loot sources' + gate, () => {
  const loot = (expiresAt: string | null) => ({
    schemaVersion: 1, generatedAt: '2026-09-14T00:00:00.000Z', expiresAt,
    season: { id: 18, name: 'Test season' },
    provenance: [{
      provider: 'test', description: 'fixture', retention: '30 days',
      attribution: 'Data from the Blizzard Game Data API.', limitations: ['no drop rates'],
      sourceCount: 1, itemCount: 2,
    }],
    sources: [{ id: 'test:encounter:1', seasonId: 18, kind: 'raid' as const, name: 'Boss', itemIds: [271564, 251136], provider: 'test' }],
    warnings: [],
  });

  // On-disk catalog may/may not carry loot (adapter configured); both states must behave, absent explains why.
  it('either has sources with attribution, or says how to supply them', () => {
    const catalog = loadCatalogFromDisk(dir!);
    const manifest = JSON.parse(readFileSync(join(dir!, 'manifest.json'), 'utf8'));
    if (manifest.loot?.path && existsSync(join(dir!, manifest.loot.path))) {
      catalog.registerLoot(JSON.parse(readFileSync(join(dir!, manifest.loot.path), 'utf8')));
      const r = catalog.lootSources();
      expect(r.sources.length).toBeGreaterThan(0);
      expect(r.unavailableReason).toBeNull();
      // Attribution mandatory wherever shown.
      expect(catalog.lootAttribution().join(' ')).toMatch(/Blizzard/);
      for (const source of r.sources.slice(0, 50)) {
        expect(source.itemIds.length).toBeGreaterThan(0);
        expect(source.provider).toBeTruthy();
      }
    } else {
      const r = catalog.lootSources();
      expect(r.sources).toEqual([]);
      // Names both routes (operator told what to do).
      expect(r.unavailableReason).toMatch(/FROSTSIM_DB2_DIR/);
      expect(r.unavailableReason).toMatch(/BLIZZARD_CLIENT_ID/);
    }
  });

  it('exposes sources and their attribution once loot is registered', () => {
    const catalog = loadCatalogFromDisk(dir!);
    catalog.registerLoot(loot('2099-01-01T00:00:00.000Z'));
    const r = catalog.lootSources();
    expect(r.sources).toHaveLength(1);
    expect(r.unavailableReason).toBeNull();
    expect(catalog.lootAttribution()).toEqual(['Data from the Blizzard Game Data API.']);
  });

  it('rejects legacy catalogs and excludes old or unverified sources from both browsing and candidates', () => {
    const catalog = loadCatalogFromDisk(dir!);
    const { season, ...legacy } = loot(null);
    catalog.registerLoot(legacy);
    expect(catalog.lootSources().sources).toEqual([]);
    expect(sourceAvailability(catalog).available).toEqual([]);
    expect(catalog.lootSources().unavailableReason).toMatch(/current-season/);
    const current = loot(null);
    const source = current.sources[0];
    catalog.registerLoot({ ...current, sources: [source,
      { ...source, id: 'old', seasonId: season.id - 1 },
      { ...source, id: 'unverified', seasonId: undefined },
      { ...source, id: 'pvp', kind: 'pvp' },
    ] });
    expect(catalog.lootSources().sources.map((s) => s.id)).toEqual([source.id]);
    expect(sourceAvailability(catalog).available.map((s) => s.id)).toEqual([source.id]);
  });

  // Blizzard API terms: 30-day retention cap; catalog refuses expired data (breach terms).
  it('refuses expired loot data and says so', () => {
    const catalog = loadCatalogFromDisk(dir!);
    catalog.registerLoot(loot('2026-09-13T00:00:00.000Z'));
    const r = catalog.lootSources(Date.parse('2026-10-20T00:00:00.000Z'));
    expect(r.sources).toEqual([]);
    expect(r.unavailableReason).toMatch(/expired on 2026-09-13/);
  });

  it('turns loot sources into Droptimizer sources with attribution attached', () => {
    const catalog = loadCatalogFromDisk(dir!);
    catalog.registerLoot(loot(null));
    const availability = sourceAvailability(catalog);
    expect(availability.available).toHaveLength(1);
    expect(availability.available[0].provenance).toBe('catalog');
    expect(availability.available[0].items.map((i) => i.itemId)).toEqual([271564, 251136]);
    expect(availability.attribution).toEqual(['Data from the Blizzard Game Data API.']);
    expect(availability.limitations).toContain('no drop rates');
    // Loot table says WHICH item, not item level: every source carries that caveat.
    expect(availability.limitations.join(' ')).toMatch(/not at what item level/);
  });

  it('rechecks cached selections at planning time, including their item membership', () => {
    const catalog = loadCatalogFromDisk(dir!);
    catalog.registerLoot(loot(null));
    const selected = sourceAvailability(catalog).available;
    const options = { catalog, character: { classId: 8, raceMaskBit: null, armorSubclass: 1, canDualWield: false, canTitansGrip: false }, baselineGear: new Map() };
    expect(() => buildScenarios(selected, options)).not.toThrow();
    expect(() => buildScenarios([{ ...selected[0], items: [{ ...selected[0].items[0], itemId: 999999 }] }], options)).toThrow(/no longer verified/);
    catalog.registerLoot(loot('2020-01-01T00:00:00.000Z'));
    expect(() => buildScenarios(selected, options)).toThrow(/expired/);
    expect(() => buildScenarios([{ ...selected[0], provenance: 'user' }], options)).not.toThrow();
  });
});

describe('worker request payloads', () => {
  // Svelte 5 $state is Proxy: structured clone rejects it; reduce to plain data (names offending path).
  it('passes a reactive-style Proxy of plain data through', () => {
    const target = { kind: 'search' as const, query: { text: 'crown', limit: 5 } };
    const proxied = new Proxy(target, {
      get: (t, k, r) => Reflect.get(t, k, r),
    });
    const plain = toPlainRequest(proxied);
    expect(plain).toEqual(target);
    expect(() => structuredClone(plain)).not.toThrow();
  });

  it('names the exact path of a value that cannot cross the boundary', () => {
    expect(() => toPlainRequest({ kind: 'search', query: { text: () => 'x' } } as never))
      .toThrow(/request\.query\.text is a function/);
  });

  it('rejects a class instance, which structured clone would strip to a bare object', () => {
    class Weird { constructor(public a = 1) {} }
    expect(() => toPlainRequest({ kind: 'search', query: new Weird() } as never))
      .toThrow(/an instance of Weird/);
  });

  it('rejects a circular reference instead of recursing forever', () => {
    const circular: Record<string, unknown> = { kind: 'search' };
    circular.self = circular;
    expect(() => toPlainRequest(circular as never)).toThrow(/circular reference/);
  });

  it('keeps Maps, which the plan options and candidate deltas rely on', () => {
    const plain = toPlainRequest({ gear: new Map([['head', { itemId: 1 }]]) } as never) as { gear: Map<string, unknown> };
    expect(plain.gear).toBeInstanceOf(Map);
    expect(plain.gear.get('head')).toEqual({ itemId: 1 });
    expect(() => structuredClone(plain)).not.toThrow();
  });
});

describe('catalog / engine compatibility', () => {
  const manifest = {
    schemaVersion: 1, catalogId: 'x', generatedAt: '', coverage: [], counts: {}, files: [],
    totals: { bytes: 0, brotliBytes: 0, fileCount: 0 },
    engine: {
      simcVersion: '1210-01', upstreamCommit: 'a'.repeat(40), clientDataVersion: '12.1.0.69814',
      simcWowVersion: '1210', hotfixDate: '2026-09-12', hotfixBuild: 69814, hotfixHash: 'b'.repeat(64), ptr: false,
    },
  } as unknown as CatalogManifest;

  it('accepts an engine with matching identity', () => {
    expect(checkCompatibility(manifest, {
      clientDataVersion: '12.1.0.69814', hotfixHash: 'b'.repeat(64), upstreamCommit: 'a'.repeat(40), ptr: false,
    })).toEqual([]);
  });

  it('reports a hotfix change even when the WoW version is unchanged', () => {
    const warnings = checkCompatibility(manifest, {
      clientDataVersion: '12.1.0.69814', hotfixHash: 'c'.repeat(64), ptr: false,
    });
    expect(warnings.map((w) => w.code)).toContain('hotfix_mismatch');
  });

  it('says so when the engine identity is unknown rather than assuming a match', () => {
    expect(checkCompatibility(manifest, null).map((w) => w.code)).toEqual(['engine_identity_unknown']);
  });
});
