import upgrades from './generated/upgrades.json';
import costs from './generated/upgrade-costs.json';
import raid from './generated/raid-rewards.json';
import policy from './generated/reward-policy.json';
import weekly from '../simc/generated/weekly-defaults.json';
import type { EngineChannel } from '../simc/channel';
import { GEAR_SLOTS, type CatalogManifest, type GearSlot } from './types';

export interface SeasonRules {
  schemaVersion: number;
  engineChannel: EngineChannel;
  build: string;
  engineCommit: string;
  upgrades: typeof upgrades | null;
  costs: (Omit<typeof costs, 'seasonCapSource'> & { seasonCapSource: {
    url: string; fetchedAt: string; quote: string; perWeek: number | null; startQuantity: number | null; capRemovedAt: string | null;
  } | null }) | null;
  raid: (typeof raid & { bonusRollRanks: typeof policy.raidBonusRollRanks }) | null;
  mplus: typeof policy.mplus | null;
  vault: typeof policy.vault | null;
  weekly: typeof weekly | null;
  unavailable: string[];
}

/** Legacy local Live data only. Selected packs always pass their own context. */
export const liveRules: SeasonRules = {
  schemaVersion: 1, engineChannel: 'live', build: upgrades.build, engineCommit: upgrades.engineCommit,
  upgrades, costs, raid: { ...raid, bonusRollRanks: policy.raidBonusRollRanks }, mplus: policy.mplus,
  vault: policy.vault, weekly, unavailable: [],
};

export function rulesMatch(rules: SeasonRules, manifest: CatalogManifest): boolean {
  try {
    const channel = manifest.engineChannel ?? manifest.engine.engineChannel ?? 'live';
    const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
    const quantity = (value: unknown) => value === null || Number.isFinite(value) && (value as number) >= 0;
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');
    const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    const rewardRank = (value: unknown) => Array.isArray(value) && value.length === 2
      && typeof value[0] === 'string' && positive(value[1]) && !!rules.upgrades?.tracks.some(track =>
        track.seasonId === rules.upgrades?.season.id && track.label === value[0] && track.ranks.some(rank => rank.rank === value[1]));
    if (rules.schemaVersion !== 1 || rules.engineChannel !== channel || rules.build !== manifest.engine.clientDataVersion
      || rules.engineCommit !== manifest.engine.upstreamCommit || !strings(rules.unavailable)
      || !['upgrades', 'costs', 'raid', 'mplus', 'vault', 'weekly'].every(key => Object.hasOwn(rules, key))) return false;
    if (rules.upgrades !== null && !(rules.upgrades.build === rules.build && Array.isArray(rules.upgrades.tracks)
      && positive(rules.upgrades.season?.id) && typeof rules.upgrades.season.name === 'string'
      && rules.upgrades.tracks.every(track => positive(track.id) && positive(track.max) && positive(track.seasonId)
        && typeof track.label === 'string' && Array.isArray(track.ranks) && track.ranks.some(rank => rank.rank === track.max)
        && track.ranks.every(rank => positive(rank.rank) && positive(rank.bonusId) && positive(rank.itemLevel) && typeof rank.extended === 'boolean')))) return false;
    if (rules.costs !== null && !(rules.costs.build === rules.build && Array.isArray(rules.costs.crests)
      && Array.isArray(rules.costs.tracks) && strings(rules.costs.unavailable) && Array.isArray(rules.costs.watermarkSlots)
      && rules.costs.watermarkSlots.every(slot => Number.isInteger(slot.index) && slot.index >= 0 && typeof slot.name === 'string')
      && rules.costs.season?.id === rules.upgrades?.season.id
      && (rules.costs.season.startsAt === null || Number.isFinite(Date.parse(rules.costs.season.startsAt)))
      && rules.costs.crests.every(crest => positive(crest.id) && positive(crest.tier) && positive(crest.trackId)
        && typeof crest.name === 'string' && typeof crest.trackLabel === 'string' && record(crest.cap)
        && (['maxQty', 'perWeek', 'startQuantity', 'rechargeAmount', 'cycleMs', 'maxQtyWorldStateId'] as const).every(key => quantity(crest.cap[key]))
        && strings(crest.cap.unavailable))
      && rules.costs.tracks.every(track => positive(track.trackId) && Array.isArray(track.steps)
        && track.steps.every(step => positive(step.fromRank) && step.toRank === step.fromRank + 1 && positive(step.itemLevel)
          && quantity(step.money) && (step.currencies === null ? strings(step.unavailable)
            : record(step.currencies) && step.money !== null && Object.entries(step.currencies).every(([id, count]) =>
              positive(Number(id)) && Number.isInteger(count) && count >= 0))))
      && (rules.costs.seasonCapSource === null || record(rules.costs.seasonCapSource)
        && quantity(rules.costs.seasonCapSource.perWeek) && quantity(rules.costs.seasonCapSource.startQuantity)
        && (rules.costs.seasonCapSource.capRemovedAt === null || Number.isFinite(Date.parse(rules.costs.seasonCapSource.capRemovedAt)))))) return false;
    const bonuses = new Set(rules.upgrades?.tracks.filter(track => track.seasonId === rules.upgrades?.season.id)
      .flatMap(track => track.ranks.map(rank => rank.bonusId)) ?? []);
    const difficulties = ['lfr', 'normal', 'heroic', 'mythic'] as const;
    if (rules.raid !== null && !(rules.raid.build === rules.build && Array.isArray(rules.raid.rewards)
      && rules.raid.seasonId === rules.upgrades?.season.id && record(rules.raid.bonusRollRanks)
      && difficulties.every(key => rewardRank(rules.raid!.bonusRollRanks[key]))
      && rules.raid.rewards.every(reward => typeof reward.id === 'string' && typeof reward.name === 'string'
        && positive(reward.instanceId) && Array.isArray(reward.ignoredItemIds) && reward.ignoredItemIds.every(positive)
        && record(reward.byDifficulty) && difficulties.every(key => record(reward.byDifficulty[key])
          && Object.keys(reward.byDifficulty[key]).length === Object.keys(reward.byDifficulty.heroic).length
          && Object.keys(reward.byDifficulty.heroic).every(id => Object.hasOwn(reward.byDifficulty[key], id))
          && Object.entries(reward.byDifficulty[key]).every(([id, bonus]) => positive(Number(id)) && bonuses.has(bonus)))))) return false;
    if (rules.mplus !== null && !(rules.mplus.seasonId === rules.upgrades?.season.id && Array.isArray(rules.mplus.rows)
      && typeof rules.mplus.reference === 'string' && rules.mplus.rows.every((row, index, rows) => positive(row.minKey)
        && (!index || row.minKey > rows[index - 1].minKey) && rewardRank(row.endOfRun) && rewardRank(row.vault)))) return false;
    if (rules.vault !== null && !(rules.vault.seasonId === rules.upgrades?.season.id && strings(rules.vault.socketSlots)
      && rules.vault.socketSlots.every(slot => GEAR_SLOTS.includes(slot as GearSlot))
      && positive(rules.vault.socketBonusId) && positive(rules.vault.socketCost)
      && positive(rules.vault.tokenPerPane) && positive(rules.vault.maxTokenPanes) && rules.vault.maxTokenPanes <= 9
      && typeof rules.vault.reference === 'string')) return false;
    if (rules.weekly !== null && !(Array.isArray(rules.weekly.rules) && rules.weekly.engine?.commit === rules.engineCommit
      && typeof rules.weekly.weekly?.commit === 'string' && typeof rules.weekly.weekly.source === 'string'
      && rules.weekly.rules.every(rule => typeof rule.class === 'string' && typeof rule.spec === 'string'
        && positive(rule.minLevel) && typeof rule.option === 'string' && /^[\w.]+$/.test(rule.option)
        && typeof rule.value === 'string' && /^[a-z0-9_:]+$/.test(rule.value)))) return false;
    return true;
  } catch { return false; }
}

export function rulesUnavailable(rules: SeasonRules | null, section: 'upgrades' | 'costs' | 'raid' | 'mplus' | 'vault' | 'weekly'): string | null {
  return rules?.[section] ? null : `Verified ${rules?.engineChannel === 'ptr' ? 'PTR' : 'selected engine'} ${section} data is unavailable for this pack.`;
}
