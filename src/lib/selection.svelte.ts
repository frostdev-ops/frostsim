// Selections per character, mirrored to storage. Per-char not global; validated on read (P08.15). Best-effort storage.

import type { GearSlot } from './import/character'
import type { ItemInstance } from './import/character'
import type { Selection } from './optimization/topgear'

export interface GearDraft {
  gems: NonNullable<Selection['gems']>
  enchants: NonNullable<Selection['enchants']>
  consumables: NonNullable<Selection['consumables']>
  embellishments: NonNullable<Selection['embellishments']>
  requiredSets: NonNullable<Selection['requiredSets']>
  selectedLoadouts: string[]
  added: Partial<Record<GearSlot, ItemInstance[]>>
}
// Gear draft in memory for tool navigation within tab.
const gearDrafts = new Map<string, GearDraft>()
export const gearDraftFor = (id: string): GearDraft | undefined => gearDrafts.get(id)
export const rememberGearDraft = (id: string, draft: GearDraft): void => { gearDrafts.set(id, draft) }

const KEY = 'frostsim.selection'
// Two tools keep independent selections against same character.
export type SelectionScope = 'gear' | 'droptimizer'

export type SlotSelection = Partial<Record<GearSlot, string[]>>

interface Stored {
  [characterId: string]: Partial<Record<SelectionScope, SlotSelection>>
}

let storageOk = true

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {}
  } catch {
    return {}
  }
}

function writeAll(all: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
    storageOk = true
  } catch {
    // Quota or blocked storage. The in-memory copy still works for this tab.
    storageOk = false
  }
}

// False once write refused; UI tells user selections won't survive.
export function selectionStorageWorks(): boolean {
  return storageOk
}

// Live selections in reactive state; navigate = re-render not reload; restored per-char on page reload.
const live = $state<Record<string, Partial<Record<SelectionScope, SlotSelection>>>>({})

function bucket(characterId: string): Partial<Record<SelectionScope, SlotSelection>> {
  live[characterId] ??= readAll()[characterId] ?? {}
  return live[characterId]
}

// Selection for character+tool; all ids validated against owned items.
export function selectionFor(
  characterId: string | null | undefined,
  scope: SelectionScope,
  ownedIds: ReadonlySet<string>,
): SlotSelection {
  if (!characterId) return {}
  const stored = bucket(characterId)[scope] ?? {}
  const out: SlotSelection = {}
  for (const [slot, ids] of Object.entries(stored) as [GearSlot, string[]][]) {
    const kept = (ids ?? []).filter((id) => ownedIds.has(id))
    if (kept.length) out[slot] = kept
  }
  return out
}

// Count of stale ids for UI notification.
export function staleCount(
  characterId: string | null | undefined,
  scope: SelectionScope,
  ownedIds: ReadonlySet<string>,
): number {
  if (!characterId) return 0
  const stored = bucket(characterId)[scope] ?? {}
  let stale = 0
  for (const ids of Object.values(stored)) {
    for (const id of ids ?? []) if (!ownedIds.has(id)) stale++
  }
  return stale
}

export function saveSelection(
  characterId: string | null | undefined,
  scope: SelectionScope,
  selection: SlotSelection,
): void {
  if (!characterId) return
  // Snapshot: $state may come from component; stored JSON and module copy must be plain.
  const plain: SlotSelection = {}
  for (const [slot, ids] of Object.entries(selection) as [GearSlot, string[]][]) {
    if (ids?.length) plain[slot] = [...ids]
  }
  bucket(characterId)[scope] = plain
  const all = readAll()
  all[characterId] = { ...all[characterId], [scope]: plain }
  writeAll(all)
}

export function clearSelection(characterId: string | null | undefined, scope: SelectionScope): void {
  if (!characterId) return
  bucket(characterId)[scope] = {}
  const all = readAll()
  if (all[characterId]) {
    delete all[characterId][scope]
    writeAll(all)
  }
}

// Drop deleted character's selections; don't leak forever.
export function forgetCharacterSelections(characterId: string): void {
  gearDrafts.delete(characterId)
  delete live[characterId]
  const all = readAll()
  if (characterId in all) {
    delete all[characterId]
    writeAll(all)
  }
}
