// Synthetic Blizzard profile API bodies (shapes from bcp_api.cpp); no real character data.
import { describe, expect, it } from 'vitest'
import { ArmoryError, armoryProfile } from './armory'
import { parseAddonExport } from './character'

export const SUMMARY = {
  name: 'Testmage', level: 90,
  character_class: { id: 8, name: 'Mage' }, race: { id: 4, name: 'Night Elf' },
  active_spec: { id: 64, name: 'Frost' }, realm: { name: 'Area 52', slug: 'area-52' },
}
export const SPECIALIZATIONS = {
  active_specialization: { id: 64 },
  specializations: [
    { specialization: { id: 63 }, loadouts: [{ is_active: true, talent_loadout_code: 'FIRECODE' }] },
    { specialization: { id: 64 }, loadouts: [
      { is_active: false, talent_loadout_code: 'OLDCODE' },
      { is_active: true, talent_loadout_code: 'CAEAAAAAAAAAAAAAAAAAAAAAAAA+/=' },
    ] },
  ],
}
export const EQUIPMENT = {
  equipped_items: [
    {
      slot: { type: 'HEAD' }, item: { id: 271546 }, name: 'Crown of the (Void)', level: { value: 678 }, bonus_list: [13334, 6652, 13696],
      enchantments: [
        { enchantment_id: 8017, enchantment_slot: { id: 0 } },
        { enchantment_id: 9999, enchantment_slot: { id: 6 } },
      ],
    },
    { slot: { type: 'FINGER_1' }, item: { id: 251136 }, sockets: [{ item: { id: 240983 } }, {}], bonus_list: [12843] },
    { slot: { type: 'WRIST' }, item: { id: 239648 }, modified_crafting_stat: [{ id: 32 }, { id: 40 }] },
    { slot: { type: 'TRINKET_1' }, item: { id: 273796 }, enchantments: [{ enchantment_id: 7000, enchantment_slot: { id: 7 } }] },
    { slot: { type: 'MAIN_HAND' }, item: { id: 273778 }, timewalker_level: 70 },
    { slot: { type: 'RANGED_OLD' }, item: { id: 1 } },
  ],
}

const profile = () => armoryProfile(
  { region: 'us', summary: SUMMARY, equipment: EQUIPMENT, specializations: SPECIALIZATIONS },
  new Date('2026-09-25T00:00:00Z'),
)

describe('armoryProfile', () => {
  it('reads as an addon export with the active spec, talents and gear', () => {
    const c = parseAddonExport(profile())
    expect(c.diagnostics.filter((d) => d.severity !== 'info')).toEqual([])
    expect(c).toMatchObject({
      name: 'Testmage', className: 'mage', level: 90, race: 'night_elf', region: 'us', server: 'area-52', spec: 'frost',
      talents: 'CAEAAAAAAAAAAAAAAAAAAAAAAAA+/=',
    })
    const bySlot = Object.fromEntries(c.equipped.map((i) => [i.slot, i]))
    expect(Object.keys(bySlot).sort()).toEqual(['finger1', 'head', 'main_hand', 'trinket1', 'wrist'])
    expect(bySlot.head).toMatchObject({ itemId: 271546, bonusIds: [13334, 6652, 13696], enchantId: 8017, gemIds: [], addonName: 'Crown of the Void', addonItemLevel: 678 })
    expect(bySlot.wrist.addonItemLevel).toBeUndefined()
    expect(bySlot.finger1).toMatchObject({ gemIds: [240983], bonusIds: [12843] })
    expect(bySlot.wrist.craftedStats).toEqual([32, 40])
    expect(bySlot.trinket1.extra).toEqual({ addon_id: '7000' })
    expect(bySlot.main_hand.dropLevel).toBe(70)
  })

  it('keeps an empty socket before a filled one in place', () => {
    const equipment = { equipped_items: [{ slot: { type: 'NECK' }, item: { id: 5 }, sockets: [{}, { item: { id: 7 } }] }] }
    expect(armoryProfile({ region: 'eu', summary: SUMMARY, equipment, specializations: {} }, new Date())).toMatch(/^neck=,id=5,gem_id=0\/7$/m)
  })

  it('writes nothing a hostile body could use to add simc options', () => {
    const summary = { ...SUMMARY, name: 'Evil"\nthreads=1', active_spec: { id: 64, name: 'Frost\nthreads=1' }, realm: { name: 'x\ny', slug: 'a\nthreads=1' } }
    const text = armoryProfile({ region: 'us', summary, equipment: EQUIPMENT, specializations: { specializations: [
      { specialization: { id: 64 }, loadouts: [{ is_active: true, talent_loadout_code: 'x\nthreads=1' }] },
    ] } }, new Date())
    expect(text).not.toMatch(/^threads=/m)
    expect(parseAddonExport(text).talents).toBeUndefined()
  })

  it('refuses a character without a class or gear', () => {
    expect(() => armoryProfile({ region: 'us', summary: {}, equipment: EQUIPMENT, specializations: {} }, new Date())).toThrow(ArmoryError)
    expect(() => armoryProfile({ region: 'us', summary: SUMMARY, equipment: {}, specializations: {} }, new Date())).toThrow(ArmoryError)
  })
})
