// Dungeon Route compares: each role faces its share of the route's enemy health. A route's health is one damage dealer's share of
// what the group kills (Keystone.guru and MDT exports scale it that way, and simc assumes it: raid_event.cpp). In a multi-character
// run every character is its own sim (single_actor_batch=1), so every damage dealer faces the same health. A tank or healer deals
// far less of a group's damage, so they face less, in simc's own log-derived ratio (raid_event.cpp: a damage dealer 27%, a tank
// 14%, a healer 5%). Route health is fixed for a whole sim (raid events are built once), so each role runs as its own sim and the
// reports are concatenated like hybrid characters (D3: no statistics are combined).

import type { SimRequest } from './assemble'
import { characterBlocks } from './multi-actor'

export type Role = 'dps' | 'tank' | 'heal'

/** simc's per-role share of a group's damage (raid_event.cpp, dungeon_route_simple_dps_members). */
export const ROLE_SHARE: Readonly<Record<Role, number>> = { dps: 27, tank: 14, heal: 5 }

const TANKS = new Set(['deathknight/blood', 'demonhunter/vengeance', 'druid/guardian', 'monk/brewmaster', 'paladin/protection', 'warrior/protection'])
const HEALERS = new Set(['druid/restoration', 'evoker/preservation', 'monk/mistweaver', 'paladin/holy', 'priest/discipline', 'priest/holy', 'shaman/restoration'])

/** A character block's role from its class line and `spec=`. */
export function roleOf(block: string): Role {
  const cls = /^\s*(\w+)\s*=/.exec(block.split('\n').find((l) => /^\s*(deathknight|demonhunter|druid|evoker|hunter|mage|monk|priest|paladin|rogue|shaman|warlock|warrior)\s*=/i.test(l)) ?? '')?.[1]?.toLowerCase()
  const spec = /^\s*spec\s*=\s*(\w+)/m.exec(block)?.[1]?.toLowerCase()
  const key = `${cls}/${spec}`
  return TANKS.has(key) ? 'tank' : HEALERS.has(key) ? 'heal' : 'dps'
}

const ROUTE_LINE = /^\s*raid_events\s*\+?=/

/** Route lines with every enemy's health multiplied by `factor` (at least 1). Enemies are NAME:HEALTH[:RACE:COUNT]. */
export function scaleRouteHealth(lines: readonly string[], factor: number): string[] {
  return lines.map((line) => (!ROUTE_LINE.test(line) ? line : line.replace(/(enemies=)([^,\s]+)/g, (_, key: string, list: string) => key + list.split('|').map((enemy) => {
    const parts = enemy.split(':')
    const health = Number(parts[1])
    if (parts.length >= 2 && Number.isFinite(health)) parts[1] = String(Math.max(1, Math.round(health * factor)))
    return parts.join(':')
  }).join('|'))))
}

export interface RoleGroup { role: Role; names: string[]; request: SimRequest }

/** A Dungeon Route run of two or more characters, split by role with each tank and healer group's route health scaled; null when
 *  nothing changes (another fight, one character, or every character a damage dealer). Damage dealers first. */
export function roleGroups(req: SimRequest): RoleGroup[] | null {
  if (req.settings.fightStyle !== 'DungeonRoute' || req.mode === 'raw' || req.profilesets?.length) return null
  const blocks = characterBlocks(req.profile)
  if (blocks.length < 2) return null
  const by = new Map<Role, typeof blocks>()
  for (const b of blocks) {
    const role = roleOf(b.text)
    by.set(role, [...(by.get(role) ?? []), b])
  }
  if (by.size === 1 && by.has('dps')) return null
  return (['dps', 'tank', 'heal'] as const).filter((r) => by.has(r)).map((role) => ({
    role,
    names: by.get(role)!.map((b) => b.name),
    request: {
      ...req,
      profile: by.get(role)!.map((b) => b.text).join('\n'),
      extraProfileLines: scaleRouteHealth(req.extraProfileLines ?? [], ROLE_SHARE[role] / ROLE_SHARE.dps),
    },
  }))
}

/** What the result says about the split. */
export function roleNote(groups: readonly RoleGroup[]): string {
  const faced = groups.filter((g) => g.role !== 'dps')
    .map((g) => `${g.names.join(', ')} (${g.role === 'tank' ? 'tank' : 'healer'}) faced ${Math.round((ROLE_SHARE[g.role] / ROLE_SHARE.dps) * 100)}%`)
  return `Dungeon Route compare: every damage dealer faced the route's full enemy health; ${faced.join('; ')} of it, simc's share of a group's damage for the role. Each role ran as its own sim.`
}
