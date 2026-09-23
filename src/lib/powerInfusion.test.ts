import { describe, expect, it } from 'vitest'
import { piDetailView, piRows, spreadOf, type PiData, type PiReportPlayer, type PiVariant } from './powerInfusion'

const v = (dps: number, prio: number, sd = 300): PiVariant => ({ dps: [dps, sd], prio: [prio, sd] })

const data: PiData = {
  schemaVersion: 1,
  engine: { commit: 'c0ffee', simcVersion: '1210-01', wowVersion: '12.1.0' },
  profiles: 'MID2',
  fightStyle: 'CastingPatchwerk',
  targetError: 0.1,
  generatedAt: '2026-09-22',
  specs: [
    {
      name: 'Marksmanship Hunter', profile: 'MID2_Hunter_Marksmanship', piTiming: 'apl', funnel: 'max_prio_damage',
      runs: [
        { targets: 1, base: v(200_000, 200_000), pi: v(210_000, 210_000) },
        {
          targets: 5, base: v(440_000, 180_000), pi: v(460_000, 186_000),
          funnel: v(437_000, 197_000), funnelPi: v(456_000, 207_000),
        },
      ],
    },
    {
      name: 'Outlaw Rogue', profile: 'MID2_Rogue_Outlaw', piTiming: 'cooldown', funnel: null,
      runs: [
        { targets: 1, base: v(250_000, 250_000), pi: v(260_000, 260_000) },
        { targets: 5, base: v(400_000, 100_000), pi: v(400_500, 100_200) },
      ],
    },
  ],
}

const byId = (targets: number) => Object.fromEntries(piRows(data, targets, 'total', 'dps').map((r) => [r.id, r]))

describe('piRows', () => {
  it('gives every row its gain on all targets, on the main target, and the share funneled', () => {
    const { 'Marksmanship Hunter': off, 'Marksmanship Hunter/funnel': on, 'Outlaw Rogue': outlaw } = byId(5)
    expect(off).toMatchObject({ label: 'Marksmanship Hunter (funnel option off)', funnel: false })
    expect(off.total).toMatchObject({ gain: 20_000, noise: false })
    expect(off.total.pct).toBeCloseTo(20_000 / 440_000 * 100)
    expect(off.total.margin).toBeCloseTo(1.96 * Math.hypot(300, 300))
    expect(off.main.gain).toBe(6_000)
    expect(off.toMain).toBeCloseTo(6_000 / 20_000)
    expect(on).toMatchObject({ label: 'Marksmanship Hunter (funnel option on)', funnel: true })
    expect([on.total.gain, on.main.gain]).toEqual([19_000, 10_000])
    expect(on.toMain).toBeCloseTo(10_000 / 19_000)
    // 500 total gain against a ~832 margin is noise, so no share; cooldown timing carried through.
    expect(outlaw.total.noise).toBe(true)
    expect(outlaw).toMatchObject({ cooldown: true })
    expect(outlaw.toMain).toBeUndefined()
  })

  it('ranks by the chosen measure and unit', () => {
    expect(piRows(data, 5, 'main', 'dps').map((r) => r.id))
      .toEqual(['Marksmanship Hunter/funnel', 'Marksmanship Hunter', 'Outlaw Rogue'])
    expect(piRows(data, 5, 'total', 'dps').map((r) => r.id))
      .toEqual(['Marksmanship Hunter', 'Marksmanship Hunter/funnel', 'Outlaw Rogue'])
    // One target: 5% beats 4%.
    expect(piRows(data, 1, 'total', 'pct').map((r) => r.id)).toEqual(['Marksmanship Hunter', 'Outlaw Rogue'])
    expect(piRows(data, 2, 'total', 'dps')).toEqual([])
    // Share funneled; a noise row has none and sorts last.
    expect(piRows(data, 5, 'toMain', 'dps').map((r) => r.id))
      .toEqual(['Marksmanship Hunter/funnel', 'Marksmanship Hunter', 'Outlaw Rogue'])
    expect(piRows(data, 5, 'toMain', 'dps').map((r) => r.spec))
      .toEqual(['Marksmanship Hunter', 'Marksmanship Hunter', 'Outlaw Rogue'])
  })

  it('at one target: no funnel rows, no rotation reading, everything lands on the main target', () => {
    const one = byId(1)
    expect(Object.keys(one)).toEqual(['Marksmanship Hunter', 'Outlaw Rogue'])
    expect(one['Marksmanship Hunter'].label).toBe('Marksmanship Hunter')
    expect(one['Marksmanship Hunter']).not.toHaveProperty('kept')
    expect(one['Marksmanship Hunter'].toMain).toBe(1)
  })

  it('reads the rotation from the main target with PI against the same alone', () => {
    const { 'Marksmanship Hunter': off, 'Marksmanship Hunter/funnel': on } = byId(5)
    expect(off.kept).toBeCloseTo(186_000 / 210_000)
    expect(off.spread).toBe('slight')
    expect(on.kept).toBeCloseTo(207_000 / 210_000)
    expect(on.spread).toBe('holds')
    expect([0.95, 0.9499, 0.85, 0.8499].map(spreadOf)).toEqual(['holds', 'slight', 'slight', 'spreads'])
  })
})

const stat = (name: string, dps: number, extra = {}) => ({ name, spell_name: name.toUpperCase(), type: 'damage', portion_apse: { mean: dps }, ...extra })
const player = (dps: [number, number], timeline: number[], up?: number[]): PiReportPlayer => ({
  name: 'MID2_Hunter_Beast_Mastery',
  stats: [stat('kill_shot', dps[0]), stat('volley', 0, { children: [stat('volley_tick', 50)] })],
  stats_pets: { duck: [stat('claw', dps[1])] },
  buffs: up ? [{ name: 'power_infusion', start_count: 2.8, uptime: 14.2, stack_uptime: { data: up } }] : [],
  collected_data: { timeline_dmg: { data: timeline } },
})

describe('piDetailView', () => {
  it('pairs the no-PI and PI reports second by second and source by source, pets included', () => {
    const run = {
      targets: 3,
      base: player([100, 40], [10, 10, 10, 10]),
      pi: player([120, 44], [10, 13, 14, 10, 9], [0, 0.6, 1, 0.4, 0]),
    }
    const v = piDetailView(run, false)
    // Shorter of the two timelines; PI up in at least half the runs from second 1 to 3.
    expect(v.timeline.map((s) => s.gain)).toEqual([0, 3, 4, 0])
    expect(v.timeline[2]).toEqual({ t: 2, without: 10, with: 14, gain: 4, piUp: 1 })
    expect(v.piWindows).toEqual([[1, 3]])
    expect(v.pi).toEqual({ casts: 2.8, uptimePct: 14.2 })
    // Breakdown from damageBreakdown: children roll into their parent, the pet is one source.
    expect(v.abilities.map((a) => [a.key, a.without, a.with, a.gain])).toEqual([
      ['own:kill_shot', 100, 120, 20], ['own:volley', 50, 50, 0], ['pet:duck', 40, 44, 4],
    ])
    expect(v.abilities[2]).toMatchObject({ label: 'duck', pet: true })
    expect(() => piDetailView(run, true)).toThrow('No funnel detail')
  })
})
