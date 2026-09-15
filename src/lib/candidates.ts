// Candidate assembly for Compare: named variants of locked baseline. Identity is generated id, never label (P07.2). Validation limited to what export states; unchecked constraints need item data (P07.3).

import type { GearSlot, ImportedCharacter, ItemInstance } from './import/character'
import { SLOT_LABELS } from './import/character'
import type { ProfileOverrides } from './import/serialize'
import { compareCandidates, differenceMargin } from './optimization/statistics'

export interface CandidateChange {
  slot?: GearSlot
  from?: ItemInstance | null
  to?: ItemInstance | null
  talents?: { name: string; value: string }
}

export interface Candidate {
  /** Engine-safe and stable for the life of the list. */
  id: string
  label: string
  overrides: ProfileOverrides
  changes: CandidateChange[]
  /** Reasons candidate cannot run; non-empty means never reaches engine. */
  issues: string[]
  /** Constraints that could not be checked without item data. */
  unchecked: string[]
  locked?: boolean
}

/** Slots whose items are freely interchangeable with each other. */
const INTERCHANGEABLE: Partial<Record<GearSlot, GearSlot[]>> = {
  finger1: ['finger1', 'finger2'],
  finger2: ['finger1', 'finger2'],
  trinket1: ['trinket1', 'trinket2'],
  trinket2: ['trinket1', 'trinket2'],
}

/** Slots an item recorded for `slot` may legally fill. */
export function targetSlots(slot: GearSlot): GearSlot[] {
  return INTERCHANGEABLE[slot] ?? [slot]
}

export function canFill(item: ItemInstance, slot: GearSlot): boolean {
  return targetSlots(item.slot).includes(slot)
}

/** How many copies character owns. Identical bag entries are separate instances. */
export function instanceCount(character: ImportedCharacter, item: ItemInstance): number {
  const base = item.instanceId.replace(/#\d+$/, '')
  return [...character.equipped, ...character.bag].filter(
    (i) => i.instanceId.replace(/#\d+$/, '') === base,
  ).length
}

export interface BuildCandidateInput {
  label: string
  items?: Partial<Record<GearSlot, ItemInstance | null>>
  talents?: { name: string; value: string }
}

/** Validates variant against baseline and returns ready-to-run. index only seeds id. */
export function buildCandidate(
  character: ImportedCharacter,
  input: BuildCandidateInput,
  id: string,
  /** Catalog legality when loaded. Absent means weapon and unique-equipped rules unchecked. */
  legality?: (slot: GearSlot, item: ItemInstance) => { issues: string[]; unchecked: string[] },
): Candidate {
  const equipped = new Map<GearSlot, ItemInstance>(character.equipped.map((i) => [i.slot, i]))
  const issues: string[] = []
  const unchecked: string[] = []
  const changes: CandidateChange[] = []
  const items: Partial<Record<GearSlot, ItemInstance | null>> = {}

  const used = new Map<string, number>()
  for (const [slotKey, item] of Object.entries(input.items ?? {})) {
    const slot = slotKey as GearSlot
    // Slot with no label is not a slot; say so rather than render "undefined".
    if (!SLOT_LABELS[slot]) {
      issues.push(
        `Frostsim could not tell which slot "${item?.addonName ?? `item ${item?.itemId ?? '?'}`}" was meant for, so this variant was not built. This is a bug in Frostsim.`,
      )
      continue
    }
    const before = equipped.get(slot) ?? null
    if (item && !canFill(item, slot)) {
      issues.push(
        `${item.addonName ?? `Item ${item.itemId}`} was recorded for ${SLOT_LABELS[item.slot]} and cannot go in ${SLOT_LABELS[slot]}.`,
      )
      continue
    }
    if (item) {
      const base = item.instanceId.replace(/#\d+$/, '')
      const count = (used.get(base) ?? 0) + 1
      used.set(base, count)
      const owned = instanceCount(character, item)
      if (count > owned) {
        issues.push(
          `You own ${owned} of ${item.addonName ?? `item ${item.itemId}`}, so it cannot fill ${count} slots at once.`,
        )
        continue
      }
    }
    if (item && legality) {
      const check = legality(slot, item)
      if (check.issues.length) { issues.push(...check.issues); continue }
      unchecked.push(...check.unchecked)
    } else if (item) {
      unchecked.push(
        'Weapon type, unique-equipped and embellishment limits are unchecked until the game-data catalog loads.',
      )
    }
    items[slot] = item
    changes.push({ slot, from: before, to: item })
  }

  const overrides: ProfileOverrides = { items }
  if (input.talents) {
    overrides.talents = input.talents.value
    changes.push({ talents: input.talents })
  }

  return { id, label: input.label, overrides, changes, issues, unchecked }
}

/** Reserves ids that survive reordering, renaming and duplicate labels. */
export function nextCandidateId(existing: readonly Candidate[]): string {
  let n = existing.length + 1
  const taken = new Set(existing.map((c) => c.id))
  while (taken.has(`c${n}`)) n++
  return `c${n}`
}

export interface RankedCandidate {
  candidate: Candidate
  /** Absent when the engine returned no result for this id. */
  mean?: number
  /** Confidence margin as the engine reports it, never a standard deviation. */
  margin?: number
  iterations?: number
  delta?: number
  deltaPct?: number
  /** Margin on the difference against the baseline, when both reported one. */
  differenceMargin?: number
  status: 'ranked' | 'missing' | 'blocked'
  /** True when the interval around this candidate overlaps the baseline's. */
  indistinguishable?: boolean
}

export interface BaselineResult {
  mean: number
  margin?: number
}

/** Rank candidates against baseline; overlapping intervals marked indistinguishable, not silently ordered (P07.6). */
export function rankCandidates(
  candidates: readonly Candidate[],
  results: ReadonlyMap<string, { mean: number; meanError?: number; iterations?: number }>,
  baseline: BaselineResult,
): RankedCandidate[] {
  const ranked = candidates.map<RankedCandidate>((candidate) => {
    if (candidate.issues.length) return { candidate, status: 'blocked' }
    const r = results.get(candidate.id)
    if (!r) return { candidate, status: 'missing' }
    const delta = r.mean - baseline.mean
    // Separation uses margin on DIFFERENCE, not sum of margins (which overstates overlap).
    const a = { mean: r.mean, margin: r.meanError ?? null, iterations: r.iterations ?? 0 }
    const b = { mean: baseline.mean, margin: baseline.margin ?? null, iterations: 0 }
    const separation = compareCandidates(a, b)
    return {
      candidate,
      mean: r.mean,
      margin: r.meanError,
      iterations: r.iterations,
      delta,
      deltaPct: baseline.mean ? (delta / baseline.mean) * 100 : undefined,
      status: 'ranked',
      differenceMargin: differenceMargin(a, b) ?? undefined,
      // Claim tie only when both sides reported error estimate.
      indistinguishable: separation === 'unknown' ? undefined : separation === 'indistinguishable',
    }
  })
  return ranked.sort((a, b) => {
    if (a.status !== b.status) {
      const order = { ranked: 0, missing: 1, blocked: 2 }
      return order[a.status] - order[b.status]
    }
    return (b.mean ?? -Infinity) - (a.mean ?? -Infinity)
  })
}
