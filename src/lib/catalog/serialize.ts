// ItemInstance -> simc profile option line. Keys/separators from item_t::parse_options (vendor/simc/engine/item/item.cpp): bonus_id on "/""/":"", gem_id on ":""/", crafted_stats on "/", enchant_id unsigned.

import type { GearSlot, ItemInstance } from './types';

/** Option keys this module owns; anything else in `extra` is passed through untouched. */
const OWNED_KEYS = new Set([
  'id', 'bonus_id', 'gem_id', 'enchant_id', 'crafted_stats', 'crafting_quality',
  'redirected_base_stats', 'content_tuning', 'drop_level', 'ilevel',
]);

export class SerializeError extends Error {}

function requireUnsigned(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new SerializeError(`${what} must be a non-negative integer, got ${value}`);
  }
  return value;
}

/** Leading token in slot=name,id=... (REQUIRED: item_t::parse_options takes everything before first comma as name; missing token = slot empty). */
export function itemToken(name: string | undefined, itemId: number): string {
  const t = (name ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return t || `item_${itemId}`;
}

export interface SerializeOptions {
  /** Readable name for leading token (absent = item_<id>); APL use_item,name=... needs the real one. */
  name?: string;
  /** Override instance's ilevel=; only for explicitly hypothetical items. */
  itemLevel?: number;
}

/** Serialize item instance to its slot=... profile line. */
export function serializeItem(instance: ItemInstance, opts: SerializeOptions = {}): string {
  const parts: string[] = [];
  parts.push(`id=${requireUnsigned(instance.itemId, 'item id')}`);

  if (instance.bonusIds?.length) {
    // Order preserved: part of item identity for cache keys and round-tripping.
    parts.push(`bonus_id=${instance.bonusIds.map((b) => requireUnsigned(b, 'bonus id')).join('/')}`);
  }
  if (instance.gemIds?.length && instance.gemIds.some((g) => g !== 0)) {
    parts.push(`gem_id=${instance.gemIds.map((g) => requireUnsigned(g, 'gem id')).join('/')}`);
  }
  if (instance.enchantId) parts.push(`enchant_id=${requireUnsigned(instance.enchantId, 'enchant id')}`);
  if (instance.craftedStats?.length) {
    parts.push(`crafted_stats=${instance.craftedStats.map((s) => requireUnsigned(s, 'crafted stat')).join('/')}`);
  }
  if (instance.craftingQuality) parts.push(`crafting_quality=${requireUnsigned(instance.craftingQuality, 'crafting quality')}`);
  if (instance.redirectedBaseStats) parts.push(`redirected_base_stats=${requireUnsigned(instance.redirectedBaseStats, 'redirected base stats')}`);
  if (instance.contentTuning) parts.push(`content_tuning=${requireUnsigned(instance.contentTuning, 'content tuning')}`);
  if (instance.dropLevel) parts.push(`drop_level=${requireUnsigned(instance.dropLevel, 'drop level')}`);
  const ilevel = opts.itemLevel ?? instance.itemLevel;
  if (ilevel !== undefined) parts.push(`ilevel=${requireUnsigned(ilevel, 'item level')}`);

  for (const [k, v] of Object.entries(instance.extra ?? {})) {
    if (OWNED_KEYS.has(k)) continue;
    if (/[,\n\r=]/.test(k) || /[,\n\r]/.test(v)) {
      throw new SerializeError(`unsafe passthrough option ${k}=${v}`);
    }
    parts.push(`${k}=${v}`);
  }

  return `${instance.slot}=${itemToken(opts.name ?? instance.addonName, instance.itemId)},${parts.join(',')}`;
}

/** Empty slot must be written explicitly, or baseline's item stays equipped. */
export function serializeEmptySlot(slot: GearSlot): string {
  return `${slot}=`;
}

/** Whole gear set as profile lines in stable slot order (identical sets = byte-identical text = same cache key). */
export function serializeGear(
  items: Map<GearSlot, ItemInstance | null>,
  slots: readonly GearSlot[],
  names?: Map<number, string>,
): string[] {
  const lines: string[] = [];
  for (const slot of slots) {
    if (!items.has(slot)) continue;
    const it = items.get(slot);
    lines.push(it ? serializeItem(it, { name: names?.get(it.itemId) }) : serializeEmptySlot(slot));
  }
  return lines;
}
