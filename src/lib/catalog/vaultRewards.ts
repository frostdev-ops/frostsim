import type { Catalog } from './catalog';
import { ITEM_BONUS, SOCKET_COLOR } from './enums';
import type { ItemInstance, ResolvedItem } from './types';
import { seasonBuildOf, upgradeBuild, upgradeSeason } from './upgrades';

export const VAULT_SOCKET_REWARD_ID = 'currency:merit:socket';
export const vaultRewardReference = 'https://www.wowhead.com/guide/systems/the-great-vault-weekly-rewards';
// Midnight Season 2: six Merit tokens buy Miasmic Jewelbinder (spell 1297709).
// SimC MID2 profiles encode an added prismatic socket with bonus 1808; re-resolve it below.
// https://www.wowhead.com/spell=1297709/miasmic-jewelbinder
export const vaultCurrencySeason = 18;
export function vaultTokenCount(panes: number): number {
  return Number.isInteger(panes) && panes >= 1 && panes <= 9 ? Math.min(panes, 3) * 2 : 0;
}

/** Unknown season membership stays ineligible; crafted/custom-level items need separate proof. */
export function vaultSocketEligible(item: ResolvedItem): boolean {
  return upgradeSeason.id === vaultCurrencySeason && ['head', 'wrist', 'waist'].includes(item.slot)
    && item.track.currentSeason === true && !item.track.hypothetical && !item.sockets.length
    && !item.gemIds.length && !item.instance.itemLevel
    && !item.descriptors.some(label => /pvp|gladiator|combatant|aspirant/i.test(label));
}

export function vaultSocketVariant(catalog: Catalog, item: ItemInstance, gemId: number, level?: number): ItemInstance | null {
  if (seasonBuildOf(catalog.manifest) !== upgradeBuild || item.source === 'catalog' || item.source === 'hypothetical' || item.vaultRewardId || item.source === 'vault') return null;
  const resolved = catalog.resolve(item, level);
  if (!resolved || !vaultSocketEligible(resolved)
    || item.bonusIds.some(id => catalog.bonus.entriesFor(id).some(([type]) => type === ITEM_BONUS.ILEVEL_IN_PVP))
    || !catalog.gemsFor([SOCKET_COLOR.PRISMATIC]).some(gem => gem.itemId === gemId && (!level || (gem.reqLevel ?? 0) <= level))) return null;
  const extra = { ...item.extra };
  delete extra.gems; delete extra.gem_bonus_id; delete extra.gem_ilevel;
  const variant: ItemInstance = { ...item, extra, originalInstanceId: item.originalInstanceId ?? item.instanceId,
    instanceId: `${item.instanceId}:merit-socket:${gemId}`, vaultRewardId: VAULT_SOCKET_REWARD_ID,
    bonusIds: [...item.bonusIds, 1808], gemIds: [gemId] };
  const socketed = catalog.resolve(variant, level);
  return socketed?.sockets.length === 1 && socketed.itemLevel === resolved.itemLevel ? variant : null;
}
