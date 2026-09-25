// Stripe billing: plan summary, Checkout, the customer portal and the signed webhook (CLAUDE.md D15; DESIGN.md C5, C6, P4-P6).
// The webhook never trusts the event body's copy of a subscription: it re-fetches the subscription under the pinned API version and
// orders writes by when it fetched, so delivery order, event timestamps and the endpoint's own API version never matter.

import { createHmac } from 'node:crypto';
import type { AppCtx, RequestCtx, Route, Task } from './app';
import { product } from './catalog';
import type { Db } from './db';
import { loadEntitlements, type SubscriptionItem } from './entitlements';
import { HttpError, errorSummary, json } from './http';
import { rateLimit } from './ratelimit';
import { safeEqual, verify } from './signed';
import { StripeError, stripe } from './stripe';
import { usedCoreSeconds } from './usage';

/** signed.ts purpose for guild checkout links (DESIGN.md P5); discord.ts signs with it and payload { kind: 'guild-checkout', guildId, discordUserId }. */
export const GUILD_CHECKOUT_PURPOSE = 'guild-checkout';
/** stripe-node's DEFAULT_TOLERANCE. */
const SIGNATURE_TOLERANCE_S = 300;
// ponytail: a sanity bound on slot packs (100 slots), not a pricing decision.
const SUB_ID = /^sub_[A-Za-z0-9]+$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUILD_ID = /^\d{17,20}$/;

interface StripeItem {
  quantity?: number;
  /** On the item since API 2025-03-31.basil; the subscription no longer carries a period. */
  current_period_start?: number;
  current_period_end?: number;
  price?: {
    lookup_key?: string | null; metadata?: Record<string, string>; unit_amount?: number | null; currency?: string;
    recurring?: { interval?: string; interval_count?: number } | null;
  };
}

interface StripeSubscription {
  status: string;
  customer: string | { id: string } | null;
  metadata?: Record<string, string>;
  items?: { data?: StripeItem[] };
}

interface EventObject {
  id?: unknown;
  subscription?: unknown;
  /** Since 2025-03-31.basil an invoice names its subscription here instead of `invoice.subscription`. */
  parent?: { subscription_details?: { subscription?: unknown } | null } | null;
}

/** Stripe-Signature `t=<unix>,v1=<hex>[,v1=<hex>...]`: HMAC-SHA256 of `<t>.<raw body>`. Every v1 is compared (a secret roll sends two). */
export function verifyStripeSignature(body: Uint8Array, header: string | null, secret: string, nowS: number): boolean {
  let t = '';
  const signatures: string[] = [];
  for (const part of (header ?? '').split(',')) {
    const eq = part.indexOf('=');
    const key = part.slice(0, eq).trim();
    if (key === 't') t = part.slice(eq + 1).trim();
    else if (key === 'v1') signatures.push(part.slice(eq + 1).trim());
  }
  if (!/^\d{1,12}$/.test(t) || nowS - Number(t) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  return signatures.reduce((ok, sig) => safeEqual(sig, expected) || ok, false);
}

/** The guild and the Discord user a guild checkout link was minted for, or null when it is forged, expired or minted for something
 *  else. */
function guildFromToken(secret: string, token: unknown, nowMs: number): { guildId: string; discordUserId: string } | null {
  if (typeof token !== 'string') return null;
  const payload = verify<{ kind?: unknown; guildId?: unknown; discordUserId?: unknown }>(secret, GUILD_CHECKOUT_PURPOSE, token, nowMs);
  return payload?.kind === 'guild-checkout' && typeof payload.guildId === 'string' && GUILD_ID.test(payload.guildId)
    && typeof payload.discordUserId === 'string' && GUILD_ID.test(payload.discordUserId)
    ? { guildId: payload.guildId, discordUserId: payload.discordUserId }
    : null;
}

/** Checkout and the portal each make Stripe calls; a looping client must not spend the account's Stripe rate limit for everyone. */
async function limitStripeCalls(ctx: RequestCtx): Promise<void> {
  if (!(await rateLimit(ctx, 'billing', ctx.session!.userId, 10, 60))) {
    throw new HttpError(429, 'rate-limited', 'Too many billing requests; wait a minute.');
  }
}

const accountGone = () => new HttpError(404, 'not-found', 'This account no longer exists.');
const accountSuspended = () => new HttpError(403, 'suspended', 'This account is suspended.');

/** A session can outlive its user by a request (or by the 300 s session cache), and account deletion reads the customer pointer once
 *  (users.ts header), so a suspended or deleted user gets no new customer and no checkout. */
async function customerFor(ctx: RequestCtx, userId: string): Promise<string> {
  const [user] = await ctx.sql`select stripe_customer_id, suspended_at from users where id = ${userId}`;
  if (!user) throw accountGone();
  if (user.suspended_at) throw accountSuspended();
  if (user.stripe_customer_id) return user.stripe_customer_id;
  // The idempotency key hands two racing first checkouts the same customer; coalesce keeps whichever was stored first.
  const created = await stripe<{ id: string }>(ctx, 'POST', '/customers', { metadata: { user_id: userId } }, `customer-${userId}`);
  const [row] = await ctx.sql`update users set stripe_customer_id = coalesce(stripe_customer_id, ${created.id})
    where id = ${userId} returning stripe_customer_id, suspended_at`;
  if (!row) {
    // Deleted meanwhile: no row points at the customer, so nothing else will ever delete it.
    try {
      await stripe(ctx, 'DELETE', `/customers/${encodeURIComponent(created.id)}`);
      ctx.log(`billing: ${userId} was deleted during checkout; Stripe customer ${created.id} deleted`);
    } catch (err) {
      ctx.log(`billing: ${userId} was deleted during checkout; Stripe customer ${created.id} left behind (${errorSummary(err)})`);
    }
    throw accountGone();
  }
  // Suspended meanwhile: the stored pointer is deletion's to clean up (its final re-check sees it), but no one pays into this account.
  if (row.suspended_at) throw accountSuspended();
  return row.stripe_customer_id;
}

async function summary(ctx: RequestCtx): Promise<Response> {
  const userId = ctx.session!.userId;
  // What a plan nets us is ours to know: the account dialog gets allowances, not revenue.
  const { paidUsd: _paid, comped: _comped, ...ent } = await loadEntitlements(ctx.sql, { userId }, ctx.now());
  const entitlements = { ...ent, guilds: ent.guilds.map(({ paidUsd: _guildPaid, ...g }) => g) };
  const { periodStart, periodEnd } = entitlements;
  const used = await usedCoreSeconds(ctx.sql, { userId }, periodStart, periodEnd);
  const rows = await ctx.sql`select stripe_subscription_id, status, current_period_end, items, guild_id
    from subscriptions where user_id = ${userId} order by updated_at desc`;
  return json({
    entitlements,
    usage: { usedCoreSeconds: used, periodStart, periodEnd },
    subscriptions: rows.map((r) => ({
      id: r.stripe_subscription_id,
      status: r.status,
      lookupKeys: (r.items as SubscriptionItem[]).map((i) => i.lookupKey),
      periodEnd: r.current_period_end,
      guildId: r.guild_id,
    })),
  });
}

async function checkout(ctx: RequestCtx): Promise<Response> {
  const body = (await ctx.json<Record<string, unknown> | null>()) ?? {};
  const lookupKey = typeof body.lookupKey === 'string' ? body.lookupKey : '';
  const plan = product(lookupKey);
  if (!plan) throw new HttpError(400, 'invalid', 'Unknown plan.');

  // Every plan is one per subscription; slots come with the compute tiers (plans.ts).
  if (body.quantity !== undefined && body.quantity !== 1) throw new HttpError(400, 'invalid', 'Plans have no quantity.');
  const quantity = 1;

  let guildId: string | null = null;
  if (plan.kind === 'guild') {
    const link = guildFromToken(ctx.config.env.SESSION_SECRET!, body.guildToken, ctx.now().getTime());
    if (!link) throw new HttpError(400, 'invalid', 'The server link is invalid or has expired. Run /frostsim subscribe again.');
    // The link is bound to the member who ran /frostsim subscribe (Manage Server): only a Frostsim account with that Discord linked pays.
    const [owner] = await ctx.sql`select 1 from identities where user_id = ${ctx.session!.userId} and provider = 'discord'
      and subject = ${link.discordUserId}`;
    if (!owner) {
      throw new HttpError(403, 'forbidden', 'This server link belongs to the Discord account that ran /frostsim subscribe. Sign in with that Discord account, or run the command yourself.');
    }
    guildId = link.guildId;
  } else if (body.guildToken !== undefined) {
    throw new HttpError(400, 'invalid', 'A server link only applies to the Discord server plan.');
  }

  await limitStripeCalls(ctx);
  const userId = ctx.session!.userId;
  const customer = await customerFor(ctx, userId);
  const prices = await stripe<{ data?: { id: string }[] }>(ctx, 'GET', '/prices', { lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = prices.data?.[0];
  if (!price) throw new HttpError(503, 'unconfigured', 'This plan is not on sale yet.');

  const origin = ctx.config.publicOrigin;
  const session = await stripe<{ url: string }>(ctx, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    customer,
    client_reference_id: userId,
    line_items: [{ price: price.id, quantity }],
    subscription_data: { metadata: { user_id: userId, guild_id: guildId ?? undefined } },
    success_url: `${origin}/?account=billing-success#/`,
    cancel_url: `${origin}/?account=billing-cancelled#/`,
    // Auto-renewal laws want the renewal and cancellation terms beside the button, with the terms one click away.
    custom_text: { submit: { message: 'Renews automatically each term until you cancel. Cancel any time in Manage billing; the plan '
      + `stays active to the end of the period you paid for. By subscribing you agree to the [Terms of use](${origin}/legal/terms.html).` } },
    // The Stripe account's own name and logo belong to its owner's other business; Checkout shows Frostsim's instead. The portal and
    // Stripe's emails have no such override and still show the account's.
    branding_settings: {
      display_name: 'Frostsim',
      icon: { type: 'url', url: `${origin}/brand/icon-512.png` },
      logo: { type: 'url', url: `${origin}/brand/frostsim-logo-web.png` },
      background_color: '#0a0c11',
      button_color: '#17c8f4',
      border_style: 'rounded',
    },
  });
  return json({ url: session.url });
}

async function portal(ctx: RequestCtx): Promise<Response> {
  await limitStripeCalls(ctx);
  const [user] = await ctx.sql`select stripe_customer_id from users where id = ${ctx.session!.userId}`;
  if (!user?.stripe_customer_id) throw new HttpError(404, 'not-found', 'There is no billing account yet.');
  // A portal configuration made through the API is never the account's default, so it is named here (bpc_...); without one, Stripe's
  // default (set in the Dashboard) applies.
  const configuration = ctx.config.env.STRIPE_PORTAL_CONFIGURATION || undefined;
  const session = await stripe<{ url: string }>(ctx, 'POST', '/billing_portal/sessions', {
    customer: user.stripe_customer_id,
    return_url: `${ctx.config.publicOrigin}/#/`,
    configuration,
  });
  return json({ url: session.url });
}

/** The subscription an event is about, for the event types that can change one; null for everything else. */
function subscriptionIdOf(type: string, object: EventObject): string | null {
  let id: unknown = null;
  if (type.startsWith('customer.subscription.')) id = object.id;
  else if (type === 'checkout.session.completed') id = object.subscription;
  else if (type.startsWith('invoice.')) id = object.parent?.subscription_details?.subscription ?? object.subscription;
  if (id && typeof id === 'object') id = (id as { id?: unknown }).id;
  return typeof id === 'string' && SUB_ID.test(id) ? id : null;
}

async function userFor(db: Db, metaUserId: string | undefined, customer: string | null): Promise<string | null> {
  if (metaUserId && USER_ID.test(metaUserId)) {
    const [user] = await db`select id from users where id = ${metaUserId}`;
    if (user) return user.id;
  }
  if (!customer) return null;
  const [user] = await db`select id from users where stripe_customer_id = ${customer}`;
  return user?.id ?? null;
}

/** Writes Stripe's current state of the subscription. Writes are ordered by when the GET was sent (ms): a read that started before
 *  another one already stored is stale and refused. Event `created` cannot order them (whole seconds, shared by distinct events). */
async function syncSubscription(ctx: AppCtx, subId: string): Promise<void> {
  const fetchedAt = ctx.now().getTime();
  let sub: StripeSubscription;
  try {
    sub = await stripe<StripeSubscription>(ctx, 'GET', `/subscriptions/${subId}`);
  } catch (err) {
    // Only test-mode data can vanish (live subscriptions are canceled, not deleted). Whatever it granted ends.
    if (!(err instanceof StripeError && err.status === 404)) throw err;
    ctx.log(`stripe webhook: ${subId} is not on Stripe; marked canceled`);
    await ctx.sql`update subscriptions set status = 'canceled', stripe_updated = ${fetchedAt}, updated_at = now()
      where stripe_subscription_id = ${subId} and coalesce(stripe_updated, 0) <= ${fetchedAt}`;
    return;
  }

  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
  const userId = await userFor(ctx.sql, sub.metadata?.user_id, customer);
  const noUser = () => ctx.log(`stripe webhook: ${subId} belongs to no user here; ignored`);
  if (!userId) return noUser();
  // ponytail: reads Stripe's first page of items (10); the catalog has 6 keys.
  const data = sub.items?.data ?? [];
  const items: SubscriptionItem[] = data.flatMap((item) => {
    const lookupKey = item.price?.lookup_key;
    if (!lookupKey) return [];
    const coreHours = Number(item.price?.metadata?.core_hours);
    // What the item charges, kept so the cost cap (queue.ts costProblem) knows what the plan pays. Months only for month or year terms.
    const amount = item.price?.unit_amount, recurring = item.price?.recurring;
    const months = (recurring?.interval === 'year' ? 12 : recurring?.interval === 'month' ? 1 : 0) * (recurring?.interval_count ?? 1);
    return [{
      lookupKey, quantity: item.quantity ?? 1, ...(coreHours > 0 ? { coreHours } : {}),
      ...(Number.isInteger(amount) && amount! >= 0 && item.price?.currency ? { unitAmount: amount!, currency: item.price.currency } : {}),
      ...(months > 0 ? { months } : {}),
    }];
  });
  const dated = data.find((item) => item.current_period_start && item.current_period_end);
  const periodStart = dated ? new Date(dated.current_period_start! * 1000) : null;
  const periodEnd = dated ? new Date(dated.current_period_end! * 1000) : null;
  const guildId = GUILD_ID.test(sub.metadata?.guild_id ?? '') ? sub.metadata!.guild_id : null;

  try {
    await ctx.sql`insert into subscriptions
        (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items, guild_id, stripe_updated)
      values (${subId}, ${userId}, ${sub.status}, ${periodStart}, ${periodEnd}, ${ctx.sql.json(items as never)}, ${guildId}, ${fetchedAt})
      on conflict (stripe_subscription_id) do update set user_id = excluded.user_id, status = excluded.status,
        current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
        items = excluded.items, guild_id = excluded.guild_id, stripe_updated = excluded.stripe_updated, updated_at = now()
      where subscriptions.stripe_updated is null or subscriptions.stripe_updated <= excluded.stripe_updated`;
  } catch (err) {
    // foreign_key_violation: the user was deleted after userFor found it (deletion cancels the subscriptions and sends exactly these
    // events). A 500 would only make Stripe retry into the same answer, so it is the same no-user case.
    if ((err as { code?: string }).code !== '23503') throw err;
    noUser();
  }
}

async function webhook(ctx: RequestCtx): Promise<Response> {
  const nowS = Math.floor(ctx.now().getTime() / 1000);
  const secret = ctx.config.env.STRIPE_WEBHOOK_SECRET!;
  if (!verifyStripeSignature(await ctx.body(), ctx.request.headers.get('stripe-signature'), secret, nowS)) {
    throw new HttpError(400, 'invalid', 'Bad signature.');
  }
  const event = await ctx.json<{ id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: EventObject } } | null>();
  if (typeof event?.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) {
    throw new HttpError(400, 'invalid', 'Not a Stripe event.');
  }
  const subId = subscriptionIdOf(event.type, event.data.object);
  if (!subId) return json({ received: true });
  // A live endpoint secret beside a test key (or the reverse) makes every refetch 404, which would cancel rows. Fail loudly instead:
  // the 500 is logged and Stripe retries once the key is fixed.
  if ((event.livemode === true) !== /^[rs]k_live_/.test(ctx.config.env.STRIPE_SECRET_KEY ?? '')) {
    throw new Error('Stripe event livemode does not match the mode of STRIPE_SECRET_KEY');
  }

  // Recorded only after the write, so a crash, a failed write or an overlapping delivery never leaves an id recorded whose write is
  // missing. Processing an event twice is harmless: it re-fetches.
  const [seen] = await ctx.sql`select 1 from stripe_events where id = ${event.id}`;
  if (seen) return json({ received: true, duplicate: true });
  await syncSubscription(ctx, subId);
  await ctx.sql`insert into stripe_events (id, type) values (${event.id}, ${event.type}) on conflict (id) do nothing`;
  return json({ received: true });
}

export const routes: Route[] = [
  { method: 'GET', path: /^\/api\/v1\/billing$/, feature: 'billing', auth: 'session', handler: summary },
  { method: 'POST', path: /^\/api\/v1\/billing\/checkout$/, feature: 'billing', auth: 'session', handler: checkout },
  { method: 'POST', path: /^\/api\/v1\/billing\/portal$/, feature: 'billing', auth: 'session', handler: portal },
  // Invoice events can exceed the 64 KiB default; nginx caps every body at 1 MiB anyway.
  { method: 'POST', path: /^\/api\/v1\/stripe\/webhook$/, feature: 'billing', auth: 'public', maxBody: 1 << 20, handler: webhook },
];
/** Rows re-read per run. Normally only subscriptions that renewed within the last hour are due, and each costs one Stripe GET. */
const RESYNC_BATCH = 50;

/** A renewal or cancellation whose webhook never arrived (endpoint down past Stripe's 3 days of retries): the stored period has ended
 *  but the status still grants. Without this the renewal grace lapses a paying user until the next event, a month on, and a missed
 *  deletion keeps granting through the grace. Oldest fetch first, so a subscription that keeps failing cannot starve the rest. */
async function resyncEnded(ctx: AppCtx): Promise<void> {
  const rows = await ctx.sql`select stripe_subscription_id from subscriptions
    where status in ('active', 'trialing', 'past_due') and current_period_end < ${ctx.now()}
    order by stripe_updated nulls first limit ${RESYNC_BATCH}`;
  for (const { stripe_subscription_id: subId } of rows) {
    try {
      await syncSubscription(ctx, subId);
    } catch (err) {
      ctx.log(`billing: resync of ${subId} failed (${errorSummary(err)})`);
    }
  }
}

export const tasks: Task[] = [{ name: 'billing-resync', feature: 'billing', everyMs: 3_600_000, run: resyncEnded }];
