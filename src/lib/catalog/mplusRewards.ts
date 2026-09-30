import type { LootSource } from './types';
import type { UpgradeRank, UpgradeTrack } from './upgrades';
import { liveRules, type SeasonRules } from './rules';

export const mplusRewardReference = 'https://www.wowhead.com/guide/midnight/season-mythic-plus-rewards-loot-drops-mounts-achievements';
/** Season 2 keystone rewards. Bonus rolls (Nebulous Voidcore) share the Great Vault column. Ascending by key. */
export const MIN_KEY = 2;

export function isMplusSource(source: LootSource): boolean;
export function isMplusSource(source: LootSource, rules: SeasonRules | null): boolean;
export function isMplusSource(source: LootSource, rules: SeasonRules | null | number = liveRules): boolean {
  if (typeof rules === 'number') rules = liveRules;
  const policy = rules?.mplus;
  return !!policy && rules?.upgrades?.season.id === policy.seasonId && source.kind === 'dungeon' && source.seasonId === policy.seasonId
    && !!source.difficulties?.includes('Mythic+ Dungeons');
}

/** Track and rank a keystone level awards; null outside the researched season or below +2. */
export function mplusReward(keyLevel: number, bonusRoll: boolean, rules: SeasonRules | null = liveRules): { track: UpgradeTrack; rank: UpgradeRank } | null {
  const policy = rules?.mplus;
  if (!policy || rules?.upgrades?.season.id !== policy.seasonId || !Number.isInteger(keyLevel)) return null;
  const row = policy.rows.findLast(row => row.minKey <= keyLevel);
  if (!row) return null;
  const [label, rankNumber] = bonusRoll ? row.vault : row.endOfRun;
  const track = rules.upgrades.tracks.find(track => track.label === label && track.seasonId === policy.seasonId);
  const rank = track?.ranks.find(rank => rank.rank === rankNumber);
  return track && rank ? { track, rank } : null;
}
