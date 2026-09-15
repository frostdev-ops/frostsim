import { CLASS_LABELS, parseAddonExport } from '../import/character'
import defaults from './generated/weekly-defaults.json'

/** Actor-scoped guided defaults; explicit user options including empty ones win. */
export function weeklyDefaultLines(profile: string): string[] {
  const character = parseAddonExport(profile)
  const keys = character.profileLines.map((line) => line.match(/^\s*([\w.]+)\s*\+?=/)?.[1]).filter(Boolean)
  // Raw/multi-actor profiles cannot safely inherit one character's defaults.
  if (keys.includes('copy') || keys.filter((key) => Object.hasOwn(CLASS_LABELS, key!)).length !== 1) return []
  return defaults.rules.filter((rule) => rule.class === character.className && rule.spec === character.spec
    && character.level !== undefined && character.level >= rule.minLevel && !keys.includes(rule.option))
    .map((rule) => `${rule.option}=${rule.value}`)
}

/** Insert after player declaration, before any later enemy changes scope. */
export function applyWeeklyDefaults(profile: string): string {
  const additions = weeklyDefaultLines(profile)
  if (!additions.length) return profile
  const lines = profile.split('\n')
  const actor = lines.findIndex((line) => {
    const key = line.match(/^\s*(\w+)\s*=/)?.[1]
    return key !== undefined && Object.hasOwn(CLASS_LABELS, key)
  })
  lines.splice(actor + 1, 0, ...additions)
  return lines.join('\n')
}

export const weeklyDefaultsSource = defaults.weekly
