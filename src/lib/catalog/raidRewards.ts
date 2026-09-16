import data from './generated/raid-rewards.json';
import type { LootSource } from './types';
import type { DropSource } from '../optimization/droptimizer';
import { itemUpgradeTrack, upgradeBuild, withMaxUpgrade } from './upgrades';

export const raidDifficulties = { lfr: 'Raid Finder', normal: 'Normal', heroic: 'Heroic', mythic: 'Mythic' };
export type RaidDifficulty = keyof typeof raidDifficulties;
export const raidRewardReferences = data.policy.references;
const rewards = new Map(data.rewards.map(row => [row.id, row]));

/** Missing/new sources or items require a refreshed mapping, never a guessed rank. */
export function hasRaidRewards(source: LootSource, build: string | undefined): boolean {
  const reward = rewards.get(source.id);
  return !!reward && build === data.build && upgradeBuild === data.build && source.kind === 'raid'
    && source.seasonId === data.seasonId && source.instanceId === reward.instanceId
    && source.itemIds.every(id => Object.hasOwn(reward.byDifficulty.heroic, id) || reward.ignoredItemIds.includes(id));
}

export function atRaidDifficulty(source: DropSource, loot: LootSource, build: string | undefined,
  difficulty: RaidDifficulty, maxUpgrade = false): DropSource {
  if (source.id !== loot.id || !hasRaidRewards(loot, build)) throw Error(`Verified raid reward levels are unavailable for ${loot.name}.`);
  const reward = rewards.get(loot.id)!;
  const bonuses: Record<string, number | undefined> = reward.byDifficulty[difficulty];
  if (!bonuses) throw Error('Unknown raid difficulty.');
  return { ...source, hypothetical: true,
    label: `${source.label} (${raidDifficulties[difficulty]}${maxUpgrade ? ', fully upgraded' : ''})`,
    items: source.items.filter(item => !reward.ignoredItemIds.includes(item.itemId)).map(item => {
      const bonusId = bonuses[item.itemId];
      if (!bonusId || !loot.itemIds.includes(item.itemId)) throw Error(`Unverified raid reward: ${item.itemId}`);
      const drop = { ...item, instanceId: `${item.instanceId}:raid:${difficulty}`, bonusIds: [bonusId],
        itemLevel: undefined, upgradeTrackHypothetical: false };
      return maxUpgrade ? withMaxUpgrade(drop)! : drop;
    }),
  };
}

export function raidRewardLabel(source: LootSource, difficulty: RaidDifficulty, maxUpgrade = false): string {
  const bonuses = rewards.get(source.id)?.byDifficulty[difficulty];
  if (!bonuses) return 'Reward levels unavailable';
  return [...new Set(Object.values(bonuses).map(bonusId => {
    const known = itemUpgradeTrack({ bonusIds: [bonusId] })!;
    const rank = maxUpgrade && known.rank.rank < known.track.max
      ? known.track.ranks.find(rank => rank.rank === known.track.max)! : known.rank;
    return `${known.track.label} ${rank.rank}/${known.track.max} · ${rank.itemLevel}`;
  }))].join(' / ');
}
