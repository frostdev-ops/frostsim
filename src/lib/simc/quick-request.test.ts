import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAddonExport } from '../import/character'
import { importRouteExport } from '../dungeonRoute'
import { validateRequest } from './assemble'
import { withPlayerScopedLines } from './options'
import { FIGHT_PRESETS, findPreset } from './presets'
import { raidBuffLines } from './raid-buffs'
import { quickRequest, scenarioLines } from './quick-request'
import { ToolSettings, type SettingsSnapshot } from '../settings.svelte'

const character = parseAddonExport(readFileSync(new URL('../../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8'))
const route = readFileSync(new URL('../../../public/routes/ruby-life-pools.simc', import.meta.url), 'utf8')

/** ToolSettings.extraProfileLines() as it was before it delegated, kept verbatim as the parity reference. */
function before(s: ToolSettings): string[] {
  const lines = [...raidBuffLines(s.raidBuffs), ...(findPreset(s.presetId)?.profileLines ?? [])]
  if (s.fightStyle === 'DungeonRoute' && s.routeText) {
    const imported = importRouteExport(s.routeText)
    if (imported.issues.length) throw new Error(imported.issues[0].message)
    lines.push(...imported.profileLines)
  }
  const actor = Object.entries({ ...s.consumables, ...s.equipmentOptions }).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`)
  return withPlayerScopedLines(lines, actor)
}

describe('scenarioLines', () => {
  it('gives ToolSettings exactly the lines it built before, for every preset', () => {
    const variants: Partial<SettingsSnapshot>[] = [
      {},
      { raidBuffs: { bloodlust: false, skyfury: true } },
      { consumables: { potion: 'disabled', flask: '' }, equipmentOptions: { 'midnight.crucible_of_erratic_energies_violence': '1' } },
      { raidBuffs: { hunters_mark: true }, consumables: { food: 'hearty_feast' }, routeText: route },
    ]
    let compared = 0
    for (const preset of FIGHT_PRESETS) {
      for (const [i, v] of variants.entries()) {
        const s = new ToolSettings(`parity-${preset.id}-${i}`, v)
        s.selectPreset(preset.id)
        expect(s.extraProfileLines()).toEqual(before(s))
        compared++
      }
    }
    expect(compared).toBe(FIGHT_PRESETS.length * variants.length)
  })

  it('throws the same route problem the settings did', () => {
    const s = new ToolSettings('parity-bad-route', { routeText: 'fight_style=Patchwerk' })
    s.selectPreset('dungeon-route')
    expect(() => before(s)).toThrow()
    expect(() => s.extraProfileLines()).toThrow(new Error(importRouteExport('fight_style=Patchwerk').issues[0].message))
  })

  it('puts actor options before an enemy a preset declares', () => {
    const lines = scenarioLines({ presetId: 'target-dummy', fightStyle: 'Patchwerk', actorOptions: { potion: 'disabled' } })
    expect(lines).toEqual(['potion=disabled', 'enemy=Fluffy_Pillow', 'enemy_fixed_health_percentage=100'])
  })
})

describe('quickRequest', () => {
  it('builds a valid request for every preset, and refuses Dungeon Route without a route', () => {
    for (const preset of FIGHT_PRESETS) {
      const req = quickRequest(character, { presetId: preset.id, threads: 4 })
      const issues = validateRequest(req, 16)
      if (preset.id === 'dungeon-route') {
        expect(issues.some((i) => i.message.includes('pull=1'))).toBe(true)
        expect(validateRequest(quickRequest(character, { presetId: preset.id, threads: 4, routeText: route }), 16)).toEqual([])
      } else {
        expect(issues).toEqual([])
      }
      expect(req.settings.fightStyle).toBe(preset.fightStyle)
    }
  })

  it('matches what the Quick Sim settings send for the same choices', () => {
    const s = new ToolSettings('parity-quick', { raidBuffs: { bloodlust: false }, consumables: { potion: 'disabled' } })
    s.selectPreset('execute-patchwerk')
    const req = quickRequest(character, { presetId: 'execute-patchwerk', threads: 4, raidBuffs: { bloodlust: false }, actorOptions: { potion: 'disabled' } })
    expect(req.extraProfileLines).toEqual(s.extraProfileLines())
    expect(req.settings).toEqual({ fightStyle: s.fightStyle, maxTime: s.maxTime, targets: s.targets, threads: 4 })
    expect(req.accuracy).toEqual(s.accuracy())
  })

  it('applies the fight lengths upstream forces, and a talent override', () => {
    expect(quickRequest(character, { presetId: 'dungeon-slice', threads: 4, maxTime: 100, targets: 5 }).settings).toMatchObject({ maxTime: 360, targets: 1 })
    expect(quickRequest(character, { presetId: 'ultraxion', threads: 4, targets: 3 }).settings).toMatchObject({ maxTime: 366, targets: 3 })
    expect(quickRequest(character, { presetId: 'patchwerk', threads: 4, talents: 'ABC123' }).profile).toContain('talents=ABC123')
    expect(() => quickRequest(character, { presetId: 'nope', threads: 4 })).toThrow('Unknown fight preset')
  })
})
