// Talent editor state over catalog's rules engine; rules in TalentModel (availability, point accounting, hero-tree, loadout codec); module holds screen needs only.

import {
  decodeLoadout, encodeLoadout, peekSpecId, TalentModel,
  type TalentBudget, type TalentSelection,
} from './catalog/talents'
import type { TalentTree } from './catalog/types'

/** Loadout's spec from codec's peekSpecId not second reader (two readers = silent wrong decode); strict about invalid strings. */
export function modelForLoadout(tree: TalentTree, loadout: string, level = 90): TalentModel | null {
  const specId = peekSpecId(loadout)
  if (specId === null || !specIdsIn(tree).includes(specId)) return null
  const model = new TalentModel(tree, specId, level)
  const decoded = decodeLoadout(model, loadout)
  return decoded.selection && !decoded.errors.length ? model : null
}

type SavedTalentLoadout = { name: string; talents: string }
const saved = $state<Record<string, SavedTalentLoadout[]>>({})
const drafts = new Map<string, string>()

export function talentDraft(characterId: string | null): string | undefined {
  return characterId ? drafts.get(characterId) : undefined
}

export function rememberTalentDraft(characterId: string | null, talents: string): void {
  if (characterId) drafts.set(characterId, talents)
}

export function savedTalentLoadouts(characterId: string | null): SavedTalentLoadout[] {
  if (!characterId) return []
  if (!(characterId in saved)) {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(`frostsim.talents.${characterId}`) ?? '[]')
      saved[characterId] = Array.isArray(value) ? value.filter((v): v is SavedTalentLoadout =>
        v && typeof v.name === 'string' && typeof v.talents === 'string' && peekSpecId(v.talents) !== null) : []
    } catch { saved[characterId] = [] }
  }
  return saved[characterId]
}

/** Returns false if storage is unavailable; the draft still survives navigation. */
export function saveTalentLoadout(characterId: string, name: string, talents: string): boolean {
  const existing = savedTalentLoadouts(characterId)
  saved[characterId] = [...existing.filter((v) => v.name !== name), { name, talents }]
  try {
    localStorage.setItem(`frostsim.talents.${characterId}`, JSON.stringify(saved[characterId]))
    return true
  } catch { return false }
}

/** Every spec id the class tree mentions, ascending. */
export function specIdsIn(tree: TalentTree): number[] {
  const ids = new Set<number>()
  for (const node of tree.nodes) {
    for (const id of node.specIds) if (id > 0) ids.add(id)
    for (const id of node.starterSpecIds) if (id > 0) ids.add(id)
  }
  return [...ids].sort((a, b) => a - b)
}

export const EMPTY: TalentSelection = { specId: 0, picks: [] }

/** Point budget NOT from engine data (simc exports no table, level/patch-dependent game rule); user-visible field, no false default. */
export const budget = $state({
  enforce: false,
  class: 31,
  spec: 30,
  hero: 10,
})

export function activeBudget(): TalentBudget | undefined {
  return budget.enforce
    ? { class: budget.class, spec: budget.spec, hero: budget.hero }
    : undefined
}

/** A plain, cloneable copy — the engine refuses a Svelte `$state` proxy. */
export function plain(selection: TalentSelection): TalentSelection {
  return {
    specId: selection.specId,
    picks: selection.picks.map((p) => ({ nodeId: p.nodeId, entryId: p.entryId, rank: p.rank })),
  }
}

export { decodeLoadout, encodeLoadout, peekSpecId, TalentModel }
