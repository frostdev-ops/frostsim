// Character -> simc profile text (inverse of character.ts). Profileset names: no '=' or '"', use generated id (P07.2).

import { GEAR_SLOTS, type GearSlot, type ImportedCharacter, type ItemInstance } from './character'

export interface ProfileOverrides {
  /** Replace the active talent string. */
  talents?: string
  /** Replace (or, with null, empty) a slot. Slots absent here are untouched. */
  items?: Partial<Record<GearSlot, ItemInstance | null>>
  /** Raw lines inserted before the character's own lines (Expert Mode header). */
  prepend?: string[]
  /** Raw lines appended after the character's own lines (APL, overrides). */
  append?: string[]
}

// Rebuild item's simc option string from parsed instance.
export function itemOptions(item: ItemInstance): string {
  const written: Record<string, string | undefined> = {
    id: `${item.itemId}`,
    enchant_id: item.enchantId !== undefined ? `${item.enchantId}` : undefined,
    gem_id: item.gemIds.length ? item.gemIds.join('/') : undefined,
    bonus_id: item.bonusIds.length ? item.bonusIds.join('/') : undefined,
    crafted_stats: item.craftedStats?.length ? item.craftedStats.join('/') : undefined,
    crafting_quality: item.craftingQuality !== undefined ? `${item.craftingQuality}` : undefined,
    content_tuning: item.contentTuning !== undefined ? `${item.contentTuning}` : undefined,
    ilevel: item.itemLevel !== undefined ? `${item.itemLevel}` : undefined,
    drop_level: item.dropLevel !== undefined ? `${item.dropLevel}` : undefined,
    redirected_base_stats:
      item.redirectedBaseStats !== undefined ? `${item.redirectedBaseStats}` : undefined,
    ...item.extra,
  }
  // Emit in export order so untouched items reproduce byte-for-byte; new at end.
  const keys = [
    ...item.optionOrder.filter((k) => written[k] !== undefined),
    ...Object.keys(written).filter((k) => written[k] !== undefined && !item.optionOrder.includes(k)),
  ]
  return ['', ...keys.map((k) => `${k}=${written[k]}`)].join(',')
}

export function itemLine(slot: GearSlot, item: ItemInstance | null): string {
  return item ? `${slot}=${itemOptions(item)}` : `${slot}=`
}

// Key an executable line assigns to, lowercased, or null.
function lineKey(line: string): string | null {
  const eq = line.indexOf('=')
  if (eq < 1) return null
  const key = line.slice(0, eq).trim()
  return (key.endsWith('+') ? key.slice(0, -1) : key).toLowerCase()
}

// Rebuild full profile; untouched lines keep original text and position (simc depends on order).
export function buildProfile(c: ImportedCharacter, o: ProfileOverrides = {}): string {
  const replacedSlots = new Set(Object.keys(o.items ?? {}) as GearSlot[])
  const out: string[] = [...(o.prepend ?? [])]
  let talentsWritten = false

  for (const line of c.profileLines) {
    const key = lineKey(line)
    if (!key) { out.push(line); continue }
    if (key === 'talents' && o.talents !== undefined) {
      out.push(`talents=${o.talents}`)
      talentsWritten = true
      continue
    }
    const slot = slotOf(key)
    if (slot && replacedSlots.has(slot)) {
      out.push(itemLine(slot, o.items![slot] ?? null))
      replacedSlots.delete(slot)
      continue
    }
    out.push(line)
  }

  // A slot the original profile never mentioned still has to be equipped.
  for (const slot of GEAR_SLOTS) {
    if (replacedSlots.has(slot)) out.push(itemLine(slot, o.items![slot] ?? null))
  }
  if (o.talents !== undefined && !talentsWritten) out.push(`talents=${o.talents}`)

  out.push(...(o.append ?? []))
  return out.join('\n') + '\n'
}

const SLOT_SET = new Set<string>(GEAR_SLOTS)
const ALIAS_TO_SLOT: Record<string, GearSlot> = {
  shoulders: 'shoulder', wrists: 'wrist', ring1: 'finger1', ring2: 'finger2',
  leg: 'legs', foot: 'feet', hand: 'hands',
}
function slotOf(key: string): GearSlot | null {
  if (SLOT_SET.has(key)) return key as GearSlot
  return ALIAS_TO_SLOT[key] ?? null
}

// Bare option lines for ProfilesetSpec.lines; engine adds profileset."<id>"+= prefix.
export function overrideLines(overrides: ProfileOverrides): string[] {
  const body: string[] = []
  if (overrides.talents !== undefined) body.push(`talents=${overrides.talents}`)
  for (const [slot, item] of Object.entries(overrides.items ?? {})) {
    body.push(itemLine(slot as GearSlot, item ?? null))
  }
  body.push(...(overrides.append ?? []))
  return body
}

// Lines for profileset."id" variant with prefix; id must be engine-safe (no =, ", or whitespace).
export function profilesetLines(id: string, overrides: ProfileOverrides): string[] {
  return overrideLines(overrides).map((line) => `profileset."${id}"+=${line}`)
}

// Engine-safe, stable, label-independent. No =, ", or whitespace.
export function candidateId(index: number, prefix = 'c'): string {
  return `${prefix}${index}`
}

// Stopping options inherited from paste; end runs silently in fixed-iter mode, so surface them (P01.10).
const STOPPING_OPTIONS = new Set(['target_error', 'iterations', 'max_time', 'fight_style'])
export function inheritedRunOptions(c: ImportedCharacter): { key: string; value: string; lineNumber: number }[] {
  return c.unmodelled.filter((u) => STOPPING_OPTIONS.has(u.key))
}
