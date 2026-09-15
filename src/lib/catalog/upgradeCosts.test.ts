import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyHighWatermark, characterCrests, characterWatermarks, costUnavailable, crestBuild,
  crestCurrencies, crestSeason, effectiveWatermark, seasonStartsAt, seasonWeekIndex,
  seasonCapSource, upgradeStepCost, watermarkSlot, watermarkSlotForGear, watermarkSlots,
  watermarkSource, weeklyCrestCap,
} from './upgradeCosts';
import { GEAR_SLOTS } from './types';
import { upgradeSeason, upgradeTracks } from './upgrades';

const hero = upgradeTracks.find(track => track.label === 'Hero')!;
const heroCrest = crestCurrencies().find(crest => crest.trackId === hero.id)!;

describe('pinned crest cost identity', () => {
  it('agrees with the upgrade identity table it was generated beside', () => {
    const upgrades = JSON.parse(readFileSync('src/lib/catalog/generated/upgrades.json', 'utf8'));
    expect(crestBuild).toBe(upgrades.build);
    expect(crestSeason.id).toBe(upgradeSeason.id);
    for (const track of upgradeTracks) {
      const cost = upgradeStepCost(track.id, 1, track.max);
      expect(cost.unavailable, track.label).toBeUndefined();
      expect(Object.keys(cost.currencies), track.label).toHaveLength(1);
    }
  });

  it('exposes exactly one crest per season track, lowest tier first', () => {
    const list = crestCurrencies();
    expect(list.map(crest => crest.tier)).toEqual(list.map((_, i) => i + 1));
    expect(list.map(crest => crest.trackId)).toEqual(upgradeTracks.map(track => track.id));
    expect(new Set(list.map(crest => crest.id)).size).toBe(list.length);
    for (const crest of list) expect(crest.name).toMatch(/\S/);
  });

  it('reports the season start and the gaps the pinned tables leave', () => {
    expect(seasonStartsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(seasonWeekIndex(Date.parse(seasonStartsAt!))).toBe(0);
    expect(seasonWeekIndex(Date.parse(seasonStartsAt!) + 20 * 864e5)).toBe(2);
    expect(seasonWeekIndex(Date.parse(seasonStartsAt!) - 1)).toBeNull();
    expect(heroCrest.cap.perWeek).toBeNull();
    expect(heroCrest.cap.unavailable.join(' ')).toMatch(/perWeek/);
    expect(costUnavailable.join(' ')).toMatch(/valorstone/i);
  });
});

describe('step cost summation', () => {
  it('sums consecutive steps and charges gold alongside crests', () => {
    const one = upgradeStepCost(hero.id, 1, 2);
    const all = upgradeStepCost(hero.id, 1, hero.max);
    expect(all.currencies[heroCrest.id]).toBe(one.currencies[heroCrest.id] * (hero.max - 1));
    expect(all.money).toBe(one.money * (hero.max - 1));
    expect(all.fromRank).toBe(1);
    expect(all.toRank).toBe(hero.max);
  });

  it('costs nothing for a no-op and splits at any intermediate rank', () => {
    expect(upgradeStepCost(hero.id, 3, 3)).toMatchObject({ currencies: {}, money: 0 });
    const split = upgradeStepCost(hero.id, 1, 3).currencies[heroCrest.id]
      + upgradeStepCost(hero.id, 3, hero.max).currencies[heroCrest.id];
    expect(split).toBe(upgradeStepCost(hero.id, 1, hero.max).currencies[heroCrest.id]);
  });

  it('names an unpriced rank instead of pricing it at zero', () => {
    const beyond = upgradeStepCost(hero.id, hero.max, hero.max + 1);
    expect(beyond.currencies).toEqual({});
    expect(beyond.unavailable?.[0]).toMatch(/ItemExtendedCostID is 0/);
  });

  it('refuses unknown tracks, unknown ranks and backwards ranges', () => {
    expect(() => upgradeStepCost(-1, 1, 2)).toThrow(/Unknown upgrade track/);
    expect(() => upgradeStepCost(hero.id, 1, 99)).toThrow(/Unknown rank/);
    expect(() => upgradeStepCost(hero.id, 4, 2)).toThrow(/whole numbers/);
    expect(() => upgradeStepCost(hero.id, 1.5, 2)).toThrow(/whole numbers/);
  });
});

describe('high watermark waiver', () => {
  const levels = hero.ranks.filter(rank => !rank.extended).map(rank => rank.itemLevel);
  const at = (level: number) => ({ slotIndex: 0, watermarks: [{ slotIndex: 0, current: 0, max: level }] });

  it('waives every crest when the watermark covers the top rank, keeping the gold', () => {
    const cost = upgradeStepCost(hero.id, 1, hero.max);
    const waived = applyHighWatermark(cost, at(levels.at(-1)!), hero.id, hero.max);
    expect(waived.currencies).toEqual({});
    expect(waived.money).toBe(cost.money);
  });

  it('waives only the steps at or below the watermark', () => {
    const cost = upgradeStepCost(hero.id, 1, hero.max);
    const half = applyHighWatermark(cost, at(levels[2]), hero.id, hero.max);
    // Steps into ranks 2 and 3 land at or below the watermark; ranks 4..6 do not.
    const perStep = upgradeStepCost(hero.id, 1, 2).currencies[heroCrest.id];
    expect(half.currencies[heroCrest.id]).toBe(perStep * (hero.max - 3));
  });

  it('waives nothing below the first rank level and never mutates the input', () => {
    const cost = upgradeStepCost(hero.id, 1, hero.max);
    const snapshot = JSON.stringify(cost);
    expect(applyHighWatermark(cost, at(1), hero.id, hero.max).currencies).toEqual(cost.currencies);
    expect(applyHighWatermark(cost, { slotIndex: 9, watermarks: [] }, hero.id, hero.max).currencies)
      .toEqual(cost.currencies);
    expect(JSON.stringify(cost)).toBe(snapshot);
  });

  it('takes the higher of the two recorded levels and refuses a mismatched rank', () => {
    expect(effectiveWatermark({ slotIndex: 14, watermarks: [{ slotIndex: 14, current: 0, max: 298 }] })).toBe(298);
    expect(effectiveWatermark({ slotIndex: 0, watermarks: [{ slotIndex: 0, current: 328, max: 300 }] })).toBe(328);
    const cost = upgradeStepCost(hero.id, 1, hero.max);
    expect(() => applyHighWatermark(cost, at(400), hero.id, 3)).toThrow(/does not match/);
  });
});

describe('watermark slot enumeration', () => {
  it('is Blizzard\'s own Enum.ItemRedundancySlot, contiguous and provenance-stamped', () => {
    expect(watermarkSlots.map(entry => entry.index)).toEqual(watermarkSlots.map((_, i) => i));
    expect(watermarkSlots).toHaveLength(17);
    expect(watermarkSlot(0)).toBe('Head');
    expect(watermarkSlot(16)).toBe('Offhand');
    expect(watermarkSlot(17)).toBeNull();
    expect(watermarkSource.enum?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(watermarkSource.addon?.fields)
      .toEqual(['slotIndex', 'characterHighWatermark', 'accountHighWatermark']);
    expect(watermarkSource.addon?.range).toEqual([0, watermarkSlots.length - 1]);
  });

  it('resolves gear slots into the redundancy groups the enum actually has', () => {
    expect(watermarkSlotForGear('head')).toBe(0);
    expect(watermarkSlotForGear('back')).toBe(11);
    expect(watermarkSlotForGear('hands')).toBe(8);
    // Redundancy: both rings and trinkets share one watermark each.
    expect(watermarkSlotForGear('finger2')).toBe(watermarkSlotForGear('finger1'));
    expect(watermarkSlotForGear('trinket2')).toBe(watermarkSlotForGear('trinket1'));
    // Not covered: no enum entry or ambiguous without weapon class.
    for (const slot of ['shirt', 'tabard', 'main_hand', 'off_hand'] as const) {
      expect(watermarkSlotForGear(slot), slot).toBeNull();
    }
    const resolved = GEAR_SLOTS.filter(slot => watermarkSlotForGear(slot) !== null);
    expect(resolved).toHaveLength(GEAR_SLOTS.length - 4);
  });

  it('drives the waiver straight from a gear slot', () => {
    const cost = upgradeStepCost(hero.id, 1, hero.max);
    const slotIndex = watermarkSlotForGear('head')!;
    const at = { slotIndex, watermarks: [{ slotIndex, current: 0, max: 400 }] };
    expect(applyHighWatermark(cost, at, hero.id, hero.max).currencies).toEqual({});
  });
});

describe('weekly crest cap', () => {
  it('has no published source either, so it stays unavailable without a caller rate', () => {
    // No official Blizzard source for season-18 cap; nothing may substitute fan-site number.
    expect(seasonCapSource).toBeNull();
    expect(costUnavailable.join(' ')).toMatch(/weekly cap/);
    expect(weeklyCrestCap(heroCrest, 0)).toBeNull();
    expect(weeklyCrestCap(heroCrest, 0, { perWeek: 15 })).toBe(15);
    expect(weeklyCrestCap(heroCrest, 3, { perWeek: 15 })).toBe(60);
    expect(weeklyCrestCap(heroCrest, 3, { perWeek: 15, startQuantity: 45 })).toBe(105);
  });

  it('is unbounded once the caller says the cap was removed, and rejects bad weeks', () => {
    expect(weeklyCrestCap(heroCrest, 5, { capRemoved: true })).toBe(Number.POSITIVE_INFINITY);
    expect(weeklyCrestCap(heroCrest, 5, { capRemoved: true, perWeek: 15 })).toBe(Number.POSITIVE_INFINITY);
    expect(() => weeklyCrestCap(heroCrest, -1)).toThrow(/whole number/);
    expect(() => weeklyCrestCap(heroCrest, 1.5, { perWeek: 15 })).toThrow(/whole number/);
  });
});

describe('character wallet', () => {
  it('reads the season crests and per-slot watermarks a real export carries', () => {
    const line = readFileSync('tests/fixtures/addon-export-demonology.simc', 'utf8')
      .split('\n').find(row => row.startsWith('# upgrade_currencies='))!;
    const upgrade = Object.fromEntries(line.split('=')[1].split('/')
      .filter(entry => entry.startsWith('c:'))
      .map(entry => entry.split(':').slice(1).map(Number)));
    const crests = characterCrests({ currencies: { upgrade } });
    expect(Object.keys(crests).map(Number)).toEqual(crestCurrencies().map(crest => crest.id));
    expect(crests[3442]).toBe(39);
    expect(crests[3446]).toBe(0);
    expect(characterCrests({})[heroCrest.id]).toBe(0);
    expect(characterWatermarks({ highWatermarks: [{ slotIndex: 14, current: 0, max: 298 }] })).toEqual({ 14: 298 });
    expect(characterWatermarks({})).toEqual({});
  });
});
