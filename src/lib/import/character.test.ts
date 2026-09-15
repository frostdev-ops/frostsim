import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isSameCharacter, looksLikeProfile, parseAddonExport } from './character'

const FIXTURE = readFileSync(
  new URL('../../../tests/fixtures/addon-export-demonology.simc', import.meta.url),
  'utf8',
)

it('matches returning characters across gear/spec changes without merging other identities', () => {
  const original = parseAddonExport('warlock=Testchar\nregion=us\nserver=Mal\'Ganis\nspec=demonology')
  const updated = parseAddonExport('warlock=TESTCHAR\nregion=US\nserver=mal-ganis\nspec=affliction\nhead=,id=271546')
  expect(isSameCharacter(original, updated)).toBe(true)
  for (const delta of [{ name: 'Someoneelse' }, { region: 'eu' }, { server: 'Duskwood' }, { className: 'mage' }, { server: undefined }, { name: '' }]) {
    expect(isSameCharacter(original, { ...updated, ...delta })).toBe(false)
  }
})

describe('parseAddonExport — real addon export', () => {
  const c = parseAddonExport(FIXTURE)

  it('reads character identity', () => {
    expect(c.className).toBe('warlock')
    expect(c.name).toBe('Testchar')
    expect(c.spec).toBe('demonology')
    expect(c.level).toBe(90)
    expect(c.race).toBe('dracthyr')
    expect(c.lootSpec).toBe('demonology')
    expect(c.professions).toEqual([
      { name: 'herbalism', rank: 1 },
      { name: 'engineering', rank: 29 },
    ])
  })

  it('reads addon and game metadata', () => {
    expect(c.addonVersion).toBe('12.1.0-03')
    expect(c.wowVersion).toBe('12.1.0.69814')
    expect(c.toc).toBe(120100)
    expect(c.checksum).toBe('af74612')
  })

  it('finds the four saved loadouts without losing the active talents', () => {
    expect(c.loadouts.map((l) => l.name)).toEqual(['M+', 'Raider.IO Build', 'ST', 'Siz'])
    expect(c.talents?.startsWith('CoQAMrNP5kak')).toBe(true)
    // Loadout is distinct string from active one.
    expect(c.loadouts.every((l) => l.talents !== c.talents)).toBe(true)
  })

  it('parses equipped items with ordered bonus ids and full item options', () => {
    const head = c.equipped.find((i) => i.slot === 'head')!
    expect(head.itemId).toBe(271546)
    expect(head.enchantId).toBe(8017)
    expect(head.bonusIds).toEqual([13334, 6652, 13696, 13692, 13698, 12852])
    expect(head.redirectedBaseStats).toBe(268242)
    expect(head.addonName).toBe('Skull of the Damned Necrolyte')
    expect(head.addonItemLevel).toBe(328)
    expect(head.source).toBe('equipped')
  })

  it('normalises slot aliases the export actually uses', () => {
    expect(c.equipped.find((i) => i.slot === 'shoulder')?.itemId).toBe(271544)
    expect(c.equipped.find((i) => i.slot === 'wrist')?.craftedStats).toEqual([32, 40])
    expect(c.equipped.find((i) => i.slot === 'wrist')?.craftingQuality).toBe(5)
  })

  it('keeps bag items out of the equipped set and out of the engine input', () => {
    expect(c.bag.length).toBeGreaterThan(20)
    expect(c.bag.every((i) => i.source === 'bag')).toBe(true)
    // P04.10: commented bag line must never become executable profile line.
    expect(c.profileLines.some((l) => l.startsWith('#'))).toBe(false)
    const equippedHeadIds = c.equipped.filter((i) => i.slot === 'head').length
    expect(equippedHeadIds).toBe(1)
  })

  it('keeps two copies of one item id distinct when their bonus ids differ (P04.4)', () => {
    const shoulders = [...c.equipped, ...c.bag].filter((i) => i.itemId === 271544)
    expect(shoulders.length).toBe(2)
    expect(new Set(shoulders.map((i) => i.instanceId)).size).toBe(2)
    expect(shoulders[0].bonusIds).not.toEqual(shoulders[1].bonusIds)
  })

  it('reads currencies and upgrade metadata, splitting item reagents from currencies', () => {
    expect(c.currencies?.catalyst?.[2813]).toBe(8)
    expect(c.currencies?.upgrade?.[3443]).toBe(103)
    expect(c.currencies?.upgradeItems?.[204682]).toBe(1)
    expect(c.currencies?.bonusRoll?.[3418]).toBe(0)
    expect(c.upgradeAchievements?.length).toBe(25)
    expect(c.highWatermarks?.[0]).toEqual({ slotIndex: 0, current: 328, max: 328 })
    // Slot never filled by character reports current 0 not "missing".
    expect(c.highWatermarks?.find((w) => w.slotIndex === 14)).toEqual({
      slotIndex: 14, current: 0, max: 298,
    })
  })

  it('reports absent sections as absent rather than empty (P04.5)', () => {
    expect(c.vault).toBeUndefined()
  })

  it('reads omnium talent choices', () => {
    expect(c.omniumTalents).toEqual([
      { id: 136821, rank: 1 }, { id: 136817, rank: 1 },
      { id: 136819, rank: 1 }, { id: 136822, rank: 1 },
    ])
  })

  it('keeps the raw export byte-identical and the profile lines in order', () => {
    expect(c.raw).toBe(FIXTURE)
    expect(c.profileLines[0]).toBe('warlock=Testchar')
    expect(c.profileLines).toContain('spec=demonology')
    expect(c.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })
})

describe('parseAddonExport — edge cases', () => {
  it('handles a BOM, CRLF line endings and trailing whitespace', () => {
    const c = parseAddonExport('﻿mage=Bob  \r\nlevel=80\r\nhead=,id=1,bonus_id=2\r\n')
    expect(c.className).toBe('mage')
    expect(c.name).toBe('Bob')
    expect(c.level).toBe(80)
    expect(c.equipped[0].bonusIds).toEqual([2])
  })

  it('accepts every slot alias simc accepts', () => {
    const c = parseAddonExport(
      ['druid=A', 'shoulders=,id=1', 'wrists=,id=2', 'ring1=,id=3', 'ring2=,id=4',
       'leg=,id=5', 'foot=,id=6', 'hand=,id=7'].join('\n'),
    )
    expect(c.equipped.map((i) => i.slot).sort()).toEqual(
      ['feet', 'finger1', 'finger2', 'hands', 'legs', 'shoulder', 'wrist'],
    )
  })

  it('unquotes a quoted character name', () => {
    expect(parseAddonExport('priest="Two Words"').name).toBe('Two Words')
  })

  it('warns and keeps the last line when a slot is set twice', () => {
    const c = parseAddonExport('rogue=A\nhead=,id=1\nhead=,id=2')
    expect(c.equipped.length).toBe(1)
    expect(c.equipped[0].itemId).toBe(2)
    expect(c.diagnostics.some((d) => d.severity === 'warning' && /more than once/.test(d.message)))
      .toBe(true)
  })

  it('errors on text that is not a profile', () => {
    const c = parseAddonExport('hello world\nthis is not a profile')
    expect(c.diagnostics.some((d) => d.severity === 'error')).toBe(true)
    expect(looksLikeProfile('hello world')).toBe(false)
    expect(looksLikeProfile('warlock=X')).toBe(true)
  })

  it('preserves unmodelled settings instead of dropping them', () => {
    const c = parseAddonExport('mage=A\nsome_future_option=17')
    expect(c.unmodelled).toEqual([{ key: 'some_future_option', value: '17', lineNumber: 2 }])
    expect(c.profileLines).toContain('some_future_option=17')
  })

  it('keeps two identical copies of an item distinguishable', () => {
    const c = parseAddonExport(
      'hunter=A\n### Gear from Bags\n# finger1=,id=9,bonus_id=1\n# finger1=,id=9,bonus_id=1',
    )
    expect(c.bag.length).toBe(2)
    expect(c.bag[0].instanceId).not.toBe(c.bag[1].instanceId)
  })

  it('parses a vault section when one is present', () => {
    const c = parseAddonExport(
      'shaman=A\n### Great Vault\n# Thing (600)\n# head=,id=42,bonus_id=7',
    )
    expect(c.vault?.length).toBe(1)
    expect(c.vault?.[0].addonItemLevel).toBe(600)
    expect(c.bag).toEqual([])
  })

  it('imports the upstream Weekly Reward Choices format without treating rewards as owned', () => {
    // simulationcraft/simc-addon core.lua emits this section and closing marker.
    const text = [
      'mage=VaultFixture', 'finger1=,id=101,bonus_id=7/8',
      '### Gear from Bags', '# finger1=,id=101,bonus_id=7/8',
      '### Weekly Reward Choices', '#', '# Reward Ring (285)',
      '# finger1=,id=101,bonus_id=7/8,ilevel=285,gem_id=12,enchant_id=34',
      '#', '# Reward Ring (285)',
      '# finger1=,id=101,bonus_id=7/8,ilevel=285,gem_id=12,enchant_id=34',
      '#', '### End of Weekly Reward Choices',
      '# head=,id=999', '### Additional Character Info', '# loot_spec=frost',
    ].join('\n')
    const c = parseAddonExport(text)
    expect(c.vault).toHaveLength(2)
    expect(c.bag).toHaveLength(1)
    expect(c.equipped).toHaveLength(1)
    expect(c.profileLines).toEqual(['mage=VaultFixture', 'finger1=,id=101,bonus_id=7/8'])
    expect(c.vault![0]).toMatchObject({ source: 'vault', itemLevel: 285, bonusIds: [7, 8], gemIds: [12], enchantId: 34 })
    expect(c.vault![0].vaultRewardId).toBe(c.vault![0].instanceId)
    expect(c.vault![1].vaultRewardId).not.toBe(c.vault![0].vaultRewardId)
    expect(parseAddonExport(text).vault!.map((i) => i.vaultRewardId)).toEqual(c.vault!.map((i) => i.vaultRewardId))
    expect(c.lootSpec).toBe('frost')
    expect(parseAddonExport('mage=A\n### Weekly Reward Choices\n### End of Weekly Reward Choices').vault).toEqual([])
  })

  it('does not treat an older-format export without metadata as broken', () => {
    const c = parseAddonExport('warrior=Old\nlevel=70\nhead=,id=5,bonus_id=1/2')
    expect(c.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(c.currencies).toBeUndefined()
    expect(c.highWatermarks).toBeUndefined()
  })
})

describe('item level options', () => {
  it('models ilevel= and drop_level= rather than leaving them in extra', () => {
    const c = parseAddonExport('mage=A\nhead=,id=1,bonus_id=2,ilevel=running,drop_level=70')
    expect(c.equipped[0].itemLevel).toBeUndefined()
    const ok = parseAddonExport('mage=A\nhead=,id=1,bonus_id=2,ilevel=granted,drop_level=70')
    expect(ok.equipped[0].dropLevel).toBe(70)
    const real = parseAddonExport('mage=A\nhead=,id=1,bonus_id=2,ilevel=489,drop_level=70')
    expect(real.equipped[0].itemLevel).toBe(489)
    expect(real.equipped[0].dropLevel).toBe(70)
    expect(real.equipped[0].extra).toEqual({})
  })

  it('makes the same item at two ilevels two distinct instances', () => {
    const c = parseAddonExport(
      'mage=A\n### Gear from Bags\n# head=,id=9,ilevel=480\n# head=,id=9,ilevel=502',
    )
    expect(c.bag[0].instanceId).not.toBe(c.bag[1].instanceId)
  })
})
