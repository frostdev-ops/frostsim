// Dungeon Route input (P10.9); every rule from engine not inferred; no dungeon mappings (live in Method Dungeon Tools); user-supplied routes validated only.

export interface RouteSettings {
  keystoneLevel: number
  /** Share of a pull's health this player is responsible for, 0-100. */
  keystonePctHp: number
  smartTargeting: boolean
  /** Extra simplified damage-dealers, 0-3. */
  simpleDpsMembers: number
}

export const ROUTE_DEFAULTS: RouteSettings = {
  keystoneLevel: 0,
  keystonePctHp: 0,
  smartTargeting: true,
  simpleDpsMembers: 0,
}

export interface RouteIssue {
  /** 1-based line of the pasted route, or 0 for a settings problem. */
  line: number
  message: string
}

export interface ParsedRoute {
  /** `raid_events+=/pull,...` lines, ready to append to a profile. */
  lines: string[]
  pulls: number
  enemies: number
  bosses: number
  issues: RouteIssue[]
}

const PULL = /^raid_events\+?=\/?pull,(.+)$/i

/** Validate pasted raid_events+=/pull lines; strict on engine-accepted shapes (unparseable enemy string aborts sim). */
export function parseRoute(text: string): ParsedRoute {
  const issues: RouteIssue[] = []
  const lines: string[] = []
  let enemies = 0
  let bosses = 0

  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const match = PULL.exec(trimmed)
    if (!match) {
      issues.push({
        line,
        message: 'Not a pull event. Each line must start with "raid_events+=/pull," — this is the only route input the engine accepts.',
      })
      return
    }

    const options = splitOptions(match[1])
    const enemiesOption = options.get('enemies')
    if (!enemiesOption) {
      issues.push({ line, message: 'This pull has no enemies= list, so it would spawn nothing.' })
      return
    }

    let lineEnemies = 0
    for (const entry of enemiesOption.split('|')) {
      const parts = entry.split(':')
      if (parts.length < 2) {
        issues.push({
          line,
          message: `"${entry}" is not a valid enemy. The engine needs NAME:HEALTH, optionally NAME:HEALTH:RACE:COUNT.`,
        })
        continue
      }
      const health = Number(parts[1])
      if (!Number.isFinite(health) || health <= 0) {
        issues.push({ line, message: `"${parts[0]}" has health "${parts[1]}", which is not a positive number.` })
        continue
      }
      const count = parts.length > 3 ? Number(parts[3]) : 1
      if (parts.length > 3 && (!Number.isInteger(count) || count < 1)) {
        issues.push({ line, message: `"${parts[0]}" has a copy count of "${parts[3]}", which must be a whole number of 1 or more.` })
        continue
      }
      lineEnemies += Number.isInteger(count) && count > 0 ? count : 1
      if (parts[0].replace(/^"|"$/g, '').startsWith('BOSS_')) bosses++
    }

    for (const flag of ['bloodlust', 'shared_health'] as const) {
      const value = options.get(flag)
      if (value !== undefined && value !== '0' && value !== '1') {
        issues.push({ line, message: `${flag}= must be 0 or 1, not "${value}".` })
      }
    }

    enemies += lineEnemies
    // SimC requires explicit first pull=1; preserve supplied IDs, else use entered order.
    lines.push(options.has('pull') ? trimmed : trimmed.replace(/pull,/i, `pull,pull=${lines.length + 1},`))
  })

  return { lines, pulls: lines.length, enemies, bosses, issues }
}

/** Splits `a=1,b=2` without breaking on the `:` and `|` inside a value. */
function splitOptions(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of text.split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0) out.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim())
  }
  return out
}

/** Settings problems, using the engine's own documented bounds. */
export function checkSettings(s: RouteSettings): RouteIssue[] {
  const issues: RouteIssue[] = []
  if (!Number.isInteger(s.keystoneLevel) || s.keystoneLevel < 0) {
    issues.push({ line: 0, message: 'Keystone level must be a whole number of 0 or more.' })
  }
  if (s.keystonePctHp < 0 || s.keystonePctHp > 100) {
    issues.push({ line: 0, message: 'Your share of pull health must be between 0 and 100 percent.' })
  }
  if (!Number.isInteger(s.simpleDpsMembers) || s.simpleDpsMembers < 0 || s.simpleDpsMembers > 3) {
    issues.push({ line: 0, message: 'Extra simplified damage-dealers must be a whole number from 0 to 3 — the engine rejects anything else.' })
  }
  // Engine warns not refuses this pairing; warning easy to miss, so state here too.
  if (s.simpleDpsMembers > 0 && s.keystonePctHp > 40) {
    issues.push({
      line: 0,
      message: 'With extra damage-dealers, a health share above 40% is high for one player. The engine will warn and will not scale enemy health.',
    })
  }
  return issues
}

/** The sim options a validated route needs, in the engine's own spelling. */
export function routeOptions(s: RouteSettings): string[] {
  const out = ['fight_style=DungeonRoute']
  if (s.keystoneLevel > 0) out.push(`keystone_level=${s.keystoneLevel}`)
  if (s.keystonePctHp > 0) out.push(`keystone_pct_hp=${s.keystonePctHp}`)
  out.push(`dungeon_route_smart_targeting=${s.smartTargeting ? 1 : 0}`)
  if (s.simpleDpsMembers > 0) out.push(`dungeon_route_simple_dps_members=${s.simpleDpsMembers}`)
  return out
}

export interface ImportedRoute extends ParsedRoute {
  sourceText: string
  name: string
  maxTime?: number
  keystoneLevel?: number
  buffs: Record<string, boolean>
  warnings: string[]
  /** Validated route setup. Keep an actor selected for profileset initialization. */
  profileLines: string[]
}

/** Accept a full Keystone.guru/MDT SimulationCraft export, not an actor profile. */
export function importRouteExport(text: string): ImportedRoute {
  const result: ImportedRoute = { sourceText: text, name: 'Imported route', lines: [], pulls: 0, enemies: 0, bosses: 0, issues: [], warnings: [], buffs: {}, profileLines: [] }
  if (text.length > 256 * 1024 || text.includes('\0')) { result.issues.push({ line: 0, message: 'Route exceeds the 256 KB limit or contains invalid characters.' }); return result }
  const global: string[] = [], pulls: string[] = []
  let renamed = false, renumbered = false
  for (const [index, raw] of text.replaceAll('\\_', '_').split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const assignment = /^(\w+(?:\.\w+)*)\s*(\+?=)\s*(.*)$/.exec(line)
    if (!assignment) { result.issues.push({ line: index + 1, message: 'Expected a SimulationCraft route option.' }); continue }
    const [, key, op, value] = assignment
    if (key === 'raid_events') {
      for (const event of value.replace(/^\//, '').split('/')) {
        if (event.startsWith('invulnerable,')) {
          if (!/^invulnerable,(?:(?:cooldown|duration|retarget)=[\d.]+,?)+$/.test(event)) result.issues.push({ line: index + 1, message: 'Invalid route safeguard event.' })
          else global.push(`raid_events+=/${event}`)
          continue
        }
        if (!event.startsWith('pull,')) { result.issues.push({ line: index + 1, message: 'Only pull and invulnerable events are supported in route imports.' }); continue }
        const options = splitOptions(event.slice(5)), number = pulls.length + 1
        if (options.has('pull') && Number(options.get('pull')) !== number) renumbered = true
        options.set('pull', String(number))
        const seen = new Set<string>()
        if (options.has('enemies')) options.set('enemies', options.get('enemies')!.split('|').map(enemy => {
          const parts = enemy.split(':'); const name = parts[0].replace(/^"|"$/g, '')
          if (!/^[A-Za-z0-9_.-]+$/.test(name)) result.issues.push({ line: index + 1, message: 'Enemy names must use letters, numbers, underscores, periods or hyphens.' })
          let unique = name, suffix = 2
          while (seen.has(unique)) { unique = `${name}_${suffix++}`; renamed = true }
          seen.add(unique); parts[0] = unique; return parts.join(':')
        }).join('|'))
        for (const [option, val] of options) if (!['enemies', 'pull', 'delay', 'bloodlust', 'shared_health'].includes(option) || option !== 'enemies' && !/^\d+(?:\.\d+)?$/.test(val)) result.issues.push({ line: index + 1, message: `Unsupported or invalid pull option: ${option}.` })
        pulls.push('raid_events+=/pull,' + [...options].map(([k, v]) => `${k}=${v}`).join(','))
      }
      continue
    }
    if (op !== '=') { result.issues.push({ line: index + 1, message: `Cannot append ${key}.` }); continue }
    if (key === 'fight_style') { if (value !== 'DungeonRoute') result.issues.push({ line: index + 1, message: 'Route exports must use DungeonRoute.' }); continue }
    if (key === 'enemy') { result.name = value.replace(/^"|"$/g, '').slice(0, 200); continue }
    if (/^override\.(bloodlust|arcane_intellect|power_word_fortitude|mark_of_the_wild|battle_shout|mystic_touch|chaos_brand|skyfury|hunters_mark|bleeding)$/.test(key) && /^[01]$/.test(value)) { result.buffs[key.slice(9)] = value === '1'; continue }
    if (['max_time', 'keystone_level', 'enemy_health', 'single_actor_batch', 'keystone_pct_hp', 'dungeon_route_smart_targeting', 'dungeon_route_simple_dps_members'].includes(key) && /^\d+(?:\.\d+)?$/.test(value)) {
      if (key === 'max_time') result.maxTime = Number(value)
      else if (key === 'keystone_level') { result.keystoneLevel = Number(value); global.push(line) }
      else if (key !== 'enemy_health') global.push(line)
      continue
    }
    result.issues.push({ line: index + 1, message: `Unsupported route option: ${key}.` })
  }
  const parsed = parseRoute(pulls.join('\n'))
  Object.assign(result, { lines: parsed.lines, pulls: parsed.pulls, enemies: parsed.enemies, bosses: parsed.bosses })
  result.issues.push(...parsed.issues)
  if (!result.pulls) result.issues.push({ line: 0, message: 'The route contains no pulls.' })
  if (renumbered) result.warnings.push('Pulls renumbered consecutively so the engine runs every pull.')
  if (renamed) result.warnings.push('Repeated enemy labels made unique; health and enemy counts are unchanged.')
  // These remaining options resolve at sim scope without clearing the actor.
  // active=0 makes SimC skip profileset initialization, then index an empty list.
  result.profileLines = [`# Frostsim route: ${result.name}`, 'enemy=frostsim_route_target', 'enemy_health=999999', 'raid_events=', ...global, ...parsed.lines]
  return result
}

/** Match the engine's numeric pull ID, including exported zero-padded IDs. */
export function hasFirstPull(text: string): boolean {
  return text.split(/\r?\n/).some(line => /^\s*raid_events\+?=/.test(line) && line.split('/').some(event => /(?:^|=)pull,/.test(event) && /(?:^|,)pull=0*1(?:,|\s*$)/.test(event)))
}

export function routeSummary(lines: readonly string[]): { name: string; pulls: number } {
  return { name: lines.find(l => l.startsWith('# Frostsim route: '))?.slice(18) ?? 'Imported route', pulls: lines.filter(l => /^raid_events\+?=/.test(l)).reduce((n,l) => n + (l.match(/(?:\/|=)pull,/g)?.length ?? 0), 0) }
}
