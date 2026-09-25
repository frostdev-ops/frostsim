// Pure Quick Sim request builder shared by the Quick Sim screen's settings and server-side jobs (Discord, Loothing), so both send the same scenario (CLAUDE.md D14, D15).

import { buildProfile } from '../import/serialize'
import type { ImportedCharacter } from '../import/character'
import { importRouteExport } from '../dungeonRoute'
import { DEFAULT_ACCURACY, DEFAULT_SETTINGS, withPlayerScopedLines, type Accuracy, type FightStyle } from './options'
import { findPreset } from './presets'
import { multiActorParts } from './multi-actor'
import { raidBuffLines, type RaidBuffSelection } from './raid-buffs'
import type { SimRequest } from './assemble'

export interface Scenario {
  presetId: string
  fightStyle: FightStyle
  raidBuffs?: RaidBuffSelection
  /** Keystone.guru/MDT export; used only when the style is DungeonRoute. */
  routeText?: string
  /** Consumable and equipment options as simc key/value; empty values are skipped. */
  actorOptions?: Record<string, string>
}

/** Profile lines a scenario contributes (`SimRequest.extraProfileLines`). Throws the first route problem. */
export function scenarioLines(s: Scenario): string[] {
  const lines = [...raidBuffLines(s.raidBuffs ?? {}), ...(findPreset(s.presetId)?.profileLines ?? [])]
  if (s.fightStyle === 'DungeonRoute' && s.routeText) {
    const route = importRouteExport(s.routeText)
    if (route.issues.length) throw new Error(route.issues[0].message)
    lines.push(...route.profileLines)
  }
  const actor = Object.entries(s.actorOptions ?? {}).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`)
  return withPlayerScopedLines(lines, actor)
}

export interface QuickOptions {
  presetId: string
  threads: number
  accuracy?: Accuracy
  maxTime?: number
  targets?: number
  /** Talent string to run instead of the character's active one. */
  talents?: string
  raidBuffs?: RaidBuffSelection
  actorOptions?: Record<string, string>
  routeText?: string
  htmlReport?: boolean
}

/** Quick Sim's request for a character and preset; validate it with validateRequest before running. */
export function quickRequest(character: ImportedCharacter, q: QuickOptions): SimRequest {
  const fightStyle = findPreset(q.presetId)?.fightStyle
  if (!fightStyle) throw new Error(`Unknown fight preset: ${q.presetId}`)
  let maxTime = q.maxTime ?? DEFAULT_SETTINGS.maxTime
  let targets = q.targets ?? DEFAULT_SETTINGS.targets
  // Same overrides as ToolSettings.selectPreset: upstream sim.cpp forces these for the style anyway.
  if (fightStyle === 'DungeonSlice') { maxTime = 360; targets = 1 }
  if (fightStyle === 'DungeonRoute') { maxTime = 2700; targets = 1 }
  if (fightStyle === 'Ultraxion') maxTime = 366
  return {
    schemaVersion: 1,
    profile: buildProfile(character, q.talents ? { talents: q.talents } : {}),
    settings: { fightStyle, maxTime, targets, threads: q.threads },
    accuracy: q.accuracy ?? DEFAULT_ACCURACY,
    extraProfileLines: scenarioLines({
      presetId: q.presetId,
      fightStyle,
      raidBuffs: q.raidBuffs,
      routeText: q.routeText,
      actorOptions: q.actorOptions,
    }),
    htmlReport: q.htmlReport ?? false,
  }
}

/** Quick Sim of several characters in one run, each its own sim (multi-actor.ts), as the Quick Sim screen builds it. */
export function compareRequest(characters: readonly ImportedCharacter[], q: QuickOptions): SimRequest {
  const one = quickRequest(characters[0], q)
  if (characters.length < 2) return one
  const parts = multiActorParts(characters.map((character) => ({ character })), one.extraProfileLines ?? [])
  return { ...one, profile: parts.profile, extraProfileLines: parts.extraProfileLines }
}
