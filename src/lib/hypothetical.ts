// Items not owned, added by hand. Marked so UI never presents as actually owned (P08.2).

import type { GearSlot, ItemInstance } from './import/character'

export interface HypotheticalInput {
  itemId: number
  slot: GearSlot
  /** The `ilevel=` override. Absent means "whatever the bonus ids compute". */
  itemLevel?: number
  bonusIds?: number[]
  gemIds?: number[]
  enchantId?: number
  craftedStats?: number[]
  craftingQuality?: number
}

export function hypotheticalItem(input: HypotheticalInput): ItemInstance {
  const bonusIds = input.bonusIds ?? []
  const gemIds = input.gemIds ?? []
  const optionOrder = [
    'id',
    ...(input.enchantId !== undefined ? ['enchant_id'] : []),
    ...(gemIds.length ? ['gem_id'] : []),
    ...(bonusIds.length ? ['bonus_id'] : []),
    ...(input.craftedStats?.length ? ['crafted_stats'] : []),
    ...(input.craftingQuality !== undefined ? ['crafting_quality'] : []),
    ...(input.itemLevel !== undefined ? ['ilevel'] : []),
  ]
  const instanceId = [
    'hyp', input.slot, input.itemId, bonusIds.join('.'), gemIds.join('.'),
    input.enchantId ?? '', input.itemLevel ?? '',
  ].join(':')

  const item: ItemInstance = {
    instanceId,
    source: 'hypothetical',
    slot: input.slot,
    itemId: input.itemId,
    bonusIds,
    gemIds,
    enchantId: input.enchantId,
    craftedStats: input.craftedStats,
    craftingQuality: input.craftingQuality,
    itemLevel: input.itemLevel,
    extra: {},
    optionOrder,
    line: '',
    lineNumber: 0,
  }
  return item
}

// Relevant item levels for invented item, anchored to its own level, clamped to game range.
export function itemLevelChoices(base: number, span = 5, step = 6): number[] {
  if (!Number.isFinite(base) || base <= 0) return []
  const out: number[] = []
  for (let i = -span; i <= span; i++) {
    const level = base + i * step
    if (level >= 1 && level <= 1000) out.push(level)
  }
  return out
}

export function isHypothetical(item: ItemInstance): boolean {
  return item.source === 'hypothetical' || item.source === 'catalog' ||
    item.upgradeTrackHypothetical === true ||
    (item.originalInstanceId !== undefined && (item.itemLevel !== undefined || item.instanceId !== item.originalInstanceId))
}
