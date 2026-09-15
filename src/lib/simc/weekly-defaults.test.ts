import { describe, expect, it } from 'vitest'
import { applyWeeklyDefaults, weeklyDefaultLines } from './weekly-defaults'
import defaults from './generated/weekly-defaults.json'
import engineLock from '../../../engine.lock.json'

describe('generated Weekly defaults', () => {
  const profile = 'warlock=Fixture\nspec=demonology\nlevel=90\n'
  it('only supplies the verified omitted default and preserves explicit input', () => {
    expect(defaults.engine.commit).toBe(engineLock.upstream.commit)
    expect(weeklyDefaultLines(profile)).toEqual(['potion=potion_of_recklessness_2'])
    for (const value of ['', 'disabled', 'liquid_luster_2']) expect(weeklyDefaultLines(profile + `potion=${value}\n`)).toEqual([])
    expect(weeklyDefaultLines(profile + '# potion=disabled\n')).toHaveLength(1)
    expect(weeklyDefaultLines(profile.replace('90', '89'))).toEqual([])
    expect(weeklyDefaultLines(profile.replace('demonology', 'affliction'))).toEqual([])
    expect(weeklyDefaultLines(profile.replace('warlock', 'mage'))).toEqual([])
    expect(weeklyDefaultLines(profile + 'warlock=Second\nspec=demonology\nlevel=90')).toEqual([])
    expect(weeklyDefaultLines(profile + 'copy=Second,Fixture\n')).toEqual([])
    expect(applyWeeklyDefaults(profile + 'enemy=Target\n')).toBe('warlock=Fixture\npotion=potion_of_recklessness_2\nspec=demonology\nlevel=90\nenemy=Target\n')
    expect(applyWeeklyDefaults(profile + 'potion=\n')).toBe(profile + 'potion=\n')
    expect(applyWeeklyDefaults(applyWeeklyDefaults(profile))).toBe(applyWeeklyDefaults(profile))
  })
})
