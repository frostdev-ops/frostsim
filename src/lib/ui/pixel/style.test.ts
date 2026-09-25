import { describe, expect, it } from 'vitest'
import { encounterFor, fightGif, FIGHT_GIFS, heroStyle, partyOf } from './style'
import { Battle, MAX_PARTY } from './battle'

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

  it('reads a multi-character profile as a party, in order', () => {
    const profile = 'mage="Ice"\nspec=frost\nlevel=90\n\ndeathknight="Bones"\nspec=unholy\nhead=,id=1\nwarlock="Fel"\nprofileset."x"+=head=,id=2'
    expect(partyOf(profile)).toEqual([{ className: 'mage', spec: 'frost' }, { className: 'death_knight', spec: 'unholy' }, { className: 'warlock' }])
    expect(partyOf('')).toEqual([])
  })

  it('fights as a party, capped at the heroes that fit', () => {
    const party = ['warrior', 'mage', 'warlock/demonology', 'hunter/beast_mastery', 'paladin/retribution', 'shaman', 'priest']
      .map((k) => heroStyle(...(k.split('/') as [string, string])))
    const battle = new Battle(party, encounterFor('Patchwerk', 3, 'quick'), { speed: 2400, dps: 250_000, progress: 0.5, samples: [] })
    let fills = 0
    const ctx = {
      fillStyle: '', globalAlpha: 1, save() {}, restore() {}, translate() {}, clearRect() {}, fillRect() { fills++ },
    } as unknown as CanvasRenderingContext2D
    for (let i = 0; i < 400; i++) { battle.step(); battle.draw(ctx) }
    expect(fills).toBeGreaterThan(0)
    expect((battle as unknown as { party: unknown[] }).party).toHaveLength(MAX_PARTY)
  })
})
