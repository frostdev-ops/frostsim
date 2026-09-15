// Items sent between screens with EXACT instance: Droptimizer -> Top Gear/Compare for interaction testing (P09.10).

import type { GearSlot, ItemInstance } from './import/character'
import type { SettingsSnapshot } from './settings.svelte'

export interface HandoffItem {
  /** The item exactly as the sending screen had it. Never re-derived. */
  item: ItemInstance
  /** The slot the receiving screen should offer it for. */
  slot: GearSlot
  /** Where it came from, in words, so the receiver can say so. */
  source: string
  /** Which character it was chosen for; a handoff never crosses characters. */
  characterId: string | null
}

export type HandoffTarget = 'gear' | 'compare'

// One pending handoff per target, not a queue (forgotten presses shouldn't auto-select).
const pending = $state<Partial<Record<HandoffTarget, HandoffItem[]>>>({})

export function sendItems(target: HandoffTarget, items: HandoffItem[]): void {
  if (!items.length) return
  const existing = pending[target] ?? []
  // Same instance sent twice is one item, not two candidates.
  const seen = new Set(existing.map((h) => h.item.instanceId))
  pending[target] = [...existing, ...items.filter((h) => !seen.has(h.item.instanceId))]
}

/** What is waiting for this screen, for the character it is showing. */
export function peekHandoff(target: HandoffTarget, characterId: string | null): HandoffItem[] {
  return (pending[target] ?? []).filter((h) => h.characterId === characterId)
}

/** Take and clear pending items after receiving screen merges them (failed merge preserves items). */
export function takeHandoff(target: HandoffTarget, characterId: string | null): HandoffItem[] {
  const mine = peekHandoff(target, characterId)
  if (!mine.length) return []
  pending[target] = (pending[target] ?? []).filter((h) => h.characterId !== characterId)
  return mine
}

export function clearHandoff(target: HandoffTarget): void {
  pending[target] = []
}


/** Setup handoff to Quick Sim carries CANDIDATE DELTA with exact ItemInstance objects, not rebuilt profile (P08.14). */
export interface SetupHandoff {
  characterId: string | null
  label: string
  /** Slot to item, or null for "empty this slot". Absent slots are untouched. */
  items: Partial<Record<GearSlot, ItemInstance | null>>
  talents?: string
  /** Exact consumable and scenario/buff choices from the compared setup. */
  consumables?: Record<string, string>
  extraProfileLines?: string[]
  settings?: Partial<SettingsSnapshot>
  /** The measured mean this setup produced in the search, for comparison. */
  searchMean?: number
  /** The baseline it was measured against, so the detail run can be compared. */
  baselineMean?: number
}

let pendingSetup: SetupHandoff | null = $state(null)

export function sendSetup(setup: SetupHandoff): void {
  pendingSetup = setup
}

export function peekSetup(characterId: string | null): SetupHandoff | null {
  return pendingSetup && pendingSetup.characterId === characterId ? pendingSetup : null
}

/** Takes and clears it, so a setup cannot be applied twice by accident. */
export function takeSetup(characterId: string | null): SetupHandoff | null {
  const mine = peekSetup(characterId)
  if (mine) pendingSetup = null
  return mine
}

export function clearSetup(): void {
  pendingSetup = null
}
