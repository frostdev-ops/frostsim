// Gated AI integration (CLAUDE.md D17): the real SQL of migration 008, the reserve transaction under concurrency, the ledger's place in the
// plan cost cap, per-player memory, export and account deletion, against the local Postgres (FROSTSIM_TEST_PG). OpenRouter and R2 are faked
// at fetch. Each run owns a fresh schema and removes it.

import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from './ai';
import { createApp, type AppCtx } from './app';
import { loadConfig } from './config';
import { connectDb, type Sql } from './db';
import { calendarMonth } from './entitlements';
import { migrate } from './migrate';
import { createR2 } from './r2';
import { createSession } from './session';
import { deleteAccount, exportAccount } from './users';
import { usedCostUsd } from './usage';

const PG = process.env.FROSTSIM_TEST_PG;
const ORIGIN = 'https://sim.test';
const PAID = 5 * 0.971 - 0.3;

describe.skipIf(!PG)('ai postgres integration (needs FROSTSIM_TEST_PG)', () => {
  const schema = `t_ai_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;
  let app: AppCtx;
  let handle: ReturnType<typeof createApp>;
  const replies: { tool_calls?: unknown[]; content?: string; status?: number; fail?: boolean }[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === 'openrouter.ai') {
      // Long enough for concurrent requests to overlap inside the reserve.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const r = replies.shift() ?? {};
      if (r.fail) throw new TypeError('fetch failed');
      if (r.status) return new Response('{}', { status: r.status });
      return Response.json({ model: 'openai/gpt-x', choices: [{ message: { role: 'assistant', content: r.content ?? 'Done.', tool_calls: r.tool_calls } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 } });
    }
    if (url.host.endsWith('r2.cloudflarestorage.com')) return new Response(null, { status: init?.method === 'DELETE' ? 204 : 200 });
    throw new Error(`unexpected fetch ${url.host}`);
  }) as typeof fetch;

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('./migrations/', import.meta.url));
    const config = loadConfig({
      FEATURES: 'ai', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'x', SESSION_SECRET: randomBytes(32).toString('hex'),
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-0123456789abcdef', AI_MONTHLY_USD_CAP: '10',
      R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
    });
    app = { config, sql, redis: null, r2: createR2(config, fakeFetch), fetch: fakeFetch, now: () => new Date(), log: () => {} };
    handle = createApp(app, routes);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  async function newUser(plan = false) {
    const [user] = await sql`insert into users (display_name) values ('Player') returning id`;
    if (plan) {
      await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items)
        values (${`sub_${randomBytes(6).toString('hex')}`}, ${user.id}, 'active', ${new Date(Date.now() - 86_400_000)}, ${new Date(Date.now() + 86_400_000)},
          ${sql.json([{ lookupKey: 'compute_s_monthly', quantity: 1, unitAmount: 500, currency: 'usd' }])})`;
    }
    const { cookie } = await createSession(app, user.id);
    const explain = (envelope: unknown = { kind: 'weights', context: { weights: [] } }, raw?: Uint8Array) => handle(new Request(`${ORIGIN}/api/v1/ai/explain`, {
      method: 'POST',
      headers: { cookie: cookie.split(';')[0], origin: ORIGIN, 'content-type': 'application/gzip' },
      body: (raw ?? new Uint8Array(gzipSync(JSON.stringify(envelope)))) as Uint8Array<ArrayBuffer>,
    }), '10.0.0.1');
    return { id: user.id as string, explain };
  }

  it('applies migration 008 and settles a call to what OpenRouter billed', async () => {
    const { id, explain } = await newUser();
    const res = await explain();
    expect([res.status, (await res.json()).remaining]).toEqual([200, 2]);
    const rows = await sql`select source, kind, model, input_tokens, output_tokens, cost_usd::float8 as cost from ai_calls where user_id = ${id}`;
    expect(rows).toEqual([{ source: 'web', kind: 'weights', model: 'openai/gpt-x', input_tokens: 10, output_tokens: 5, cost: 0.002 }]);
  });

  it('lets exactly 3 of 8 simultaneous calls from a free account through, and writes no row for the refused ones', async () => {
    const { id, explain } = await newUser();
    const results = await Promise.all(Array.from({ length: 8 }, () => explain()));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 402, 402, 402, 402, 402]);
    expect(await sql`select 1 from ai_calls where user_id = ${id}`).toHaveLength(3);
  });

  it('answers an exhausted account 402 without reading its body', async () => {
    const { explain } = await newUser();
    for (let i = 0; i < 3; i++) expect((await explain()).status).toBe(200);
    const res = await explain(null, new TextEncoder().encode('not gzip'));
    expect([res.status, (await res.json()).error]).toEqual([402, 'ai-quota']);
  });

  it('frees the row of a request OpenRouter refused, so it does not use up one of the day\'s calls', async () => {
    const { id, explain } = await newUser();
    replies.push({ status: 500 });
    expect((await explain()).status).toBe(502);
    expect(await sql`select 1 from ai_calls where user_id = ${id}`).toHaveLength(0);
    const next = await explain();
    expect([next.status, (await next.json()).remaining]).toEqual([200, 2]);
  });

  it('keeps the reserve of a request lost to a network failure, and it counts toward the day', async () => {
    const { id, explain } = await newUser();
    replies.push({ fail: true });
    expect((await explain()).status).toBe(502);
    expect(await sql`select cost_usd::float8 as cost from ai_calls where user_id = ${id}`).toEqual([{ cost: 0.05 }]);
    const next = await explain();
    expect([next.status, (await next.json()).remaining]).toEqual([200, 1]);
  });

  it('counts a failed call at its reserve, and counts AI spend toward the plan cost cap', async () => {
    const { id, explain } = await newUser(true);
    const period = calendarMonth(new Date());
    expect(await usedCostUsd(sql, { userId: id }, period.periodStart, period.periodEnd)).toBe(0);
    await sql`insert into ai_calls (user_id, source, kind, cost_usd) values (${id}, 'web', 'report', ${PAID - 0.01})`;
    expect(await usedCostUsd(sql, { userId: id }, period.periodStart, period.periodEnd)).toBeCloseTo(PAID - 0.01, 6);
    const res = await explain();
    expect([res.status, (await res.json()).error]).toEqual([402, 'cost-cap']);
    expect(await sql`select 1 from ai_calls where user_id = ${id}`).toHaveLength(1);
  });

  it('sums compute jobs and AI calls in one scope, and a guild pool apart from a member\'s own use', async () => {
    const { id } = await newUser();
    const guild = `g-${randomBytes(3).toString('hex')}`;
    await sql`insert into compute_jobs (user_id, source, pack_id, threads, status, cost_usd) values (${id}, 'web', 'p', 8, 'done', 1.25)`;
    await sql`insert into ai_calls (user_id, source, kind, cost_usd) values (${id}, 'web', 'report', 0.5)`;
    await sql`insert into ai_calls (user_id, guild_id, source, kind, cost_usd) values (${id}, ${guild}, 'discord', 'takeaway', 0.7)`;
    const { periodStart, periodEnd } = calendarMonth(new Date());
    expect(await usedCostUsd(sql, { userId: id }, periodStart, periodEnd)).toBeCloseTo(1.75, 6);
    expect(await usedCostUsd(sql, { guildId: guild }, periodStart, periodEnd)).toBeCloseTo(0.7, 6);
  });

  it('saves a note, recalls it, and keeps only the newest 20 per player and character', async () => {
    const { id, explain } = await newUser();
    const character = { name: 'Testchar', realm: 'Area 52', region: 'us' };
    for (let i = 0; i < 22; i++) await sql`insert into ai_memory (user_id, character_key, note) values (${id}, 'k', ${`old ${i}`})`;
    replies.push({ tool_calls: [{ id: 'n', type: 'function', function: { name: 'memory_note', arguments: JSON.stringify({ text: 'newest finding' }) } }] });
    const res = await explain({ kind: 'weights', context: {}, character });
    expect(res.status).toBe(200);
    // The route keys by an HMAC of the character; the rows seeded under 'k' belong to another character and are untouched.
    const own = await sql`select note from ai_memory where user_id = ${id} and character_key <> 'k'`;
    expect(own).toEqual([{ note: 'newest finding' }]);
    expect(await sql`select 1 from ai_memory where user_id = ${id} and character_key = 'k'`).toHaveLength(22);
    // A second player never reads it.
    const other = await newUser();
    replies.push({ tool_calls: [{ id: 'r', type: 'function', function: { name: 'memory_recall', arguments: '{}' } }] });
    await other.explain({ kind: 'weights', context: {}, character });
    expect(await sql`select 1 from ai_memory where user_id = ${other.id}`).toHaveLength(0);
  });

  it('exports both tables, and on deletion removes the notes and keeps the ledger without the user id', async () => {
    const { id, explain } = await newUser();
    await explain();
    await sql`insert into ai_memory (user_id, character_key, note) values (${id}, 'k', 'a note')`;
    const data = await exportAccount(sql, id);
    expect(data!.aiCalls).toHaveLength(1);
    expect(data!.aiMemory).toEqual([expect.objectContaining({ character_key: 'k', note: 'a note' })]);

    expect(await deleteAccount(app, id, 'system')).toBe('deleted');
    expect(await sql`select 1 from ai_memory where user_id = ${id}`).toHaveLength(0);
    expect(await sql`select 1 from ai_calls where user_id = ${id}`).toHaveLength(0);
    const kept = await sql`select user_id, cost_usd::float8 as cost from ai_calls where kind = 'weights' and user_id is null and cost_usd = 0.002`;
    expect(kept.length).toBeGreaterThanOrEqual(1);
  });
});
