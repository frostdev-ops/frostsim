// Billing routes and the Stripe webhook (CLAUDE.md D15; DESIGN.md C5, C6, P4-P6). Stripe is always a fake fetch. The replay
// scenarios run twice: against an in-memory stand-in here, and against the local Postgres in the gated suite at the bottom.

import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { GUILD_CHECKOUT_PURPOSE, routes, tasks, verifyStripeSignature } from './billing';
import { loadConfig } from './config';
import { connectDb, type Sql } from './db';
import { entitlementsFor, type SubscriptionItem } from './entitlements';
import { migrate } from './migrate';
import { createR2 } from './r2';
import type { Redis } from './redis';
import { createSession } from './session';
import { sign } from './signed';
import { STRIPE_API_VERSION } from './stripe';

const ORIGIN = 'https://sim.test';
const SID = 'a'.repeat(43);
const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = 's'.repeat(32);
const WHSEC = 'whsec_test_secret';
const GUILD = '123456789012345678';
const NOW = new Date('2026-09-23T12:00:00Z');
const NOW_S = NOW.getTime() / 1000;
const START_S = Date.parse('2026-09-10T00:00:00Z') / 1000;
const END_S = Date.parse('2026-10-10T00:00:00Z') / 1000;
/** Every harness's now(). It stands still unless a test moves it, and only ever forward, so rows written by one test stay older. */
const clock = { ms: NOW.getTime() };
const config = loadConfig({
  FEATURES: 'billing', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: SECRET,
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC,
});

interface Row {
  stripe_subscription_id: string;
  user_id: string;
  status: string;
  current_period_start: Date | null;
  current_period_end: Date | null;
  items: SubscriptionItem[];
  guild_id: string | null;
  stripe_updated: number;
}
interface User { id: string; stripe_customer_id: string | null; suspended_at?: Date | null; discord?: string }
interface Call { method: string; path: string; query: URLSearchParams; form: URLSearchParams; headers: Headers }

/** A Stripe subscription as GET /v1/subscriptions/:id returns it under the pinned version: the period lives on each item. */
function stripeSub(status: string, over: { metadata?: Record<string, string>; items?: unknown[]; customer?: string } = {}) {
  const item = { quantity: 1, current_period_start: START_S, current_period_end: END_S,
    price: { id: 'price_m', object: 'price', lookup_key: 'compute_m_monthly', metadata: { core_hours: '10' } } };
  return { id: 'sub_1', object: 'subscription', status, customer: over.customer ?? 'cus_1', metadata: over.metadata ?? { user_id: USER },
    items: { object: 'list', data: over.items ?? [item] } };
}

let eventSeq = 0;
const event = (type: string, created: number, object: object) => ({ id: `evt_${++eventSeq}`, object: 'event', type, created, data: { object } });

function signedWebhook(payload: object, { secret = WHSEC, t = NOW_S, header }: { secret?: string; t?: number; header?: string } = {}) {
  const body = JSON.stringify(payload);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return new Request(`${ORIGIN}/api/v1/stripe/webhook`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': header ?? `t=${t},v1=${v1}` },
  });
}

/** Fake Stripe: records every call; subscriptions come from `truth` (null -> 404), `failures` answers 500 that many times first.
 *  `held` makes the next subscription GET read `truth` on arrival but answer only once released. `onCustomer` runs while a customer
 *  is being created; customer DELETEs answer `deleteStatus`. */
function fakeStripe() {
  const state = { truth: stripeSub('active') as object | null, failures: 0, prices: true, calls: [] as Call[],
    held: null as { arrived(): void; released: Promise<void> } | null, onCustomer: null as (() => unknown) | null, deleteStatus: 200 };
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? 'GET', path: url.pathname.replace(/^\/v1/, ''), query: url.searchParams,
      form: new URLSearchParams(typeof init.body === 'string' ? init.body : ''), headers: new Headers(init.headers) };
    state.calls.push(call);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (call.path.startsWith('/subscriptions/')) {
      const truth = state.truth;
      const held = state.held;
      state.held = null;
      if (held) {
        held.arrived();
        await held.released;
      }
      if (state.failures > 0) {
        state.failures--;
        return reply({ error: { type: 'api_error' } }, 500);
      }
      return truth ? reply(truth) : reply({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, 404);
    }
    if (call.path === '/customers') {
      await state.onCustomer?.();
      return reply({ id: 'cus_new' });
    }
    if (call.method === 'DELETE' && call.path.startsWith('/customers/')) return reply({ deleted: true }, state.deleteStatus);
    if (call.path === '/prices') return reply({ data: state.prices ? [{ id: `price_${call.query.get('lookup_keys[0]')}` }] : [] });
    if (call.path === '/checkout/sessions') return reply({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    if (call.path === '/billing_portal/sessions') return reply({ url: 'https://billing.stripe.com/p/session/test_1' });
    return reply({ error: { type: 'invalid_request_error' } }, 404);
  }) as typeof fetch;
  return { state, fetchFn };
}

/** In-memory stand-in for the queries billing.ts, session.ts, entitlements.ts and usage.ts issue. */
function memoryDb(users: User[]) {
  const events = new Set<string>();
  const subs = new Map<string, Row>();
  /** The next subscription write throws this, like a Postgres outage or a constraint violation. */
  const faults = { upsertError: null as Error | null };
  const run = (q: string, v: unknown[]): unknown[] => {
    if (q.includes('from sessions s join users')) {
      return [{ user_id: USER, role: 'user', display_name: 'Bob', suspended_at: null, expires_at: new Date(NOW.getTime() + 3600_000), last_seen_at: NOW }];
    }
    if (q.includes('from stripe_events where id')) return events.has(v[0] as string) ? [{}] : [];
    if (q.includes('insert into stripe_events')) {
      events.add(v[0] as string);
      return [];
    }
    if (q.includes('from identities where user_id')) return users.some((u) => u.id === v[0] && u.discord === v[1]) ? [{}] : [];
    if (q.includes('select id from users where id')) return users.filter((u) => u.id === v[0]);
    if (q.includes('select id from users where stripe_customer_id')) return users.filter((u) => u.stripe_customer_id === v[0]);
    if (q.startsWith('select stripe_customer_id')) return users.filter((u) => u.id === v[0]);
    if (q.includes('update users set stripe_customer_id')) {
      const user = users.find((u) => u.id === v[1]);
      if (!user) return [];
      user.stripe_customer_id ??= v[0] as string;
      return [user];
    }
    if (q.includes('insert into subscriptions')) {
      const err = faults.upsertError;
      faults.upsertError = null;
      if (err) throw err;
      const [id, userId, status, start, end, items, guildId, updated] = v as [string, string, string, Date | null, Date | null, SubscriptionItem[], string | null, number];
      const old = subs.get(id);
      if (!old || old.stripe_updated <= updated) {
        subs.set(id, { stripe_subscription_id: id, user_id: userId, status, current_period_start: start, current_period_end: end, items, guild_id: guildId, stripe_updated: updated });
      }
      return [];
    }
    if (q.includes("set status = 'canceled'")) {
      const old = subs.get(v[1] as string);
      if (old && old.stripe_updated <= (v[2] as number)) subs.set(old.stripe_subscription_id, { ...old, status: 'canceled', stripe_updated: v[0] as number });
      return [];
    }
    if (q.includes('from subscriptions where user_id')) return [...subs.values()].filter((s) => s.user_id === v[0]);
    if (q.includes('current_period_end <')) {
      return [...subs.values()]
        .filter((s) => ['active', 'trialing', 'past_due'].includes(s.status) && s.current_period_end && s.current_period_end < (v[0] as Date))
        .sort((a, b) => a.stripe_updated - b.stripe_updated).slice(0, v[1] as number);
    }
    if (q.includes('comp_core_seconds')) return [{ core_seconds: 0, max_threads: null }];
    if (q.includes('sum(core_seconds)')) return [{ used: 1234 }];
    return [];
  };
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve(run(strings.join('?'), values)),
    { json: (value: unknown) => value }) as unknown as Sql;
  return { sql, events, subs, faults };
}

function harness(users: User[] = [{ id: USER, stripe_customer_id: null }], { sql, redis = null }: { sql?: Sql; redis?: Redis | null } = {}) {
  const stripe = fakeStripe();
  const db = memoryDb(users);
  const lines: string[] = [];
  const app = { config, sql: sql ?? db.sql, redis, r2: createR2(config, stripe.fetchFn), fetch: stripe.fetchFn,
    now: () => new Date(clock.ms), log: (l: string) => lines.push(l) };
  const handle = createApp(app, routes);
  const send = (request: Request) => handle(request, '10.0.0.1');
  /** Holds the next subscription GET; `arrived` settles once it has read Stripe's state. */
  const hold = () => {
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    stripe.state.held = { arrived, released: new Promise<void>((resolve) => (release = resolve)) };
    return { arrived: reached, release };
  };
  const resync = () => tasks.find((t) => t.name === 'billing-resync')!.run(app);
  return { ...stripe, ...db, users, lines, send, hold, resync, webhook: (payload: object) => send(signedWebhook(payload)) };
}

const cookie = `__Host-fs_sid=${SID}`;
const post = (path: string, body?: unknown) => new Request(ORIGIN + path, {
  method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body),
});
const entitlementsOf = (rows: Row[]) => entitlementsFor(rows.map((r) => ({ status: r.status, currentPeriodStart: r.current_period_start,
  currentPeriodEnd: r.current_period_end, items: r.items, guildId: r.guild_id })), { coreSeconds: 0, maxThreads: null }, NOW);

/** Racing, out-of-order and stale-payload deliveries: the stored row is always Stripe's most recently fetched state. */
async function replayScenarios(h: ReturnType<typeof harness> & { rows(): Promise<Row[]> }) {
  const paid = { coreSeconds: 36_000, maxThreads: 16, hostedShares: true, periodStart: new Date(START_S * 1000), periodEnd: new Date(END_S * 1000) };
  const none = { coreSeconds: 0, maxThreads: 0, hostedShares: false };

  // Two events from the same second, handled at once: the one that read Stripe before the payment completed writes last, and loses.
  h.state.truth = stripeSub('incomplete');
  const held = h.hold();
  const stale = h.webhook(event('customer.subscription.created', 100, stripeSub('incomplete')));
  await held.arrived;
  clock.ms += 1;
  h.state.truth = stripeSub('active');
  expect((await h.webhook(event('customer.subscription.updated', 100, stripeSub('past_due')))).status).toBe(200);
  held.release();
  expect((await stale).status).toBe(200);
  expect(await h.rows()).toMatchObject([{ status: 'active', stripe_updated: clock.ms, items: [{ lookupKey: 'compute_m_monthly', quantity: 1, coreHours: 10 }] }]);
  expect(entitlementsOf(await h.rows())).toMatchObject(paid);

  // An older event delivered late re-reads Stripe instead of applying its payload.
  expect((await h.webhook(event('customer.subscription.created', 90, stripeSub('incomplete')))).status).toBe(200);
  expect(await h.rows()).toMatchObject([{ status: 'active' }]);

  // deleted, then the older updated.
  h.state.truth = stripeSub('canceled');
  expect((await h.webhook(event('customer.subscription.deleted', 300, stripeSub('canceled')))).status).toBe(200);
  expect(await h.rows()).toMatchObject([{ status: 'canceled' }]);
  expect(entitlementsOf(await h.rows())).toMatchObject(none);
  expect((await h.webhook(event('customer.subscription.updated', 250, stripeSub('active')))).status).toBe(200);
  expect(await h.rows()).toMatchObject([{ status: 'canceled' }]);
  expect(entitlementsOf(await h.rows())).toMatchObject(none);
}

describe('verifyStripeSignature', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const sig = (t: number, secret = WHSEC, payload: Uint8Array = body) =>
    createHmac('sha256', secret).update(`${t}.`).update(payload).digest('hex');

  it('accepts a valid signature, also one 299 s old', () => {
    expect(verifyStripeSignature(body, `t=${NOW_S},v1=${sig(NOW_S)}`, WHSEC, NOW_S)).toBe(true);
    expect(verifyStripeSignature(body, `t=${NOW_S - 299},v1=${sig(NOW_S - 299)}`, WHSEC, NOW_S)).toBe(true);
  });

  it('refuses a wrong secret, a changed body, and a signature past the 300 s tolerance', () => {
    expect(verifyStripeSignature(body, `t=${NOW_S},v1=${sig(NOW_S, 'whsec_other')}`, WHSEC, NOW_S)).toBe(false);
    expect(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), `t=${NOW_S},v1=${sig(NOW_S)}`, WHSEC, NOW_S)).toBe(false);
    expect(verifyStripeSignature(body, `t=${NOW_S - 301},v1=${sig(NOW_S - 301)}`, WHSEC, NOW_S)).toBe(false);
  });

  it('accepts any matching v1 among several, and ignores v0 and a tampered t', () => {
    const header = `t=${NOW_S},v1=${sig(NOW_S, 'whsec_old')},v1=${sig(NOW_S)},v0=${sig(NOW_S)}`;
    expect(verifyStripeSignature(body, header, WHSEC, NOW_S)).toBe(true);
    expect(verifyStripeSignature(body, `t=${NOW_S},v0=${sig(NOW_S)}`, WHSEC, NOW_S)).toBe(false);
    expect(verifyStripeSignature(body, `t=${NOW_S + 1},v1=${sig(NOW_S)}`, WHSEC, NOW_S)).toBe(false);
    expect(verifyStripeSignature(body, `t=abc,v1=${sig(NOW_S)}`, WHSEC, NOW_S)).toBe(false);
    expect(verifyStripeSignature(body, null, WHSEC, NOW_S)).toBe(false);
  });
});

describe('stripe webhook', () => {
  const rowsOf = (h: ReturnType<typeof harness>) => async () => [...h.subs.values()];

  it('400s a bad or expired signature and a signed body that is not an event, touching nothing', async () => {
    const h = harness();
    const payload = event('customer.subscription.updated', 100, stripeSub('active'));
    for (const request of [
      signedWebhook(payload, { secret: 'whsec_wrong' }),
      signedWebhook(payload, { t: NOW_S - 301 }),
      signedWebhook(payload, { header: 'v1=deadbeef' }),
      signedWebhook({ hello: 'world' }),
    ]) {
      const res = await h.send(request);
      expect([res.status, (await res.json()).error]).toEqual([400, 'invalid']);
    }
    expect(h.state.calls).toEqual([]);
    expect(h.events.size).toBe(0);
  });

  it('replays out of order and always ends in the refetched truth', async () => {
    const h = harness();
    await replayScenarios({ ...h, rows: rowsOf(h) });
  });

  it('ignores a duplicate event without calling Stripe again', async () => {
    const h = harness();
    const payload = event('customer.subscription.updated', 100, stripeSub('active'));
    expect(await (await h.webhook(payload)).json()).toEqual({ received: true });
    expect(await (await h.webhook(payload)).json()).toEqual({ received: true, duplicate: true });
    expect(h.state.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /subscriptions/sub_1']);
    expect(h.state.calls[0].headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
  });

  it('500s when the refetch fails and processes Stripe\'s retry of the same event', async () => {
    const h = harness();
    h.state.failures = 1;
    const payload = event('customer.subscription.created', 100, stripeSub('active'));
    expect((await h.webhook(payload)).status).toBe(500);
    expect(h.events.size).toBe(0);
    expect(h.lines.join()).not.toContain(WHSEC);
    expect(await (await h.webhook(payload)).json()).toEqual({ received: true });
    expect([...h.subs.values()]).toMatchObject([{ status: 'active' }]);
  });

  it('records the event only after its write: a crash, a failed write or an overlapping delivery never loses it', async () => {
    const h = harness();
    const payload = event('customer.subscription.deleted', 100, { id: 'sub_1' });
    h.state.truth = stripeSub('canceled');

    // Mid-processing (where a crash would stop it) nothing is recorded yet, and a second delivery is processed, not skipped.
    const held = h.hold();
    const first = h.webhook(payload);
    await held.arrived;
    expect(h.events.size).toBe(0);
    expect(await (await h.webhook(payload)).json()).toEqual({ received: true });
    held.release();
    expect(await (await first).json()).toEqual({ received: true });
    expect(h.events.size).toBe(1);

    // A write that fails (Postgres down) leaves the id unrecorded, so Stripe's retry lands.
    const next = event('customer.subscription.updated', 101, { id: 'sub_2' });
    h.faults.upsertError = new Error('connection terminated');
    expect((await h.webhook(next)).status).toBe(500);
    expect(h.events.has(next.id)).toBe(false);
    expect(await (await h.webhook(next)).json()).toEqual({ received: true });
    expect(h.events.has(next.id)).toBe(true);
  });

  it('500s a live event under a test key without calling Stripe, so a mode mix-up cannot cancel rows', async () => {
    const h = harness();
    const res = await h.webhook({ ...event('customer.subscription.updated', 100, { id: 'sub_1' }), livemode: true });
    expect([res.status, (await res.json()).error]).toEqual([500, 'internal']);
    expect(h.state.calls).toEqual([]);
    expect(h.events.size).toBe(0);
    expect(h.lines.join()).toContain('livemode does not match');
  });

  it('finds the subscription on checkout sessions and invoices, and skips events about none', async () => {
    const h = harness();
    await h.webhook(event('checkout.session.completed', 100, { id: 'cs_1', mode: 'subscription', subscription: 'sub_1' }));
    await h.webhook(event('invoice.paid', 101, { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } } }));
    await h.webhook(event('invoice.payment_failed', 102, { id: 'in_2', subscription: 'sub_1' }));
    expect(h.state.calls.map((c) => c.path)).toEqual(['/subscriptions/sub_1', '/subscriptions/sub_1', '/subscriptions/sub_1']);
    for (const payload of [
      event('checkout.session.completed', 103, { id: 'cs_2', mode: 'payment', subscription: null }),
      event('invoice.paid', 104, { id: 'in_3', parent: null }),
      event('charge.succeeded', 105, { id: 'ch_1' }),
      event('customer.subscription.updated', 106, { id: '../customers/cus_1' }),
    ]) expect(await (await h.webhook(payload)).json()).toEqual({ received: true });
    expect(h.state.calls).toHaveLength(3);
    expect(h.events.size).toBe(3);
  });

  it('maps items, core hours and the guild, and falls back to the customer when metadata has no user', async () => {
    const h = harness([{ id: USER, stripe_customer_id: 'cus_1' }]);
    h.state.truth = stripeSub('active', {
      metadata: { guild_id: GUILD },
      items: [
        { quantity: 1, current_period_start: START_S, current_period_end: END_S, price: { lookup_key: 'discord_guild_monthly', metadata: { core_hours: '5' } } },
        { quantity: 3, current_period_start: START_S, current_period_end: END_S, price: { lookup_key: 'slots_5_monthly', metadata: {} } },
        { quantity: 1, price: { lookup_key: null, metadata: { core_hours: '99' } } },
      ],
    });
    await h.webhook(event('customer.subscription.created', 100, { id: 'sub_1' }));
    expect([...h.subs.values()]).toEqual([{
      stripe_subscription_id: 'sub_1', user_id: USER, status: 'active', guild_id: GUILD, stripe_updated: clock.ms,
      current_period_start: new Date(START_S * 1000), current_period_end: new Date(END_S * 1000),
      items: [{ lookupKey: 'discord_guild_monthly', quantity: 1, coreHours: 5 }, { lookupKey: 'slots_5_monthly', quantity: 3 }],
    }]);
    expect(entitlementsOf([...h.subs.values()]).guilds).toEqual([{ guildId: GUILD, coreSeconds: 18_000, maxThreads: 8,
      periodStart: new Date(START_S * 1000), periodEnd: new Date(END_S * 1000) }]);
  });

  it('stores nothing for a subscription that maps to no user, and cancels one Stripe no longer has', async () => {
    const h = harness([{ id: USER, stripe_customer_id: null }]);
    h.state.truth = stripeSub('active', { metadata: {}, customer: 'cus_stranger' });
    await h.webhook(event('customer.subscription.created', 100, { id: 'sub_1' }));
    expect(h.subs.size).toBe(0);
    expect(h.lines).toEqual(['stripe webhook: sub_1 belongs to no user here; ignored']);

    h.state.truth = stripeSub('active');
    await h.webhook(event('customer.subscription.updated', 101, { id: 'sub_1' }));
    h.state.truth = null;
    expect((await h.webhook(event('customer.subscription.deleted', 102, { id: 'sub_1' }))).status).toBe(200);
    expect([...h.subs.values()]).toMatchObject([{ status: 'canceled', stripe_updated: clock.ms }]);
    expect(h.lines.at(-1)).toBe('stripe webhook: sub_1 is not on Stripe; marked canceled');
  });

  it('200s and records events for a deleted user, before or during the write, logging each once so Stripe does not retry', async () => {
    const h = harness([]);
    h.state.truth = stripeSub('canceled');
    const before = event('customer.subscription.deleted', 100, { id: 'sub_1' });
    expect(await (await h.webhook(before)).json()).toEqual({ received: true });

    // Postgres' answer when the users row goes between the lookup and the insert (the gated suite races a real deletion).
    h.users.push({ id: USER, stripe_customer_id: 'cus_1' });
    h.faults.upsertError = Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
    const during = event('invoice.payment_failed', 101, { id: 'in_1', subscription: 'sub_1' });
    expect(await (await h.webhook(during)).json()).toEqual({ received: true });

    expect([h.events.has(before.id), h.events.has(during.id), h.subs.size]).toEqual([true, true, 0]);
    expect(h.lines).toEqual(Array(2).fill('stripe webhook: sub_1 belongs to no user here; ignored'));
  });
});

describe('billing-resync task', () => {
  // Stored period Aug 10 - Sep 10: at NOW (Sep 23) the 3-day renewal grace is over, so the row grants nothing until it is re-read.
  const ended = (id: string, status: string, stripeUpdated: number): Row => ({
    stripe_subscription_id: id, user_id: USER, status, current_period_start: new Date('2026-08-10T00:00:00Z'),
    current_period_end: new Date('2026-09-10T00:00:00Z'), items: [{ lookupKey: 'compute_m_monthly', quantity: 1, coreHours: 10 }],
    guild_id: null, stripe_updated: stripeUpdated,
  });

  it('re-reads granting subscriptions whose period ended, restoring a renewal whose webhook never came', async () => {
    const h = harness();
    h.subs.set('sub_1', ended('sub_1', 'active', 1));
    h.subs.set('sub_off', ended('sub_off', 'canceled', 0));
    h.subs.set('sub_now', { ...ended('sub_now', 'active', 0), current_period_end: new Date(END_S * 1000) });
    expect(entitlementsOf([h.subs.get('sub_1')!]).coreSeconds).toBe(0);

    await h.resync();
    expect(h.state.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /subscriptions/sub_1']);
    expect(h.subs.get('sub_1')).toMatchObject({ status: 'active', current_period_end: new Date(END_S * 1000), stripe_updated: clock.ms });
    expect(entitlementsOf([h.subs.get('sub_1')!])).toMatchObject({ coreSeconds: 36_000, periodEnd: new Date(END_S * 1000) });
  });

  it('ends a missed cancellation, and one failing subscription neither stops the run nor starves the others', async () => {
    const h = harness();
    h.subs.set('sub_1', ended('sub_1', 'active', 2));
    h.subs.set('sub_stuck', ended('sub_stuck', 'past_due', 1));
    h.state.truth = stripeSub('canceled');
    h.state.failures = 1;
    await h.resync();
    expect(h.state.calls.map((c) => c.path)).toEqual(['/subscriptions/sub_stuck', '/subscriptions/sub_1']);
    expect(h.lines).toEqual(['billing: resync of sub_stuck failed (StripeError: Stripe answered 500 api_error)']);
    expect(h.subs.get('sub_1')!.status).toBe('canceled');
    // Never re-read successfully, so it stays first in line for the next run.
    await h.resync();
    expect(h.state.calls.map((c) => c.path).slice(2)).toEqual(['/subscriptions/sub_stuck']);
    expect(h.subs.get('sub_stuck')!.status).toBe('canceled');
  });
});

describe('checkout', () => {
  const guildToken = (payload: object, purpose = GUILD_CHECKOUT_PURPOSE, now = NOW.getTime()) => sign(SECRET, purpose, payload, 900, now);
  const refused = async (h: ReturnType<typeof harness>, body: unknown) => {
    const res = await h.send(post('/api/v1/billing/checkout', body));
    return [res.status, (await res.json()).error];
  };

  it('creates the customer once, resolves the price by lookup key and builds the subscription session', async () => {
    const h = harness();
    const res = await h.send(post('/api/v1/billing/checkout', { lookupKey: 'compute_m_monthly' }));
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const [customer, prices, session] = h.state.calls;
    expect([customer.method, customer.path, customer.form.get('metadata[user_id]'), customer.headers.get('idempotency-key')])
      .toEqual(['POST', '/customers', USER, `customer-${USER}`]);
    expect(h.users[0].stripe_customer_id).toBe('cus_new');
    expect([prices.method, prices.path, prices.query.toString()]).toEqual(['GET', '/prices', 'lookup_keys%5B0%5D=compute_m_monthly&active=true&limit=1']);
    expect(session.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(session.headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
    expect(Object.fromEntries(session.form)).toEqual({
      mode: 'subscription',
      customer: 'cus_new',
      client_reference_id: USER,
      'line_items[0][price]': 'price_compute_m_monthly',
      'line_items[0][quantity]': '1',
      'subscription_data[metadata][user_id]': USER,
      success_url: `${ORIGIN}/?account=billing-success#/`,
      cancel_url: `${ORIGIN}/?account=billing-cancelled#/`,
    });
  });

  it('reuses a stored customer and passes a quantity for slot packs only', async () => {
    const h = harness([{ id: USER, stripe_customer_id: 'cus_1' }]);
    await h.send(post('/api/v1/billing/checkout', { lookupKey: 'slots_5_monthly', quantity: 3 }));
    expect(h.state.calls.map((c) => c.path)).toEqual(['/prices', '/checkout/sessions']);
    expect([h.state.calls[1].form.get('customer'), h.state.calls[1].form.get('line_items[0][quantity]')]).toEqual(['cus_1', '3']);
    for (const quantity of [0, 1.5, 21, '3', null]) expect(await refused(h, { lookupKey: 'slots_5_monthly', quantity })).toEqual([400, 'invalid']);
    expect(await refused(h, { lookupKey: 'compute_s_monthly', quantity: 1 })).toEqual([400, 'invalid']);
    expect(h.state.calls).toHaveLength(2);
  });

  it('accepts catalog lookup keys only', async () => {
    const h = harness();
    for (const body of [{ lookupKey: 'compute_xl_monthly' }, { lookupKey: 'toString' }, {}, [], null, 'compute_m_monthly']) {
      expect(await refused(h, body)).toEqual([400, 'invalid']);
    }
    expect(h.state.calls).toEqual([]);
  });

  it('puts the guild from a valid guild checkout token into the subscription metadata', async () => {
    const h = harness([{ id: USER, stripe_customer_id: 'cus_1', discord: '223456789012345678' }]);
    const token = guildToken({ kind: 'guild-checkout', guildId: GUILD, discordUserId: '223456789012345678' });
    await h.send(post('/api/v1/billing/checkout', { lookupKey: 'discord_guild_monthly', guildToken: token }));
    const form = h.state.calls[1].form;
    expect([form.get('subscription_data[metadata][guild_id]'), form.get('subscription_data[metadata][user_id]')]).toEqual([GUILD, USER]);
  });

  it('refuses a guild link minted for another Discord user, or a user without Discord linked, before any Stripe call', async () => {
    const token = guildToken({ kind: 'guild-checkout', guildId: GUILD, discordUserId: '223456789012345678' });
    for (const users of [[{ id: USER, stripe_customer_id: null, discord: '323456789012345678' }], [{ id: USER, stripe_customer_id: null }]]) {
      const h = harness(users);
      expect(await refused(h, { lookupKey: 'discord_guild_monthly', guildToken: token })).toEqual([403, 'forbidden']);
      expect(h.state.calls).toEqual([]);
    }
  });

  it('refuses guild checkouts without a valid token, and tokens on any other plan', async () => {
    const h = harness([{ id: USER, stripe_customer_id: 'cus_1' }]);
    const good = { kind: 'guild-checkout', guildId: GUILD, discordUserId: '1' };
    for (const token of [
      undefined,
      'nope',
      guildToken(good, GUILD_CHECKOUT_PURPOSE, NOW.getTime() - 901_000),
      guildToken(good, 'oauth'),
      guildToken({ ...good, kind: 'link' }),
      guildToken({ ...good, guildId: '../1' }),
      sign('x'.repeat(32), GUILD_CHECKOUT_PURPOSE, good, 900, NOW.getTime()),
    ]) expect(await refused(h, { lookupKey: 'discord_guild_monthly', guildToken: token })).toEqual([400, 'invalid']);
    expect(await refused(h, { lookupKey: 'compute_s_monthly', guildToken: guildToken(good) })).toEqual([400, 'invalid']);
    expect(h.state.calls).toEqual([]);
  });

  it('429s checkout and the portal past 10 a minute per user, before any Stripe call', async () => {
    // Redis answers the 11th INCR of this window; session lookups on this stub fall back to the database.
    const redis = { multi: () => ({ incr() { return this; }, expire() { return this; }, exec: async () => [[null, 11], [null, 1]] }) };
    const h = harness([{ id: USER, stripe_customer_id: 'cus_1' }], { redis: redis as unknown as Redis });
    expect(await refused(h, { lookupKey: 'compute_s_monthly' })).toEqual([429, 'rate-limited']);
    const portal = await h.send(post('/api/v1/billing/portal'));
    expect([portal.status, (await portal.json()).error]).toEqual([429, 'rate-limited']);
    expect(h.state.calls).toEqual([]);
  });

  it('refuses a suspended or deleted account before any Stripe call', async () => {
    // Reachable through a session cached before the suspension or deletion.
    const suspended = harness([{ id: USER, stripe_customer_id: 'cus_1', suspended_at: NOW }]);
    expect(await refused(suspended, { lookupKey: 'compute_s_monthly' })).toEqual([403, 'suspended']);
    const gone = harness([]);
    expect(await refused(gone, { lookupKey: 'compute_s_monthly' })).toEqual([404, 'not-found']);
    expect([...suspended.state.calls, ...gone.state.calls]).toEqual([]);
  });

  it('deletes the customer it made for an account deleted meanwhile, and leaves one on an account suspended meanwhile to deletion', async () => {
    const deleted = harness();
    deleted.state.onCustomer = () => deleted.users.splice(0);
    expect(await refused(deleted, { lookupKey: 'compute_s_monthly' })).toEqual([404, 'not-found']);
    expect(deleted.state.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /customers', 'DELETE /customers/cus_new']);
    expect(deleted.lines).toEqual([`billing: ${USER} was deleted during checkout; Stripe customer cus_new deleted`]);

    // Best effort: a failed delete is still a clean 404, and the log names the customer to remove by hand.
    const stuck = harness();
    stuck.state.onCustomer = () => stuck.users.splice(0);
    stuck.state.deleteStatus = 500;
    expect(await refused(stuck, { lookupKey: 'compute_s_monthly' })).toEqual([404, 'not-found']);
    expect(stuck.lines).toEqual([`billing: ${USER} was deleted during checkout; Stripe customer cus_new left behind (StripeError: Stripe answered 500)`]);

    const suspended = harness();
    suspended.state.onCustomer = () => (suspended.users[0].suspended_at = NOW);
    expect(await refused(suspended, { lookupKey: 'compute_s_monthly' })).toEqual([403, 'suspended']);
    expect([suspended.users[0].stripe_customer_id, suspended.state.calls.map((c) => c.path)]).toEqual(['cus_new', ['/customers']]);
  });

  it('503s a catalog plan that has no Stripe price', async () => {
    const h = harness([{ id: USER, stripe_customer_id: 'cus_1' }]);
    h.state.prices = false;
    expect(await refused(h, { lookupKey: 'shares_plus_monthly' })).toEqual([503, 'unconfigured']);
  });
});

describe('portal and summary', () => {
  it('opens the portal for a stored customer and 404s without one', async () => {
    const h = harness([{ id: USER, stripe_customer_id: 'cus_1' }]);
    expect(await (await h.send(post('/api/v1/billing/portal'))).json()).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
    expect(Object.fromEntries(h.state.calls[0].form)).toEqual({ customer: 'cus_1', return_url: `${ORIGIN}/#/` });
    const none = await harness().send(post('/api/v1/billing/portal'));
    expect([none.status, (await none.json()).error]).toEqual([404, 'not-found']);
  });

  it('summarises entitlements, usage over the billing period and subscriptions', async () => {
    const h = harness();
    await h.webhook(event('customer.subscription.created', 100, { id: 'sub_1' }));
    const res = await h.send(new Request(`${ORIGIN}/api/v1/billing`, { headers: { cookie } }));
    const period = { periodStart: new Date(START_S * 1000).toISOString(), periodEnd: new Date(END_S * 1000).toISOString() };
    expect(await res.json()).toEqual({
      entitlements: { coreSeconds: 36_000, maxThreads: 16, slots: 0, hostedShares: true, guilds: [], ...period },
      usage: { usedCoreSeconds: 1234, ...period },
      subscriptions: [{ id: 'sub_1', status: 'active', lookupKeys: ['compute_m_monthly'], periodEnd: period.periodEnd, guildId: null }],
    });
  });
});

const PG = process.env.FROSTSIM_TEST_PG;

describe.skipIf(!PG)('billing postgres integration (needs FROSTSIM_TEST_PG)', () => {
  const schema = `t_billing_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('./migrations/', import.meta.url));
    await sql`insert into users (id, display_name) values (${USER}, 'Bob')`;
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  const rows = async () => (await sql`select stripe_subscription_id, user_id, status, current_period_start, current_period_end, items, guild_id,
    stripe_updated::float8 as stripe_updated from subscriptions`) as unknown as Row[];

  it('upserts replays in any order to the refetched truth and records each event once', async () => {
    const h = harness(undefined, { sql });
    await replayScenarios({ ...h, rows });
    // Leaves sub_1 active for the summary test below.
    h.state.truth = stripeSub('active');
    const payload = event('customer.subscription.updated', 400, { id: 'sub_1' });
    expect(await (await h.webhook(payload)).json()).toEqual({ received: true });
    expect(await (await h.webhook(payload)).json()).toEqual({ received: true, duplicate: true });
    expect(await sql`select type from stripe_events where id = ${payload.id}`).toEqual([{ type: 'customer.subscription.updated' }]);
  });

  it('stores the new customer and serves the summary from real rows', async () => {
    const h = harness(undefined, { sql });
    const session = await createSession({ sql, redis: null, log: () => {}, now: () => NOW, config }, USER);
    const headers = { origin: ORIGIN, 'content-type': 'application/json', cookie: session.cookie.split(';')[0] };
    await h.send(new Request(`${ORIGIN}/api/v1/billing/checkout`, { method: 'POST', headers, body: '{"lookupKey":"compute_s_monthly"}' }));
    expect(await sql`select stripe_customer_id from users where id = ${USER}`).toEqual([{ stripe_customer_id: 'cus_new' }]);
    const summary = await (await h.send(new Request(`${ORIGIN}/api/v1/billing`, { headers }))).json();
    expect(summary.subscriptions).toEqual([{ id: 'sub_1', status: 'active', lookupKeys: ['compute_m_monthly'],
      periodEnd: new Date(END_S * 1000).toISOString(), guildId: null }]);
    expect(summary.usage.usedCoreSeconds).toBe(0);
  });

  it('404s a checkout whose account is deleted while its customer is created, and deletes that customer', async () => {
    const gone = '22222222-2222-4222-8222-222222222222';
    await sql`insert into users (id, display_name) values (${gone}, 'Gone')`;
    const session = await createSession({ sql, redis: null, log: () => {}, now: () => NOW, config }, gone);
    const h = harness(undefined, { sql });
    h.state.onCustomer = () => sql`delete from users where id = ${gone}`;
    const res = await h.send(new Request(`${ORIGIN}/api/v1/billing/checkout`, { method: 'POST', body: '{"lookupKey":"compute_s_monthly"}',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: session.cookie.split(';')[0] } }));
    expect([res.status, (await res.json()).error]).toEqual([404, 'not-found']);
    expect(h.state.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /customers', 'DELETE /customers/cus_new']);
  });

  it('200s an event whose user is deleted while its write waits on the deletion, storing nothing and recording the event', async () => {
    const gone = '33333333-3333-4333-8333-333333333333';
    await sql`insert into users (id, display_name) values (${gone}, 'Gone')`;
    const h = harness(undefined, { sql });
    h.state.truth = stripeSub('canceled', { metadata: { user_id: gone }, customer: 'cus_gone' });
    const payload = event('customer.subscription.deleted', 500, { id: 'sub_gone' });
    let delivery!: Promise<Response>;
    await sql.begin(async (tx) => {
      await tx`delete from users where id = ${gone}`;
      const [{ pid }] = await tx`select pg_backend_pid() as pid`;
      delivery = h.webhook(payload);
      // Commit only once the insert's foreign key check is blocked on this deletion's row lock.
      for (let i = 0; !(await sql`select 1 from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`).length; i++) {
        if (i === 300) throw new Error('the webhook never waited on the deletion');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    expect(await (await delivery).json()).toEqual({ received: true });
    expect(await sql`select 1 from subscriptions where stripe_subscription_id = 'sub_gone'`).toEqual([]);
    expect(await sql`select type from stripe_events where id = ${payload.id}`).toEqual([{ type: 'customer.subscription.deleted' }]);
    expect(h.lines).toEqual(['stripe webhook: sub_gone belongs to no user here; ignored']);
  });

  it('billing-resync selects only granting rows whose period ended, and stores the refetched period', async () => {
    const h = harness(undefined, { sql });
    await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items, stripe_updated)
      values ('sub_later', ${USER}, 'active', '2026-08-10T00:00:00Z', '2026-09-10T00:00:00Z', '[]', 5),
        ('sub_due', ${USER}, 'past_due', '2026-08-10T00:00:00Z', '2026-09-10T00:00:00Z', '[]', 0),
        ('sub_done', ${USER}, 'canceled', '2026-08-10T00:00:00Z', '2026-09-10T00:00:00Z', '[]', 0)`;
    h.state.truth = stripeSub('active');
    await h.resync();
    // Least recently fetched first.
    expect(h.state.calls.map((c) => c.path)).toEqual(['/subscriptions/sub_due', '/subscriptions/sub_later']);
    expect(await sql`select status, current_period_end from subscriptions where stripe_subscription_id = 'sub_due'`)
      .toEqual([{ status: 'active', current_period_end: new Date(END_S * 1000) }]);
  });
});
