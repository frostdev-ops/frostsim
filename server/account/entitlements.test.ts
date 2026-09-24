// Catalog and entitlements (CLAUDE.md D14, D15; DESIGN.md C6): pure allowance math over subscription rows.

import { describe, expect, it } from 'vitest';
import { CATALOG, product } from './catalog';
import { calendarMonth, entitlementsFor, RENEWAL_GRACE_MS, type Subscription } from './entitlements';

const NOW = new Date('2026-09-23T12:00:00Z');
const START = new Date('2026-09-10T00:00:00Z');
const END = new Date('2026-10-10T00:00:00Z');
const NONE = { coreSeconds: 0, maxThreads: null };

function sub(over: Partial<Subscription>): Subscription {
  return { status: 'active', currentPeriodStart: START, currentPeriodEnd: END, items: [], guildId: null, ...over };
}

describe('catalog', () => {
  it('maps the lookup keys, carries no core-hour sizes, and grants nothing for unknown or prototype keys', () => {
    expect(product('compute_l_monthly')).toEqual({ kind: 'compute', maxThreads: 32, hostedShares: true });
    expect(product('slots_5_monthly')).toEqual({ kind: 'slots', slotsPerUnit: 5 });
    expect(product('discord_guild_monthly')?.kind).toBe('guild');
    expect(product('nope')).toBeNull();
    expect(product('toString')).toBeNull();
    expect(JSON.stringify(CATALOG)).not.toMatch(/hour|seconds/i);
  });
});

describe('entitlementsFor', () => {
  it('free tier: nothing, metered over the UTC calendar month', () => {
    expect(entitlementsFor([], NONE, NOW)).toEqual({
      coreSeconds: 0, maxThreads: 0, slots: 0, hostedShares: false, guilds: [],
      periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('a compute tier grants its hours, threads, hosted shares and its own billing period', () => {
    const ent = entitlementsFor([sub({ items: [{ lookupKey: 'compute_m_monthly', quantity: 1, coreHours: 50 }] })], NONE, NOW);
    expect(ent).toMatchObject({ coreSeconds: 180_000, maxThreads: 16, hostedShares: true, periodStart: START, periodEnd: END });
  });

  it('counts active, trialing and past_due; ignores canceled, incomplete and unpaid', () => {
    const items = [{ lookupKey: 'compute_s_monthly', quantity: 1, coreHours: 1 }];
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(entitlementsFor([sub({ status, items })], NONE, NOW).coreSeconds).toBe(3600);
    }
    for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'unpaid']) {
      expect(entitlementsFor([sub({ status, items })], NONE, NOW).maxThreads).toBe(0);
    }
  });

  it('multiplies slots by quantity and stacks add-ons with a tier', () => {
    const ent = entitlementsFor([
      sub({ items: [{ lookupKey: 'slots_5_monthly', quantity: 3 }, { lookupKey: 'shares_plus_monthly', quantity: 1 }] }),
      sub({ items: [{ lookupKey: 'slots_5_monthly', quantity: 1 }, { lookupKey: 'unknown_key', quantity: 9 }] }),
    ], NONE, NOW);
    expect(ent).toMatchObject({ slots: 20, hostedShares: true, coreSeconds: 0, maxThreads: 0 });
    expect(entitlementsFor([sub({ items: [{ lookupKey: 'slots_5_monthly', quantity: -2 }] })], NONE, NOW).slots).toBe(0);
  });

  it('adds comped seconds and takes the larger thread ceiling', () => {
    const items = [{ lookupKey: 'compute_s_monthly', quantity: 1, coreHours: 1 }];
    expect(entitlementsFor([sub({ items })], { coreSeconds: 500, maxThreads: 32 }, NOW)).toMatchObject({ coreSeconds: 4100, maxThreads: 32 });
    expect(entitlementsFor([], { coreSeconds: 500, maxThreads: 4 }, NOW)).toMatchObject({ coreSeconds: 500, maxThreads: 4 });
  });

  it('runs comped hours without comped threads at the smallest tier width, never 0 threads', () => {
    expect(entitlementsFor([], { coreSeconds: 36_000, maxThreads: null }, NOW)).toMatchObject({ coreSeconds: 36_000, maxThreads: 8 });
    expect(entitlementsFor([], { coreSeconds: 0, maxThreads: null }, NOW).maxThreads).toBe(0);
  });

  it('keeps guild pools apart from the payer, merged per guild', () => {
    const ent = entitlementsFor([
      sub({ guildId: 'g1', items: [{ lookupKey: 'discord_guild_monthly', quantity: 1, coreHours: 10 }, { lookupKey: 'compute_l_monthly', quantity: 1, coreHours: 99 }] }),
      sub({ guildId: 'g1', currentPeriodStart: null, items: [{ lookupKey: 'discord_guild_monthly', quantity: 2, coreHours: 1 }] }),
      sub({ guildId: 'g2', status: 'canceled', items: [{ lookupKey: 'discord_guild_monthly', quantity: 1, coreHours: 5 }] }),
    ], NONE, NOW);
    expect(ent).toMatchObject({ coreSeconds: 0, maxThreads: 0, hostedShares: false });
    expect(ent.guilds).toEqual([{ guildId: 'g1', coreSeconds: 43_200, maxThreads: 8, periodStart: START, periodEnd: END }]);
  });

  it('meters over the calendar month when the stored period is incomplete, and never lapses without an end', () => {
    const items = [{ lookupKey: 'compute_s_monthly', quantity: 1, coreHours: 1 }];
    const later = new Date('2027-01-15T00:00:00Z');
    expect(entitlementsFor([sub({ currentPeriodStart: null, items })], NONE, NOW)).toMatchObject({ coreSeconds: 3600, ...calendarMonth(NOW) });
    expect(entitlementsFor([sub({ currentPeriodEnd: null, items })], NONE, later)).toMatchObject({ coreSeconds: 3600, ...calendarMonth(later) });
  });
});

describe('a missed renewal webhook (stored current_period_end has passed)', () => {
  const DAY = 86_400_000;
  const at = (ms: number) => new Date(END.getTime() + ms);
  // The next period of the stored one's length (30 days), not the calendar month.
  const NEXT = { periodStart: END, periodEnd: new Date(END.getTime() + 30 * DAY) };
  const paid = sub({ status: 'past_due', items: [
    { lookupKey: 'compute_m_monthly', quantity: 1, coreHours: 10 }, { lookupKey: 'slots_5_monthly', quantity: 2 },
  ] });
  const guild = sub({ guildId: 'g1', items: [{ lookupKey: 'discord_guild_monthly', quantity: 1, coreHours: 5 }] });
  const shares = sub({ items: [{ lookupKey: 'shares_plus_monthly', quantity: 1 }] });

  it('grants the stored period up to its last millisecond', () => {
    expect(entitlementsFor([paid, guild], NONE, at(-1))).toMatchObject({
      coreSeconds: 36_000, maxThreads: 16, slots: 10, hostedShares: true, periodStart: START, periodEnd: END,
      guilds: [{ guildId: 'g1', coreSeconds: 18_000, maxThreads: 8, periodStart: START, periodEnd: END }],
    });
  });

  it('keeps granting for RENEWAL_GRACE_MS (3 days), metered from current_period_end for one more period length', () => {
    expect(RENEWAL_GRACE_MS).toBe(3 * DAY);
    for (const now of [at(0), at(RENEWAL_GRACE_MS - 1)]) {
      expect(entitlementsFor([paid, guild], NONE, now)).toMatchObject({
        coreSeconds: 36_000, maxThreads: 16, slots: 10, hostedShares: true, ...NEXT,
        guilds: [{ guildId: 'g1', coreSeconds: 18_000, maxThreads: 8, ...NEXT }],
      });
      expect(entitlementsFor([shares], NONE, now).hostedShares).toBe(true);
    }
  });

  it('lapses at period end + 3 days: no hours, threads, slots, hosted shares or guild pool; free-tier calendar month', () => {
    const now = at(RENEWAL_GRACE_MS);
    expect(entitlementsFor([paid, guild], NONE, now)).toEqual({
      coreSeconds: 0, maxThreads: 0, slots: 0, hostedShares: false, guilds: [], ...calendarMonth(now),
    });
    expect(entitlementsFor([shares], NONE, now).hostedShares).toBe(false);
    // Comped hours are not a subscription and do not lapse.
    expect(entitlementsFor([paid], { coreSeconds: 500, maxThreads: null }, now)).toMatchObject({ coreSeconds: 500, maxThreads: 8 });
  });

  it('meters a zero-length stored period in its grace over the calendar month', () => {
    const now = at(DAY);
    expect(entitlementsFor([sub({ currentPeriodStart: END, items: paid.items })], NONE, now)).toMatchObject({ coreSeconds: 36_000, ...calendarMonth(now) });
  });
});
