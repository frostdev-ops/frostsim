// Character history (CLAUDE.md D15; DESIGN.md C5): what a cloud slot remembers about its character over time. Pure, and shared by
// the account server (snapshots on save) and the Character page (charts and the change log).

import { SLOT_LABELS, type GearSlot, type ImportedCharacter } from '../import/character'
import type { StoredReport } from '../store/records'

/** The addon's own name and item level for an equipped item: what the game showed, not catalog data. */
export interface GearItem { slot: GearSlot; itemId: number; name?: string; ilvl?: number }
export interface GearSnapshot { itemLevel: number | null; gear: GearItem[] }
export interface GearChange { slot: GearSlot; label: string; from?: GearItem; to?: GearItem }

/** The 16 slots the game averages; shirt and tabard do not count. */
const AVERAGED: GearSlot[] = ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'finger1',
  'finger2', 'trinket1', 'trinket2', 'main_hand', 'off_hand']

export function gearSnapshot(c: ImportedCharacter): GearSnapshot {
  const gear = c.equipped
    .filter((i) => AVERAGED.includes(i.slot))
    .map((i): GearItem => ({ slot: i.slot, itemId: i.itemId, name: i.addonName, ilvl: i.itemLevel ?? i.addonItemLevel }))
  return { itemLevel: averageItemLevel(gear), gear }
}

/** The game's equipped average: 16 slots, an empty one counts 0, and a main hand with no off hand (a two-hander) counts twice.
 *  Null when an equipped item has no item level in the export. */
export function averageItemLevel(gear: GearItem[]): number | null {
  if (gear.some((g) => g.ilvl === undefined)) return null
  const by = new Map(gear.map((g) => [g.slot, g.ilvl!]))
  if (!by.has('off_hand') && by.has('main_hand')) by.set('off_hand', by.get('main_hand')!)
  return Math.round((AVERAGED.reduce((sum, s) => sum + (by.get(s) ?? 0), 0) / AVERAGED.length) * 10) / 10
}

const key = (g: GearItem | undefined) => (g ? `${g.itemId}:${g.ilvl ?? ''}` : '')

export function sameGear(a: GearItem[], b: GearItem[]): boolean {
  return gearChanges(a, b).length === 0
}

/** Slots whose item or item level changed from `before` to `after`, in slot order. */
export function gearChanges(before: GearItem[], after: GearItem[]): GearChange[] {
  const was = new Map(before.map((g) => [g.slot, g]))
  const now = new Map(after.map((g) => [g.slot, g]))
  return AVERAGED.filter((s) => key(was.get(s)) !== key(now.get(s)))
    .map((slot) => ({ slot, label: SLOT_LABELS[slot], from: was.get(slot), to: now.get(slot) }))
}

export interface SimPoint { reportId: string; createdAt: string; dps: number; dpsError?: number; fightStyle?: string; targets?: number; gameBuild?: string }

/** A finished Quick Sim as a history point for `characterId` (the run's main character or one run beside it), or null. Other tools
 *  change gear or talents on purpose, so only Quick Sim tracks the character as it is. */
export function simPoint(r: StoredReport, characterId = r.characterId): SimPoint | null {
  if (r.tool !== 'quick' || r.completion !== 'complete') return null
  const member = r.characterId === characterId ? null : r.summary.members?.find((m) => m.characterId === characterId)
  if (r.characterId !== characterId && !member) return null
  const dps = member ? member.dps : r.summary.dps
  if (!(Number(dps) > 0)) return null
  const settings = (r.requestSnapshot as { settings?: { fightStyle?: unknown; targets?: unknown } } | null)?.settings
  return {
    reportId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    dps: dps!,
    dpsError: member ? member.confidenceMargin : r.summary.confidenceMargin,
    fightStyle: typeof settings?.fightStyle === 'string' ? settings.fightStyle : undefined,
    targets: typeof settings?.targets === 'number' ? settings.targets : undefined,
    gameBuild: r.engine.wowVersion,
  }
}
