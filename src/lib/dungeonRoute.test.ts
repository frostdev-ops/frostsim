import { describe, expect, it } from 'vitest'
import { checkSettings, parseRoute, ROUTE_DEFAULTS, routeOptions } from './dungeonRoute'

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
