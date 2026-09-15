// Item display: one place decides name and whether verified game data or addon comment. Resolution memoised per catalog (gear screens re-render often, resolution walks tables and curves).

import { STAT_LABEL } from './catalog/enums'
import type { ResolvedItem } from './catalog/types'
import type { ItemInstance } from './import/character'

export interface DisplayItem {
  name: string
  itemLevel?: number
  quality?: number
  qualityLabel?: string
  /** True when name and item level came from export's comment, not catalog. */
  unverified: boolean
  descriptors: string[]
  /** "2,481 Intellect · 1,033 Haste", or empty when stats could not be scaled (e.g. "2,481 Intellect · 1,033 Haste" or empty). */
  stats: string
  socketCount: number
  hasEnchant: boolean
  resolved: ResolvedItem | null
  /** Fields catalog could not derive, for UI to state plainly. */
  unresolved: string[]
}

/** Resolution happens once per character in catalog worker; this reads result. Anything catalog could not resolve is absent, never faked. */
export function resolveItem(
  item: ItemInstance,
  resolved: ReadonlyMap<string, ResolvedItem>,
): ResolvedItem | null {
  return resolved.get(item.instanceId) ?? null
}

const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

export function display(
  item: ItemInstance,
  resolvedItems: ReadonlyMap<string, ResolvedItem>,
  catalogLoaded = resolvedItems.size > 0,
): DisplayItem {
  const resolved = resolveItem(item, resolvedItems)
  if (!resolved) {
    return {
      name: item.addonName ?? `Item ${item.itemId}`,
      itemLevel: item.addonItemLevel,
      unverified: true,
      descriptors: [],
      stats: '',
      socketCount: item.gemIds.filter(Boolean).length,
      hasEnchant: item.enchantId !== undefined,
      resolved: null,
      unresolved: catalogLoaded ? [`item ${item.itemId} is not in this catalog`] : [],
    }
  }
  const stats = resolved.stats
    .filter((s) => s.value !== null && s.value > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 4)
    .map((s) => `${fmt.format(s.value!)} ${s.label ?? `stat ${s.type}`}`)
    .join(' · ')

  return {
    name: resolved.name,
    itemLevel: resolved.itemLevel,
    quality: resolved.quality,
    qualityLabel: resolved.qualityLabel,
    unverified: false,
    descriptors: resolved.descriptors,
    stats,
    socketCount: resolved.sockets.length,
    hasEnchant: resolved.enchantId !== null,
    resolved,
    unresolved: resolved.unresolved,
  }
}

export { STAT_LABEL }
