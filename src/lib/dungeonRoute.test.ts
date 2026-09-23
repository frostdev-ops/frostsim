import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkSettings, importRouteExport, parseRoute, ROUTE_DEFAULTS, routeOptions, routePulls } from './dungeonRoute'

// P10.9: rules from vendor/simc not inferred; no dungeon mappings invented here.

describe('parseRoute', () => {
  it('accepts the engine’s own pull syntax and counts what it spawns', () => {
    const r = parseRoute([
      '# first pull',
      'raid_events+=/pull,enemies=Mob_A:1000000|Mob_B:500000,delay=5,bloodlust=0',
      'raid_events+=/pull,enemies=BOSS_Big:9000000,delay=20,bloodlust=1',
    ].join('\n'))
    expect(r.issues).toEqual([])
    expect(r.pulls).toBe(2)
    expect(r.enemies).toBe(3)
    expect(r.bosses).toBe(1)
    expect(r.lines).toHaveLength(2)
  })

  it('counts the copy field, which multiplies one entry into several enemies', () => {
    const r = parseRoute('raid_events+=/pull,enemies=Trash:100:humanoid:4')
    expect(r.issues).toEqual([])
    expect(r.enemies).toBe(4)
  })

  it('rejects a line that is not a pull event', () => {
    const r = parseRoute('fight_style=DungeonRoute')
    expect(r.issues[0].line).toBe(1)
    expect(r.issues[0].message).toContain('raid_events+=/pull,')
  })

  it('catches the enemy string the engine throws on', () => {
    // raid_event.cpp throws "bad enemy string" and aborts the whole run, which
    // reaches the user as a failed simulation long after they left the input.
    const r = parseRoute('raid_events+=/pull,enemies=JustAName')
    expect(r.issues[0].message).toContain('NAME:HEALTH')
  })

  it('catches health and copy counts that are not numbers', () => {
    expect(parseRoute('raid_events+=/pull,enemies=A:lots').issues[0].message).toContain('not a positive number')
    expect(parseRoute('raid_events+=/pull,enemies=A:100:humanoid:many').issues[0].message).toContain('whole number')
  })

  it('catches a pull with no enemies, which would spawn nothing', () => {
    expect(parseRoute('raid_events+=/pull,delay=5').issues[0].message).toContain('no enemies=')
  })

  it('checks the boolean flags the engine only accepts as 0 or 1', () => {
    expect(parseRoute('raid_events+=/pull,enemies=A:1,bloodlust=yes').issues[0].message)
      .toContain('must be 0 or 1')
    expect(parseRoute('raid_events+=/pull,enemies=A:1,shared_health=1').issues).toEqual([])
  })

  it('ignores comments and blank lines', () => {
    expect(parseRoute('\n# nothing here\n   \n').pulls).toBe(0)
  })
})

describe('checkSettings', () => {
  it('accepts the defaults', () => {
    expect(checkSettings(ROUTE_DEFAULTS)).toEqual([])
  })

  it('enforces the engine’s own bounds', () => {
    expect(checkSettings({ ...ROUTE_DEFAULTS, keystonePctHp: 120 })[0].message).toContain('0 and 100')
    // sim.cpp:3930 bounds this at 0-3 and the engine rejects anything else.
    expect(checkSettings({ ...ROUTE_DEFAULTS, simpleDpsMembers: 4 })[0].message).toContain('0 to 3')
    expect(checkSettings({ ...ROUTE_DEFAULTS, keystoneLevel: -1 })[0].message).toContain('0 or more')
  })

  it('repeats the engine’s own warning about the awkward pairing', () => {
    const issues = checkSettings({ ...ROUTE_DEFAULTS, simpleDpsMembers: 2, keystonePctHp: 60 })
    expect(issues[0].message).toContain('will not scale enemy health')
  })
})

describe('routeOptions', () => {
  it('emits the engine’s own spelling, omitting defaults', () => {
    expect(routeOptions(ROUTE_DEFAULTS)).toEqual([
      'fight_style=DungeonRoute',
      'dungeon_route_smart_targeting=1',
    ])
  })

  it('includes every option the user actually set', () => {
    expect(routeOptions({
      keystoneLevel: 12, keystonePctHp: 30, smartTargeting: false, simpleDpsMembers: 2,
    })).toEqual([
      'fight_style=DungeonRoute',
      'keystone_level=12',
      'keystone_pct_hp=30',
      'dungeon_route_smart_targeting=0',
      'dungeon_route_simple_dps_members=2',
    ])
  })
})

describe('routePulls', () => {
  it('breaks a real export into per-pull rows', () => {
    const route = importRouteExport(readFileSync('public/routes/ruby-life-pools.simc', 'utf8'))
    const pulls = routePulls(route)
    expect(route.issues).toEqual([])
    expect(pulls.map(p => p.pull)).toEqual(Array.from({ length: route.pulls }, (_, i) => i + 1))
    expect(pulls[0].enemies).toHaveLength(8)
    expect(pulls[0].delay).toBe(16)
    expect(pulls[0].bloodlust).toBe(false)
    expect(pulls[0].enemies[0]).toEqual({ name: 'primal-juggernaut_1', health: 5653382, boss: false })
    const boss = pulls[2].enemies.at(-1)!
    expect(boss).toEqual({ name: 'defier-draghar_1', health: 8833410, boss: true })
  })

  it('defaults the fields a line omits', () => {
    expect(routePulls(parseRoute('raid_events+=/pull,enemies=Mob_A:1000'))[0])
      .toEqual({ pull: 1, delay: 0, bloodlust: false, enemies: [{ name: 'Mob_A', health: 1000, boss: false }] })
  })

  it('expands the copy field so the rows match the summary count', () => {
    const route = parseRoute('raid_events+=/pull,pull=1,delay=5,bloodlust=1,enemies=Trash_A:1000:humanoid:4|BOSS_Big:9000')
    const [pull] = routePulls(route)
    expect(pull.enemies).toHaveLength(route.enemies)
    expect(pull.enemies).toHaveLength(5)
    expect(pull.delay).toBe(5)
    expect(pull.bloodlust).toBe(true)
    expect(pull.enemies.filter(e => e.name === 'Trash_A')).toHaveLength(4)
    expect(pull.enemies.at(-1)).toEqual({ name: 'Big', health: 9000, boss: true })
  })
})
