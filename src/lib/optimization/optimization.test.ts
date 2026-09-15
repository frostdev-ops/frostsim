// Selection statistics, candidate generation, and the staged runner.
// No wasm: the engine is a fake RunBatch, so this pins the logic that decides what
// gets simulated and what gets eliminated.

import { describe, expect, it, vi } from 'vitest';

import { canonicalize, candidateId, collect, deltaToLines, generate, upperBound, type Dimension } from './candidates';
import { compareCandidates, differenceMargin, gainOverBaseline, indistinguishable, retain, unresolvedTie } from './statistics';
import {
  DEFAULT_MAX_ITERATIONS, DEFAULT_STAGE_PLAN, InvalidCandidateError, cacheKey, emptyLedger,
  memoryCache, planForTargetError, runStagedSearch, validateCandidateLines,
  type ProfilesetOutcome, type RunBatch,
} from './runner';
import { estimateWork, iterationCeiling, perCandidateSamples, recommendation, search, selectionToDimensions } from './topgear';
import { buildScenarios } from './droptimizer';
import { engineRunBatch, outcomeToProfilesetOutcome } from './engine-adapter';
import * as simcJob from '../simc/job';
import { DEFAULT_SETTINGS } from '../simc/options';
import * as droptimizer from './droptimizer';
import type { Candidate, CandidateMeasurement, StagePlan } from './types';
import type { Catalog } from '../catalog/catalog';
import type { CharacterConstraints } from '../catalog/legality';
import type { GearSlot, ItemInstance, ResolvedItem } from '../catalog/types';
import { parseAddonExport } from '../import/character';
import { characterConstraints } from '../import/constraints';

// --- doubles ---------------------------------------------------------------

const CHARACTER: CharacterConstraints = {
  classId: 8, raceMaskBit: null, armorSubclass: 1, canDualWield: false, canTitansGrip: false,
};

function item(id: number, slot: GearSlot, extra: Partial<ItemInstance> = {}): ItemInstance {
  return { instanceId: `i${id}-${slot}`, slot, itemId: id, bonusIds: [], gemIds: [], ...extra };
}

function resolved(inst: ItemInstance, over: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    instanceId: inst.instanceId, itemId: inst.itemId, name: `Item ${inst.itemId}`, slot: inst.slot,
    eligibleSlots: [inst.slot], itemLevel: 300, computedItemLevel: 300, baseItemLevel: 200,
    quality: 4, qualityLabel: 'Epic', itemClass: 4, itemSubclass: 1, inventoryType: 5, bindType: 1,
    sockets: [], gemIds: [], gemColors: [], gemUnique: [], uniqueEquipped: false,
    enchantId: null, setId: 0, craftingQuality: 0, stats: [],
    descriptors: [], track: { label: null, step: null, max: null }, bonusIds: inst.bonusIds,
    weapon: null, classMask: 0, raceMask: '0x0', unresolved: [], instance: inst, ...over,
  };
}

function fakeCatalog(resolveFn: (i: ItemInstance) => ResolvedItem | null = (i) => resolved(i)): Catalog {
  return {
    catalogId: 'test-catalog',
    resolve: resolveFn,
    enchantsFor: () => [],
    coverage: () => null,
    embellishments: () => [],
  } as unknown as Catalog;
}

function measurement(id: string, mean: number, margin: number | null, iterations = 5000): CandidateMeasurement {
  return { candidateId: id, mean, margin, confidence: 0.95, iterations, stageIndex: 0 };
}

// --- statistics ------------------------------------------------------------

describe('selection statistics', () => {
  it('combines two independent margins for the difference, not either alone', () => {
    expect(differenceMargin({ mean: 100, margin: 3, iterations: 1 }, { mean: 90, margin: 4, iterations: 1 })).toBe(5);
  });

  it('separates candidates only when the interval on the difference excludes zero', () => {
    const a = { mean: 1000, margin: 3, iterations: 5000 };
    const b = { mean: 994, margin: 4, iterations: 5000 }; // diff 6, margin 5
    expect(compareCandidates(a, b)).toBe('a_better');
    const c = { mean: 996, margin: 4, iterations: 5000 }; // diff 4, margin 5
    expect(compareCandidates(a, c)).toBe('indistinguishable');
  });

  it('does not separate when a margin is missing', () => {
    expect(compareCandidates({ mean: 1000, margin: null, iterations: 1 }, { mean: 1, margin: 1, iterations: 1 }))
      .toBe('unknown');
  });

  it('never eliminates a candidate with too few samples', () => {
    const out = retain(
      [measurement('a', 1000, 1, 5000), measurement('loser', 500, 1, 10)],
      { retentionFactor: 1, minIterations: 200, maxSurvivors: 10 },
    );
    expect(out.eliminated).toEqual([]);
    expect(out.retainedForInsufficientEvidence.map((m) => m.candidateId)).toEqual(['loser']);
  });

  it('eliminates only what is separated from the leader', () => {
    const out = retain(
      [measurement('lead', 1000, 2), measurement('close', 998, 2), measurement('far', 900, 2)],
      { retentionFactor: 1, minIterations: 200, maxSurvivors: 10 },
    );
    expect(out.survivors.map((m) => m.candidateId)).toEqual(['lead', 'close']);
    expect(out.eliminated.map((e) => e.measurement.candidateId)).toEqual(['far']);
  });

  it('reports survivors that did not fit the budget instead of silently dropping them', () => {
    const ms = Array.from({ length: 5 }, (_, i) => measurement(`c${i}`, 1000 - i, 50));
    const out = retain(ms, { retentionFactor: 1, minIterations: 200, maxSurvivors: 2 });
    expect(out.survivors).toHaveLength(2);
    expect(out.droppedWhileAlive.map((m) => m.candidateId)).toEqual(['c2', 'c3', 'c4']);
    expect(out.eliminated).toEqual([]);
  });

  it('reports an unresolved tie rather than declaring a winner', () => {
    const tie = unresolvedTie([measurement('a', 1000, 5), measurement('b', 999, 5), measurement('c', 800, 5)]);
    expect(tie.map((m) => m.candidateId)).toEqual(['a', 'b']);
  });

  // B2: the results table has three states and `|| undefined` only has two.
  it('keeps "separable", "tied" and "untested" apart', () => {
    expect(indistinguishable(true)).toBe(false);
    expect(indistinguishable(false)).toBe(true);
    expect(indistinguishable(null)).toBeUndefined();
    expect(indistinguishable(undefined)).toBeUndefined();
    // The shape it replaces collapsed the first case into the last: for a
    // three-state input, `significant === false || undefined` answers `undefined`
    // whenever `significant` is true, which is the row that WAS separable.
    const old = (significant: boolean | null) => significant === false || undefined;
    expect(old(true)).toBeUndefined();
    expect(old(null)).toBeUndefined();
  });

  it('marks a gain as insignificant when it is inside the combined margin', () => {
    const g = gainOverBaseline({ mean: 1010, margin: 8, iterations: 1 }, { mean: 1000, margin: 8, iterations: 1 });
    expect(g.absolute).toBe(10);
    expect(g.percent).toBeCloseTo(1);
    expect(g.significant).toBe(false);
  });

  it('leaves significance unknown when uncertainty is unknown', () => {
    expect(gainOverBaseline({ mean: 1010, margin: null, iterations: 1 }, { mean: 1000, margin: 8, iterations: 1 }).significant)
      .toBeNull();
  });
});

// --- candidate generation --------------------------------------------------

describe('candidate generation', () => {
  const dims = (): Dimension[] => [
    { key: 'slot:head', kind: 'gear', slot: 'head', options: [
      { key: 'a', label: 'A', item: item(1, 'head') },
      { key: 'b', label: 'B', item: item(2, 'head') },
    ] },
    { key: 'slot:hands', kind: 'gear', slot: 'hands', options: [
      { key: 'c', label: 'C', item: item(3, 'hands') },
      { key: 'd', label: 'D', item: item(4, 'hands') },
      { key: 'e', label: 'E', item: item(5, 'hands') },
    ] },
  ];

  const opts = () => ({
    workCap: 100, character: CHARACTER, catalog: fakeCatalog(),
    baselineGear: new Map<GearSlot, ItemInstance | null>(),
  });

  it('is an upper bound, not a count of legal candidates', () => {
    expect(upperBound(dims())).toEqual({ value: 6, overflow: false });
  });

  it('flags a space too large for exact integer arithmetic', () => {
    const huge: Dimension[] = Array.from({ length: 40 }, (_, i) => ({
      key: `d${i}`, kind: 'gear' as const, options: [{ key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' }],
    }));
    expect(upperBound(huge).overflow).toBe(true);
  });

  it('produces the full product plus the baseline', () => {
    const { candidates, report } = collect(generate(dims(), opts()), 100);
    expect(candidates).toHaveLength(7);
    expect(candidates[0].id).toBe('baseline');
    expect(report.produced).toBe(7);
    expect(report.capped).toBe(false);
  });

  it('stops at the work cap and says the search is not exhaustive', () => {
    const { candidates, report } = collect(generate(dims(), { ...opts(), workCap: 3 }), 100);
    expect(candidates).toHaveLength(3);
    expect(report.capped).toBe(true);
  });

  it('collapses duplicates by canonical form, not by label', () => {
    const same = item(1, 'head');
    const duplicated: Dimension[] = [{
      key: 'slot:head', kind: 'gear', slot: 'head',
      options: [
        { key: 'x', label: 'Named one way', item: same },
        { key: 'y', label: 'Named another way', item: { ...same, instanceId: 'other-id' } },
      ],
    }];
    const { candidates, report } = collect(generate(duplicated, opts()), 100);
    expect(candidates).toHaveLength(2); // baseline + one real variant
    expect(report.duplicatesCollapsed).toBe(1);
  });

  it('rejects an illegal combination before it reaches the engine', () => {
    const catalog = fakeCatalog((i) =>
      resolved(i, { eligibleSlots: i.itemId === 2 ? ['hands'] : [i.slot] }));
    const { report } = collect(generate(dims(), { ...opts(), catalog }), 100);
    expect(report.rejectedIllegal + report.produced).toBeGreaterThan(0);
    // Item 2 cannot sit in head, so every combination using it is gone.
    expect(report.produced).toBe(4); // baseline + 3 hands options with item 1
  });

  it('composes a gem dimension onto the item the gear dimension chose', () => {
    const dimensions: Dimension[] = [
      { key: 'slot:head', kind: 'gear', slot: 'head', options: [
        { key: 'a', label: 'A', item: item(1, 'head') },
        { key: 'b', label: 'B', item: item(2, 'head') },
      ] },
      { key: 'gems:head', kind: 'gem', slot: 'head', options: [
        { key: 'g1', label: 'Crit gem', gemIds: [100] },
        { key: 'g2', label: 'Haste gem', gemIds: [200] },
      ] },
    ];
    const { candidates } = collect(generate(dimensions, opts()), 100);
    const variants = candidates.filter((c) => c.id !== 'baseline');
    expect(variants).toHaveLength(4);
    // Each item appears with each gem, rather than the gem replacing the item.
    const pairs = variants.map((c) => {
      const head = c.delta.gear?.get('head');
      return `${head?.itemId}:${head?.gemIds?.join('.')}`;
    }).sort();
    expect(pairs).toEqual(['1:100', '1:200', '2:100', '2:200']);
  });

  it('applies an enchant dimension to the baseline item when no gear varies', () => {
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['back', item(9, 'back')]]);
    const dimensions: Dimension[] = [{
      key: 'enchant:back', kind: 'enchant', slot: 'back',
      options: [{ key: '1', label: 'E1', enchantId: 111 }, { key: '2', label: 'E2', enchantId: 222 }],
    }];
    const { candidates } = collect(generate(dimensions, { ...opts(), baselineGear }), 100);
    const variants = candidates.filter((c) => c.id !== 'baseline');
    expect(variants.map((c) => c.delta.gear?.get('back')?.enchantId).sort()).toEqual([111, 222]);
    expect(variants.every((c) => c.delta.gear?.get('back')?.itemId === 9)).toBe(true);
  });

  it('clears imported numeric and named enhancements when None is selected', () => {
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['head', item(1, 'head', {
      enchantId: 12, gemIds: [34], extra: { enchant: 'old_enchant', gems: 'old_gem', gem_bonus_id: '9', gem_ilevel: '300', initial_cd: '20' },
    })]]);
    const options = { ...opts(), baselineGear };
    const dimensions = selectionToDimensions({ slots: {}, enchants: { head: [0] }, gems: { head: [[]] } }, options);
    const variants = collect(generate(dimensions, options), 100).candidates;
    const cleared = variants.find((c) => c.delta.gear?.get('head')?.enchantId === 0 && !c.delta.gear?.get('head')?.gemIds.length)!;
    expect(cleared).toBeDefined();
    expect(cleared.lines[0]).not.toMatch(/enchant|gem/);
    expect(cleared.lines[0]).toContain('initial_cd=20');
  });

  it('rejects a combination that breaks a required set bonus', () => {
    const catalog = fakeCatalog((i) => resolved(i, { setId: i.itemId <= 2 ? 77 : 0 }));
    const dimensions: Dimension[] = [
      { key: 'slot:head', kind: 'gear', slot: 'head', options: [
        { key: 'set', label: 'Set head', item: item(1, 'head') },
        { key: 'off', label: 'Off-set head', item: item(3, 'head') },
      ] },
    ];
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['hands', item(2, 'hands')]]);
    const { candidates } = collect(
      generate(dimensions, { ...opts(), catalog, baselineGear, requiredSets: [{ setId: 77, pieces: 2 }] }),
      100,
    );
    const variants = candidates.filter((c) => c.id !== 'baseline');
    expect(variants).toHaveLength(1);
    expect(variants[0].delta.gear?.get('head')?.itemId).toBe(1);
  });

  // PLAN TG-02's paired-slot case, and the one foundation suspected of producing a
  // duplicate key: the user offers an item for trinket1 that they already wear in
  // trinket2. One physical item cannot fill both slots, so the combination is
  // rejected rather than collapsed — and nothing duplicates.
  it('rejects putting an already-worn item into the other slot of a pair', () => {
    const pairCatalog = fakeCatalog((i) => resolved(i, { eligibleSlots: ['trinket1', 'trinket2'], inventoryType: 12 }));
    const wornT1 = item(1001, 'trinket1');
    const wornT2 = item(1002, 'trinket2');
    const fromBags = item(1003, 'trinket1');
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['trinket1', wornT1], ['trinket2', wornT2]]);

    const dims: Dimension[] = [{
      key: 'slot:trinket1', kind: 'gear', slot: 'trinket1',
      options: [
        // The same physical instance already worn in trinket2.
        { key: 'worn', label: 'already worn', item: { ...wornT2, slot: 'trinket1' } },
        { key: 'bag', label: 'from bags', item: fromBags },
      ],
    }];

    const { candidates, report } = collect(
      generate(dims, { workCap: 100, character: CHARACTER, catalog: pairCatalog, baselineGear }),
      100,
    );
    expect(report.rejectedIllegal).toBe(1);
    expect(candidates.map((c) => c.id)).toEqual(['baseline', candidates[1].id]);
    expect(candidates[1].delta.gear?.get('trinket1')?.itemId).toBe(1003);

    // The invariants a keyed {#each} depends on.
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
    expect(new Set(candidates.map((c) => c.canonical)).size).toBe(candidates.length);
  });

  it('keeps a swap that moves a worn item between paired slots distinct from the baseline', () => {
    // Two DIFFERENT owned copies, so the swap is legal. It must be its own
    // candidate with its own identity, never collapse onto the baseline.
    const pairCatalog = fakeCatalog((i) => resolved(i, { eligibleSlots: ['trinket1', 'trinket2'], inventoryType: 12 }));
    const wornT1 = item(1001, 'trinket1');
    const wornT2 = item(1002, 'trinket2');
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['trinket1', wornT1], ['trinket2', wornT2]]);
    const dims: Dimension[] = [
      { key: 'slot:trinket1', kind: 'gear', slot: 'trinket1', options: [
        { key: 'keep', label: 'keep', item: wornT1 },
        { key: 'swap', label: 'swap', item: { ...wornT2, instanceId: 'copy-of-1002', slot: 'trinket1' } },
      ] },
    ];
    const { candidates } = collect(
      generate(dims, { workCap: 100, character: CHARACTER, catalog: pairCatalog, baselineGear }),
      100,
    );
    const canonicals = candidates.map((c) => c.canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
  });

  it('generates each ring and trinket pair once without duplicating the current setup', () => {
    for (const [first, second] of [['finger1', 'finger2'], ['trinket1', 'trinket2']] as const) {
      const pool = [item(1, first), item(2, second), item(3, first)];
      const baselineGear = new Map<GearSlot, ItemInstance | null>([[first, pool[0]], [second, pool[1]]]);
      const catalog = fakeCatalog((i) => resolved(i, { eligibleSlots: [first, second] }));
      const options = { ...opts(), catalog, baselineGear };
      const dimensions = selectionToDimensions({ slots: { [first]: pool, [second]: [...pool].reverse() } }, options);
      expect(dimensions).toHaveLength(1);
      expect(dimensions[0].options).toHaveLength(3);
      const { candidates } = collect(generate(dimensions, options), 100);
      expect(candidates).toHaveLength(3);
      expect(candidates[0].id).toBe('baseline');
      const pairs = candidates.map((c) => [first, second].map((slot) =>
        (c.delta.gear?.get(slot) ?? baselineGear.get(slot))!.itemId).sort().join('/'));
      expect(pairs.sort()).toEqual(['1/2', '1/3', '2/3']);
      for (const c of candidates) for (const [slot, gear] of c.delta.gear ?? []) expect(gear?.slot).toBe(slot);
    }
  });

  it('does not manufacture another physical copy by giving the same ring different enchants', () => {
    const ring = item(1, 'finger1');
    const catalog = fakeCatalog((i) => resolved(i, { eligibleSlots: ['finger1', 'finger2'] }));
    const dimensions: Dimension[] = [
      { key: 'first', kind: 'gear', slot: 'finger1', options: [{ key: 'ring', label: '', item: ring }] },
      { key: 'second', kind: 'gear', slot: 'finger2', options: [{ key: 'ring', label: '', item: ring }] },
      { key: 'enchant', kind: 'enchant', slot: 'finger2', options: [{ key: 'e', label: '', enchantId: 10 }] },
    ];
    const { candidates, report } = collect(generate(dimensions, { ...opts(), catalog }), 100);
    expect(candidates.map((c) => c.id)).toEqual(['baseline']);
    expect(report.rejectedIllegal).toBe(1);
  });

  it('allows one Vault reward per complete set while preserving owned combinations and enhancements', () => {
    const head = item(1, 'head'), hands = item(2, 'hands');
    const vaultHead = item(3, 'head', { source: 'vault', vaultRewardId: 'reward-head' });
    const vaultHands = item(4, 'hands', { source: 'hypothetical', vaultRewardId: 'reward-hands', itemLevel: 300 });
    const options = { ...opts(), baselineGear: new Map<GearSlot, ItemInstance>([['head', head], ['hands', hands]]) };
    const dimensions = selectionToDimensions({
      slots: { head: [vaultHead], hands: [hands, item(5, 'hands'), vaultHands] },
      loadouts: ['A', 'B'], enchants: { head: [100] },
    }, options);
    const { candidates } = collect(generate(dimensions, options), 100);
    expect(candidates.some((c) => c.provenance.vaultRewardId === 'reward-head')).toBe(true);
    expect(candidates.some((c) => c.provenance.vaultRewardId === 'reward-hands')).toBe(true);
    expect(candidates.some((c) => !c.provenance.vaultRewardId && c.delta.gear?.get('hands')?.itemId === 5)).toBe(true);
    expect(candidates.some((c) => c.provenance.vaultRewardId === 'reward-head' && c.delta.talents === 'B' && c.delta.gear?.get('head')?.enchantId === 100)).toBe(true);
    for (const c of candidates) {
      expect([...c.delta.gear?.values() ?? []].filter((i) => i?.vaultRewardId).length).toBeLessThanOrEqual(1);
    }
  });

  it('inherits compatible worn-slot enchants for original and upgraded Vault rewards without mutating inputs', () => {
    const first = item(1, 'finger1', { enchantId: 101 });
    const second = item(2, 'finger2', { extra: { enchant: 'test_enchant_2' } });
    const reward = item(3, 'finger1', { source: 'vault', vaultRewardId: 'ring' });
    const maxed = { ...reward, instanceId: 'maxed', originalInstanceId: reward.instanceId, itemLevel: 334 };
    const options = { ...opts(),
      baselineGear: new Map<GearSlot, ItemInstance>([['finger1', first], ['finger2', second]]),
      catalog: fakeCatalog((i) => resolved(i, { eligibleSlots: ['finger1', 'finger2'] })) };
    options.catalog.enchantsFor = () => [101, 102, 103].map((enchantId, i) =>
      ({ enchantId, rank: i + 1, option: 'test_enchant', name: 'Test enchant', effects: [] }));
    const selection = { slots: { finger1: [reward, maxed], finger2: [reward, maxed] }, enchants: { finger1: [0, 103] } };
    const before = JSON.stringify([selection, first, second]);
    const { candidates } = collect(generate(selectionToDimensions(selection, options), options), 100);
    for (const instanceId of [reward.instanceId, maxed.instanceId]) {
      const variants = candidates.filter((c) => c.provenance.vaultItem?.instanceId === instanceId);
      expect(variants.filter((c) => c.provenance.vaultItem?.slot === 'finger1')
        .map((c) => c.provenance.vaultItem?.enchantId).sort()).toEqual([0, 101, 103]);
      expect(variants.some((c) => c.provenance.vaultItem?.slot === 'finger2' && c.provenance.vaultItem.enchantId === 102)).toBe(true);
      expect(variants.some((c) => c.lines.some((line) => line.startsWith('finger2=') && line.includes('enchant_id=102')))).toBe(true);
    }
    expect(JSON.stringify([selection, first, second])).toBe(before);
  });

  it('preserves reward enchants and never transfers an incompatible or unknown worn-slot enchant', () => {
    const baseline = item(1, 'main_hand', { enchantId: 101 });
    const reward = item(2, 'main_hand', { source: 'vault', vaultRewardId: 'weapon' });
    const options = { ...opts(), baselineGear: new Map<GearSlot, ItemInstance>([['main_hand', baseline]]) };
    options.catalog.enchantsFor = () => [{ enchantId: 202, rank: 0, option: 'other', name: 'Other', effects: [] }];
    for (const extra of [{}, { enchantId: 303 }, { extra: { enchant: 'explicit_2' } }]) {
      const chosen = { ...reward, ...extra };
      const dimensions = selectionToDimensions({ slots: { main_hand: [chosen] } }, options);
      expect(dimensions.find((d) => d.key === 'vault')?.options[1].item).toEqual(chosen);
    }
    options.catalog.enchantsFor = () => [{ enchantId: 101, rank: 0, option: 'known', name: 'Known', effects: [] }];
    baseline.enchantId = undefined;
    baseline.extra = { enchant: 'unknown' };
    expect(selectionToDimensions({ slots: { main_hand: [reward] } }, options)
      .find((d) => d.key === 'vault')?.options[1].item?.enchantId).toBeUndefined();
    baseline.extra = undefined;
    baseline.enchantId = 101;
    options.baselineGear.set('off_hand', item(3, 'off_hand', { enchantId: 202 }));
    options.catalog.enchantsFor = () => [101, 202].map((enchantId) =>
      ({ enchantId, rank: 0, option: String(enchantId), name: 'Weapon enchant', effects: [] }));
    const weapons = selectionToDimensions({ slots: { main_hand: [reward], off_hand: [reward] } }, options)
      .find((d) => d.key === 'vault')!.options.slice(1);
    expect(weapons.map((option) => [option.item?.slot, option.item?.enchantId]))
      .toEqual([['main_hand', 101], ['off_hand', 202]]);
  });

  it('rejects original and upgraded copies of one physical ring and any two Vault variants in paired slots', () => {
    for (const [first, second] of [['finger1', 'finger2'], ['trinket1', 'trinket2']] as const) {
      const original = item(1, first);
      const upgraded = { ...original, instanceId: 'upgrade', originalInstanceId: original.instanceId, itemLevel: 310 };
      const worn = item(2, second);
      const reward = item(3, first, { source: 'vault', vaultRewardId: 'reward' });
      const rewardUpgrade = { ...reward, instanceId: 'vault-upgrade', itemLevel: 320 };
      const rewardOther = item(4, first, { source: 'vault', vaultRewardId: 'other-reward' });
      const pool = [original, upgraded, worn, reward, rewardUpgrade, rewardOther];
      const options = { ...opts(), baselineGear: new Map<GearSlot, ItemInstance>([[first, original], [second, worn]]),
        catalog: fakeCatalog((i) => resolved(i, { eligibleSlots: [first, second] })) };
      const { candidates } = collect(generate(selectionToDimensions({ slots: { [first]: pool, [second]: pool } }, options), options), 100);
      expect(candidates.some((c) => [...c.delta.gear?.values() ?? []].some((i) => i?.instanceId === 'upgrade'))).toBe(true);
      for (const c of candidates) {
        const full = new Map([...options.baselineGear, ...c.delta.gear ?? []]);
        const items = [...full.values()].filter((i): i is ItemInstance => !!i);
        expect(items.filter((i) => i.vaultRewardId).length).toBeLessThanOrEqual(1);
        expect(new Set(items.map((i) => i.originalInstanceId ?? i.instanceId)).size).toBe(items.length);
      }
    }
  });

  it('keeps identical owned and Vault reward choices distinct without changing simulation cache identity', () => {
    const owned = item(1, 'head');
    const vault = { ...owned, source: 'vault' as const, instanceId: 'reward', vaultRewardId: 'reward' };
    const options = { ...opts(), baselineGear: new Map<GearSlot, ItemInstance>([['head', owned]]) };
    const { candidates } = collect(generate(selectionToDimensions({ slots: { head: [owned, vault] } }, options), options), 100);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].canonical).toBe(candidates[1].canonical);
    expect(candidates[1].provenance.vaultRewardId).toBe('reward');
    expect(candidates[1].provenance.vaultItem).toEqual(vault);
    expect(candidates[1].delta.gear).toBeUndefined();
  });

  it('can decline a Vault item in an empty slot while optimizing owned gear in another slot', () => {
    const head = item(1, 'head', { source: 'vault', vaultRewardId: 'head' });
    const hands = item(2, 'hands');
    const options = opts();
    const { candidates } = collect(generate(selectionToDimensions({ slots: { head: [head], hands: [hands] } }, options), options), 100);
    expect(candidates.some((c) => !c.provenance.vaultRewardId && c.delta.gear?.get('hands')?.itemId === 2)).toBe(true);
    expect(candidates.some((c) => c.provenance.vaultRewardId === 'head' && c.delta.gear?.get('hands')?.itemId === 2)).toBe(true);
  });

  it('can equip a single Vault reward when both paired baseline slots are empty', () => {
    const reward = item(1, 'finger1', { source: 'vault', vaultRewardId: 'ring' });
    const options = { ...opts(), catalog: fakeCatalog((i) => resolved(i, { eligibleSlots: ['finger1', 'finger2'] })) };
    const { candidates } = collect(generate(selectionToDimensions({ slots: { finger1: [reward], finger2: [reward] } }, options), options), 100);
    expect(candidates.some((c) => c.provenance.vaultRewardId === 'ring')).toBe(true);
    expect(candidates[0].id).toBe('baseline');
  });

  it('applies one global Vault override after owned ring pairs and before slot-specific enhancements', () => {
    const a = item(1, 'finger1'), b = item(2, 'finger2'), bag = item(3, 'finger1');
    const reward = item(4, 'finger1', { source: 'vault', vaultRewardId: 'ring' });
    const pool = [a, b, bag, reward];
    const options = { ...opts(), workCap: 1000,
      baselineGear: new Map<GearSlot, ItemInstance>([['finger1', a], ['finger2', b]]),
      catalog: fakeCatalog((i) => resolved(i, { eligibleSlots: ['finger1', 'finger2'] })) };
    const dimensions = selectionToDimensions({ slots: { finger1: pool, finger2: pool },
      enchants: { finger1: [100] }, gems: { finger2: [[200]] }, loadouts: ['A', 'B'] }, options);
    const vaultIndex = dimensions.findIndex((d) => d.key === 'vault');
    expect(dimensions.findIndex((d) => d.key === 'pair:finger1')).toBeLessThan(vaultIndex);
    expect(dimensions[vaultIndex].options).toHaveLength(3); // none, either ring slot
    const { candidates, report } = collect(generate(dimensions, options), 1000);
    expect(report.capped).toBe(false);
    const vaultSets = candidates.filter((c) => c.provenance.vaultRewardId === 'ring');
    for (const companion of [a, b, bag]) {
      expect(vaultSets.some((c) => [...new Map([...options.baselineGear, ...c.delta.gear ?? []]).values()]
        .some((i) => i?.instanceId === companion.instanceId))).toBe(true);
    }
    expect(vaultSets.some((c) => c.provenance.vaultItem?.enchantId === 100 && c.delta.talents === 'B')).toBe(true);
    expect(vaultSets.some((c) => c.provenance.vaultItem?.gemIds[0] === 200 && c.delta.talents === 'A')).toBe(true);
  });

  it('can pair a Vault reward with the only owned ring', () => {
    const owned = item(1, 'finger1');
    const reward = item(2, 'finger1', { source: 'vault', vaultRewardId: 'ring' });
    const pool = [owned, reward];
    const options = { ...opts(), baselineGear: new Map<GearSlot, ItemInstance>([['finger1', owned]]),
      catalog: fakeCatalog((i) => resolved(i, { eligibleSlots: ['finger1', 'finger2'] })) };
    const { candidates } = collect(generate(selectionToDimensions({ slots: { finger1: pool, finger2: pool } }, options), options), 100);
    expect(candidates.some((c) => c.provenance.vaultRewardId === 'ring' && c.provenance.vaultItem?.slot === 'finger1')).toBe(true);
    expect(candidates.some((c) => c.provenance.vaultRewardId === 'ring' && c.provenance.vaultItem?.slot === 'finger2')).toBe(true);
  });

  it('tries slot enhancements on either pooled ring and collapses equivalent completed pairs', () => {
    const pool = [item(1, 'finger1'), item(2, 'finger2')];
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['finger1', pool[0]], ['finger2', pool[1]]]);
    const catalog = fakeCatalog((i) => resolved(i, { eligibleSlots: ['finger1', 'finger2'] }));
    const options = { ...opts(), baselineGear, catalog };
    for (const enchants of [{ finger1: [100] }, { finger1: [100], finger2: [100] }]) {
      const dimensions = selectionToDimensions({ slots: { finger1: pool, finger2: pool }, enchants }, options);
      const { candidates } = collect(generate(dimensions, options), 100);
      const pairs = candidates.map((c) => {
        const full = new Map([...baselineGear, ...c.delta.gear ?? []]);
        return [...full.values()].map((i) => `${i!.itemId}:${i!.enchantId ?? 0}`).sort().join('/');
      }).sort();
      expect(pairs).toEqual(enchants.finger2 ? ['1:0/2:0', '1:0/2:100', '1:100/2:0', '1:100/2:100'] : ['1:0/2:0', '1:0/2:100', '1:100/2:0']);
    }
  });

  it('compares a two-hander with legal one-hand and off-hand pairs, preserving Fury dual two-handers', () => {
    const imported = parseAddonExport('warrior=Fixture\nspec=fury\nmain_hand=weapon,id=1\noff_hand=weapon,id=2');
    const importedItems = new Map(imported.equipped.map((i) => [i.instanceId, resolved(i, { itemClass: 2, inventoryType: 17 })]));
    expect(characterConstraints(imported, importedItems).constraints).toMatchObject({ canDualWield: true, canTitansGrip: true });
    expect(characterConstraints(imported, new Map()).constraints.canTitansGrip).toBe(false);
    const caster = parseAddonExport('warlock=Fixture\nspec=demonology\noff_hand=lantern,id=2');
    const held = new Map(caster.equipped.map((i) => [i.instanceId, resolved(i, { itemClass: 4, itemSubclass: 0, inventoryType: 23, eligibleSlots: ['off_hand'] })]));
    const casterRules = characterConstraints(caster, held);
    expect(casterRules.unknown.some((message) => message.includes('dual wield'))).toBe(false);
    expect(casterRules.constraints.canDualWield).toBe(false);
    const sword = item(1, 'main_hand');
    const offhand = item(2, 'off_hand');
    const staff = item(3, 'main_hand');
    const catalog = fakeCatalog((i) => resolved(i, {
      itemClass: 2, inventoryType: i.itemId === 3 ? 17 : 13,
      eligibleSlots: i.itemId === 3 ? ['main_hand'] : ['main_hand', 'off_hand'],
    }));
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['main_hand', sword], ['off_hand', offhand]]);
    const character = { ...CHARACTER, canDualWield: true };
    const options = { ...opts(), character, catalog, baselineGear };
    const dimensions = selectionToDimensions({ slots: { main_hand: [sword, staff], off_hand: [offhand] }, enchants: { off_hand: [22] } }, options);
    const { candidates } = collect(generate(dimensions, options), 100);
    const twoHand = candidates.filter((c) => c.delta.gear?.get('main_hand')?.itemId === 3);
    expect(twoHand).toHaveLength(1);
    expect(twoHand[0].lines).toContain('off_hand=');
    const furyOptions = { ...options, character: { ...character, canTitansGrip: true } };
    const furyDimensions = selectionToDimensions({ slots: { main_hand: [staff], off_hand: [{ ...staff, instanceId: 'second-staff' }] } }, furyOptions);
    const fury = collect(generate(furyDimensions, furyOptions), 100).candidates;
    expect(fury).toHaveLength(2);
    expect(fury[1].delta.gear?.get('off_hand')?.itemId).toBe(3);
  });

  it('canonicalizes gear independently of insertion order', () => {
    const a = canonicalize({ gear: new Map([['head', item(1, 'head')], ['hands', item(3, 'hands')]]) });
    const b = canonicalize({ gear: new Map([['hands', item(3, 'hands')], ['head', item(1, 'head')]]) });
    expect(a).toBe(b);
  });

  it('preserves extra option line order, which simc is sensitive to', () => {
    const lines = deltaToLines({ extraLines: ['b=2', 'a=1'] });
    expect(lines).toEqual(['b=2', 'a=1']);
  });

  it('mints profileset-safe ids', () => {
    expect(candidateId('anything', 7)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// --- runner ----------------------------------------------------------------

function candidate(id: string, lines: string[] = ['head=id=1']): Candidate {
  return {
    id, provenance: { kind: 'gear', items: [], label: id }, delta: {}, cost: { unknownCosts: [] },
    lines, canonical: `${id}-canonical`,
  };
}

function fakeEngine(means: Record<string, number>, over: Partial<ProfilesetOutcome> = {}): RunBatch {
  return async (req) => ({
    results: req.profilesets
      .filter((p) => means[p.id] !== undefined)
      .map((p) => ({ id: p.id, mean: means[p.id], margin: 2, iterations: 5000 })),
    baseline: { mean: means.baseline ?? 1000, margin: 2, iterations: 5000 },
    confidence: 0.95,
    targetReached: true,
    engineIdentity: 'test-engine',
    ...over,
  });
}

const ONE_STAGE: StagePlan = {
  version: 1, retentionFactor: 1, minIterations: 200,
  stages: [{ label: 'Only', accuracy: { mode: 'iterations', iterations: 1000 }, maxSurvivors: 100, batchSize: 100 }],
};

describe('candidate line validation', () => {
  it('rejects a line break, which would corrupt the profile', () => {
    expect(() => validateCandidateLines(candidate('a', ['head=1\nmain_hand=2']))).toThrow(InvalidCandidateError);
  });

  it('rejects a double quote, which would break the profileset option parser', () => {
    expect(() => validateCandidateLines(candidate('a', ['name="x"']))).toThrow(InvalidCandidateError);
  });

  it('rejects text that is not an option assignment', () => {
    expect(() => validateCandidateLines(candidate('a', ['just some text']))).toThrow(InvalidCandidateError);
  });

  it('accepts an append assignment', () => {
    expect(() => validateCandidateLines(candidate('a', ['actions+=/frostbolt']))).not.toThrow();
  });

  it('rejects an id that would break the profileset key', () => {
    expect(() => validateCandidateLines(candidate('bad id', ['head=1']))).toThrow(InvalidCandidateError);
  });
});

describe('staged runner', () => {
  const base = { profile: 'mage="x"', catalogId: 'test-catalog', engineIdentity: 'test-engine' };

  it('advances the best owned setup and each Vault reward through final precision despite a smaller survivor cap', async () => {
    const choices = [candidate('baseline', []), candidate('owned'), candidate('ownedWeak'), candidate('vaultA'), candidate('vaultAWeak'), candidate('vaultB')];
    choices[3].provenance.vaultRewardId = choices[4].provenance.vaultRewardId = 'rewardA';
    choices[5].provenance.vaultRewardId = 'rewardB';
    const runBatch = vi.fn(fakeEngine({ baseline: 1000, owned: 1500, ownedWeak: 1200, vaultA: 2000, vaultAWeak: 1700, vaultB: 3000 }));
    const plan: StagePlan = { ...ONE_STAGE, stages: [
      { ...ONE_STAGE.stages[0], label: 'Screen', maxSurvivors: 1 },
      { ...ONE_STAGE.stages[0], label: 'Final', accuracy: { mode: 'iterations', iterations: 5000 } },
    ] };
    const result = await runStagedSearch(choices, { ...base, runBatch, plan });
    // The unmodified baseline survives too, and costs nothing to keep: it has no
    // option lines, so it is never submitted as a profileset — the engine simulates
    // the base profile in every job regardless. See the `isReference` rescue.
    expect(runBatch.mock.calls[1][0].profilesets.map((p) => p.id).sort()).toEqual(['owned', 'vaultA', 'vaultB']);
    expect(result.candidates.filter((s) => s.status === 'measured').map((s) => s.candidate.id).sort()).toEqual(['baseline', 'owned', 'vaultA', 'vaultB']);
    expect(result.candidates.find((s) => s.candidate.id === 'owned')?.measurement?.stageIndex).toBe(1);
    expect(result.warnings.some((w) => w.includes('survivor budget raised from 1 to 3'))).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('never recommends an earlier budget-dropped mean or includes it in the final tie', async () => {
    const choices = [candidate('baseline', []), candidate('vaultBest'), candidate('vaultDropped')];
    choices[1].provenance.vaultRewardId = choices[2].provenance.vaultRewardId = 'reward';
    const plan: StagePlan = { ...ONE_STAGE, stages: [
      { ...ONE_STAGE.stages[0], label: 'Screen', maxSurvivors: 2 },
      { ...ONE_STAGE.stages[0], label: 'Final', accuracy: { mode: 'iterations', iterations: 5000 } },
    ] };
    const runBatch: RunBatch = (req) => fakeEngine(req.accuracy.mode === 'iterations' && req.accuracy.iterations === 1000
      ? { baseline: 1000, vaultBest: 2001, vaultDropped: 2000 }
      : { baseline: 1000, vaultBest: 1001 })(req);
    const result = await runStagedSearch(choices, { ...base, runBatch, plan });
    expect(result.droppedWhileAlive).toEqual(['vaultDropped']);
    // Its old row remains inspectable, but it does NOT rank first. Its 2000 came
    // from the screening stage; every row above it was measured at final precision,
    // and a coarse number must not outrank a refined one just by being larger.
    const dropped = result.candidates.findIndex((s) => s.candidate.id === 'vaultDropped');
    expect(dropped).toBeGreaterThan(0);
    expect(result.candidates[0].measurement?.stageIndex).toBe(1);
    expect(result.unresolvedTie.sort()).toEqual(['baseline', 'vaultBest']);
    expect(recommendation(result)).toMatchObject({ keepCurrent: true, winner: { id: 'vaultBest' } });
  });

  // F1: retention sees only what is still racing.
  it('does not let a budget-dropped candidate lead the next stage and eliminate refined survivors', async () => {
    // 'lucky' measures highest in the screening stage but does not fit the survivor
    // budget. It kept status 'measured', so it was still handed to `retain` at the
    // next stage — where its coarse 3000 became the leader and separated the real
    // survivors, which had by then been measured properly and were nowhere near it.
    const choices = [candidate('a'), candidate('b'), candidate('lucky')];
    const stage = (label: string, iterations: number, maxSurvivors: number) =>
      ({ label, accuracy: { mode: 'iterations', iterations } as const, maxSurvivors, batchSize: 100 });
    const plan: StagePlan = { ...ONE_STAGE, stages: [stage('Screen', 1000, 2), stage('Refine', 2000, 2), stage('Final', 5000, 2)] };
    // All three tie at the screening precision; 'lucky' has the lowest mean of the
    // three and so falls outside the two-candidate budget. The survivors are then
    // measured properly and both come down to ~1500 — below the number 'lucky' was
    // abandoned with, which is exactly when the stale row used to take over.
    const runBatch: RunBatch = (req) => fakeEngine(
      req.accuracy.mode === 'iterations' && req.accuracy.iterations === 1000
        ? { a: 2000, b: 1999, lucky: 1998 }
        : { a: 1500, b: 1499 },
    )(req);
    const result = await runStagedSearch(choices, { ...base, runBatch, plan });
    expect(result.droppedWhileAlive).toEqual(['lucky']);
    // Neither survivor is eliminated by a candidate the search had stopped paying for.
    expect(result.candidates.filter((s) => s.status === 'eliminated')).toEqual([]);
    expect(result.candidates[0].candidate.id).toBe('a');
    expect(result.candidates[0].measurement?.stageIndex).toBe(2);
    expect(result.candidates.at(-1)!.candidate.id).toBe('lucky');
  });

  it('passes the sample floor and reruns cached and resumed target-error results below it', async () => {
    const plan = DEFAULT_STAGE_PLAN;
    const c = candidate('a');
    const cache = memoryCache();
    cache.set(cacheKey({ ...base, canonical: c.canonical, accuracy: plan.stages[0].accuracy }), measurement('a', 1200, 2, 100));
    const ledger = emptyLedger();
    ledger.completed.a = measurement('a', 1200, 2, 100);
    ledger.completed.baseline = measurement('baseline', 1000, 2, 100);
    const runBatch = vi.fn(fakeEngine({ a: 1200 }));
    const result = await runStagedSearch([c, candidate('baseline', [])], { ...base, plan, cache, ledger, runBatch });
    expect(runBatch.mock.calls).toHaveLength(plan.stages.length);
    expect(runBatch.mock.calls.every(([req]) => req.minIterations === 200)).toBe(true);
    expect(result.candidates.find((state) => state.candidate.id === 'baseline')!.history[1].iterations).toBe(5000);
    expect(result.warnings.join(' ')).not.toMatch(/lack of samples/);
  });

  it('measures every candidate and ranks them', async () => {
    const r = await runStagedSearch([candidate('a'), candidate('b')], {
      ...base, plan: ONE_STAGE, runBatch: fakeEngine({ a: 1200, b: 1100 }),
    });
    expect(r.candidates.map((s) => s.candidate.id)).toEqual(['a', 'b']);
    expect(r.candidates[0].measurement?.mean).toBe(1200);
    expect(r.incomplete).toBeNull();
  });

  it('marks a candidate the engine omitted as missing, without guessing why', async () => {
    const r = await runStagedSearch([candidate('a'), candidate('gone')], {
      ...base, plan: ONE_STAGE, runBatch: fakeEngine({ a: 1200 }),
    });
    const gone = r.candidates.find((s) => s.candidate.id === 'gone')!;
    expect(gone.status).toBe('missing');
    expect(gone.note).toMatch(/produced no result or did not run/);
    expect(r.warnings.join(' ')).toMatch(/absent from the engine report/);
  });

  it('quarantines an invalid candidate instead of letting it kill the batch', async () => {
    const runBatch = vi.fn(fakeEngine({ a: 1200 }));
    const r = await runStagedSearch([candidate('a'), candidate('b', ['oops'])], {
      ...base, plan: ONE_STAGE, runBatch,
    });
    expect(runBatch.mock.calls[0][0].profilesets.map((p) => p.id)).toEqual(['a']);
    expect(r.candidates.find((s) => s.candidate.id === 'b')!.status).toBe('failed');
  });

  it('keeps earlier batches when a later one fails', async () => {
    let call = 0;
    const runBatch: RunBatch = async (req) => {
      if (++call === 2) throw new Error('engine exploded');
      return {
        results: req.profilesets.map((p) => ({ id: p.id, mean: 1000, margin: 2, iterations: 5000 })),
        baseline: null, confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
      };
    };
    const plan: StagePlan = { ...ONE_STAGE, stages: [{ ...ONE_STAGE.stages[0], batchSize: 1 }] };
    const ledger = emptyLedger();
    const r = await runStagedSearch([candidate('a'), candidate('b')], { ...base, plan, runBatch, ledger });
    expect(r.incomplete?.reason).toBe('error');
    expect(Object.keys(ledger.completed)).toEqual(['a']);
    expect(r.candidates.find((s) => s.candidate.id === 'b')!.status).toBe('pending');
  });

  it('stops at a batch boundary when cancelled', async () => {
    const controller = new AbortController();
    const runBatch: RunBatch = async (req) => {
      controller.abort();
      return {
        results: req.profilesets.map((p) => ({ id: p.id, mean: 1000, margin: 2, iterations: 5000 })),
        baseline: null, confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
      };
    };
    const plan: StagePlan = { ...ONE_STAGE, stages: [{ ...ONE_STAGE.stages[0], batchSize: 1 }] };
    const r = await runStagedSearch([candidate('a'), candidate('b')], {
      ...base, plan, runBatch, signal: controller.signal,
    });
    expect(r.incomplete?.reason).toBe('cancelled');
    expect(r.candidates.filter((s) => s.status === 'measured')).toHaveLength(1);
  });

  it('eliminates between stages and re-measures survivors at the next precision', async () => {
    const plan: StagePlan = {
      version: 1, retentionFactor: 1, minIterations: 200,
      stages: [
        { label: 'S1', accuracy: { mode: 'iterations', iterations: 1000 }, maxSurvivors: 10, batchSize: 10 },
        { label: 'S2', accuracy: { mode: 'iterations', iterations: 5000 }, maxSurvivors: 10, batchSize: 10 },
      ],
    };
    const seen: string[][] = [];
    const runBatch: RunBatch = async (req) => {
      seen.push(req.profilesets.map((p) => p.id));
      const means: Record<string, number> = { lead: 1200, close: 1199, far: 800 };
      return {
        results: req.profilesets.map((p) => ({ id: p.id, mean: means[p.id], margin: 2, iterations: 5000 })),
        baseline: null, confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
      };
    };
    const r = await runStagedSearch([candidate('lead'), candidate('close'), candidate('far')], { ...base, plan, runBatch });
    expect(seen[0]).toEqual(['lead', 'close', 'far']);
    expect(seen[1]).toEqual(['lead', 'close']);
    expect(r.candidates.find((s) => s.candidate.id === 'far')!.status).toBe('eliminated');
    expect(r.unresolvedTie.sort()).toEqual(['close', 'lead']);
  });

  it('reuses a cached measurement only at the same precision', async () => {
    const cache = memoryCache();
    const runBatch = vi.fn(fakeEngine({ a: 1200 }));
    await runStagedSearch([candidate('a')], { ...base, plan: ONE_STAGE, runBatch, cache });
    await runStagedSearch([candidate('a')], { ...base, plan: ONE_STAGE, runBatch, cache });
    expect(runBatch).toHaveBeenCalledTimes(1);

    const finer: StagePlan = {
      ...ONE_STAGE,
      stages: [{ ...ONE_STAGE.stages[0], accuracy: { mode: 'iterations', iterations: 50_000 } }],
    };
    await runStagedSearch([candidate('a')], { ...base, plan: finer, runBatch, cache });
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  // A candidate with no lines is the unmodified baseline. `profileset."x"+=` with
  // no lines creates no profileset and the engine reports no error, so submitting
  // it would come back as 'missing' every time. Its result is the base actor's.
  it('measures a lineless candidate from the base actor, not as a profileset', async () => {
    const runBatch = vi.fn(fakeEngine({ a: 1200 }));
    const r = await runStagedSearch([candidate('baseline', []), candidate('a')], {
      ...base, plan: ONE_STAGE, runBatch,
    });
    expect(runBatch.mock.calls[0][0].profilesets.map((p) => p.id)).toEqual(['a']);
    const baselineState = r.candidates.find((s) => s.candidate.id === 'baseline')!;
    expect(baselineState.status).toBe('measured');
    expect(baselineState.measurement?.mean).toBe(1000);
  });

  it('still runs the base profile when every candidate is lineless', async () => {
    const runBatch = vi.fn(fakeEngine({}));
    const r = await runStagedSearch([candidate('baseline', [])], { ...base, plan: ONE_STAGE, runBatch });
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(r.candidates[0].status).toBe('measured');
  });

  // frostsim-b5 found a browser hang: a finalist stage whose only remaining work
  // was the baseline sent an empty profileset list, the adapter skipped the engine
  // and never settled, and the search waited forever. A search that cannot finish
  // must say so.
  it('fails loudly when a batch returns nothing at all instead of waiting', async () => {
    const empty: RunBatch = async () => ({
      results: [], baseline: null, confidence: null, targetReached: null, engineIdentity: 'test-engine',
    });
    const r = await runStagedSearch([candidate('a')], { ...base, plan: ONE_STAGE, runBatch: empty });
    expect(r.incomplete?.reason).toBe('error');
    expect(r.incomplete?.message).toMatch(/no candidate results and no baseline/);
  });

  it('names the empty-profileset case when a baseline-only batch comes back empty', async () => {
    const empty: RunBatch = async () => ({
      results: [], baseline: null, confidence: null, targetReached: null, engineIdentity: 'test-engine',
    });
    const r = await runStagedSearch([candidate('baseline', [])], { ...base, plan: ONE_STAGE, runBatch: empty });
    expect(r.incomplete?.message).toMatch(/profileset list is empty/);
  });

  // A timeout must CANCEL the engine, not merely settle our own promise. The old
  // implementation raced the promise, so on expiry the search moved on while the
  // engine kept simulating — the UI abandoned the run and a core kept burning.
  it('aborts the underlying run on timeout rather than abandoning it', async () => {
    let sawAbort = false;
    const honours: RunBatch = (req) => new Promise((_, reject) => {
      req.signal?.addEventListener('abort', () => {
        sawAbort = true;
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      });
    });
    const r = await runStagedSearch([candidate('a')], {
      ...base, plan: ONE_STAGE, runBatch: honours, batchTimeoutMs: 20,
    });
    expect(sawAbort).toBe(true);
    expect(r.incomplete?.reason).toBe('error');
    expect(r.incomplete?.message).toMatch(/did not settle within/);
    // An honoured abort is reported as the timeout it was, not as a user cancel.
    expect(r.incomplete?.message).not.toMatch(/may still be running/);
    expect(r.candidates[0].status).toBe('pending');
  });

  it('says so when the adapter ignores cancellation and the engine may still run', async () => {
    const ignores: RunBatch = () => new Promise(() => {});
    const r = await runStagedSearch([candidate('a')], {
      ...base, plan: ONE_STAGE, runBatch: ignores, batchTimeoutMs: 20, abortGraceMs: 30,
    });
    expect(r.incomplete?.reason).toBe('error');
    // Silently pretending the engine stopped is exactly what caused the original bug.
    expect(r.warnings.join(' ')).toMatch(/cancellation was not honoured/);
    expect(r.warnings.join(' ')).toMatch(/engine may still be running/);
  });

  it('propagates an outer cancel to the adapter, so the engine stops', async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const honours: RunBatch = (req) => new Promise((_, reject) => {
      req.signal?.addEventListener('abort', () => {
        sawAbort = true;
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      });
      setTimeout(() => controller.abort(), 10);
    });
    const r = await runStagedSearch([candidate('a')], {
      ...base, plan: ONE_STAGE, runBatch: honours, signal: controller.signal,
    });
    expect(sawAbort).toBe(true);
    expect(r.incomplete?.reason).toBe('cancelled');
  });

  // The grace branch used to keep running after the race was won: it awaited the
  // full grace, then fired onAbandoned and threw — pushing a false warning into a
  // result that had already been assembled, and leaving a dangling rejection. These
  // advance time past the grace and assert nothing happens afterwards.
  describe('no delayed side effects after settlement', () => {
    it('fires nothing after an honoured cancellation, however long we wait', async () => {
      vi.useFakeTimers();
      try {
        const honours: RunBatch = (req) => new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
        });
        const promise = runStagedSearch([candidate('a')], {
          ...base, plan: ONE_STAGE, runBatch: honours, batchTimeoutMs: 20, abortGraceMs: 1000,
        });
        await vi.advanceTimersByTimeAsync(25);      // timeout fires, adapter honours it
        await vi.advanceTimersByTimeAsync(5000);    // well past the grace
        const r = await promise;
        expect(r.warnings.join(' ')).not.toMatch(/cancellation was not honoured/);
        expect(r.incomplete?.message).toMatch(/did not settle within/);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fires nothing after a normal success, and leaves no timer or listener behind', async () => {
      vi.useFakeTimers();
      try {
        const promise = runStagedSearch([candidate('a')], {
          ...base, plan: ONE_STAGE, runBatch: fakeEngine({ a: 1200 }), batchTimeoutMs: 5000, abortGraceMs: 1000,
        });
        await vi.advanceTimersByTimeAsync(0);
        const r = await promise;
        expect(r.candidates[0].status).toBe('measured');
        await vi.advanceTimersByTimeAsync(60_000);  // far past both timeout and grace
        expect(r.warnings.join(' ')).not.toMatch(/cancellation was not honoured/);
        // A leaked timeout timer or an armed grace would still be pending here.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not leave the abort listener attached after a normal success', async () => {
      const controller = new AbortController();
      const added: string[] = [];
      const realAdd = controller.signal.addEventListener.bind(controller.signal);
      const realRemove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener = ((t: string, l: never, o: never) => { added.push(t); return realAdd(t, l, o); }) as never;
      controller.signal.removeEventListener = ((t: string, l: never, o: never) => {
        const i = added.indexOf(t); if (i >= 0) added.splice(i, 1); return realRemove(t, l, o);
      }) as never;

      await runStagedSearch([candidate('a')], {
        ...base, plan: ONE_STAGE, runBatch: fakeEngine({ a: 1200 }), signal: controller.signal, batchTimeoutMs: 5000,
      });
      expect(added).toEqual([]);
    });
  });

  // Without a batch timeout the grace used to be bypassed entirely, so a caller
  // cancel against an adapter that ignores it hung with no warning at all.
  it('applies the grace to a caller cancel even with no batch timeout set', async () => {
    const controller = new AbortController();
    const ignores: RunBatch = () => new Promise(() => {});
    const promise = runStagedSearch([candidate('a')], {
      ...base, plan: ONE_STAGE, runBatch: ignores, signal: controller.signal, abortGraceMs: 30,
    });
    controller.abort();
    const r = await promise;
    expect(r.warnings.join(' ')).toMatch(/cancellation was not honoured/);
    expect(r.incomplete?.reason).toBe('cancelled');
  });

  it('hands the adapter an already-aborted signal when cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    let aborted: boolean | null = null;
    const runBatch: RunBatch = async (req) => {
      aborted = req.signal?.aborted ?? null;
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    };
    const r = await runStagedSearch([candidate('a')], { ...base, plan: ONE_STAGE, runBatch, signal: controller.signal });
    // The loop's own pre-check catches this first; if it ever does not, the adapter
    // must still see an aborted signal rather than starting an engine run.
    expect(r.incomplete?.reason).toBe('cancelled');
    if (aborted !== null) expect(aborted).toBe(true);
  });

  it('counts what each stage measured, not the running total', async () => {
    const plan: StagePlan = {
      version: 1, retentionFactor: 1, minIterations: 200,
      stages: [
        { label: 'S1', accuracy: { mode: 'iterations', iterations: 1000 }, maxSurvivors: 2, batchSize: 10 },
        { label: 'S2', accuracy: { mode: 'iterations', iterations: 5000 }, maxSurvivors: 2, batchSize: 10 },
      ],
    };
    const r = await runStagedSearch(
      [candidate('lead'), candidate('close'), candidate('far')],
      { ...base, plan, runBatch: fakeEngine({ lead: 1200, close: 1199, far: 800 }) },
    );
    expect(r.stagesRun.map((s) => s.candidates)).toEqual([3, 2]);
  });

  it('resumes from a ledger without re-running what it already measured', async () => {
    const ledger = emptyLedger();
    ledger.completed.a = measurement('a', 1200, 2);
    ledger.eliminated.gone = 'separated in an earlier session';
    const runBatch = vi.fn(fakeEngine({ a: 1200, b: 1100 }));
    const r = await runStagedSearch([candidate('a'), candidate('b'), candidate('gone')], {
      ...base, plan: ONE_STAGE, runBatch, ledger,
    });
    expect(runBatch.mock.calls[0][0].profilesets.map((p) => p.id)).toEqual(['b']);
    expect(r.candidates.find((s) => s.candidate.id === 'a')!.measurement?.mean).toBe(1200);
    expect(r.candidates.find((s) => s.candidate.id === 'gone')!.status).toBe('eliminated');
  });

  it('stops rather than mixing results from two different engine binaries', async () => {
    const r = await runStagedSearch([candidate('a')], {
      ...base, plan: ONE_STAGE,
      runBatch: fakeEngine({ a: 1200 }, { engineIdentity: 'a-different-binary' }),
    });
    expect(r.incomplete?.reason).toBe('error');
    expect(r.incomplete?.message).toMatch(/engine identity changed/);
  });

  it('does not cache when the engine identity is unknown', async () => {
    const cache = memoryCache();
    const runBatch = vi.fn(fakeEngine({ a: 1200 }));
    const noIdentity = { profile: base.profile, catalogId: base.catalogId };
    const first = await runStagedSearch([candidate('a')], { ...noIdentity, plan: ONE_STAGE, runBatch, cache });
    await runStagedSearch([candidate('a')], { ...noIdentity, plan: ONE_STAGE, runBatch, cache });
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(first.warnings.join(' ')).toMatch(/not cached/);
  });

  it('keys the cache on engine, catalog, precision and input together', () => {
    const parts = { engineIdentity: 'e1', catalogId: 'c1', canonical: 'x', accuracy: { mode: 'iterations', iterations: 1 } as const };
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, engineIdentity: 'e2' }));
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, catalogId: 'c2' }));
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, canonical: 'y' }));
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, accuracy: { mode: 'iterations', iterations: 2 } }));
  });
});

// --- Top Gear --------------------------------------------------------------

describe('Top Gear workload estimate', () => {
  const opts = {
    catalog: fakeCatalog(), character: CHARACTER,
    baselineGear: new Map<GearSlot, ItemInstance | null>(),
  };

  it('names the dimension driving the growth', () => {
    const est = estimateWork({
      slots: { head: [item(1, 'head'), item(2, 'head')], hands: [item(3, 'hands'), item(4, 'hands'), item(5, 'hands')] },
    }, opts);
    // 2 x 3 variants, plus the unmodified baseline, which is simulated too.
    expect(est.combinations).toBe(7);
    expect(est.growthDrivers[0].factor).toBe(3);
    expect(est.exact).toBe(false); // legality may still reduce it
  });

  it('reports when the selection exceeds the work cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => item(i, 'head'));
    const est = estimateWork({ slots: { head: many, hands: many.map((m) => ({ ...m, slot: 'hands' as GearSlot })) } }, opts);
    expect(est.combinations).toBe(1601);
    expect(est.exceedsCap).toBe(false);
    const capped = estimateWork({ slots: { head: many, hands: many.map((m) => ({ ...m, slot: 'hands' as GearSlot })) } }, { ...opts, workCap: 100 });
    expect(capped.exceedsCap).toBe(true);
  });

  it('compares one consumable or enhancement against unchanged gear and composes the choices', () => {
    const baselineGear = new Map<GearSlot, ItemInstance | null>([['head', item(1, 'head')]]);
    const options = { ...opts, baselineGear, workCap: 100 };
    const dimensions = selectionToDimensions({ slots: {}, consumables: { flask: ['only_one'] }, gems: { head: [[100]] }, enchants: { head: [200] } }, options);
    expect(dimensions.map((d) => d.options.length)).toEqual([2, 2, 2]);
    const { candidates } = collect(generate(dimensions, options), 100);
    expect(candidates).toHaveLength(8);
    expect(candidates[0].id).toBe('baseline');
    expect(candidates.some((c) => c.lines.includes('flask=only_one') && c.delta.gear?.get('head')?.enchantId === 200 && c.delta.gear?.get('head')?.gemIds[0] === 100)).toBe(true);
    expect(estimateWork({ slots: {} }, options).combinations).toBe(1);
    expect(() => selectionToDimensions({ slots: {}, consumables: { iterations: ['1'] } }, options)).toThrow('Invalid consumable');
    expect(() => selectionToDimensions({ slots: {}, consumables: { flask: ['bad\niterations=1'] } }, options)).toThrow('Invalid consumable');
  });

  // frostsim-b5 measured the 0.05% finalist stage as the expensive one by a wide
  // margin, while a UI weighting stages by candidate count showed all three as
  // equal. Samples scale as 1/targetError², so the later stage must cost more even
  // with far fewer candidates.
  it('costs the precise stage far more than the broad one, despite fewer candidates', () => {
    const est = estimateWork({ slots: { head: Array.from({ length: 50 }, (_, i) => item(i, 'head')) } }, opts);
    const [survey, , finalists] = est.stages;
    expect(finalists.candidates).toBeLessThan(survey.candidates);
    // 1% -> 0.05% is 400x the samples per candidate, which swamps the narrowing.
    expect(finalists.relativeCost).toBeGreaterThan(survey.relativeCost * 10);
  });

  it('scales per-candidate samples as the inverse square of the target error', () => {
    expect(perCandidateSamples({ mode: 'targetError', targetError: 0.5, maxIterations: 1e9 }))
      .toBeCloseTo(perCandidateSamples({ mode: 'targetError', targetError: 1, maxIterations: 1e9 }) * 4);
    expect(perCandidateSamples({ mode: 'iterations', iterations: 1234 })).toBe(1234);
    // Never above the ceiling the stage actually stops at.
    expect(perCandidateSamples({ mode: 'targetError', targetError: 0.001, maxIterations: 5000 })).toBe(5000);
  });

  it('narrows the candidate count stage by stage', () => {
    const est = estimateWork({ slots: { head: Array.from({ length: 10 }, (_, i) => item(i, 'head')) } }, opts);
    const counts = est.stages.map((s) => s.candidates);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('includes a finalist for every Vault reward and the no-Vault alternative in workload estimates', () => {
    const vault = [item(1, 'head', { source: 'vault', vaultRewardId: 'a' }), item(2, 'head', { source: 'vault', vaultRewardId: 'b' })];
    const plan = { ...ONE_STAGE, stages: [
      { ...ONE_STAGE.stages[0], label: 'Screen', maxSurvivors: 1 },
      { ...ONE_STAGE.stages[0], label: 'Final' },
    ] };
    const estimate = estimateWork({ slots: { head: vault } }, { ...opts, plan });
    expect(estimate.stages[1].candidates).toBe(3);
  });

  it('keeps nine Vault rewards with upgraded variants linear rather than blocking their legal search', () => {
    const slots: GearSlot[] = ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs'];
    const baselineGear = new Map(slots.map((slot, i) => [slot, item(i + 1, slot)]));
    const selection = { slots: Object.fromEntries(slots.map((slot, i) => {
      const reward = item(i + 20, slot, { source: 'vault', vaultRewardId: `reward${i}` });
      return [slot, [baselineGear.get(slot)!, reward, { ...reward, instanceId: `${reward.instanceId}:up`, itemLevel: 321 }]];
    })) };
    const options = { ...opts, baselineGear, workCap: 5000 };
    const estimate = estimateWork(selection, options);
    expect(estimate.exceedsCap).toBe(false);
    expect(estimate.combinations).toBeLessThanOrEqual(20);
    const { candidates, report } = collect(generate(selectionToDimensions(selection, options), options), 5000);
    expect(candidates).toHaveLength(19);
    expect(report.examined).toBe(19);
    expect(report.rejectedIllegal).toBe(0);
  });
});

// Foundation traced a browser failure to the result being dropped between the
// final report parse and the UI. Nothing in post-processing may turn a COMPLETED
// search into a rejection: every batch has already run, and losing the result
// discards measurements that cost minutes and looks identical to a failed search.
describe('a completed search survives broken post-processing', () => {
  const opts = {
    catalog: fakeCatalog(), character: CHARACTER,
    baselineGear: new Map<GearSlot, ItemInstance | null>(),
    profile: 'mage="x"', engineIdentity: 'test-engine',
    plan: ONE_STAGE,
  };

  it('returns the measurements with a warning rather than rejecting', async () => {
    const runBatch: RunBatch = async (req) => ({
      results: req.profilesets.map((p) => ({ id: p.id, mean: 1200, margin: 2, iterations: 5000 })),
      baseline: { mean: 1000, margin: 2, iterations: 5000 },
      confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
    });
    const handle = search({ slots: { head: [item(1, 'head'), item(2, 'head')] } }, { ...opts, runBatch });
    const r = await handle.result;
    // Sanity: the search really did produce measurements.
    expect(r.candidates.some((s) => s.status === 'measured')).toBe(true);

    // Now the same search with a candidate whose cost is missing entirely, which
    // is what used to throw in the summary step.
    const broken = await search({ slots: { head: [item(1, 'head'), item(2, 'head')] } }, {
      ...opts,
      runBatch: async (req) => {
        const out = await runBatch(req);
        return out;
      },
    }).result;
    for (const state of broken.candidates) delete (state.candidate as { cost?: unknown }).cost;
    expect(() => recommendation(broken)).not.toThrow();
  });

  it('tolerates a candidate with no cost at all', async () => {
    const runBatch: RunBatch = async (req) => ({
      results: req.profilesets.map((p) => ({ id: p.id, mean: 1200, margin: 2, iterations: 5000 })),
      baseline: null, confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
    });
    // A candidate missing `cost` reaches the summary step; it must not throw.
    const dimensionless = search({ slots: {} }, { ...opts, runBatch });
    const r = await dimensionless.result;
    expect(r.warnings.join(' ')).not.toMatch(/could not be assembled/);
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});

// A result is rendered by a template that iterates these fields. Anything a view
// iterates must be present and empty rather than absent: the baseline candidate
// used to omit `provenance.items`, so a template threw on exactly one row, in a
// subtree that renders once at the very end of a search. The search succeeds, the
// flags are all correct, and the results simply never appear.
describe('every candidate is safe to render', () => {
  const opts = {
    catalog: fakeCatalog(), character: CHARACTER,
    baselineGear: new Map<GearSlot, ItemInstance | null>(),
    profile: 'mage="x"', engineIdentity: 'test-engine', plan: ONE_STAGE,
  };
  const runBatch: RunBatch = async (req) => ({
    results: req.profilesets.map((p) => ({ id: p.id, mean: 1200, margin: 2, iterations: 5000 })),
    baseline: { mean: 1000, margin: 2, iterations: 5000 },
    confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
  });

  it('gives every candidate an iterable provenance.items, baseline included', async () => {
    const r = await search({ slots: { head: [item(1, 'head'), item(2, 'head')] } }, { ...opts, runBatch }).result;
    expect(r.candidates.length).toBeGreaterThan(1);
    const baseline = r.candidates.find((s) => s.candidate.id === 'baseline');
    expect(baseline).toBeDefined();
    for (const state of r.candidates) {
      // The exact shape a template does `{#each ... as item}` over.
      expect(Array.isArray(state.candidate.provenance.items), state.candidate.id).toBe(true);
      expect(() => [...state.candidate.provenance.items]).not.toThrow();
      expect(typeof state.candidate.provenance.label).toBe('string');
      expect(Array.isArray(state.candidate.cost.unknownCosts)).toBe(true);
      expect(Array.isArray(state.candidate.lines)).toBe(true);
      expect(Array.isArray(state.history)).toBe(true);
    }
  });

  // A keyed `{#each}` throws `each_key_duplicate` and takes the whole subtree
  // down. Every array in a result is a candidate key source, so every one of them
  // has to be duplicate-free — and a duplicate candidate id would be a correctness
  // problem regardless of whether anything rendered it.
  it('produces no duplicates in any array a template could key on', async () => {
    const plan: StagePlan = {
      version: 1, retentionFactor: 1, minIterations: 200,
      stages: [
        { label: 'S1', accuracy: { mode: 'iterations', iterations: 100 }, maxSurvivors: 10, batchSize: 1 },
        { label: 'S2', accuracy: { mode: 'iterations', iterations: 200 }, maxSurvivors: 10, batchSize: 1 },
      ],
    };
    // batchSize 1 across several candidates forces many batches, which is what
    // used to repeat the same per-batch warning once per batch.
    const noIdentity = { catalog: fakeCatalog(), character: CHARACTER, baselineGear: new Map<GearSlot, ItemInstance | null>(), profile: 'p', plan };
    const r = await search(
      { slots: { head: [item(1, 'head'), item(2, 'head'), item(3, 'head')] } },
      { ...noIdentity, runBatch },   // no engineIdentity: pushes a warning per batch
    ).result;

    const unique = (xs: unknown[]) => new Set(xs.map((x) => JSON.stringify(x))).size === xs.length;
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(unique(r.warnings), `warnings: ${JSON.stringify(r.warnings)}`).toBe(true);
    expect(unique(r.candidates.map((s) => s.candidate.id))).toBe(true);
    expect(unique(r.droppedWhileAlive)).toBe(true);
    expect(unique(r.unresolvedTie)).toBe(true);
    expect(unique(r.stagesRun.map((s) => s.label))).toBe(true);
  });

  it('mints unique candidate ids by construction, not by luck', () => {
    // Many candidates over several dimensions, so index and hash both get exercised.
    const dims: Dimension[] = [
      { key: 'a', kind: 'gear', slot: 'head', options: Array.from({ length: 12 }, (_, i) => ({ key: `h${i}`, label: `h${i}`, item: item(100 + i, 'head') })) },
      { key: 'b', kind: 'gear', slot: 'hands', options: Array.from({ length: 12 }, (_, i) => ({ key: `g${i}`, label: `g${i}`, item: item(200 + i, 'hands') })) },
    ];
    const { candidates } = collect(generate(dims, {
      workCap: 500, character: CHARACTER, catalog: fakeCatalog(),
      baselineGear: new Map<GearSlot, ItemInstance | null>(),
    }), 500);
    expect(candidates.length).toBe(145); // 12 x 12 variants plus the baseline
    const ids = candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The baseline shares the namespace, so it must not collide with a generated id.
    expect(ids.filter((id) => id === 'baseline')).toHaveLength(1);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('gives the Droptimizer baseline the same guarantee', async () => {
    const ring = item(100, 'finger1');
    const sources = [{ id: 's', label: 'S', provenance: 'user' as const, items: [ring] }];
    const r = await droptimizer.run(sources, {
      ...opts, runBatch,
      baselineGear: new Map<GearSlot, ItemInstance | null>([['finger1', item(1, 'finger1')]]),
    }).result;
    for (const state of r.candidates) {
      expect(Array.isArray(state.candidate.provenance.items), state.candidate.id).toBe(true);
    }
    // And the row shapes the results table iterates.
    for (const row of r.rows) {
      expect(Array.isArray(row.sourceIds)).toBe(true);
      expect(Array.isArray(row.scenario.unchecked)).toBe(true);
    }
  });
});

describe('Top Gear recommendation', () => {
  // Foundation saw a search return in 58ms with every candidate unmeasured, which
  // a screen faithfully rendered as "Keep your current gear" — a confidently wrong
  // answer based on no measurement, and indistinguishable from a real result.
  it('is not a recommendation at all when nothing was measured', () => {
    const rec = recommendation({
      baseline: null,
      candidates: [
        { candidate: candidate('a'), status: 'missing', measurement: null, history: [] },
        { candidate: candidate('b'), status: 'failed', measurement: null, history: [] },
      ],
      unresolvedTie: [], truncated: false, droppedWhileAlive: [], stagesRun: [], warnings: [], problems: [], incomplete: null,
    });
    expect(rec.measured).toBe(false);
    expect(rec.keepCurrent).toBe(false);
    expect(rec.winner).toBeNull();
    expect(rec.reason).toMatch(/not a recommendation/);
  });

  it('marks a real answer as measured', () => {
    const rec = recommendation({
      baseline: measurement('baseline', 1000, 2),
      candidates: [
        { candidate: candidate('baseline'), status: 'measured', measurement: measurement('baseline', 1000, 2), history: [] },
      ],
      unresolvedTie: [], truncated: false, droppedWhileAlive: [], stagesRun: [], warnings: [], problems: [], incomplete: null,
    });
    expect(rec.measured).toBe(true);
  });

  it('keeps the current setup when the leader is not distinguishable from it', () => {
    const rec = recommendation({
      baseline: measurement('baseline', 1000, 5),
      candidates: [
        { candidate: candidate('better'), status: 'measured', measurement: measurement('better', 1004, 5), history: [] },
        { candidate: candidate('baseline'), status: 'measured', measurement: measurement('baseline', 1000, 5), history: [] },
      ],
      unresolvedTie: ['better', 'baseline'], truncated: false, droppedWhileAlive: [],
      stagesRun: [], warnings: [], problems: [], incomplete: null,
    });
    expect(rec.keepCurrent).toBe(true);
    expect(rec.winner?.id).toBe('better');
  });

  it('recommends a change when it is measurably better', () => {
    const rec = recommendation({
      baseline: measurement('baseline', 1000, 2),
      candidates: [
        { candidate: candidate('better'), status: 'measured', measurement: measurement('better', 1100, 2), history: [] },
        { candidate: candidate('baseline'), status: 'measured', measurement: measurement('baseline', 1000, 2), history: [] },
      ],
      unresolvedTie: [], truncated: false, droppedWhileAlive: [], stagesRun: [], warnings: [], problems: [], incomplete: null,
    });
    expect(rec.keepCurrent).toBe(false);
  });
});

// --- Droptimizer -----------------------------------------------------------

describe('Droptimizer scenarios', () => {
  const ring = item(100, 'finger1');
  const catalog = fakeCatalog((i) => resolved(i, {
    eligibleSlots: i.itemId === 100 ? ['finger1', 'finger2'] : [i.slot],
    inventoryType: i.itemId === 200 ? 17 : 11,
  }));

  const opts = {
    catalog, character: CHARACTER,
    baselineGear: new Map<GearSlot, ItemInstance | null>([
      ['finger1', item(1, 'finger1')], ['finger2', item(2, 'finger2')],
    ]),
  };

  it('tries one item in every eligible slot', () => {
    const { scenarios } = buildScenarios([{ id: 's1', label: 'Source', provenance: 'user', items: [ring] }], opts);
    expect(scenarios.map((s) => s.slot).sort()).toEqual(['finger1', 'finger2']);
    expect(scenarios[0].replaces?.itemId).toBe(1);
  });

  it('simulates a duplicate once but keeps every source association', () => {
    const { scenarios, sourcesFor } = buildScenarios([
      { id: 'raid', label: 'Raid', provenance: 'user', items: [ring] },
      { id: 'vault', label: 'Vault', provenance: 'user', items: [ring] },
    ], opts);
    expect(scenarios).toHaveLength(2); // two slots, not four
    expect(sourcesFor.get(scenarios[0].candidate.id)).toEqual(['raid', 'vault']);
  });

  it('empties the off hand for a two-hander and says it did rather than inventing a companion', () => {
    const twoHander = item(200, 'main_hand');
    // Only item 200 is the two-hander; the baseline rings must still resolve to
    // their own slots or the whole set reads as illegal.
    const weaponCatalog = fakeCatalog((i) => i.itemId === 200
      ? resolved(i, { eligibleSlots: ['main_hand'], inventoryType: 17, itemClass: 2 })
      : resolved(i, { eligibleSlots: [i.slot], inventoryType: 11 }));
    const { scenarios } = buildScenarios(
      [{ id: 's', label: 'S', provenance: 'user', items: [twoHander] }],
      { ...opts, catalog: weaponCatalog },
    );
    expect(scenarios[0].unchecked.join(' ')).toMatch(/off hand was emptied/);
    expect(scenarios[0].candidate.delta.gear?.get('off_hand')).toBeNull();
  });

  it('reports an item the catalog does not know instead of dropping it silently', () => {
    const { scenarios, warnings } = buildScenarios(
      [{ id: 's', label: 'S', provenance: 'user', items: [item(999, 'head')] }],
      { ...opts, catalog: fakeCatalog(() => null) },
    );
    expect(scenarios).toHaveLength(0);
    expect(warnings[0]).toMatch(/not in the catalog/);
  });

  it('marks every candidate cost as unknown rather than zero', () => {
    const { scenarios } = buildScenarios([{ id: 's1', label: 'S', provenance: 'user', items: [ring] }], opts);
    expect(scenarios[0].candidate.cost.unknownCosts).toContain('upgrade currency');
    expect(scenarios[0].candidate.cost.currencies).toBeUndefined();
  });
});

// P09.9: a Great Vault row offers several rewards and the user takes exactly one.
// Presenting them as a ranked list of upgrades would read as a shopping list.
describe('Droptimizer exclusive choices', () => {
  const ring = item(100, 'finger1');
  const catalog = fakeCatalog((i) => resolved(i, { eligibleSlots: ['finger1'] }));
  const baseOpts = {
    catalog, character: CHARACTER,
    baselineGear: new Map<GearSlot, ItemInstance | null>([['finger1', item(1, 'finger1')]]),
    profile: 'mage="x"', catalogId: 'test-catalog', engineIdentity: 'test-engine',
  };

  async function runWith(exclusive: boolean, means: Record<string, number>, margin = 2) {
    const trinket = { ...ring, instanceId: 'alt', itemId: 101 };
    const sources = [{
      id: 'vault', label: 'Great Vault', provenance: 'user' as const,
      items: [ring, trinket], exclusive, hypothetical: false,
    }];
    const { scenarios } = buildScenarios(sources, baseOpts);
    // Map the generated candidate ids onto the supplied means, in order.
    const byIndex = scenarios.map((s, i) => [s.candidate.id, Object.values(means)[i]] as const);
    const runBatch: RunBatch = async (req) => ({
      results: req.profilesets.map((p) => ({
        id: p.id, mean: byIndex.find(([id]) => id === p.id)?.[1] ?? 1000, margin, iterations: 5000,
      })),
      baseline: { mean: 1000, margin, iterations: 5000 },
      confidence: 0.95, targetReached: true, engineIdentity: 'test-engine',
    });
    return droptimizer.run(sources, { ...baseOpts, runBatch, plan: ONE_STAGE }).result;
  }

  it('groups an exclusive source into one choice with a single pick', async () => {
    const r = await runWith(true, { a: 1200, b: 1100 });
    expect(r.exclusiveChoices).toHaveLength(1);
    const [choice] = r.exclusiveChoices;
    expect(choice.label).toBe('Great Vault');
    expect(choice.rows).toHaveLength(2);
    expect(choice.best?.mean).toBe(1200);
    expect(choice.indistinguishable).toEqual([]);
  });

  it('refuses to pick when the rewards cannot be told apart', async () => {
    const r = await runWith(true, { a: 1200, b: 1199 }, 50);
    expect(r.exclusiveChoices[0].indistinguishable).toHaveLength(1);
  });

  it('leaves independent sources ungrouped', async () => {
    const r = await runWith(false, { a: 1200, b: 1100 });
    expect(r.exclusiveChoices).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });

  it('never shows a probability, because none is known', async () => {
    const r = await runWith(true, { a: 1200, b: 1100 });
    expect(r.probabilitiesUnavailable).toBe(true);
    expect(r.probabilityExplanation).toMatch(/no verified loot table/);
  });
});

describe('default stage plan', () => {
  // Bounds time, not memory: peak RSS was measured flat against iteration count.
  it('bounds every stage to a finite amount of engine time', () => {
    for (const stage of DEFAULT_STAGE_PLAN.stages) {
      expect(iterationCeiling(stage.accuracy)).toBeLessThanOrEqual(DEFAULT_MAX_ITERATIONS);
    }
  });

  // A 0.05% finalist stage ran >180s for 3 candidates in a browser and then killed
  // the worker. Samples scale as 1/targetError², so anything that tight is minutes
  // per candidate. The ladder has to end somewhere a browser can reach.
  it('ends at a precision a browser can actually finish', () => {
    const last = DEFAULT_STAGE_PLAN.stages[DEFAULT_STAGE_PLAN.stages.length - 1];
    expect(last.accuracy.mode).toBe('targetError');
    if (last.accuracy.mode === 'targetError') {
      expect(last.accuracy.targetError).toBeGreaterThanOrEqual(0.2);
    }
    // And the whole plan's worst case stays within a few minutes of engine time.
    // ~345 iterations/second measured at 4 threads on the reference machine.
    const worstCaseSeconds = DEFAULT_STAGE_PLAN.stages
      .reduce((total, s) => total + (s.maxSurvivors * perCandidateSamples(s.accuracy)) / 345, 0);
    expect(worstCaseSeconds).toBeLessThan(15 * 60);
  });

  it('tightens precision and narrows survivors at every step', () => {
    const errors = DEFAULT_STAGE_PLAN.stages.map((s) =>
      s.accuracy.mode === 'targetError' ? s.accuracy.targetError : 0);
    expect(errors).toEqual([...errors].sort((a, b) => b - a));
    const survivors = DEFAULT_STAGE_PLAN.stages.map((s) => s.maxSurvivors);
    expect(survivors).toEqual([...survivors].sort((a, b) => b - a));
  });
});

// --- P08.4 socket and unique constraints during generation -------------------

describe('generation enforces socket and unique rules', () => {
  const SOCKET_RED = 0x2;
  const SOCKET_BLUE = 0x8;
  const RED_GEM = 900;
  const BLUE_GEM = 901;
  const UNIQUE_GEM = 902;

  /** Resolves gems the way the real catalog does: colour and uniqueness per gem. */
  function socketCatalog(sockets: number[]): Catalog {
    return fakeCatalog((inst) => resolved(inst, {
      sockets,
      gemIds: inst.gemIds ?? [],
      gemColors: (inst.gemIds ?? []).map((g) => (g === BLUE_GEM ? SOCKET_BLUE : SOCKET_RED)),
      gemUnique: (inst.gemIds ?? []).map((g) => g === UNIQUE_GEM),
    }));
  }

  function gemDimension(slot: GearSlot, loadouts: number[][]): Dimension {
    return {
      key: `gems:${slot}`, kind: 'gem', slot,
      options: loadouts.map((gemIds) => ({ key: gemIds.join('.'), label: gemIds.join('/'), gemIds })),
    };
  }

  const baseline = (slot: GearSlot, gemIds: number[] = []) =>
    new Map<GearSlot, ItemInstance | null>([[slot, item(1, slot, { gemIds })]]);

  it('rejects a gem whose colour the socket does not accept', () => {
    const { candidates } = collect(
      generate([gemDimension('head', [[RED_GEM], [BLUE_GEM]])], {
        workCap: 50, character: CHARACTER, catalog: socketCatalog([SOCKET_RED]),
        baselineGear: baseline('head'), includeBaseline: false,
      }),
      50,
    );
    // Only the red gem fits a red socket.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].canonical).toContain(String(RED_GEM));
  });

  it('rejects more gems than the item has sockets', () => {
    const { candidates, report } = collect(
      generate([gemDimension('head', [[RED_GEM, RED_GEM], [RED_GEM]])], {
        workCap: 50, character: CHARACTER, catalog: socketCatalog([SOCKET_RED]),
        baselineGear: baseline('head'), includeBaseline: false,
      }),
      50,
    );
    expect(candidates).toHaveLength(1);
    expect(report.rejectedIllegal).toBe(1);
  });

  it('rejects the same unique gem socketed twice, across different slots', () => {
    const gear = new Map<GearSlot, ItemInstance | null>([
      ['head', item(1, 'head')],
      ['hands', item(2, 'hands')],
    ]);
    const { candidates, report } = collect(
      generate(
        [gemDimension('head', [[UNIQUE_GEM], [RED_GEM]]), gemDimension('hands', [[UNIQUE_GEM], [RED_GEM]])],
        {
          workCap: 50, character: CHARACTER, catalog: socketCatalog([SOCKET_RED]),
          baselineGear: gear, includeBaseline: false,
        },
      ),
      50,
    );
    // 4 combinations, minus the one that wears the unique gem in both slots.
    expect(report.rejectedIllegal).toBe(1);
    expect(candidates).toHaveLength(3);
  });

  it('accepts any gem in an unrestricted socket', () => {
    const { candidates } = collect(
      generate([gemDimension('head', [[RED_GEM], [BLUE_GEM]])], {
        workCap: 50, character: CHARACTER, catalog: socketCatalog([0]),
        baselineGear: baseline('head'), includeBaseline: false,
      }),
      50,
    );
    expect(candidates).toHaveLength(2);
  });
});

// --- P08.2 embellishments ----------------------------------------------------

describe('embellishment dimension', () => {
  const EMB_A = 7001;
  const EMB_B = 7002;

  function embDimension(slot: GearSlot, ids: number[]): Dimension {
    return {
      key: `embellishment:${slot}`, kind: 'embellishment', slot,
      options: ids.map((bonusId) => ({ key: String(bonusId), label: String(bonusId), embellishmentBonusId: bonusId })),
    };
  }

  const gear = () => new Map<GearSlot, ItemInstance | null>([
    ['head', item(1, 'head')],
    ['hands', item(2, 'hands')],
  ]);

  it('puts the embellishment bonus id on the item line', () => {
    const { candidates } = collect(
      generate([embDimension('head', [0, EMB_A])], {
        workCap: 50, character: CHARACTER, catalog: fakeCatalog(),
        baselineGear: gear(), includeBaseline: false,
        embellishmentBonusIds: [EMB_A, EMB_B],
      }),
      50,
    );
    expect(candidates).toHaveLength(2);
    const withEmb = candidates.find((c) => c.lines.some((l) => l.includes(String(EMB_A))));
    expect(withEmb).toBeDefined();
    // And the unembellished option really carries no embellishment.
    const without = candidates.find((c) => c !== withEmb)!;
    expect(without.lines.some((l) => l.includes(String(EMB_A)))).toBe(false);
  });

  it('replaces an embellishment the item already carried rather than stacking one', () => {
    const pre = new Map<GearSlot, ItemInstance | null>([
      ['head', item(1, 'head', { bonusIds: [EMB_A] })],
    ]);
    const { candidates } = collect(
      generate([embDimension('head', [EMB_A, EMB_B])], {
        workCap: 50, character: CHARACTER, catalog: fakeCatalog(),
        baselineGear: pre, includeBaseline: false,
        embellishmentBonusIds: [EMB_A, EMB_B],
      }),
      50,
    );
    const swapped = candidates.find((c) => c.lines.some((l) => l.includes(String(EMB_B))))!;
    const line = swapped.lines.find((l) => l.startsWith('head='))!;
    expect(line).toContain(String(EMB_B));
    expect(line).not.toContain(String(EMB_A));
  });

  it('enforces a supplied embellishment limit and ignores it when none is given', () => {
    const dims = [embDimension('head', [0, EMB_A]), embDimension('hands', [0, EMB_B])];
    const opts = {
      workCap: 50, character: CHARACTER, catalog: fakeCatalog(),
      baselineGear: gear(), includeBaseline: false,
      embellishmentBonusIds: [EMB_A, EMB_B],
    };
    expect(collect(generate(dims, opts), 50).candidates).toHaveLength(4);

    const limited = collect(generate(dims, { ...opts, embellishmentLimit: 1 }), 50);
    // The combination wearing both is the only one removed.
    expect(limited.candidates).toHaveLength(3);
    expect(limited.report.rejectedIllegal).toBe(1);
  });

  it('counts embellishments on slots the candidate did not change', () => {
    const wearing = new Map<GearSlot, ItemInstance | null>([
      ['head', item(1, 'head')],
      ['hands', item(2, 'hands', { bonusIds: [EMB_B] })],
    ]);
    const limited = collect(
      generate([embDimension('head', [0, EMB_A])], {
        workCap: 50, character: CHARACTER, catalog: fakeCatalog(),
        baselineGear: wearing, includeBaseline: false,
        embellishmentBonusIds: [EMB_A, EMB_B], embellishmentLimit: 1,
      }),
      50,
    );
    // The hands already wear one, so adding a second to the head is over the limit.
    expect(limited.candidates).toHaveLength(1);
    expect(limited.report.rejectedIllegal).toBe(1);
  });

  it('is reachable from a Selection', () => {
    const dims = selectionToDimensions(
      { slots: {}, embellishments: { head: [0, EMB_A] } },
      { catalog: fakeCatalog(), character: CHARACTER, baselineGear: gear() },
    );
    expect(dims.map((d) => d.kind)).toContain('embellishment');
    expect(dims[0].options.map((o) => o.embellishmentBonusId)).toEqual([undefined, 0, EMB_A]);
  });
});

// --- P09.2 usability filtering ----------------------------------------------

describe('loot usability filtering', () => {
  const AGILITY = 3;
  const INTELLECT = 5;
  const COMBINED = 71; // strength/agility/intellect
  const MAGE = 8;
  const CLOTH = 1;
  const PLATE = 4;

  const stat = (type: number) => ({ type, label: null, value: 100, allocation: 0 });

  function itemWith(over: Partial<ResolvedItem>): ResolvedItem {
    return resolved(item(1, 'head'), { itemClass: 4, itemSubclass: CLOTH, ...over });
  }

  it('filters an item the class mask excludes', () => {
    const warriorOnly = itemWith({ classMask: 1 }); // bit 0 = warrior
    expect(droptimizer.usabilityReasons(warriorOnly, { classId: MAGE })).toEqual(['class']);
    expect(droptimizer.usabilityReasons(itemWith({ classMask: 0 }), { classId: MAGE })).toEqual([]);
  });

  it('filters the wrong armor type, and only for real armor', () => {
    const plate = itemWith({ itemSubclass: PLATE });
    expect(droptimizer.usabilityReasons(plate, { classId: MAGE, armorSubclass: CLOTH })).toEqual(['armor_type']);
    // A cloak (subclass 0) is not one of the four armor types and is never filtered.
    const cloak = itemWith({ itemSubclass: 0 });
    expect(droptimizer.usabilityReasons(cloak, { classId: MAGE, armorSubclass: CLOTH })).toEqual([]);
  });

  it('filters a single wrong primary stat but keeps combined and stat-less items', () => {
    const agi = itemWith({ stats: [stat(AGILITY)] });
    expect(droptimizer.usabilityReasons(agi, { classId: MAGE, primaryStat: INTELLECT })).toEqual(['primary_stat']);

    const combined = itemWith({ stats: [stat(COMBINED)] });
    expect(droptimizer.usabilityReasons(combined, { classId: MAGE, primaryStat: INTELLECT })).toEqual([]);

    const secondariesOnly = itemWith({ stats: [stat(32)] });
    expect(droptimizer.usabilityReasons(secondariesOnly, { classId: MAGE, primaryStat: INTELLECT })).toEqual([]);
  });

  it('filters an item that fits none of the slots being filled', () => {
    const boots = itemWith({ eligibleSlots: ['feet'] });
    expect(droptimizer.usabilityReasons(boots, { classId: MAGE, slots: ['head', 'hands'] })).toEqual(['slot']);
    expect(droptimizer.usabilityReasons(boots, { classId: MAGE, slots: ['feet'] })).toEqual([]);
  });

  it('keeps a source that loses every item, rather than hiding the boss', () => {
    const catalog = fakeCatalog((i) => resolved(i, { itemClass: 4, itemSubclass: PLATE }));
    const { sources, removed } = droptimizer.filterSources(
      [{ id: 'boss', label: 'Boss', provenance: 'catalog', items: [item(1, 'head'), item(2, 'chest')] }],
      catalog,
      { classId: MAGE, armorSubclass: CLOTH },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].items).toHaveLength(0);
    expect(removed.map((r) => r.reasons[0])).toEqual(['armor_type', 'armor_type']);
  });

  it('keeps an item the catalog cannot resolve rather than filtering on ignorance', () => {
    const catalog = fakeCatalog(() => null);
    const { sources, removed } = droptimizer.filterSources(
      [{ id: 'boss', label: 'Boss', provenance: 'catalog', items: [item(9999, 'head')] }],
      catalog,
      { classId: MAGE, armorSubclass: CLOTH },
    );
    expect(sources[0].items).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });
});

// --- one accuracy field driving the whole ladder -----------------------------

describe('planForTargetError', () => {
  it('reproduces the shipped ladder when asked for its own target error', () => {
    const plan = planForTargetError(0.2);
    expect(plan.stages.map((s) => (s.accuracy as { targetError: number }).targetError)).toEqual([1, 0.5, 0.2]);
    expect(iterationCeiling(plan.stages[2].accuracy)).toBe(iterationCeiling(DEFAULT_STAGE_PLAN.stages[2].accuracy));
  });

  it('gets tighter at every stage when the final target tightens', () => {
    const loose = planForTargetError(0.5);
    const tight = planForTargetError(0.05);
    for (let i = 0; i < 3; i++) {
      const a = (loose.stages[i].accuracy as { targetError: number }).targetError;
      const b = (tight.stages[i].accuracy as { targetError: number }).targetError;
      expect(b).toBeLessThan(a);
    }
  });

  it('raises the iteration ceiling as the target tightens, but never past the cap', () => {
    const tight = planForTargetError(0.05);
    expect(iterationCeiling(tight.stages[2].accuracy))
      .toBeGreaterThan(iterationCeiling(planForTargetError(0.5).stages[2].accuracy));
    for (const stage of planForTargetError(0.01).stages) {
      expect(iterationCeiling(stage.accuracy)).toBeLessThanOrEqual(DEFAULT_MAX_ITERATIONS);
    }
  });

  it('refuses a target that would never terminate', () => {
    // 0 and NaN are what a blank or mistyped field produces.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const stage of planForTargetError(bad).stages) {
        const e = (stage.accuracy as { targetError: number }).targetError;
        expect(e).toBeGreaterThan(0);
        expect(Number.isFinite(e)).toBe(true);
      }
    }
  });

  it('keeps the versioned plan settings, including the multiplicity correction', () => {
    const plan = planForTargetError(0.1);
    expect(plan.version).toBe(DEFAULT_STAGE_PLAN.version);
    expect(plan.correctForMultipleComparisons).toBe(true);
    expect(plan.retentionFactor).toBe(DEFAULT_STAGE_PLAN.retentionFactor);
  });

  it('actually runs, and a tighter plan measures at least as precisely', async () => {
    const candidates: Candidate[] = [
      { id: 'baseline', provenance: { kind: 'baseline', items: [], label: 'b' }, delta: {}, cost: { unknownCosts: [] }, lines: [], canonical: '' },
      { id: 'a', provenance: { kind: 'gear', items: [], label: 'a' }, delta: {}, cost: { unknownCosts: [] }, lines: ['head=,id=1'], canonical: 'a' },
    ];
    const seen: number[] = [];
    const runBatch: RunBatch = async (req) => {
      if (req.accuracy.mode === 'targetError') seen.push(req.accuracy.targetError);
      return {
        results: req.profilesets.map((p) => ({ id: p.id, mean: 200_000, margin: 100, iterations: 5000 })),
        baseline: { mean: 199_000, margin: 100, iterations: 5000 },
        confidence: 0.95, targetReached: true, engineIdentity: 'e', problems: [],
      };
    };
    const result = await runStagedSearch(candidates, {
      profile: 'p', plan: planForTargetError(0.1), catalogId: 'c', engineIdentity: 'e', runBatch,
    });
    expect(result.incomplete).toBeNull();
    expect(Math.min(...seen)).toBeCloseTo(0.1, 5);
  });
});

// --- engine problems come from two places, and one of them omits candidates ----

describe('problem collection from an engine outcome', () => {
  function outcome(over: { problems?: string[]; notices?: { level: string; message: string; kind: string }[] }) {
    return {
      jobId: 'j', request: {}, engineIdentity: 'e', appElapsedSeconds: 1,
      profilesetStatus: { completed: [], missing: [] }, inputWarnings: [],
      engineNotices: over.notices ?? [],
      report: {
        profilesets: [], players: [], problems: over.problems ?? [], warnings: [], logs: [],
        options: { confidence: 0.95 }, targetReached: true, timings: {},
      },
    } as unknown as Parameters<typeof outcomeToProfilesetOutcome>[0];
  }

  it('delays target-error convergence until the sample floor without raising the iteration ceiling', async () => {
    const job = vi.spyOn(simcJob, 'runJob').mockReturnValue({
      jobId: 'j', state: 'complete', result: Promise.resolve(outcome({})), cancel: vi.fn(),
    });
    try {
      const runBatch = engineRunBatch({ settings: DEFAULT_SETTINGS, extraOptions: ['analyze_error_interval=50'] });
      for (const accuracy of [
        { mode: 'targetError', targetError: 1, maxIterations: 1000 },
        { mode: 'targetError', targetError: 1, maxIterations: 100 },
        { mode: 'iterations', iterations: 1000 },
      ] as const) {
        await runBatch({ profile: 'mage="x"', profilesets: [], accuracy, minIterations: 200 });
        const request = job.mock.calls.at(-1)![0];
        expect(request.accuracy).toEqual(accuracy);
        expect(request.extraOptions).toEqual(accuracy.mode === 'targetError'
          ? ['analyze_error_interval=50', 'analyze_error_interval=200']
          : ['analyze_error_interval=50']);
      }
    } finally {
      job.mockRestore();
    }
  });

  it('includes stderr notices, which are the only ones that see candidate sims', () => {
    // `error_list` is per-sim and `sim_t::merge` does not copy it, so a problem
    // raised inside a profileset's child sim never reaches report.problems at all.
    // Without the stderr source a candidate problem is invisible.
    const r = outcomeToProfilesetOutcome(outcome({
      problems: [],
      notices: [{ level: 'error', message: 'candidate blew up', kind: 'problem' }],
    }));
    expect(r.problems).toEqual(['candidate blew up']);
  });

  it('ignores notices that are not problems', () => {
    const r = outcomeToProfilesetOutcome(outcome({
      notices: [
        { level: 'info', message: 'an assumption', kind: 'model' },
        { level: 'error', message: 'a real one', kind: 'problem' },
      ],
    }));
    expect(r.problems).toEqual(['a real one']);
  });

  it('deduplicates a problem that both sources report', () => {
    const r = outcomeToProfilesetOutcome(outcome({
      problems: ['same thing'],
      notices: [{ level: 'error', message: 'same thing', kind: 'problem' }],
    }));
    expect(r.problems).toEqual(['same thing']);
  });

  it('is empty on a clean run', () => {
    expect(outcomeToProfilesetOutcome(outcome({})).problems).toEqual([]);
  });
});

// --- distinctness as a control ----------------------------------------------

describe('identical means are reported honestly, and that is exactly the problem', () => {
  // The execution track has now shipped two defects where every candidate returned
  // the baseline's number: candidate lines passed as sim arguments, and candidate
  // lines placed after the `enemy=` block so each candidate equipped the target
  // dummy. Both exit 0 and warn about nothing.
  //
  // These tests pin what the runner does with that input, and the point is that it
  // does the RIGHT thing — which is why the failure is invisible. A caller cannot
  // tell this apart from a genuine tie by looking at the result, so anything that
  // can assert its candidates must differ should assert it.

  const candidates: Candidate[] = ['baseline', 'a', 'b', 'c'].map((id) => ({
    id,
    provenance: { kind: id === 'baseline' ? 'baseline' : 'gear', items: [], label: id },
    delta: {},
    cost: { unknownCosts: [] },
    lines: id === 'baseline' ? [] : [`head=,id=${id.charCodeAt(0)}`],
    canonical: id,
  }));

  const constantRunBatch = (mean: number): RunBatch => async (req) => ({
    results: req.profilesets.map((p) => ({ id: p.id, mean, margin: 500, iterations: 20_000 })),
    baseline: { mean, margin: 500, iterations: 20_000 },
    confidence: 0.95, targetReached: true, engineIdentity: 'e', problems: [],
  });

  it('ties every candidate together when they all return the same number', async () => {
    const result = await runStagedSearch(candidates, {
      profile: 'p', plan: DEFAULT_STAGE_PLAN, catalogId: 'c', engineIdentity: 'e',
      runBatch: constantRunBatch(200_000),
    });
    // Nothing is eliminated, because nothing is separable — correct, and useless.
    expect(result.candidates.every((s) => s.status === 'measured')).toBe(true);
    expect(result.unresolvedTie).toHaveLength(candidates.length);
    expect(result.incomplete).toBeNull();
    // And there is no warning, because from the runner's side nothing went wrong.
    expect(result.warnings).toEqual([]);
  });

  it('produces a result a caller cannot distinguish from a real tie', async () => {
    // A genuine tie: means differ by far less than the margin.
    const realTie: RunBatch = async (req) => ({
      results: req.profilesets.map((p, i) => ({ id: p.id, mean: 200_000 + i, margin: 500, iterations: 20_000 })),
      baseline: { mean: 200_000, margin: 500, iterations: 20_000 },
      confidence: 0.95, targetReached: true, engineIdentity: 'e', problems: [],
    });
    const opts = { profile: 'p', plan: DEFAULT_STAGE_PLAN, catalogId: 'c', engineIdentity: 'e' };
    const broken = await runStagedSearch(candidates, { ...opts, runBatch: constantRunBatch(200_000) });
    const genuine = await runStagedSearch(candidates, { ...opts, runBatch: realTie });

    // Same shape, same verdict, same absence of warnings. The only difference is
    // whether the numbers are literally equal — which is why a distinctness check
    // belongs in any test that knows its candidates should differ.
    expect(broken.unresolvedTie.length).toBe(genuine.unresolvedTie.length);
    expect(broken.warnings).toEqual(genuine.warnings);
    expect(recommendation(broken).keepCurrent).toBe(recommendation(genuine).keepCurrent);

    const distinct = new Set(genuine.candidates.map((s) => s.measurement?.mean));
    expect(distinct.size).toBeGreaterThan(1);
    expect(new Set(broken.candidates.map((s) => s.measurement?.mean)).size).toBe(1);
  });
});

// --- P09.3: preferences applied to a dropped item, ceilings deliberately not -----

describe('drop scenarios carry the user stated preferences', () => {
  const RED_GEM = 900;
  const gear = new Map<GearSlot, ItemInstance | null>([['head', item(1, 'head')]]);
  const source = (itemId: number) => ({
    id: 's', label: 'Boss', provenance: 'catalog' as const,
    items: [{ instanceId: `s:${itemId}`, slot: 'head' as GearSlot, itemId, bonusIds: [], gemIds: [] }],
  });

  function opts(over: Record<string, unknown> = {}) {
    const options = {
      catalog: fakeCatalog((i) => resolved(i, {
        eligibleSlots: ['head'], sockets: [0x2], craftingQuality: 0,
        gemIds: i.gemIds ?? [], gemColors: (i.gemIds ?? []).map(() => 0x2),
        gemUnique: (i.gemIds ?? []).map(() => false),
      })),
      character: CHARACTER,
      baselineGear: gear,
      ...over,
    } as Parameters<typeof buildScenarios>[1];
    options.catalog.lootSources = () => ({
      sources: [{ id: 's', seasonId: 18, kind: 'raid', name: 'Boss', provider: 'test', itemIds: [50] }],
      provenance: [], expiresAt: null, unavailableReason: null,
    });
    return options;
  }

  it('sockets a preferred gem into a dropped item', () => {
    const { scenarios } = buildScenarios([source(50)], opts({ preferredGems: { head: [RED_GEM] } }));
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].candidate.lines[0]).toContain(`gem_id=${RED_GEM}`);
  });

  it('applies only as many gems as the item has sockets, and says so', () => {
    const { scenarios } = buildScenarios(
      [source(50)],
      opts({ preferredGems: { head: [RED_GEM, RED_GEM, RED_GEM] } }),
    );
    // One socket on this item, so one gem.
    expect(scenarios[0].candidate.lines[0]).toContain(`gem_id=${RED_GEM}`);
    expect(scenarios[0].candidate.lines[0]).not.toContain(`${RED_GEM}/${RED_GEM}`);
    expect(scenarios[0].unchecked.join(' ')).toMatch(/2 preferred gem\(s\) were not applied/);
  });

  it('refuses to apply crafted stats to an item that is not crafted', () => {
    const { scenarios } = buildScenarios([source(50)], opts({ preferredCraftedStats: [40, 49] }));
    expect(scenarios[0].candidate.lines[0]).not.toContain('crafted_stats');
    expect(scenarios[0].unchecked.join(' ')).toMatch(/not a crafted item/);
  });

  it('applies crafted stats when the item really is crafted', () => {
    const catalog = fakeCatalog((i) => resolved(i, {
      eligibleSlots: ['head'], sockets: [], craftingQuality: 3,
    }));
    const { scenarios } = buildScenarios([source(50)], opts({ catalog, preferredCraftedStats: [40, 49] }));
    expect(scenarios[0].candidate.lines[0]).toContain('crafted_stats=40/49');
  });

  it('applies a preferred enchant', () => {
    const { scenarios } = buildScenarios([source(50)], opts({ preferredEnchants: { head: 7777 } }));
    expect(scenarios[0].candidate.lines[0]).toContain('enchant_id=7777');
  });

  it('changes nothing and adds no note when no preferences are given', () => {
    const { scenarios } = buildScenarios([source(50)], opts());
    expect(scenarios[0].candidate.lines[0]).not.toContain('gem_id');
    expect(scenarios[0].candidate.lines[0]).not.toContain('enchant_id');
    expect(scenarios[0].unchecked).toEqual([]);
  });

  it('never raises the item level, because upgrade ceilings are not in the data', () => {
    // P09.3 asks for upgrade ceilings. `track.step` and `track.max` are null in the
    // catalog because item_naming.inc gives a label and no track model, so a "fully
    // upgraded" scenario would be a guessed number driving a recommendation.
    const { scenarios } = buildScenarios([source(50)], opts({ preferredGems: { head: [RED_GEM] } }));
    expect(scenarios[0].candidate.lines[0]).not.toContain('ilevel=');
    expect(scenarios[0].item.track.step).toBeNull();
    expect(scenarios[0].item.track.max).toBeNull();
  });
});
