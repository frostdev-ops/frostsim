// What a user or a Discord guild may use right now (CLAUDE.md D14, D15; DESIGN.md C6). entitlementsFor is pure; loadEntitlements reads
// the rows it needs. Free tier: no compute, no slots, no hosted shares (a business decision to revisit, not an invented one).

import type { Db } from './db';
import { CATALOG, product } from './catalog';
import { FREE_SLOTS, UNLIMITED_SLOTS } from '../../src/lib/account/plans';

export interface SubscriptionItem {
  lookupKey: string;
  quantity: number;
  /** From the Stripe Price metadata `core_hours`, which overrides the catalog's hours per month; absent means the catalog's. */
  coreHours?: number;
}

export interface Subscription {
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  items: SubscriptionItem[];
  /** Set for a Discord guild pool; such a subscription never counts toward its payer's personal allowance. */
  guildId: string | null;
}

/** Admin-comped allowance (users.comp_core_seconds / comp_max_threads). */
export interface Comp {
  coreSeconds: number;
  maxThreads: number | null;
}

export interface Period {
  periodStart: Date;
  periodEnd: Date;
}

export interface GuildEntitlement extends Period {
  guildId: string;
  coreSeconds: number;
  maxThreads: number;
}

export interface Entitlements extends Period {
  coreSeconds: number;
  maxThreads: number;
  slots: number;
  hostedShares: boolean;
  guilds: GuildEntitlement[];
}

/** past_due still counts: Stripe is retrying the payment. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

/** How long an active status outlives its stored current_period_end. Past it, a missed renewal (or deletion) webhook counts as a lapse
 *  instead of granting forever; billing's hourly `billing-resync` task re-reads the subscription from Stripe and restores it. */
export const RENEWAL_GRACE_MS = 3 * 86_400_000;

export function calendarMonth(now: Date): Period {
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function live(sub: Subscription, now: Date): boolean {
  const end = sub.currentPeriodEnd;
  return ACTIVE_STATUSES.has(sub.status) && (!end || now.getTime() < end.getTime() + RENEWAL_GRACE_MS);
}

/** `date` plus `n` calendar months (UTC), the day clamped to the target month's last day, like Stripe's billing anchor. */
function addMonths(date: Date, n: number): Date {
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), last), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

/** Longer than this, a billing period (6 months, a year) is metered in monthly slices from its start, so the monthly allowance
 *  resets every month instead of a year's hours being spendable at once. */
const MONTH_MS = 32 * 86_400_000;

/** The metering window: the stored period, or inside the renewal grace the next one of the same length (not the calendar month,
 *  which would hand out a fresh allowance mid-cycle); for long terms, the month of it that contains now. Null when none does. */
function periodOf(sub: Subscription, now: Date): Period | null {
  const { currentPeriodStart: start, currentPeriodEnd: end } = sub;
  if (!start || !end) return null;
  const period = now < end ? { periodStart: start, periodEnd: end } : { periodStart: end, periodEnd: new Date(2 * end.getTime() - start.getTime()) };
  if (!(period.periodStart <= now && now < period.periodEnd)) return null;
  if (period.periodEnd.getTime() - period.periodStart.getTime() <= MONTH_MS) return period;
  let k = 0;
  while (addMonths(period.periodStart, k + 1) <= now) k++;
  const sliceEnd = addMonths(period.periodStart, k + 1);
  return { periodStart: addMonths(period.periodStart, k), periodEnd: sliceEnd < period.periodEnd ? sliceEnd : period.periodEnd };
}

/** Comped hours without comped threads run at the smallest compute tier's width instead of 0 threads. */
const SMALLEST_COMPUTE_THREADS = Math.min(...Object.values(CATALOG).filter((p) => p.kind === 'compute').map((p) => p.maxThreads ?? Infinity));

const units = (quantity: number) => (Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0);

export function entitlementsFor(subs: readonly Subscription[], comp: Comp, now: Date): Entitlements {
  let coreSeconds = comp.coreSeconds;
  let maxThreads = comp.maxThreads ?? 0;
  let extraSlots = 0;
  let hostedShares = false;
  // ponytail: with two compute subscriptions the first one's period meters both; add per-subscription windows if that case appears.
  let computePeriod: Period | null = null;
  const guilds = new Map<string, GuildEntitlement>();

  for (const sub of subs) {
    if (!live(sub, now)) continue;
    for (const item of sub.items) {
      const p = product(item.lookupKey);
      // A zero or negative quantity grants nothing at all, slots and hosted links included.
      if (!p || !units(item.quantity)) continue;
      const hours = Number(item.coreHours) > 0 ? Number(item.coreHours) : (p.coreHoursPerMonth ?? 0);
      const seconds = hours * 3600 * units(item.quantity);
      if (sub.guildId) {
        if (p.kind !== 'guild') continue;
        const guild = guilds.get(sub.guildId)
          ?? { guildId: sub.guildId, coreSeconds: 0, maxThreads: 0, ...(periodOf(sub, now) ?? calendarMonth(now)) };
        guild.coreSeconds += seconds;
        guild.maxThreads = Math.max(guild.maxThreads, p.maxThreads ?? 0);
        guilds.set(sub.guildId, guild);
        continue;
      }
      if (p.kind === 'compute') {
        coreSeconds += seconds;
        maxThreads = Math.max(maxThreads, p.maxThreads ?? 0);
        computePeriod ??= periodOf(sub, now);
      }
      extraSlots = Math.max(extraSlots, p.extraSlots ?? 0);
      if (p.hostedShares) hostedShares = true;
    }
  }
  if (coreSeconds > 0 && maxThreads < 1) maxThreads = SMALLEST_COMPUTE_THREADS;
  // Every account has FREE_SLOTS; the best plan adds its extra, up to the unlimited ceiling (plans do not stack).
  const slots = Math.min(UNLIMITED_SLOTS, FREE_SLOTS + extraSlots);
  return { coreSeconds, maxThreads, slots, hostedShares, ...(computePeriod ?? calendarMonth(now)), guilds: [...guilds.values()] };
}

/** Rows -> entitlementsFor. For a guild, only subscriptions carrying that guild_id count and the result's `guilds[0]` is it. */
export async function loadEntitlements(db: Db, who: { userId: string } | { guildId: string }, now: Date): Promise<Entitlements> {
  const rows = 'userId' in who
    ? await db`select status, current_period_start, current_period_end, items, guild_id from subscriptions where user_id = ${who.userId}`
    : await db`select status, current_period_start, current_period_end, items, guild_id from subscriptions where guild_id = ${who.guildId}`;
  const [user] = 'userId' in who
    ? await db`select comp_core_seconds::float8 as core_seconds, comp_max_threads as max_threads from users where id = ${who.userId}`
    : [];
  const subs: Subscription[] = rows.map((r) => ({
    status: r.status,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    items: r.items,
    guildId: r.guild_id,
  }));
  return entitlementsFor(subs, { coreSeconds: user?.core_seconds ?? 0, maxThreads: user?.max_threads ?? null }, now);
}
