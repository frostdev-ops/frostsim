import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { damageBreakdown, parsePlayerDetail, PlayerNotInReportError } from './detail'
import { parseReport } from './report'

// Shapes from real v2 report (MID2_Mage_Frost, 50 iterations, 4 threads), trimmed to parser-read fields.
const report = {
  version: '1210-01',
  report_version: '2.0.0',
  sim: {
    options: {
      iterations: 53,
      target_error: 0,
      threads: 4,
      max_time: 300,
      fight_style: 'Patchwerk',
      desired_targets: 1,
      single_actor_batch: false,
      fixed_time: true,
      confidence: 0.95,
      confidence_estimator: 1.9599639854088815,
    },
    players: [
      {
        name: 'MID2_Mage_Frost_Spellslinger',
        specialization: 'Frost Mage',
        collected_data: {
          dps: { sum: 1, count: 49, mean: 223973.7, min: 1, max: 2 },
          action_sequence_precombat: [
            { time: 0, id: 1236994, name: 'potion', target: 'none', spell_name: 'Potion of Recklessness' },
          ],
          action_sequence: [
            {
              time: 3.267,
              id: 84714,
              name: 'frozen_orb',
              target: 'Fluffy_Pillow',
              spell_name: 'Frozen Orb',
              queue_failed: false,
              buffs: [
                { id: 205473, name: 'icicles', stacks: 1 },
                { id: 2825, name: 'bloodlust', stacks: 1 },
              ],
              resources: { mana: 250000 },
            },
          ],
        },
        stats: [
          {
            id: 1297908,
            spell_name: 'Font of Venomous Rage',
            name: 'font_of_venomous_rage',
            school: 'nature',
            type: 'damage',
            num_executes: { sum: 98, count: 49, mean: 2 },
            compound_amount: 4844927.095296284,
            portion_aps: { sum: 796766.88, count: 49, mean: 16260.548720665005 },
            portion_apse: { sum: 796766.88, count: 49, mean: 16260.548720665005 },
            portion_amount: 0.07189403648837234,
            num_ticks: { sum: 490, count: 49, mean: 10 },
            tick_results: {
              crit: { count: { sum: 262, count: 49, mean: 5.35 }, pct: 53.46938775510205 },
              hit: { count: { sum: 228, count: 49, mean: 4.65 }, pct: 46.53 },
            },
          },
          {
            id: 228354,
            spell_name: 'Frostbolt',
            name: 'frostbolt',
            school: 'frost',
            type: 'damage',
            num_executes: { sum: 7300, count: 49, mean: 148.98 },
            compound_amount: 9000000,
            portion_aps: { sum: 1, count: 49, mean: 30000 },
            portion_apse: { sum: 1, count: 49, mean: 30000 },
            portion_amount: 0.2,
            children: [
              {
                id: 228354,
                spell_name: 'Flurry',
                name: 'flurry_bolt',
                school: 'frost',
                type: 'damage',
                num_executes: { sum: 7300, count: 49, mean: 148.98 },
                compound_amount: 4566155.891593359,
                portion_aps: { sum: 742677.4, count: 49, mean: 15156.681618500788 },
                portion_apse: { sum: 742677.4, count: 49, mean: 15156.681618500788 },
              },
            ],
          },
          {
            id: 1264426,
            spell_name: 'Void-Touched',
            name: 'augmentation',
            type: 'damage',
            num_executes: { sum: 49, count: 49, mean: 1 },
            compound_amount: 0,
          },
        ],
        stats_pets: {
          // Pet up for part of fight; rate while active is 5x contribution (engine emits both portion_aps and portion_apse).
          water_elemental: [
            {
              id: 31707,
              spell_name: 'Waterbolt',
              name: 'waterbolt',
              school: 'frost',
              type: 'damage',
              num_executes: { sum: 490, count: 49, mean: 10 },
              compound_amount: 500000,
              portion_aps: { sum: 1, count: 49, mean: 12500 },
              portion_apse: { sum: 1, count: 49, mean: 2500 },
            },
          ],
        },
        buffs_constant: [
          {
            name: 'arcane_intellect',
            spell_name: 'Arcane Intellect',
            spell_school: 'arcane',
            spell: 1459,
            start_count: 1,
            duration: 301.0641320754717,
            uptime: 100,
            default_value: 0.03,
          },
        ],
        buffs: [
          {
            name: 'akilzons_rite',
            spell_name: "Akil'zon's Rite",
            spell_school: 'arcane',
            spell: 1297664,
            start_count: 4.3061224489795915,
            refresh_count: 1.7959183673469388,
            duration: 17.035094827586207,
            uptime: 24.19347730413918,
            expire_count: 4.040816326530612,
          },
        ],
      },
    ],
    statistics: { elapsed_time_seconds: 0.17 },
  },
}

const PLAYER = 'MID2_Mage_Frost_Spellslinger'

describe('parsePlayerDetail abilities', () => {
  it('ranks pet groups with player spells and attributes expanded abilities to their owner', () => {
    const detail = parsePlayerDetail(report, PLAYER)
    const rows = damageBreakdown(detail)
    expect(rows.reduce((sum, row) => sum + row.dpsWithChildren, 0)).toBeCloseTo(detail.totalDps, 6)
    expect(rows.reduce((sum, row) => sum + (row.portionPct ?? 0), 0)).toBeCloseTo(100, 6)
    const pet = rows.find((row) => row.isPet)!
    expect(pet).toMatchObject({ owner: PLAYER, pet: 'water_elemental', dpsWithChildren: 2500 })
    expect(pet.children![0]).toMatchObject({ owner: PLAYER, pet: 'water_elemental', spellName: 'Waterbolt', id: 31707 })
    expect(pet.children![0].portionPct).toBeCloseTo(2500 / detail.totalDps * 100, 6)
    expect(rows.some((row) => row.name === 'augmentation')).toBe(false)
    expect(rows.find((row) => row.name === 'frostbolt')?.children?.[0].spellName).toBe('Flurry')
  })

  it('keeps identical ability names from different pets distinct and uses the requested owner total', () => {
    const detail = parsePlayerDetail(report, PLAYER)
    detail.pets.push({ ...detail.pets[0], name: 'another_elemental' })
    const rows = damageBreakdown(detail, 100_000)
    const children = rows.filter((row) => row.isPet).flatMap((row) => row.children ?? [])
    expect(children.map((row) => row.name)).toEqual(['waterbolt', 'waterbolt'])
    expect(new Set(children.map((row) => row.key)).size).toBe(2)
    expect(children.map((row) => row.pet)).toEqual(['water_elemental', 'another_elemental'])
    expect(children.map((row) => row.portionPct)).toEqual([2.5, 2.5])
  })

  it('keeps damage descendants of non-damage nodes without counting healing in damage totals', () => {
    const stat = (name: string, type: string, amount: number, children: unknown[] = []) => ({
      name, type, actual_amount: { mean: amount }, compound_amount: amount,
      portion_apse: { mean: amount }, children,
    })
    const raw = { sim: { players: [{ name: 'Mixed', stats: [stat('hit', 'damage', 10, [
      stat('heal', 'heal', 20, [stat('proc', 'damage', 5)]),
    ])] }] } }
    const rows = damageBreakdown(parsePlayerDetail(raw, 'Mixed'), 15)
    expect(rows[0].dpsWithChildren).toBe(15)
    expect(rows[0].totalAmount).toBe(15)
    expect(rows[0].children?.map((row) => row.name)).toEqual(['proc'])
  })
  it('ranks abilities by their dps contribution', () => {
    const d = parsePlayerDetail(report, PLAYER)
    expect(d.abilities.map((a) => a.name)).toEqual(['frostbolt', 'font_of_venomous_rage', 'augmentation'])
    expect(d.abilities[1].dps).toBeCloseTo(16260.55, 2)
    expect(d.abilities[1].totalAmount).toBeCloseTo(4844927.1, 1)
    expect(d.abilities[1].executeCount).toBe(2)
    expect(d.abilities[1].tickCount).toBe(10)
    expect(d.abilities[1].portionPct).toBeCloseTo(7.189, 3)
    expect(d.abilities[1].school).toBe('nature')
  })

  it('computes crit share from the result counts, not from a per-bucket percentage', () => {
    // 262 crits out of 490 results.
    expect(parsePlayerDetail(report, PLAYER).abilities[1].critPct).toBeCloseTo((262 / 490) * 100, 6)
  })

  it('leaves crit share undefined when the engine recorded no results', () => {
    expect(parsePlayerDetail(report, PLAYER).abilities[2].critPct).toBeUndefined()
  })

  it('keeps dots and secondary effects as children rather than flattening them', () => {
    const frostbolt = parsePlayerDetail(report, PLAYER).abilities[0]
    expect(frostbolt.children?.map((c) => c.name)).toEqual(['flurry_bolt'])
    expect(frostbolt.children![0].dps).toBeCloseTo(15156.68, 2)
  })

  it('rolls children into dpsWithChildren, because a parent excludes them', () => {
    // Verified against a real report: the top level summed to 125,850 against a
    // reported 223,974, and only the recursive sum matched.
    const frostbolt = parsePlayerDetail(report, PLAYER).abilities[0]
    expect(frostbolt.dps).toBeCloseTo(30000, 6)
    expect(frostbolt.dpsWithChildren).toBeCloseTo(30000 + 15156.681618500788, 6)
  })

  it('reads pets as their own tree, which does not overlap the player tree', () => {
    const d = parsePlayerDetail(report, PLAYER)
    expect(d.pets).toHaveLength(1)
    expect(d.pets[0].name).toBe('water_elemental')
    expect(d.pets[0].dps).toBeCloseTo(2500, 6)
    // Player abilities (children included) + pets, counted once each.
    expect(d.totalDps).toBeCloseTo(30000 + 15156.681618500788 + 16260.548720665005 + 2500, 6)
  })

  it('takes contributions from portion_apse, never from portion_aps', () => {
    // stats.cpp:269-270 — portion_aps divides by the ACTOR's active time,
    // portion_apse by the fight length. For a pet up for part of the fight the
    // two differ by its uptime, and only the second is additive. Measured on a
    // 13-pet Demonology profile: apse totalled 234,531.8 against a reported
    // 234,531.8, while aps totalled 558,956.9.
    const pet = parsePlayerDetail(report, PLAYER).pets[0]
    expect(pet.dps).toBeCloseTo(2500, 6)
    expect(pet.rateWhileActive).toBeCloseTo(12500, 6)
    // The rate must never reach the additive total.
    expect(parsePlayerDetail(report, PLAYER).totalDps).not.toBeCloseTo(
      30000 + 15156.681618500788 + 16260.548720665005 + 12500,
      6,
    )
  })

  it('reports what share of the actor the ability table accounts for', () => {
    // The Mage's abilities are most of it; a pet spec's are a small fraction,
    // and the caller needs to be able to say so rather than implying the table
    // is the whole story.
    const d = parsePlayerDetail(report, PLAYER)
    expect(d.abilityShare).toBeCloseTo((30000 + 15156.681618500788 + 16260.548720665005) / 223973.7, 6)
  })

  it('handles an actor with no pets', () => {
    const noPets = {
      ...report,
      sim: {
        ...report.sim,
        players: [{ ...report.sim.players[0], stats_pets: {} }],
      },
    }
    const d = parsePlayerDetail(noPets, PLAYER)
    expect(d.pets).toEqual([])
    expect(d.totalDps).toBeCloseTo(30000 + 15156.681618500788 + 16260.548720665005, 6)
  })
})

describe('parsePlayerDetail buffs', () => {
  it('marks constant buffs apart from dynamic ones and sorts by uptime', () => {
    const buffs = parsePlayerDetail(report, PLAYER).buffs
    expect(buffs.map((b) => [b.name, b.constant])).toEqual([
      ['arcane_intellect', true],
      ['akilzons_rite', false],
    ])
    expect(buffs[1].uptimePct).toBeCloseTo(24.193, 3)
    expect(buffs[1].startCount).toBeCloseTo(4.306, 3)
    expect(buffs[1].refreshCount).toBeCloseTo(1.796, 3)
    expect(buffs[1].id).toBe(1297664)
  })

  it('does not clip uptime, because a multi-target buff can legitimately pass 100', () => {
    const wide = {
      ...report,
      sim: {
        ...report.sim,
        players: [{ ...report.sim.players[0], buffs: [{ name: 'chill', uptime: 265.4, start_count: 3 }] }],
      },
    }
    expect(parsePlayerDetail(wide, PLAYER).buffs[0].uptimePct).toBeCloseTo(265.4, 1)
  })
})

describe('parsePlayerDetail action sequence', () => {
  it('reads the sample sequence with its active buffs', () => {
    const d = parsePlayerDetail(report, PLAYER)
    expect(d.sequence).toHaveLength(1)
    expect(d.sequence[0]).toMatchObject({ time: 3.267, action: 'frozen_orb', target: 'Fluffy_Pillow' })
    expect(d.sequence[0].buffs.map((b) => b.name)).toEqual(['icicles', 'bloodlust'])
    expect(d.sequence[0].resources).toEqual({ mana: 250000 })
  })

  it('treats the engine\'s "none" target as no target', () => {
    expect(parsePlayerDetail(report, PLAYER).precombat[0].target).toBeUndefined()
  })

  it('returns empty sequences rather than failing when the engine recorded none', () => {
    const bare = {
      ...report,
      sim: {
        ...report.sim,
        players: [{ ...report.sim.players[0], collected_data: { dps: { sum: 1, count: 49, mean: 1, min: 1, max: 1 } } }],
      },
    }
    const d = parsePlayerDetail(bare, PLAYER)
    expect(d.sequence).toEqual([])
    expect(d.precombat).toEqual([])
  })
})

describe('parsePlayerDetail failure', () => {
  it('names the players it does have when asked for one it does not', () => {
    expect(() => parsePlayerDetail(report, 'Nobody')).toThrow(PlayerNotInReportError)
    expect(() => parsePlayerDetail(report, 'Nobody')).toThrow(new RegExp(PLAYER))
  })
})

// Point FROSTSIM_REPORT_FIXTURE=/tmp/out.json to test both parsers against real report; skipped unset (WASM-free by default).
const fixturePath = process.env.FROSTSIM_REPORT_FIXTURE
describe.skipIf(!fixturePath)('against a real engine report', () => {
  it('parses the summary and the detail without inventing anything', () => {
    const raw = JSON.parse(readFileSync(fixturePath!, 'utf8'))
    const summary = parseReport(raw)
    expect(summary.players.length).toBeGreaterThan(0)
    expect(summary.gameData?.wowVersion).toMatch(/^\d+\./)
    expect(summary.actualIterations).toBe(summary.players[0].dps.count)

    const detail = parsePlayerDetail(raw, summary.players[0].name)
    expect(detail.abilities.length).toBeGreaterThan(0)
    expect(detail.buffs.length).toBeGreaterThan(0)
    // Breakdown adds up to reported DPS; test pet specs too (Mage alone can't distinguish portion_aps from apse).
    expect(detail.totalDps).toBeCloseTo(summary.players[0].dps.mean, 0)
    const breakdown = damageBreakdown(detail, summary.players[0].dps.mean)
    expect(breakdown.reduce((sum, row) => sum + row.dpsWithChildren, 0)).toBeCloseTo(summary.players[0].dps.mean, 0)
    expect(breakdown.reduce((sum, row) => sum + row.totalAmount, 0)).toBeCloseTo(raw.sim.players[0].collected_data.compound_dmg.mean, 0)
    expect(detail.abilityShare).toBeGreaterThan(0)
    expect(detail.abilityShare).toBeLessThanOrEqual(1.0001)
    if (detail.pets.length) {
      // Rates while active > contributions for pets not up whole fight.
      const rates = detail.pets.reduce((s, p) => s + p.rateWhileActive, 0)
      const contributions = detail.pets.reduce((s, p) => s + p.dps, 0)
      expect(rates).toBeGreaterThanOrEqual(contributions)
    }
  })
})
