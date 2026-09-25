// The shared plan table: terms sold, discounts, lookup keys and the "≈ sims" guide (DESIGN.md C6).
import { describe, expect, it } from 'vitest'
import { FREE_SLOTS, PLANS, UNLIMITED_SLOTS, approxSims, discountPercent, lookupKey, perMonth, slotStatus, slotsLabel, termsOf } from './plans'

const plan = (id: string) => PLANS.find((p) => p.id === id)!

describe('plans', () => {
  it('sells compute and the guild pool monthly, for 6 months and yearly, and nothing else', () => {
    for (const id of ['compute_s', 'compute_m', 'compute_l', 'discord_guild']) expect(termsOf(plan(id))).toEqual(['monthly', 'semiannual', 'yearly'])
    expect(PLANS.map((p) => p.id)).toEqual(['compute_s', 'compute_m', 'compute_l', 'discord_guild'])
    expect(lookupKey(plan('compute_m'), 'semiannual')).toBe('compute_m_semiannual')
  })

  it('discounts 6 months by about 10 % and a year by about 20 %', () => {
    expect(PLANS.filter((p) => p.usd?.monthly).map((p) => [p.id, discountPercent(p, 'semiannual'), discountPercent(p, 'yearly')])).toEqual([
      ['compute_s', 11, 19], ['compute_m', 10, 20], ['compute_l', 10, 20], ['discord_guild', 10, 20],
    ])
    expect(discountPercent(plan('compute_s'), 'monthly')).toBe(0)
    expect([perMonth(plan('compute_s'), 'yearly'), perMonth(plan('compute_m'), 'semiannual'), perMonth(plan('compute_l'), 'monthly')]).toEqual([2.42, 4.5, 10])
  })

  it('gives every account one slot, S one more, M two more and L unlimited', () => {
    expect(FREE_SLOTS).toBe(1)
    expect(['compute_s', 'compute_m', 'compute_l'].map((id) => plan(id).extraSlots)).toEqual([1, 2, UNLIMITED_SLOTS])
    expect(slotsLabel(3)).toBe('3')
    expect(slotsLabel(UNLIMITED_SLOTS)).toBe('Unlimited')
  })

  it('says why a character cannot be saved: full, over the limit after a downgrade, or never for unlimited', () => {
    expect(slotStatus(0, 1)).toEqual({ canAdd: true, note: '1 of 1 slot free.' })
    expect(slotStatus(1, 1)).toEqual({ canAdd: false, note: 'All 1 slot is in use. Replace or delete a character to save another or choose a plan with more slots.' })
    expect(slotStatus(3, 2).note).toBe('You have 3 characters and 2 slots. They stay, and you can download, replace or delete them; delete 2 to save a new one or choose a plan with more slots.')
    expect(slotStatus(40, UNLIMITED_SLOTS)).toEqual({ canAdd: true, note: '' })
    expect(slotStatus(UNLIMITED_SLOTS, UNLIMITED_SLOTS).note).not.toMatch(/choose a plan/)
  })

  it('turns an allowance into standard sims, rounded down to two significant figures', () => {
    expect(approxSims(20 * 3600)).toBe(6400)
    expect(approxSims(50 * 3600)).toBe(16000)
    expect(approxSims(120 * 3600)).toBe(38000)
    expect(approxSims(80 * 3600)).toBe(25000)
    expect(approxSims(95)).toBe(8)
    expect(approxSims(-5)).toBe(0)
  })
})
