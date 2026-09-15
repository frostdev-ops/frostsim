// Expert Mode slots and stat-weight selection, kept at module level and mirrored to localStorage; user-written APL is expensive (no copy). NOT guaranteed across reloads (private mode, quota, blocked data fail silently); persistDrafts() returns actual outcome.

export interface StatWeight {
  stat: string
  value: number
  error?: number
}

/** simc scale-factor stat tokens; names verified in engine/util/util.cpp. */
export const STAT_CHOICES = [
  { id: 'strength', label: 'Strength' },
  { id: 'agility', label: 'Agility' },
  { id: 'intellect', label: 'Intellect' },
  { id: 'stamina', label: 'Stamina' },
  { id: 'crit', label: 'Critical strike' },
  { id: 'haste', label: 'Haste' },
  { id: 'mastery', label: 'Mastery' },
  { id: 'versatility', label: 'Versatility' },
  { id: 'weapon_dps', label: 'Weapon DPS' },
] as const

import { ROUTE_DEFAULTS } from './dungeonRoute'

const KEY = 'frostsim.advanced'

/** P10.4: Expert slots kept PER SPECIALIZATION; Frost rotation wrong for Fire; prev spec's APL would silently reference unavailable spells. Key is import-time spec. */
export const NO_SPEC = ''

export interface ExpertDraft {
  mode: 'character' | 'raw'
  raw: string
  header: string
  preActor: string
  postActor: string
  footer: string
  extraOptions: string
}

export interface StatWeightChoice {
  selected: string[]
  normalize: boolean
}

const EXPERT_DEFAULTS: ExpertDraft = {
  mode: 'character',
  raw: '',
  header: '',
  preActor: '',
  postActor: '',
  footer: '',
  extraOptions: '',
}

/** Raw DPS per point by default; normalized weights need primary attribute in scaled stats or all return 0.00 (measured); default list has none. */
const WEIGHT_DEFAULTS: StatWeightChoice = {
  selected: ['crit', 'haste', 'mastery', 'versatility'],
  normalize: false,
}

const PRIMARY_ATTRIBUTES = ['strength', 'agility', 'intellect']

/** Whether normalize_scale_factors=1 can produce numbers; empty selection scales everything including primary. */
export function canNormalizeWeights(choice: StatWeightChoice): boolean {
  return choice.normalize
    && (choice.selected.length === 0 || choice.selected.some((s) => PRIMARY_ATTRIBUTES.includes(s)))
}

const TEXT_FIELDS = ['raw', 'header', 'preActor', 'postActor', 'footer', 'extraOptions'] as const

function readStore(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(KEY)
    const value = raw ? (JSON.parse(raw) as unknown) : null
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Only the shapes this module owns; anything else in storage is ignored. */
function readExpert(specKey: string): ExpertDraft {
  const out: ExpertDraft = { ...EXPERT_DEFAULTS }
  const store = readStore()
  const bySpec = store.bySpec as Record<string, unknown> | undefined
  // expert without spec: pre-P10.4 shape; adopt once into open spec's bucket rather than discard.
  const e = (bySpec?.[specKey] ?? (specKey === NO_SPEC ? store.expert : undefined)) as
    Record<string, unknown> | undefined
  if (e && typeof e === 'object') {
    for (const k of TEXT_FIELDS) if (typeof e[k] === 'string') out[k] = e[k] as string
    if (e.mode === 'raw' || e.mode === 'character') out.mode = e.mode
  }
  return out
}

function readWeights(): StatWeightChoice {
  const out: StatWeightChoice = { ...WEIGHT_DEFAULTS, selected: [...WEIGHT_DEFAULTS.selected] }
  const w = readStore().statWeights as Record<string, unknown> | undefined
  if (w && typeof w === 'object') {
    if (Array.isArray(w.selected) && w.selected.every((x) => typeof x === 'string')) {
      out.selected = w.selected as string[]
    }
    if (typeof w.normalize === 'boolean') out.normalize = w.normalize
  }
  return out
}

/** The spec whose slots are currently loaded. Changed by `useSpec()`. */
let currentSpec = NO_SPEC

export const expert = $state<ExpertDraft>(readExpert(NO_SPEC))
export const statWeights = $state<StatWeightChoice>(readWeights())

/** Dungeon Route input (P10.9), off by default; changes fight style for whole run, user must ask for it. */
export const route = $state({
  enabled: false,
  text: '',
  ...ROUTE_DEFAULTS,
})

/** Switches visible slots to another spec, saving current ones first; must never silently carry or discard rotations (P10.4). */
export function useSpec(specKey: string | undefined | null): void {
  const key = specKey ?? NO_SPEC
  if (key === currentSpec) return
  persistDrafts()
  currentSpec = key
  Object.assign(expert, readExpert(key))
}

/** Which spec's slots are on screen, for the UI to name. */
export function activeSpec(): string {
  return currentSpec
}

/** Specs that have any Expert text stored, so the UI can offer to copy one. */
export function specsWithDrafts(): string[] {
  const bySpec = readStore().bySpec as Record<string, Record<string, unknown>> | undefined
  if (!bySpec) return []
  return Object.keys(bySpec).filter((k) =>
    TEXT_FIELDS.some((f) => typeof bySpec[k]?.[f] === 'string' && (bySpec[k][f] as string).trim()),
  )
}

/** Copies another spec's slots into the current one, on an explicit action. */
export function copyFromSpec(specKey: string): boolean {
  const source = readExpert(specKey)
  if (!TEXT_FIELDS.some((f) => source[f].trim())) return false
  Object.assign(expert, source)
  return persistDrafts()
}

/** True when the current drafts are safely mirrored outside this tab's memory. */
export function persistDrafts(): boolean {
  try {
    const store = readStore()
    const bySpec = (store.bySpec ?? {}) as Record<string, unknown>
    bySpec[currentSpec] = { ...expert }
    localStorage.setItem(KEY, JSON.stringify({
      bySpec,
      statWeights: { selected: [...statWeights.selected], normalize: statWeights.normalize },
    }))
    return true
  } catch {
    return false
  }
}

/** Anything a user typed here that is not part of a saved character or report. */
export function hasUnsavedDrafts(): boolean {
  return TEXT_FIELDS.some((k) => expert[k].trim().length > 0)
}
