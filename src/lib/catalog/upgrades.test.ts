import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Catalog } from './catalog';
import { serializeItem } from './serialize';
import { itemUpgradeTrack, upgradeTracks, withItemLevel, withMaxUpgrade, withUpgradeRank } from './upgrades';
import { atRaidDifficulty, hasRaidRewards, raidDifficulties } from './raidRewards';
import raidRewards from './generated/raid-rewards.json';
import type { LootSource } from './types';
import { sourceAvailability, buildScenarios } from '../optimization/droptimizer';
import type { ItemInstance } from './types';
import { artifactGate } from '../../../tests/artifact-gate.js';

// Each catalog's manifest.json is tracked, the generated payloads beside it are not.
const dir = 'public/catalogs/' + (existsSync('public/catalogs')
  ? readdirSync('public/catalogs').find(name => name.startsWith('12.1.0.69814-'))
  : undefined);
const gate = artifactGate(`${dir}/items.json`, 'npm run catalog:build');
const json = (file: string) => JSON.parse(readFileSync(`${dir}/${file}.json`, 'utf8'));
const catalog = gate ? null! : new Catalog({ manifest: json('manifest'), items: json('items'), bonus: json('item-bonus'),
  scaling: json('scaling'), enchants: json('enchants'), gems: json('gems'), sets: json('sets'),
  embellishments: json('embellishments'), consumables: json('consumables') });
const item: ItemInstance = { instanceId: 'vault-reward', source: 'vault', vaultRewardId: 'reward-1',
  itemId: 268807, slot: 'head', bonusIds: [12841], gemIds: [], enchantId: 0 };

describe.skipIf(gate)('engine-pinned upgrade identities' + gate, () => {
  it('resolves boss-specific raid drops and keeps restricted Myth drops through max upgrades and planning', () => {
    const loot = { schemaVersion: 1, generatedAt: '', expiresAt: null, provenance: [], warnings: [],
      season: { id: raidRewards.seasonId, name: 'Midnight Season 2' },
      sources: raidRewards.rewards.map(reward => ({ id: reward.id, name: reward.name, instanceId: reward.instanceId,
        kind: 'raid' as const, seasonId: raidRewards.seasonId, provider: 'blizzard-journal',
        itemIds: [...Object.keys(reward.byDifficulty.heroic).map(Number), ...reward.ignoredItemIds] })) };
    catalog.registerLoot(loot);
    const sources = sourceAvailability(catalog).available;
    const mythicLevels: number[] = [];
    for (const [index, reward] of raidRewards.rewards.entries()) {
      const source = sources.find(source => source.id === reward.id)!;
      const original = JSON.stringify(source);
      const metadata = loot.sources.find((source: LootSource) => source.id === reward.id)!;
      expect(hasRaidRewards(metadata, raidRewards.build)).toBe(true);
      for (const difficulty of Object.keys(raidDifficulties) as (keyof typeof raidDifficulties)[]) {
        const dropped = atRaidDifficulty(source, metadata, raidRewards.build, difficulty);
        const maxed = atRaidDifficulty(source, metadata, raidRewards.build, difficulty, true);
        expect(dropped.items.length).toBeGreaterThan(0);
        for (const [i, drop] of dropped.items.entries()) {
          const known = itemUpgradeTrack(drop)!;
          expect(known.rank.rank).toBe(difficulty === 'mythic' && index >= 6 ? 9 : [1, 2, 2, 3, 3, 3, 4, 4][index]);
          expect(known.track.label).toBe({ lfr: 'Veteran', normal: 'Champion', heroic: 'Hero', mythic: 'Myth' }[difficulty]);
          expect(catalog.resolve(drop)?.itemLevel).toBe(known.rank.itemLevel);
          expect(serializeItem(drop)).toContain(`bonus_id=${known.rank.bonusId}`);
          expect(serializeItem(drop)).not.toContain('ilevel=');
          expect(catalog.resolve(maxed.items[i])?.itemLevel).toBeGreaterThanOrEqual(known.rank.itemLevel);
          expect(itemUpgradeTrack(maxed.items[i])?.rank.rank).toBe(index >= 6 && difficulty === 'mythic' ? 9 : 6);
        }
        if (difficulty === 'mythic') mythicLevels.push(catalog.resolve(dropped.items[0])!.itemLevel);
      }
      expect(JSON.stringify(source)).toBe(original);
    }
    expect(mythicLevels).toEqual([318, 321, 321, 324, 324, 324, 344, 344]);
    const source = sources.find(source => source.id === raidRewards.rewards[6].id)!;
    const metadata: LootSource = loot.sources.find((entry: LootSource) => entry.id === source.id)!;
    expect(hasRaidRewards({ ...metadata, seasonId: 999 }, raidRewards.build)).toBe(false);
    expect(hasRaidRewards(metadata, 'future-build')).toBe(false);
    expect(hasRaidRewards({ ...metadata, itemIds: [...metadata.itemIds, 1] }, raidRewards.build)).toBe(false);
    const dropped = atRaidDifficulty(source, metadata, raidRewards.build, 'mythic', true);
    const plan = buildScenarios([dropped], { catalog, character: { classId: 8, raceMaskBit: null, armorSubclass: 1, canDualWield: false, canTitansGrip: false }, baselineGear: new Map(), playerLevel: 90 });
    expect(plan.scenarios.length).toBeGreaterThan(0);
    expect(plan.scenarios.every(scenario => scenario.item.itemLevel === 344)).toBe(true);
  });
  it('maxes each track without changing originals, duplicating max variants or lowering restricted drops', () => {
    const base = catalog.search({ slot: 'head', minQuality: 4, limit: 1 })[0];
    for (const track of upgradeTracks) {
      const original = { ...item, itemId: base.itemId, bonusIds: [track.ranks[0].bonusId], gemIds: [456], enchantId: 123 };
      const maxed = withMaxUpgrade(original)!;
      expect(itemUpgradeTrack(maxed)?.rank.rank).toBe(track.max);
      expect(catalog.resolve(maxed)?.itemLevel).toBe(track.ranks.find(rank => rank.rank === track.max)!.itemLevel);
      expect(maxed).toMatchObject({ vaultRewardId: original.vaultRewardId, originalInstanceId: original.instanceId, gemIds: [456], enchantId: 123 });
      expect(original.bonusIds).toEqual([track.ranks[0].bonusId]);
      expect(withMaxUpgrade(maxed)).toBe(maxed);
      expect(withMaxUpgrade(withItemLevel(original, 1000))?.instanceId).toBe(maxed.instanceId);
      const importedMax = { ...maxed, instanceId: original.instanceId };
      expect(serializeItem(withMaxUpgrade(withItemLevel(importedMax, 1000))!)).toBe(serializeItem(importedMax));
      const reorderedMax = { ...importedMax, bonusIds: [...importedMax.bonusIds, 123] };
      expect(serializeItem(withMaxUpgrade(withItemLevel(reorderedMax, 1000))!)).toBe(serializeItem(reorderedMax));
    }
    const restricted = { ...item, bonusIds: [13848] };
    expect(withMaxUpgrade(restricted)).toBe(restricted);
    expect(itemUpgradeTrack(withMaxUpgrade(withItemLevel(restricted, 1000))!)?.rank.rank).toBe(9);
    expect(withMaxUpgrade({ ...item, bonusIds: [] })).toBeNull();
    expect(withMaxUpgrade({ ...item, craftingQuality: 5 })).toBeNull();
  });

  it('identifies overlapping tracks by bonus, not level, and refuses ambiguous bonuses', () => {
    expect(itemUpgradeTrack({ bonusIds: [12845] })?.track.label).toBe('Hero');
    expect(itemUpgradeTrack({ bonusIds: [12849] })?.track.label).toBe('Myth');
    expect(itemUpgradeTrack({ bonusIds: [12845, 12849] })).toBeNull();
    expect(itemUpgradeTrack({ bonusIds: [] })).toBeNull();
    expect(itemUpgradeTrack({ bonusIds: [12793] })?.track.seasonId).toBe(17);
    expect(itemUpgradeTrack({ bonusIds: [12841, 12841] })?.rank.rank).toBe(1);
  });

  it('resolves every ordinary seasonal rank to exactly the level the engine tables prescribe', () => {
    const baseItem = catalog.search({ slot: 'head', minQuality: 4, limit: 1 })[0];
    expect(baseItem).toBeDefined();
    for (const track of upgradeTracks) {
      expect(track.max).toBe(6);
      for (const rank of track.ranks.filter(rank => !rank.extended)) {
        const upgraded = withUpgradeRank({ ...item, itemId: baseItem.itemId }, track.id, rank.rank);
        expect(catalog.resolve(upgraded)?.itemLevel, `${track.label} ${rank.rank}`).toBe(rank.itemLevel);
        expect(catalog.resolve(upgraded)?.track.step).toBe(rank.rank);
        expect(serializeItem(upgraded)).not.toContain('ilevel=');
      }
    }
  });

  it('preserves physical and Vault identity, gems and extra options when replacing the rank bonus', () => {
    const original = { ...item, bonusIds: [12841, 123], gemIds: [456], extra: { custom: 'unchanged' }, itemLevel: 320 };
    const upgraded = withUpgradeRank(original, 617, 6);
    expect(upgraded).toMatchObject({ originalInstanceId: item.instanceId, vaultRewardId: item.vaultRewardId,
      bonusIds: [123, 12846], gemIds: [456], extra: original.extra, itemLevel: undefined });
    expect(withItemLevel(upgraded, 350).originalInstanceId).toBe(item.instanceId);
    expect(withItemLevel(upgraded, 350).vaultRewardId).toBe(item.vaultRewardId);
    expect(withItemLevel(upgraded, 350).instanceId).not.toBe(upgraded.instanceId);
    expect(withItemLevel({ ...upgraded, gemIds: [999] }, 350).instanceId).not.toBe(withItemLevel(upgraded, 350).instanceId);
    expect(serializeItem(withItemLevel(upgraded, 350))).toContain('ilevel=350');
    expect(withUpgradeRank({ ...item, bonusIds: [] }, 617, 1).upgradeTrackHypothetical).toBe(true);
  });

  it('keeps restricted drops identifiable without treating them as obtainable upgrades', () => {
    const myth = upgradeTracks.find(track => track.label === 'Myth')!;
    expect(myth.ranks.filter(rank => rank.extended).map(rank => rank.itemLevel)).toEqual([337, 340, 344]);
    expect(() => withUpgradeRank(item, myth.id, 9)).toThrow(/ordinary upgrades/);
    const imported = { ...item, bonusIds: [13848] };
    expect(itemUpgradeTrack(imported)?.rank.rank).toBe(9);
    expect(withUpgradeRank(imported, myth.id, 9).bonusIds).toEqual([13848]);
    expect(() => withItemLevel(item, NaN)).toThrow();
    expect(() => withItemLevel(item, 0)).toThrow();
    expect(() => withItemLevel(item, 300.5)).toThrow();
    expect(() => withUpgradeRank({ ...item, craftingQuality: 5 }, 617, 2)).toThrow(/Crafted/);
  });

  it('upgrades the real engine fixture instances without losing the requested rank level', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/mid2-raid-gear.json', 'utf8'));
    let count = 0;
    for (const row of fixture.items) {
      const options = Object.fromEntries(row.encoded.split(',').slice(1).map((part: string) => part.split('=')));
      const imported = { ...item, itemId: Number(options.id), bonusIds: (options.bonus_id ?? '').split(/[/:]/).filter(Boolean).map(Number) };
      const known = itemUpgradeTrack(imported);
      if (!known || known.rank.extended) continue;
      count++;
      const upgraded = withUpgradeRank(imported, known.track.id, known.track.max);
      expect(catalog.resolve(upgraded)?.itemLevel, row.encoded).toBe(known.track.ranks.find(rank => rank.rank === known.track.max)?.itemLevel);
    }
    expect(count).toBeGreaterThan(0);
  });
});
