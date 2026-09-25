// Stripe price script (scripts/stripe-catalog.mjs): the Prices the plan table asks for, and keep/replace/create against Stripe.
import { describe, expect, it } from 'vitest';
import { desiredPrices, plan } from './stripe-catalog.mjs';

describe('stripe catalog', () => {
  it('asks for one Price per priced plan and term, in cents, with the right recurrence', () => {
    const prices = desiredPrices();
    expect(prices.map((p) => p.lookupKey)).toEqual([
      'compute_s_monthly', 'compute_s_semiannual', 'compute_s_yearly', 'compute_m_monthly', 'compute_m_semiannual', 'compute_m_yearly',
      'compute_l_monthly', 'compute_l_semiannual', 'compute_l_yearly', 'discord_guild_monthly', 'discord_guild_semiannual', 'discord_guild_yearly',
    ]);
    expect(prices.find((p) => p.lookupKey === 'compute_s_semiannual')).toMatchObject({ unitAmount: 1600, currency: 'usd', interval: 'month', intervalCount: 6 });
    expect(prices.find((p) => p.lookupKey === 'compute_l_yearly')).toMatchObject({ unitAmount: 9600, interval: 'year', intervalCount: 1 });
  });

  it('keeps a matching Price, replaces a changed one and creates a missing one', () => {
    const desired = desiredPrices().slice(0, 3);
    const existing = [
      { lookup_key: 'compute_s_monthly', unit_amount: 300, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } },
      { lookup_key: 'compute_s_semiannual', unit_amount: 1800, currency: 'usd', recurring: { interval: 'month', interval_count: 6 } },
    ];
    expect(plan(desired, existing).map((s) => [s.lookupKey, s.action])).toEqual([
      ['compute_s_monthly', 'keep'], ['compute_s_semiannual', 'replace'], ['compute_s_yearly', 'create'],
    ]);
  });
});
