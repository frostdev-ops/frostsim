import { describe, expect, it } from 'vitest'
import presentation from '../../public/presentation.json'
import icons from './battlenet/generated/spell-icons.json'
import { RAID_BUFFS } from './simc/raid-buffs'

// Raid buffs are shown by name, so each name must resolve to a spell. Icons are served by file name
// because Blizzard's media API has no record for many spells (Chaos Brand's 1490; the consumable,
// enchant and pet spells below all 404'd there).
describe('generated presentation data', () => {
  it('resolves every raid buff name except the combined Bloodlust / Heroism label', () => {
    const key = (label: string) => label.toLowerCase().replaceAll(' ', '_').replace(/[^a-z0-9_]/g, '')
    const missing = Object.values(RAID_BUFFS).filter((label) => !label.includes('/') && !(key(label) in presentation.names))
    expect(missing).toEqual([])
  })

  it('names the icon file of spells the media API does not index', () => {
    const name = (id: number) => icons.names[(icons.spells as Record<string, number>)[id]]
    expect(name(1490)).toBe('ability_demonhunter_empowerwards')
    expect(name(1309535)).toBe('spell_shadow_shadowandflame')
    expect(name(104317)).toBe('ability_warlock_impoweredimp')
    expect(name(1237006)).toBe('inv_12_profession_enchanting_manaoil_red')
  })

  it('stores icon names the way the render CDN spells them: no whitespace, no path separators', () => {
    expect(icons.names.every((n) => n.length > 0 && !/[\s/\\?#]/.test(n))).toBe(true)
  })
})
