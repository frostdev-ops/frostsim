import { describe, expect, it } from 'vitest'
import { encounterFor, fightGif, FIGHT_GIFS, heroStyle } from './style'

describe('pixel battle style', () => {
  it('picks melee or ranged from class and spec', () => {
    expect(heroStyle('warlock', 'demonology')).toMatchObject({ melee: false, weapon: 'staff' })
    expect(heroStyle('druid', 'feral')).toMatchObject({ melee: true, weapon: 'claws' })
    expect(heroStyle('shaman', 'elemental').shot).toBe('lightning')
    expect(heroStyle('death knight', 'frost').melee).toBe(true)
    expect(heroStyle(undefined).weapon).toBe('staff')
    expect(heroStyle('warlock', 'demonology').pets).toEqual(['felguard', 'wildimp', 'wildimp', 'wildimp'])
    expect(heroStyle('hunter', 'beast mastery').pets).toEqual(['wolf', 'wolf'])
    expect(heroStyle('mage', 'frost').pets).toEqual([])
    expect(heroStyle('death knight', 'unholy').pets).toEqual(['ghoul'])
    expect(heroStyle('paladin', 'retribution')).toMatchObject({ weapon: 'greatsword', holy: true })
  })

  it('reads the class keys exports write, and names each look\'s Discord GIF', () => {
    expect(heroStyle('deathknight', 'blood')).toEqual(heroStyle('death knight', 'blood'))
    expect(heroStyle('demonhunter').weapon).toBe('glaives')
    expect(fightGif('deathknight', 'unholy')).toBe('death_knight-unholy')
    expect(fightGif('mage', 'frost')).toBe('mage')
    expect(fightGif('warlock', 'demonology')).toBe('warlock-demonology')
    expect(fightGif('bard')).toBeNull()
    expect(FIGHT_GIFS.map((g) => g.name)).toContain('hunter-beast_mastery')
  })

  it('shapes the enemies from fight style, targets and tool', () => {
    expect(encounterFor('Patchwerk', 1, 'quick')).toMatchObject({ boss: 'boss', adds: 0, loot: null })
    expect(encounterFor('ExecutePatchwerk').bossStart).toBe(0.2)
    expect(encounterFor('CastingPatchwerk').bossAttack).toBe('orb')
    expect(encounterFor('HecticAddCleave', 3, 'gear')).toMatchObject({ boss: 'boss', adds: 3, loot: 'gem' })
    expect(encounterFor('DungeonSlice', 8, 'crests')).toMatchObject({ boss: null, adds: 5, loot: 'coin' })
    expect(encounterFor('TargetDummy').boss).toBe('dummy')
  })
})

describe('Discord fight GIFs', () => {
  it('has a rendered file for every look (npm run data:fight-gifs)', async () => {
    const { existsSync } = await import('node:fs')
    for (const g of FIGHT_GIFS) expect(existsSync(new URL(`../../../../public/discord/fight/${g.name}.gif`, import.meta.url)), g.name).toBe(true)
  })
})
