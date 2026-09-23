import { describe, expect, it } from 'vitest'
import presentation from '../../public/presentation.json'
import icons from './battlenet/generated/spell-icon-aliases.json'
import { RAID_BUFFS } from './simc/raid-buffs'

// Raid buffs are shown by name, so each name must resolve to a spell, and a spell whose own
// media Blizzard does not publish needs an alias to try instead (Chaos Brand's 1490 did not).
describe('generated presentation data', () => {
  it('resolves every raid buff name except the combined Bloodlust / Heroism label', () => {
    const key = (label: string) => label.toLowerCase().replaceAll(' ', '_').replace(/[^a-z0-9_]/g, '')
    const missing = Object.values(RAID_BUFFS).filter((label) => !label.includes('/') && !(key(label) in presentation.names))
    expect(missing).toEqual([])
  })

  it('gives the lowest id of an icon group a fallback', () => {
    expect((icons.aliases as Record<string, number>)['1490']).toBe(255260)
  })
})
