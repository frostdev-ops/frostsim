import data from './generated/upgrades.json';
import type { ItemInstance } from './types';
import { serializeItem } from './serialize';

export interface UpgradeRank {
  rank: number;
  itemLevel: number;
  bonusId: number;
  /** Client DB2 marks this rank inaccessible to ordinary upgrades. */
  extended: boolean;
}
export interface UpgradeTrack {
  id: number;
  label: string;
  seasonId: number;
  /** Highest ordinary rank; extended drops may exceed max. */
  max: number;
  ranks: UpgradeRank[];
}

export const upgradeSeason = data.season;
export const upgradeBuild = data.build;
/** item_t::decode_ilevel / engine/config.hpp at pinned engine commit. */
export const MAX_ITEM_LEVEL = 1300;
export const upgradeTracks: UpgradeTrack[] = data.tracks.filter(track => track.seasonId === upgradeSeason.id);
const byBonus = new Map(data.tracks.flatMap(track => track.ranks.map(rank => [rank.bonusId, { track, rank }] as const)));

/** Bonus identity decisive; two conflicting track bonuses remain unknown. */
export function itemUpgradeTrack(item: Pick<ItemInstance, 'bonusIds'>): { track: UpgradeTrack; rank: UpgradeRank } | null {
  const matches = [...new Set(item.bonusIds)].flatMap(id => byBonus.has(id) ? [byBonus.get(id)!] : []);
  return matches.length === 1 ? matches[0] : null;
}

/** Item keeps its sockets, enchant, crafting options and physical identity. */
export function withUpgradeRank<T extends ItemInstance>(item: T, trackId: number, rankNumber: number): T {
  if (item.craftingQuality || item.craftedStats?.length) {
    throw Error('Crafted items use crafting quality rather than upgrade tracks. Use a custom item level.');
  }
  const track = data.tracks.find(track => track.id === trackId);
  const rank = track?.ranks.find(rank => rank.rank === rankNumber);
  if (!track || !rank) throw Error('Unknown upgrade track or rank.');
  const original = itemUpgradeTrack(item);
  if (rank.extended && (original?.track.id !== trackId || original.rank.rank !== rankNumber)) {
    throw Error('This rank cannot be reached with ordinary upgrades. Import the item at this rank instead.');
  }
  const originalInstanceId = item.originalInstanceId ?? item.instanceId;
  const upgraded = { ...item, originalInstanceId,
    bonusIds: [...item.bonusIds.filter(id => !byBonus.has(id)), rank.bonusId], itemLevel: undefined,
    upgradeTrackHypothetical: item.upgradeTrackHypothetical || original?.track.id !== trackId };
  upgraded.instanceId = `${originalInstanceId}:upgrade:${serializeItem(upgraded)}`;
  return upgraded;
}

/** Max ordinary rank, preserving already-higher restricted drops; unknown tracks cannot be guessed. */
export function withMaxUpgrade<T extends ItemInstance>(item: T): T | null {
  const known = itemUpgradeTrack(item);
  if (!known || item.craftingQuality || item.craftedStats?.length) return null;
  if (known.rank.rank >= known.track.max) return item.itemLevel === undefined ? item : withItemLevel(item, undefined);
  return withUpgradeRank(item, known.track.id, known.track.max);
}

/** SimC's explicit ilevel option; changes scaling not imported track. */
export function withItemLevel<T extends ItemInstance>(item: T, level: number | undefined): T {
  if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > MAX_ITEM_LEVEL)) {
    throw Error(`Item level must be a whole number from 1 to ${MAX_ITEM_LEVEL}.`);
  }
  const originalInstanceId = item.originalInstanceId ?? item.instanceId;
  const overridden = { ...item, originalInstanceId, itemLevel: level };
  overridden.instanceId = `${originalInstanceId}:upgrade:${serializeItem(overridden)}`;
  return overridden;
}
