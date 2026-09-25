// The shared plan table: terms sold, discounts, lookup keys and the "≈ sims" guide (DESIGN.md C6).
import { describe, expect, it } from 'vitest'
import { PLANS, approxSims, discountPercent, lookupKey, termsOf } from './plans'

const plan = (id: string) => PLANS.find((p) => p.id === id)!

describe('plans', () => {
  it('sells compute and the guild pool monthly, for 6 months and yearly; slots and hosted links monthly only', () => {
    for (const id of ['compute_s', 'compute_m', 'compute_l', 'discord_guild']) expect(termsOf(plan(id))).toEqual(['monthly', 'semiannual', 'yearly'])
    expect(termsOf(plan('slots_5'))).toEqual(['monthly'])
    expect(lookupKey(plan('compute_m'), 'semiannual')).toBe('compute_m_semiannual')
  })

  it('discounts 6 months by about 10 % and a year by about 20 %', () => {
    expect(PLANS.filter((p) => p.usd?.monthly).map((p) => [p.id, discountPercent(p, 'semiannual'), discountPercent(p, 'yearly')])).toEqual([
      ['compute_s', 11, 19], ['compute_m', 10, 20], ['compute_l', 10, 20], ['discord_guild', 10, 20],
    ])
    expect(discountPercent(plan('compute_s'), 'monthly')).toBe(0)
    expect(discountPercent(plan('slots_5'), 'yearly')).toBe(0)
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
