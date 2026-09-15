// Run settings, one instance per tool (P08.15); module-level state and localStorage copy persist across screens and reloads.

import {
  DEFAULT_SETTINGS, FIGHT_STYLES, LIMITS, type Accuracy, type FightStyle, withPlayerScopedLines,
} from './simc/options'
import { FIGHT_PRESETS, findPreset, presetForStyle } from './simc/client'
import { RAID_BUFFS, raidBuffLines, type RaidBuff, type RaidBuffSelection } from './simc/raid-buffs'
import { importRouteExport } from './dungeonRoute'

const KEY = 'frostsim.settings'

export type AccuracyMode = 'targetError' | 'iterations' | 'script'

export interface SettingsSnapshot {
  routeText?: string
  fightStyle: FightStyle
  maxTime: number
  targets: number
  threads: number
  accuracyMode: AccuracyMode
  targetError: number
  maxIterations: number
  iterations: number
  loadoutName: string | null
  presetId: string
  raidBuffs?: RaidBuffSelection
  consumables?: Record<string, string>
  equipmentOptions?: Record<string, string>
}

/** Accuracy is a mode (not two fields that fight); fixed-iteration mode carries no target error (P01.10). */
export class ToolSettings {
  routeText = $state('')
  readonly tool: string
  fightStyle = $state<FightStyle>(DEFAULT_SETTINGS.fightStyle)
  maxTime = $state(DEFAULT_SETTINGS.maxTime)
  targets = $state(DEFAULT_SETTINGS.targets)
  threads = $state(DEFAULT_SETTINGS.threads)
  /** P06.10: off by default; HTML report is 2.6x JSON and costs engine time, so user request signals worth producing. */
  htmlReport = $state(false)
  accuracyMode = $state<AccuracyMode>('targetError')
  targetError = $state(0.1)
  maxIterations = $state(100_000)
  iterations = $state(10_000)
  /** Talent loadout to run instead of the imported active one. */
  loadoutName = $state<string | null>(null)
  /** The chosen scenario; two are built from profileLines (Target Dummy, Execute Patchwerk), not upstream styles. */
  presetId = $state('patchwerk')
  raidBuffs = $state<RaidBuffSelection>({})
  consumables = $state<Record<string, string>>({})
  equipmentOptions = $state<Record<string, string>>({})
  private readonly defaults: SettingsSnapshot

  constructor(tool: string, overrides: Partial<SettingsSnapshot> = {}) {
    this.tool = tool
    this.apply(overrides)
    this.defaults = this.snapshot()
    this.apply(read(tool))
    // Persist after any change, coalesced by microtask queue.
    $effect.root(() => {
      $effect(() => { write(this.tool, this.snapshot()) })
    })
  }

  accuracy(): Accuracy {
    // 'script' states nothing; raw multi-profile script keeps its own stopping rule; engine layer rejects it outside raw run.
    if (this.accuracyMode === 'script') return { mode: 'script' }
    return this.accuracyMode === 'iterations'
      ? { mode: 'iterations', iterations: clampInt(this.iterations, 1, LIMITS.iterations) }
      : {
          mode: 'targetError',
          targetError: clamp(this.targetError, 0.01, 10),
          maxIterations: clampInt(this.maxIterations, 100, LIMITS.iterations),
        }
  }

  restoreDefaults(): void {
    this.routeText = ''
    this.apply(this.defaults)
    this.htmlReport = false
  }

  snapshot(): SettingsSnapshot {
    return {
      routeText: this.routeText,
      fightStyle: this.fightStyle,
      maxTime: this.maxTime,
      targets: this.targets,
      threads: this.threads,
      accuracyMode: this.accuracyMode,
      targetError: this.targetError,
      maxIterations: this.maxIterations,
      iterations: this.iterations,
      loadoutName: this.loadoutName,
      presetId: this.presetId,
      raidBuffs: { ...this.raidBuffs },
      consumables: { ...this.consumables },
      equipmentOptions: { ...this.equipmentOptions },
    }
  }

  /** Applies a preset by id, keeping `fightStyle` in step for the engine. */
  selectPreset(id: string): void {
    const preset = findPreset(id)
    if (!preset || !preset.supported.ok) return
    this.presetId = preset.id
    if (preset.fightStyle) this.fightStyle = preset.fightStyle
    // Locked upstream sim.cpp overrides these fields before combat (DungeonSlice: 360/1, DungeonRoute: 2700/1, Ultraxion: 366).
    if (this.fightStyle === 'DungeonSlice') { this.maxTime = 360; this.targets = 1 }
    if (this.fightStyle === 'DungeonRoute') { this.maxTime = 2700; this.targets = 1 }
    if (this.fightStyle === 'Ultraxion') this.maxTime = 366
  }

  /** Profile lines this scenario contributes, for `SimRequest.extraProfileLines`. */
  extraProfileLines(): string[] | undefined {
    const lines = [...raidBuffLines(this.raidBuffs), ...(findPreset(this.presetId)?.profileLines ?? [])]
    if (this.fightStyle === 'DungeonRoute' && this.routeText) {
      const route = importRouteExport(this.routeText)
      if (route.issues.length) throw new Error(route.issues[0].message)
      lines.push(...route.profileLines)
    }
    const actor = Object.entries({ ...this.consumables, ...this.equipmentOptions }).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`)
    return withPlayerScopedLines(lines, actor)
  }

  apply(s: Partial<SettingsSnapshot>): void {
    if (typeof s.routeText === 'string' && s.routeText.length <= 256 * 1024) this.routeText = s.routeText
    for (const field of ['consumables', 'equipmentOptions'] as const) {
      if (s[field]) this[field] = Object.fromEntries(Object.entries(s[field]!).filter(([key, value]) =>
        /^(flask|food|potion|augmentation|temporary_enchant|midnight\.crucible_of_erratic_energies_(violence|sustenance|predation)|dragonflight\.player\.ruby_whelp_shell_training)$/.test(key)
        && typeof value === 'string' && /^[a-zA-Z0-9_:/.=-]*$/.test(value)))
    }
    if (s.raidBuffs && typeof s.raidBuffs === 'object') {
      this.raidBuffs = Object.fromEntries((Object.keys(RAID_BUFFS) as RaidBuff[])
        .filter((key) => typeof s.raidBuffs?.[key] === 'boolean')
        .map((key) => [key, s.raidBuffs![key]]))
    }
    if (s.fightStyle && FIGHT_STYLES.includes(s.fightStyle)) this.fightStyle = s.fightStyle
    if (isNum(s.maxTime)) this.maxTime = clampInt(s.maxTime, 10, LIMITS.maxTimeSeconds)
    if (isNum(s.targets)) this.targets = clampInt(s.targets, 1, LIMITS.targets)
    if (isNum(s.threads)) this.threads = clampInt(s.threads, 1, 64)
    if (s.accuracyMode === 'iterations' || s.accuracyMode === 'targetError'
      || s.accuracyMode === 'script') {
      this.accuracyMode = s.accuracyMode
    }
    if (isNum(s.targetError)) this.targetError = clamp(s.targetError, 0.01, 10)
    if (isNum(s.maxIterations)) this.maxIterations = clampInt(s.maxIterations, 100, LIMITS.iterations)
    if (isNum(s.iterations)) this.iterations = clampInt(s.iterations, 1, LIMITS.iterations)
    if (s.loadoutName !== undefined) this.loadoutName = s.loadoutName
    if (typeof s.presetId === 'string' && findPreset(s.presetId)?.supported.ok) {
      this.selectPreset(s.presetId)
    } else if (s.fightStyle) {
      // A snapshot saved before presets existed: recover the id from the style.
      this.presetId = presetForStyle(this.fightStyle)?.id ?? this.presetId
    }
  }
}

/** Sanity: every preset the UI can select must be findable by its id. */
export const SELECTABLE_PRESETS = FIGHT_PRESETS.filter((p) => p.supported.ok)

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
function clampInt(v: number, lo: number, hi: number): number {
  return clamp(Math.round(v), lo, hi)
}

function read(tool: string): Partial<SettingsSnapshot> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    const one = all[tool]
    return one && typeof one === 'object' ? (one as Partial<SettingsSnapshot>) : {}
  } catch {
    return {}
  }
}

function write(tool: string, snapshot: SettingsSnapshot): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    all[tool] = snapshot
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* preferences are a convenience; storage refusal is not an error */ }
}

export const quickSettings = new ToolSettings('quick')
export const compareSettings = new ToolSettings('compare')
export const gearSettings = new ToolSettings('gear', {
  // A search runs many candidates, so the per-candidate budget starts coarser.
  accuracyMode: 'targetError',
  targetError: 1,
  maxIterations: 20_000,
})
export const dropSettings = new ToolSettings('droptimizer', {
  accuracyMode: 'targetError',
  targetError: 0.7,
  maxIterations: 30_000,
})
export const advancedSettings = new ToolSettings('advanced')
export const crestSettings = new ToolSettings('crests', {
  // A CEILING ON LOOSENESS, NOT THE PRECISION THE RUN USES. Crest Sim derives
  // phase 3's target error from the spread between the plans it has to separate
  // and never runs looser than `CrestPlanning.anchorTargetError` — see
  // `planTargetError`. The old 0.5 default sat inside the dead zone the fifth
  // browser run measured (the engine bottoms out at ~210 iterations and ~0.33%
  // achieved no matter what is requested between 0.33% and 10%), so it read as a
  // precision choice while changing nothing. 0.1 is what the run actually uses.
  accuracyMode: 'targetError',
  targetError: 0.1,
  maxIterations: 30_000,
})

/** Crest Sim plan-ahead inputs; separate from ToolSettings (not sim settings); NOTHING HAS DEFAULT (no source for season-18 cap). */
export interface CrestPlanning {
  /** Target error for phase-1 anchor measurements (precision choice, not game data); effective value is min(this, run's target error). */
  anchorTargetError: number
  /** Whether budget counts unearned crests, PERSISTED WITH GATED NUMBERS (avoids silent revert of budget state). */
  planAhead: boolean
  /** 0-based season week to plan to. */
  week: number
  capRemoved: boolean
  /** Crests earned per week, by currency id. Empty entries are unset. */
  perWeek: Record<number, number>
  /** Crests granted at season start, by currency id. */
  startQuantity: Record<number, number>
  /** Crests held, typed in when the export carried no currency block. */
  held: Record<number, number>
}

// See CrestPlanning.anchorTargetError: chosen for resolvability, not measured.
export const DEFAULT_ANCHOR_TARGET_ERROR = 0.1

function numbers(value: unknown): Record<number, number> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, n]) => Number.isInteger(Number(key)) && isNum(n) && n >= 0)
    .map(([key, n]) => [Number(key), n as number]))
}

function readPlanning(): CrestPlanning {
  let saved: Record<string, unknown> = {}
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    if (all['crests.planning'] && typeof all['crests.planning'] === 'object') {
      saved = all['crests.planning'] as Record<string, unknown>
    }
  } catch { /* preferences are a convenience */ }
  return {
    anchorTargetError: isNum(saved.anchorTargetError) ? clamp(saved.anchorTargetError, 0.01, 1) : DEFAULT_ANCHOR_TARGET_ERROR,
    planAhead: saved.planAhead === true,
    week: isNum(saved.week) ? clampInt(saved.week, 0, 51) : 0,
    capRemoved: saved.capRemoved === true,
    perWeek: numbers(saved.perWeek),
    startQuantity: numbers(saved.startQuantity),
    held: numbers(saved.held),
  }
}

export const crestPlanning: CrestPlanning = $state(readPlanning())

$effect.root(() => {
  $effect(() => {
    try {
      const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
      all['crests.planning'] = {
        anchorTargetError: crestPlanning.anchorTargetError,
        planAhead: crestPlanning.planAhead,
        week: crestPlanning.week,
        capRemoved: crestPlanning.capRemoved,
        perWeek: { ...crestPlanning.perWeek },
        startQuantity: { ...crestPlanning.startQuantity },
        held: { ...crestPlanning.held },
      }
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch { /* storage refusal is not an error */ }
  })
})
