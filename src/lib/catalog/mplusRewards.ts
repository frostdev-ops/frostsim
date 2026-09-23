import type { LootSource } from './types';
import { upgradeSeason, upgradeTracks, type UpgradeRank, type UpgradeTrack } from './upgrades';

export const mplusRewardReference = 'https://www.wowhead.com/guide/midnight/season-mythic-plus-rewards-loot-drops-mounts-achievements';
/** Season 2 keystone rewards. Bonus rolls (Nebulous Voidcore) share the Great Vault column. Ascending by key. */
const policy = { seasonId: 18, rows: [
  { minKey: 2, endOfRun: ['Champion', 2], vault: ['Hero', 1] },
  { minKey: 4, endOfRun: ['Champion', 3], vault: ['Hero', 2] },
  { minKey: 5, endOfRun: ['Champion', 4], vault: ['Hero', 2] },
  { minKey: 6, endOfRun: ['Hero', 1], vault: ['Hero', 3] },
  { minKey: 7, endOfRun: ['Hero', 1], vault: ['Hero', 4] },
  { minKey: 8, endOfRun: ['Hero', 2], vault: ['Hero', 4] },
  { minKey: 10, endOfRun: ['Hero', 3], vault: ['Myth', 1] },
] as const };
export const MIN_KEY = 2;

export function isMplusSource(source: LootSource): boolean {
  return upgradeSeason.id === policy.seasonId && source.kind === 'dungeon' && source.seasonId === policy.seasonId
    && !!source.difficulties?.includes('Mythic+ Dungeons');
}

/** Track and rank a keystone level awards; null outside the researched season or below +2. */
export function mplusReward(keyLevel: number, bonusRoll: boolean): { track: UpgradeTrack; rank: UpgradeRank } | null {
  if (upgradeSeason.id !== policy.seasonId || !Number.isInteger(keyLevel)) return null;
  const row = policy.rows.findLast(row => row.minKey <= keyLevel);
  if (!row) return null;
  const [label, rankNumber] = bonusRoll ? row.vault : row.endOfRun;
  const track = upgradeTracks.find(track => track.label === label);
  const rank = track?.ranks.find(rank => rank.rank === rankNumber);
  return track && rank ? { track, rank } : null;
}
