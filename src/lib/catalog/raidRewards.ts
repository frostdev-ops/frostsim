import data from './generated/raid-rewards.json';
import type { LootSource } from './types';
import type { DropSource } from '../optimization/droptimizer';
import { itemUpgradeTrack, withMaxUpgrade } from './upgrades';
import { liveRules, type SeasonRules } from './rules';

export const raidDifficulties = { lfr: 'Raid Finder', normal: 'Normal', heroic: 'Heroic', mythic: 'Mythic' };
export type RaidDifficulty = keyof typeof raidDifficulties;
const bonusRollReference = 'https://www.wowhead.com/guide/midnight/bonus-rolls-item-upgrades';
export const raidRewardReferences = [...data.policy.references, bonusRollReference];
/** Season 2 bonus rolls (Nebulous Voidcore) drop at the raid Great Vault level, the same for every boss. */

/** Missing/new sources or items require a refreshed mapping, never a guessed rank. */
export function hasRaidRewards(source: LootSource, build: string | undefined, rules: SeasonRules | null = liveRules): boolean {
  const data = rules?.raid;
  const reward = data?.rewards.find(row => row.id === source.id);
  return !!data && !!reward && build === data.build && rules?.upgrades?.build === data.build && source.kind === 'raid'
    && source.seasonId === data.seasonId && source.instanceId === reward.instanceId
    && source.itemIds.every(id => Object.hasOwn(reward.byDifficulty.heroic, id) || reward.ignoredItemIds.includes(id));
}

/** Drops already above the ordinary max (Mythic final bosses, Very Rare) stay there. */
function bonusRollBonus(difficulty: RaidDifficulty, dropBonusId: number, rules: SeasonRules): number {
  const drop = itemUpgradeTrack({ bonusIds: [dropBonusId] }, rules);
  if (!drop || !rules.raid) throw Error('Verified raid upgrade data is unavailable.');
  if (drop.rank.rank > drop.track.max) return dropBonusId;
  const [label, rank] = rules.raid.bonusRollRanks[difficulty];
  const bonusId = rules.upgrades?.tracks.find(track => track.label === label && track.seasonId === rules.upgrades?.season.id)?.ranks.find(step => step.rank === rank)?.bonusId;
  if (!bonusId) throw Error(`Unknown bonus roll track: ${label} ${rank}`);
  return bonusId;
}

export function atRaidDifficulty(source: DropSource, loot: LootSource, build: string | undefined,
  difficulty: RaidDifficulty, maxUpgrade = false, bonusRoll = false, rules: SeasonRules | null = liveRules): DropSource {
  if (!rules || source.id !== loot.id || !hasRaidRewards(loot, build, rules)) throw Error(`Verified raid reward levels are unavailable for ${loot.name}.`);
  const reward = rules.raid!.rewards.find(row => row.id === loot.id)!;
  const bonuses: Record<string, number | undefined> = reward.byDifficulty[difficulty];
  if (!bonuses) throw Error('Unknown raid difficulty.');
  return { ...source, hypothetical: true,
    label: `${source.label} (${raidDifficulties[difficulty]}${bonusRoll ? ', bonus roll' : ''}${maxUpgrade ? ', fully upgraded' : ''})`,
    items: source.items.filter(item => !reward.ignoredItemIds.includes(item.itemId)).map(item => {
      const bonusId = bonuses[item.itemId];
      if (!bonusId || !loot.itemIds.includes(item.itemId)) throw Error(`Unverified raid reward: ${item.itemId}`);
      const drop = { ...item, instanceId: `${item.instanceId}:raid:${difficulty}${bonusRoll ? ':bonus' : ''}`,
        bonusIds: [bonusRoll ? bonusRollBonus(difficulty, bonusId, rules) : bonusId],
        itemLevel: undefined, upgradeTrackHypothetical: false };
      return maxUpgrade ? withMaxUpgrade(drop, rules)! : drop;
    }),
  };
}

export function raidRewardLabel(source: LootSource, difficulty: RaidDifficulty, maxUpgrade = false, bonusRoll = false, rules: SeasonRules | null = liveRules): string {
  const bonuses = rules?.raid?.rewards.find(row => row.id === source.id)?.byDifficulty[difficulty];
  if (!bonuses) return 'Reward levels unavailable';
  return [...new Set(Object.values(bonuses).map(bonusId => {
    const known = itemUpgradeTrack({ bonusIds: [bonusRoll ? bonusRollBonus(difficulty, bonusId, rules!) : bonusId] }, rules)!;
    const rank = maxUpgrade && known.rank.rank < known.track.max
      ? known.track.ranks.find(rank => rank.rank === known.track.max)! : known.rank;
    return `${known.track.label} ${rank.rank}/${known.track.max} · ${rank.itemLevel}`;
  }))].join(' / ');
}
