import data from './generated/raid-rewards.json';
import type { LootSource } from './types';
import type { DropSource } from '../optimization/droptimizer';
import { itemUpgradeTrack, upgradeBuild, upgradeTracks, withMaxUpgrade } from './upgrades';

export const raidDifficulties = { lfr: 'Raid Finder', normal: 'Normal', heroic: 'Heroic', mythic: 'Mythic' };
export type RaidDifficulty = keyof typeof raidDifficulties;
const bonusRollReference = 'https://www.wowhead.com/guide/midnight/bonus-rolls-item-upgrades';
export const raidRewardReferences = [...data.policy.references, bonusRollReference];
/** Season 2 bonus rolls (Nebulous Voidcore) drop at the raid Great Vault level, the same for every boss. */
const bonusRollRanks: Record<RaidDifficulty, [string, number]> = {
  lfr: ['Champion', 1], normal: ['Hero', 1], heroic: ['Myth', 1], mythic: ['Myth', 6] };
const rewards = new Map(data.rewards.map(row => [row.id, row]));

/** Missing/new sources or items require a refreshed mapping, never a guessed rank. */
export function hasRaidRewards(source: LootSource, build: string | undefined): boolean {
  const reward = rewards.get(source.id);
  return !!reward && build === data.build && upgradeBuild === data.build && source.kind === 'raid'
    && source.seasonId === data.seasonId && source.instanceId === reward.instanceId
    && source.itemIds.every(id => Object.hasOwn(reward.byDifficulty.heroic, id) || reward.ignoredItemIds.includes(id));
}

/** Drops already above the ordinary max (Mythic final bosses, Very Rare) stay there. */
function bonusRollBonus(difficulty: RaidDifficulty, dropBonusId: number): number {
  const drop = itemUpgradeTrack({ bonusIds: [dropBonusId] })!;
  if (drop.rank.rank > drop.track.max) return dropBonusId;
  const [label, rank] = bonusRollRanks[difficulty];
  const bonusId = upgradeTracks.find(track => track.label === label)?.ranks.find(step => step.rank === rank)?.bonusId;
  if (!bonusId) throw Error(`Unknown bonus roll track: ${label} ${rank}`);
  return bonusId;
}

export function atRaidDifficulty(source: DropSource, loot: LootSource, build: string | undefined,
  difficulty: RaidDifficulty, maxUpgrade = false, bonusRoll = false): DropSource {
  if (source.id !== loot.id || !hasRaidRewards(loot, build)) throw Error(`Verified raid reward levels are unavailable for ${loot.name}.`);
  const reward = rewards.get(loot.id)!;
  const bonuses: Record<string, number | undefined> = reward.byDifficulty[difficulty];
  if (!bonuses) throw Error('Unknown raid difficulty.');
  return { ...source, hypothetical: true,
    label: `${source.label} (${raidDifficulties[difficulty]}${bonusRoll ? ', bonus roll' : ''}${maxUpgrade ? ', fully upgraded' : ''})`,
    items: source.items.filter(item => !reward.ignoredItemIds.includes(item.itemId)).map(item => {
      const bonusId = bonuses[item.itemId];
      if (!bonusId || !loot.itemIds.includes(item.itemId)) throw Error(`Unverified raid reward: ${item.itemId}`);
      const drop = { ...item, instanceId: `${item.instanceId}:raid:${difficulty}${bonusRoll ? ':bonus' : ''}`,
        bonusIds: [bonusRoll ? bonusRollBonus(difficulty, bonusId) : bonusId],
        itemLevel: undefined, upgradeTrackHypothetical: false };
      return maxUpgrade ? withMaxUpgrade(drop)! : drop;
    }),
  };
}

export function raidRewardLabel(source: LootSource, difficulty: RaidDifficulty, maxUpgrade = false, bonusRoll = false): string {
  const bonuses = rewards.get(source.id)?.byDifficulty[difficulty];
  if (!bonuses) return 'Reward levels unavailable';
  return [...new Set(Object.values(bonuses).map(bonusId => {
    const known = itemUpgradeTrack({ bonusIds: [bonusRoll ? bonusRollBonus(difficulty, bonusId) : bonusId] })!;
    const rank = maxUpgrade && known.rank.rank < known.track.max
      ? known.track.ranks.find(rank => rank.rank === known.track.max)! : known.rank;
    return `${known.track.label} ${rank.rank}/${known.track.max} · ${rank.itemLevel}`;
  }))].join(' / ');
}
