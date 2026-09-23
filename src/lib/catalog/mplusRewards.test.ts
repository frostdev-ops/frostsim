import { describe, expect, it } from 'vitest';
import { isMplusSource, mplusReward } from './mplusRewards';
import type { LootSource } from './types';

describe('Mythic+ keystone rewards', () => {
  it('maps key levels to end-of-dungeon and bonus roll (Great Vault) levels', () => {
    const expected: [number, number, number][] = [[2, 295, 305], [3, 295, 305], [4, 298, 308], [5, 302, 308],
      [6, 305, 311], [7, 305, 315], [9, 308, 315], [10, 311, 318], [15, 311, 318]];
    for (const [key, endOfRun, bonusRoll] of expected) {
      expect(mplusReward(key, false)?.rank.itemLevel, `+${key}`).toBe(endOfRun);
      expect(mplusReward(key, true)?.rank.itemLevel, `+${key} bonus`).toBe(bonusRoll);
    }
    expect(mplusReward(10, true)?.track.label).toBe('Myth');
    expect(mplusReward(1, true)).toBeNull();
    expect(mplusReward(Number.NaN, true)).toBeNull();
  });
  it('accepts only current-season Mythic+ dungeons', () => {
    const dungeon: LootSource = { id: 'd', kind: 'dungeon', seasonId: 18, name: 'Boss', itemIds: [], provider: 'test',
      difficulties: ['Normal', 'Heroic', 'Mythic', 'Mythic+ Dungeons'] };
    expect(isMplusSource(dungeon)).toBe(true);
    expect(isMplusSource({ ...dungeon, seasonId: 17 })).toBe(false);
    expect(isMplusSource({ ...dungeon, kind: 'raid' })).toBe(false);
    expect(isMplusSource({ ...dungeon, difficulties: ['Mythic'] })).toBe(false);
  });
});
