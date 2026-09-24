// Gated compute integration (CLAUDE.md D14; DESIGN.md C8, P1, P3, P6): the queue, metering, limits, worker protocol and the
// autoscaler against the local Postgres (and Redis for progress lines), with a fake clock and fake R2/hcloud fetch. Each run owns a
// fresh schema and unique Redis keys, and removes both.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Redis as RawRedis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppCtx } from '../app';
import { loadConfig } from '../config';
import { connectDb, type Sql } from '../db';
import { migrate } from '../migrate';
import { createR2 } from '../r2';
import { connectRedis, type Redis } from '../redis';
import { createSession } from '../session';
import { sha256Hex } from '../signed';
import type { SimRequest } from '../../../src/lib/simc/assemble';
import { DEFAULT_SETTINGS } from '../../../src/lib/simc/options';
import { SCOPE_LOCK, cancelJob, claimJob, completeJob, enqueueJob, expireJobs, failJob, jobView, progressJob, resultBytes, tasks as queueTasks } from './queue';
import { HEARTBEAT_LOSS_MS, tick } from './autoscaler';
import { routes as clientRoutes } from './routes';
import { routes as workerRoutes } from './worker-routes';

const PG = process.env.FROSTSIM_TEST_PG;
const REDIS = process.env.FROSTSIM_TEST_REDIS;
const ORIGIN = 'https://sim.test';
const PACK = 'c97e14c7a5ad-dc0508afe741';
const ENGINE_SHA = 'e'.repeat(64);
const RESULT = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
const START = Date.parse('2026-09-15T10:00:00Z');
const PERIOD = { start: new Date(START - 86_400_000), end: new Date(START + 29 * 86_400_000) };

const ready = (r: Redis) => (r.status === 'ready' ? Promise.resolve() : new Promise<void>((resolve) => r.once('ready', () => resolve())));

function simRequest(over: Partial<SimRequest> = {}): SimRequest {
  return {
    schemaVersion: 1,
    profile: 'warlock=Fixture\nlevel=90\nspec=demonology\n',
    settings: { ...DEFAULT_SETTINGS, fightStyle: 'Patchwerk', maxTime: 300, targets: 1, threads: 4 },
    accuracy: { mode: 'iterations', iterations: 1000 },
    ...over,
  };
}

describe.skipIf(!PG)('compute postgres integration (needs FROSTSIM_TEST_PG)', () => {
  const schema = `t_compute_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;
  let redis: Redis | null = null;
  let raw: RawRedis | null = null;
  const redisKeys = new Set<string>();
  let clock = START;
  const now = () => new Date(clock);
  const logs: string[] = [];

  // Fake R2 and hcloud behind one fetch.
  const uploaded = new Set<string>();
  /** Uploaded results whose object reports a size just past resultBytes' 32 MiB read cap. */
  const oversized = new Set<string>();
  const servers = new Map<number, { id: number }>();
  const hcloudCalls: { method: string; path: string; body: any }[] = [];
  let nextServer = 1000;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === 'api.hetzner.cloud') {
      const body = req.method === 'POST' ? await req.json() : null;
      hcloudCalls.push({ method: req.method, path: url.pathname, body });
      if (req.method === 'GET' && url.pathname === '/v1/servers') return Response.json({ servers: [...servers.values()], meta: { pagination: { next_page: null } } });
      if (req.method === 'GET' && url.pathname === '/v1/server_types') {
        const cores = url.searchParams.get('name') === 'ccx33' ? 8 : 32;
        return Response.json({ server_types: [{ cores, prices: [{ location: 'fsn1', price_hourly: { net: '0.5', gross: '0.595' } }] }] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/servers') {
        const server = { id: nextServer++ };
        servers.set(server.id, server);
        return Response.json({ server, root_password: null });
      }
      const del = /^\/v1\/servers\/(\d+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && del) return new Response('{}', { status: servers.delete(Number(del[1])) ? 200 : 404 });
      return new Response(null, { status: 500 });
    }
    const [, bucket, ...key] = url.pathname.split('/');
    const path = key.join('/');
    if (bucket === 'frostsim-engines' && req.method === 'HEAD') {
      return path === `engines/${PACK}/simc-linux-x64.zst`
        ? new Response(null, { headers: { 'x-amz-meta-sha256': ENGINE_SHA } }) : new Response(null, { status: 404 });
    }
    const result = /^results\/([0-9a-f-]+)\.json\.gz$/.exec(path);
    if (bucket === 'frostsim-data' && result && uploaded.has(result[1])) {
      const length = oversized.has(result[1]) ? (32 << 20) + 1 : RESULT.byteLength;
      return new Response(req.method === 'HEAD' ? null : RESULT, { headers: { 'content-length': String(length) } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const env = {
    FEATURES: 'compute', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: 's'.repeat(32),
    R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
    HCLOUD_TOKEN: 'hc', HCLOUD_LOCATION: 'fsn1', HCLOUD_SNAPSHOT_ID: '42', WORKER_MAX: '2', WORKER_MONTHLY_EUR_CAP: '50',
  };
  const app = (over: Record<string, string> = {}): AppCtx => {
    const config = loadConfig({ ...env, ...over });
    return { config, sql, redis, r2: createR2(config, fakeFetch), fetch: fakeFetch, now, log: (line) => logs.push(line) };
  };
  const handle = (a = app()) => createApp(a, [...clientRoutes, ...workerRoutes]);

  async function user(plan: { lookupKey: string; coreHours: number } | null = { lookupKey: 'compute_l_monthly', coreHours: 10 }, guildId: string | null = null) {
    const [u] = await sql`insert into users (display_name) values ('T') returning id`;
    if (plan) {
      await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items, guild_id)
        values (${`sub_${randomUUID()}`}, ${u.id}, 'active', ${PERIOD.start}, ${PERIOD.end},
          ${sql.json([{ lookupKey: plan.lookupKey, quantity: 1, coreHours: plan.coreHours }])}, ${guildId})`;
    }
    return u.id as string;
  }

  async function addWorker(over: { hcloudId?: number; status?: string; createdAt?: Date } = {}) {
    const token = randomBytes(32).toString('base64url');
    const [w] = await sql`insert into workers (hcloud_id, server_type, token_hash, cores, status, hourly_eur, created_at, last_seen_at)
      values (${over.hcloudId ?? null}, 'ccx53', ${sha256Hex(token)}, 32, ${over.status ?? 'ready'}, 0.5, ${over.createdAt ?? now()}, ${now()})
      returning id`;
    return { id: w.id as string, token };
  }

  async function enqueue(userId: string, over: Partial<SimRequest> = {}, guildId: string | null = null) {
    clock += 1; // distinct created_at, so queue order is the enqueue order
    const res = await enqueueJob(app(), { userId, guildId, source: 'web', packId: PACK, request: simRequest(over) });
    if (res.ok) redisKeys.add(`frostsim:job:${res.id}:log`).add(`frostsim:job:${res.id}:seq`);
    return res;
  }
  const jobRow = async (id: string) => (await sql`select * from compute_jobs where id = ${id}`)[0];

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('../migrations/', import.meta.url));
    if (REDIS) {
      redis = connectRedis(REDIS, () => {});
      raw = new RawRedis(REDIS, { enableReadyCheck: false });
      await ready(redis);
      redisKeys.add(`frostsim:native:${PACK}`).add('frostsim:native:deadbeef0000-000000000000');
    }
  });

  afterAll(async () => {
    if (raw && redisKeys.size) await raw.del(...redisKeys);
    redis?.disconnect();
    raw?.disconnect();
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  // claimJob takes the oldest claimable job of ANY user, so every test starts from an empty queue and fleet.
  beforeEach(async () => {
    await sql`update compute_jobs set status = 'cancelled' where status in ('queued', 'running')`;
    await sql`update workers set status = 'deleted', deleted_at = ${now()} where deleted_at is null`;
    servers.clear();
    hcloudCalls.length = 0;
    uploaded.clear();
  });

  it('enqueues with the entitlement thread count and stores the assembled payload', async () => {
    const u = await user({ lookupKey: 'compute_m_monthly', coreHours: 1 });
    const res = await enqueue(u);
    expect(res.ok).toBe(true);
    const job = await jobRow((res as { id: string }).id);
    expect(job).toMatchObject({ status: 'queued', threads: 16, source: 'web', pack_id: PACK, user_id: u, guild_id: null, attempts: 0 });
    expect(job.payload.args).toContain('threads=16');
    expect(job.payload.args[0]).toBe('/profile.simc');
    expect(job.payload.profile).toContain('warlock=Fixture');
    expect(job.request.settings.threads).toBe(4);
  });

  it('refuses Expert Mode, no plan, a used-up allowance, a pack without a native build and missing capacity', async () => {
    const paid = await user({ lookupKey: 'compute_s_monthly', coreHours: 1 });
    expect(await enqueue(paid, { mode: 'raw' })).toMatchObject({ ok: false, status: 400, code: 'invalid' });
    expect(await enqueue(paid, { slots: { header: 'x=1' } })).toMatchObject({ ok: false, status: 400 });
    expect(await enqueue(paid, { htmlReport: true })).toMatchObject({ ok: false, status: 400 });
    expect(await enqueue(paid, { profile: 'warlock=A\nlevel=90 /etc/passwd\n' })).toMatchObject({ ok: false, status: 400, code: 'invalid' });
    expect(await enqueue(await user(null))).toMatchObject({ ok: false, status: 402, code: 'not-entitled' });

    await sql`insert into compute_jobs (user_id, source, pack_id, threads, status, core_seconds, created_at)
      values (${paid}, 'web', ${PACK}, 8, 'done', 3600, ${now()})`;
    expect(await enqueue(paid)).toMatchObject({ ok: false, status: 402, code: 'no-allowance' });

    const other = await user();
    const wrongPack = await enqueueJob(app(), { userId: other, guildId: null, source: 'web', packId: 'deadbeef0000-000000000000', request: simRequest() });
    expect(wrongPack).toMatchObject({ ok: false, status: 409, code: 'no-native-engine' });

    // No live worker and no autoscaler: 503. At WORKER_MAX with only a draining worker: 503. Compute off: 503.
    const noFleet = await enqueueJob(app({ HCLOUD_TOKEN: '' }), { userId: other, guildId: null, source: 'web', packId: PACK, request: simRequest() });
    expect(noFleet).toMatchObject({ ok: false, status: 503, code: 'capacity' });
    await addWorker({ status: 'draining' });
    await addWorker({ status: 'draining' });
    expect(await enqueue(other)).toMatchObject({ ok: false, status: 503, code: 'capacity' });
    const off = await enqueueJob(app({ FEATURES: '' }), { userId: other, guildId: null, source: 'web', packId: PACK, request: simRequest() });
    expect(off).toMatchObject({ ok: false, status: 503, code: 'compute-disabled' });
  });

  it('refuses a suspended user for every source, guild jobs included, before anything is stored', async () => {
    const u = await user();
    const guild = `g${randomBytes(4).toString('hex')}`;
    await user({ lookupKey: 'discord_guild_monthly', coreHours: 1 }, guild);
    await sql`update users set suspended_at = ${now()} where id = ${u}`;
    for (const source of ['web', 'discord', 'loothing'] as const) {
      for (const guildId of [null, guild]) {
        expect(await enqueueJob(app(), { userId: u, guildId, source, packId: PACK, request: simRequest() }), `${source} ${guildId}`)
          .toMatchObject({ ok: false, status: 403, code: 'suspended' });
      }
    }
    expect(await sql`select count(*)::int as n from compute_jobs where user_id = ${u}`).toEqual([{ n: 0 }]);
    await sql`update users set suspended_at = null where id = ${u}`;
    expect(await enqueue(u)).toMatchObject({ ok: true });
  });

  it('refuses a non-admin under ADMIN_ONLY for every source, and lets an admin through', async () => {
    const u = await user();
    for (const source of ['web', 'discord', 'loothing'] as const) {
      expect(await enqueueJob(app({ ADMIN_ONLY: '1' }), { userId: u, guildId: null, source, packId: PACK, request: simRequest() }), source)
        .toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    }
    await sql`update users set role = 'admin' where id = ${u}`;
    expect(await enqueueJob(app({ ADMIN_ONLY: '1' }), { userId: u, guildId: null, source: 'web', packId: PACK, request: simRequest() }))
      .toMatchObject({ ok: true });
  });

  it('stores a failed job\'s notices and never shows them or an effective run for it', async () => {
    const id = ((await enqueue(await user())) as { id: string }).id;
    const w = await addWorker();
    const bearer = { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' };
    await claimJob(app(), w.id, 32);
    const fail = (body: unknown) => handle()(new Request(`${ORIGIN}/api/v1/worker/jobs/${id}/fail`, {
      method: 'POST', body: JSON.stringify(body), headers: bearer }), '10.0.0.1');
    expect((await fail({ error: 'x', notices: [1] })).status).toBe(400);
    expect((await fail({ error: 'simc exited with status 3: Error: boom', notices: ['Error: boom'] })).status).toBe(204);
    expect((await jobRow(id)).payload.notices).toEqual(['Error: boom']);
    expect((await jobRow(id)).summary).toBeNull();
    const view = await jobView(app(), id);
    expect(view).toMatchObject({ status: 'failed', error: 'simc exited with status 3: Error: boom' });
    expect(view).not.toHaveProperty('summary');
    expect(view).not.toHaveProperty('notices');
    expect(view).not.toHaveProperty('effective');
  });

  it('allows 3 queued jobs per user, even under concurrent enqueues, then 429', async () => {
    const u = await user();
    const results = await Promise.all(Array.from({ length: 6 }, () => enqueue(u)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toEqual(Array(3).fill({ ok: false, status: 429, code: 'too-many-jobs', message: expect.any(String) }));
  });

  it('runs guild jobs from the guild pool with its own thread width, allowance and limits', async () => {
    const guild = `g${randomBytes(4).toString('hex')}`;
    const payer = await user({ lookupKey: 'discord_guild_monthly', coreHours: 1 }, guild);
    const member = await user(null);
    expect(await enqueue(member)).toMatchObject({ ok: false, status: 402, code: 'not-entitled' });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await enqueue(member, {}, guild));
    expect(ids.every((r) => r.ok)).toBe(true);
    expect((await jobRow((ids[0] as { id: string }).id)).threads).toBe(8);
    expect(await enqueue(payer, {}, guild)).toMatchObject({ ok: false, status: 429 });
    // One running job per guild, however many workers ask.
    const w = await addWorker();
    const first = await claimJob(app(), w.id, 32);
    expect(first).toMatchObject({ id: (ids[0] as { id: string }).id, threads: 8 });
    expect(await claimJob(app(), w.id, 32)).toBeNull();
    // The guild's usage never touches the member's personal ledger, and a used-up pool refuses.
    await sql`update compute_jobs set status = 'done', core_seconds = 3600 where id = ${(first as { id: string }).id}`;
    expect(await enqueue(member, {}, guild)).toMatchObject({ ok: false, status: 402, code: 'no-allowance' });
    expect(await cancelJob(app(), (ids[1] as { id: string }).id, { guildId: guild })).toBe(true);
  });

  it('never gives two concurrently claiming workers the same job, and runs one job per scope', async () => {
    const jobs: string[] = [];
    for (let i = 0; i < 8; i++) jobs.push(((await enqueue(await user())) as { id: string }).id);
    const busy = await user();
    const siblings = [await enqueue(busy), await enqueue(busy)].map((r) => (r as { id: string }).id);
    const [a, b] = [await addWorker(), await addWorker()];
    const claimed: string[] = [];
    // Concurrent rounds until the queue has nothing claimable left.
    for (let round = 0; round < 5; round++) {
      const got = await Promise.all(Array.from({ length: 12 }, (_, i) => claimJob(app(), i % 2 ? a.id : b.id, 32)));
      for (const job of got) if (job && job !== 'draining') claimed.push(job.id);
    }
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).toHaveLength(9);
    expect(new Set(claimed)).toEqual(new Set([...jobs, claimed.find((id) => siblings.includes(id))!]));
    const running = await sql`select id from compute_jobs where id in ${sql(siblings)} and status = 'running'`;
    expect(running).toHaveLength(1);
    // Only jobs that fit the worker's free cores.
    const small = ((await enqueue(await user())) as { id: string }).id;
    expect(await claimJob(app(), a.id, 31)).toBeNull();
    expect(await claimJob(app(), a.id, 32)).toMatchObject({ id: small });
  });

  it('keeps one running job per scope against a sibling claim still in flight', async () => {
    const u = await user();
    const [older, younger] = [await enqueue(u), await enqueue(u)].map((r) => (r as { id: string }).id);
    const w = await addWorker();
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    let inFlight = () => {};
    const started = new Promise<void>((resolve) => (inFlight = resolve));
    // Another worker's claimJob, paused before COMMIT: row lock, scope lock, row updated but not yet visible.
    const other = sql.begin(async (tx) => {
      await tx`select id from compute_jobs where id = ${younger} for update`;
      await tx`select pg_advisory_xact_lock(${SCOPE_LOCK}::int, hashtext(${`u:${u}`}::text))`;
      await tx`update compute_jobs set status = 'running', worker_id = ${w.id}, attempts = 1 where id = ${younger}`;
      inFlight();
      await hold;
    });
    await started;
    let claimed;
    try {
      claimed = await claimJob(app(), w.id, 32);
    } finally {
      // An open transaction would hang afterAll's sql.end() and leave the schema behind.
      release();
      await other;
    }
    expect(claimed).toBeNull();
    expect(await sql`select id from compute_jobs where user_id = ${u} and status = 'running'`).toEqual([{ id: younger }]);
    expect((await jobRow(older)).status).toBe('queued');
  });

  it('requeues a job whose lease expired, then fails it after 2 attempts, unmetered', async () => {
    const id = ((await enqueue(await user())) as { id: string }).id;
    const w = await addWorker();
    expect(await claimJob(app(), w.id, 32)).toMatchObject({ id });
    clock += 30_000;
    expect(await progressJob(app(), w.id, id, [])).toBe('ok'); // lease now ends at +90 s
    clock += 59_000;
    await expireJobs(app());
    expect(await jobRow(id)).toMatchObject({ status: 'running', attempts: 1 });
    clock += 2000;
    await expireJobs(app());
    expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 1, worker_id: null, claimed_at: null });
    expect(await progressJob(app(), w.id, id, ['late'])).toBe('lost');

    expect(await claimJob(app(), w.id, 32)).toMatchObject({ id });
    clock += 61_000;
    await expireJobs(app());
    expect(await jobRow(id)).toMatchObject({ status: 'failed', attempts: 2, core_seconds: 0, error: 'The cloud worker stopped responding.' });
  });

  it('meters threads x min(worker wall, coordinator claim-to-complete), and fails a job with no result', async () => {
    const u = await user();
    const w = await addWorker();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(((await enqueue(u)) as { id: string }).id);

    expect(await claimJob(app(), w.id, 32)).toMatchObject({ id: ids[0], threads: 32 });
    clock += 10_000;
    uploaded.add(ids[0]);
    expect(await completeJob(app(), w.id, ids[0], 1000, { dps: 123.4 })).toBe('ok');
    expect(await jobRow(ids[0])).toMatchObject({ status: 'done', wall_seconds: 10, core_seconds: 320, summary: { dps: 123.4 } });

    await claimJob(app(), w.id, 32);
    clock += 10_000;
    uploaded.add(ids[1]);
    expect(await completeJob(app(), w.id, ids[1], 5, {})).toBe('ok');
    expect(await jobRow(ids[1])).toMatchObject({ core_seconds: 160, wall_seconds: 5 });
    expect(await resultBytes(app(), ids[1])).toEqual(RESULT);
    // Replaced through the still-valid presigned PUT: refused before it is buffered (the Discord bot reads results server-side).
    oversized.add(ids[1]);
    expect(await resultBytes(app(), ids[1]).catch((e: unknown) => e)).toMatchObject({ status: 413, code: 'too-large' });

    await claimJob(app(), w.id, 32);
    expect(await completeJob(app(), w.id, ids[2], 5, {})).toBe('missing');
    expect(await jobRow(ids[2])).toMatchObject({ status: 'failed', core_seconds: 0 });
    expect(await resultBytes(app(), ids[2])).toBeNull();
    expect(await completeJob(app(), w.id, ids[2], 5, {})).toBe('lost');
  });

  it('meters a job cancelled or failed while running, claim to now capped at 1800 s, and never a queued cancel', async () => {
    const u = await user();
    const w = await addWorker();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(((await enqueue(u)) as { id: string }).id);
    expect(await claimJob(app(), w.id, 32)).toMatchObject({ id: ids[0] });
    clock += 10_000;
    expect(await cancelJob(app(), ids[0], { userId: u })).toBe(true);
    expect(await jobRow(ids[0])).toMatchObject({ status: 'cancelled', wall_seconds: 10, core_seconds: 320 });
    expect(await claimJob(app(), w.id, 32)).toMatchObject({ id: ids[1] });
    clock += 3600_000;
    expect(await failJob(app(), w.id, ids[1], 'simc exited with status 137')).toBe(true);
    expect(await jobRow(ids[1])).toMatchObject({ status: 'failed', wall_seconds: 1800, core_seconds: 57_600 });
    expect(await cancelJob(app(), ids[2], { userId: u })).toBe(true);
    expect(await jobRow(ids[2])).toMatchObject({ status: 'cancelled', wall_seconds: 0, core_seconds: 0 });
  });

  it('fails a queued job at claim once its scope\'s allowance is used up', async () => {
    const u = await user({ lookupKey: 'compute_l_monthly', coreHours: 1 });
    const w = await addWorker();
    const first = ((await enqueue(u)) as { id: string }).id;
    const second = ((await enqueue(u)) as { id: string }).id;
    expect(await claimJob(app(), w.id, 32)).toMatchObject({ id: first });
    clock += 200_000;
    uploaded.add(first);
    expect(await completeJob(app(), w.id, first, 200, {})).toBe('ok'); // 6400 core-seconds of a 3600 allowance
    expect(await claimJob(app(), w.id, 32)).toBeNull();
    expect(await jobRow(second)).toMatchObject({ status: 'failed', attempts: 0, core_seconds: 0, error: 'The cloud allowance for this period is used up.' });
  });

  it('gives a claim back when the claim route fails after committing it', async () => {
    const id = ((await enqueue(await user())) as { id: string }).id;
    const w = await addWorker();
    const a = app();
    a.r2 = { ...a.r2, presign: async () => { throw new Error('r2 down'); } };
    const res = await handle(a)(new Request(`${ORIGIN}/api/v1/worker/claim`, {
      method: 'POST', body: JSON.stringify({ freeCores: 32, agentVersion: '1' }),
      headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
    }), '10.0.0.1');
    expect(res.status).toBe(500);
    expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 0, worker_id: null, claimed_at: null });
  });

  it.skipIf(!REDIS)('marks a restarted job in its progress log (needs FROSTSIM_TEST_REDIS)', async () => {
    const id = ((await enqueue(await user())) as { id: string }).id;
    const w = await addWorker();
    await claimJob(app(), w.id, 32);
    await progressJob(app(), w.id, id, ['60%']);
    clock += 61_000;
    await expireJobs(app());
    expect(await claimJob(app(), w.id, 32)).toMatchObject({ id });
    expect(await jobView(app(), id, 1)).toMatchObject({
      lines: ['Frostsim Cloud: the server running this job stopped; restarting it on another server.'], next: 2 });
  });

  it('fails a queued job nobody could claim in time, but not one waiting behind its own running job', async () => {
    const a = await user();
    const b = await user();
    const w = await addWorker();
    const running = ((await enqueue(a)) as { id: string }).id;
    const behind = ((await enqueue(a)) as { id: string }).id;
    const stuck = ((await enqueue(b)) as { id: string }).id;
    await claimJob(app(), w.id, 32);
    await sql`update compute_jobs set lease_until = ${new Date(clock + 3600_000)} where id = ${running}`;
    clock += 16 * 60_000;
    await expireJobs(app());
    expect((await jobRow(stuck)).status).toBe('failed');
    expect((await jobRow(behind)).status).toBe('queued');
    await sql`update compute_jobs set status = 'done', finished_at = ${now()} where id = ${running}`;
    clock += 60_000;
    await expireJobs(app());
    expect((await jobRow(behind)).status).toBe('queued');
    clock += 15 * 60_000;
    await expireJobs(app());
    expect(await jobRow(behind)).toMatchObject({ status: 'failed', error: 'No cloud worker became available in time.' });
  });

  it('nulls request, payload and engine notices after 7 days and keeps the ledger', async () => {
    const u = await user();
    const [old] = await sql`insert into compute_jobs (user_id, source, pack_id, threads, status, core_seconds, request, payload, summary, created_at)
      values (${u}, 'web', ${PACK}, 8, 'done', 42, '{}', ${sql.json({ profile: 'p', args: [], notices: ['warn'] })}, ${sql.json({ dps: 5 })},
        ${new Date(clock - 8 * 86_400_000)})
      returning id`;
    const fresh = ((await enqueue(u)) as { id: string }).id;
    await queueTasks.find((t) => t.name === 'compute-retention')!.run(app());
    expect(await jobRow(old.id)).toMatchObject({ request: null, payload: null, summary: { dps: 5 }, core_seconds: 42 });
    expect((await jobRow(fresh)).payload).not.toBeNull();
  });

  it('serves the client and worker protocol over HTTP with ownership checks', async () => {
    const owner = await user({ lookupKey: 'compute_m_monthly', coreHours: 10 });
    const stranger = await user();
    const cookie = async (id: string) => {
      const session = await createSession(app(), id);
      redisKeys.add(`frostsim:sess:${session.idHash}`).add(`frostsim:rl:compute-submit:${id}:${Math.floor(clock / 60_000)}`);
      return session.cookie.split(';')[0];
    };
    const [mine, theirs] = [await cookie(owner), await cookie(stranger)];
    const h = handle();
    const call = (path: string, init: RequestInit = {}) => h(new Request(ORIGIN + path, init), '10.0.0.1');
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

    const submitted = await post('/api/v1/compute/jobs', { packId: PACK, request: simRequest() }, { cookie: mine, origin: ORIGIN });
    expect(submitted.status).toBe(200);
    const { id } = await submitted.json();
    redisKeys.add(`frostsim:job:${id}:log`).add(`frostsim:job:${id}:seq`);
    expect(await (await call(`/api/v1/compute/jobs/${id}`, { headers: { cookie: mine } })).json())
      .toEqual({ status: 'queued', position: 1, lines: [], next: 0 });
    expect((await call(`/api/v1/compute/jobs/${id}`, { headers: { cookie: theirs } })).status).toBe(404);
    const refused = await post('/api/v1/compute/jobs', { packId: PACK, request: simRequest({ mode: 'raw' }) }, { cookie: mine, origin: ORIGIN });
    expect([refused.status, (await refused.json()).error]).toEqual([400, 'invalid']);

    const w = await addWorker({ status: 'booting' });
    const bearer = { authorization: `Bearer ${w.token}` };
    expect((await post('/api/v1/worker/claim', { freeCores: 32, agentVersion: '1' }, { authorization: 'Bearer nope' })).status).toBe(401);
    const claimed = await post('/api/v1/worker/claim', { freeCores: 32, agentVersion: '1' }, bearer);
    expect(claimed.status).toBe(200);
    const job = await claimed.json();
    expect(Object.keys(job).sort()).toEqual(['args', 'engine', 'jobId', 'leaseSeconds', 'profile', 'resultPut', 'threads']);
    expect(job).toMatchObject({ jobId: id, threads: 16, leaseSeconds: 60, engine: { sha256: ENGINE_SHA } });
    expect(job.engine.url).toContain(`/frostsim-engines/engines/${PACK}/simc-linux-x64.zst?`);
    expect(job.resultPut.url).toContain(`/frostsim-data/results/${id}.json.gz?`);
    // Both outlive the agent's worst case: engine download retries, simc's 1800 s RuntimeMaxSec and upload retries (~3810 s).
    for (const url of [job.engine.url, job.resultPut.url]) expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('4200');
    expect(JSON.stringify(job)).not.toContain(owner);
    expect((await sql`select status from workers where id = ${w.id}`)[0].status).toBe('ready');

    const progress = await post(`/api/v1/worker/jobs/${id}/progress`, { lines: ['a', 'b'] }, bearer);
    expect(await progress.json()).toEqual({ cancel: false });
    expect((await post(`/api/v1/worker/jobs/${id}/progress`, { lines: 'x' }, bearer)).status).toBe(400);
    uploaded.add(id);
    clock += 2000;
    const running = await (await call(`/api/v1/compute/jobs/${id}`, { headers: { cookie: mine } })).json();
    expect(running).not.toHaveProperty('notices');
    expect(running).not.toHaveProperty('effective');
    expect((await post(`/api/v1/worker/jobs/${id}/complete`, { wallSeconds: 1, summary: {}, notices: 'x' }, bearer)).status).toBe(400);
    const notices = [...Array.from({ length: 205 }, (_, i) => `n${i}`), 'y'.repeat(600)];
    const done = await post(`/api/v1/worker/jobs/${id}/complete`, { wallSeconds: 1.5, summary: { dps: 1, iterations: 1000 }, notices }, bearer);
    expect(done.status).toBe(204);
    // Stored bounded (the last 200 lines, 500 characters each) in the payload, and returned beside the summary with what the worker ran.
    const view = await (await call(`/api/v1/compute/jobs/${id}`, { headers: { cookie: mine } })).json();
    expect(view).toMatchObject({ status: 'done', effective: { threads: 16, args: job.args, profile: job.profile } });
    expect(view.summary).toEqual({ dps: 1, iterations: 1000 });
    expect(view.notices).toEqual([...notices.slice(-200, -1), 'y'.repeat(500)]);
    // Not in the summary, which the ledger keeps for good and the account export returns whole.
    expect((await jobRow(id)).summary).toEqual({ dps: 1, iterations: 1000 });
    expect((await jobRow(id)).payload.notices).toHaveLength(200);
    expect((await jobRow(id)).core_seconds).toBe(24);

    const result = await call(`/api/v1/compute/jobs/${id}/result`, { headers: { cookie: mine } });
    expect(result.headers.get('content-type')).toBe('application/gzip');
    expect(result.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(RESULT);
    expect((await call(`/api/v1/compute/jobs/${id}/result`, { headers: { cookie: theirs } })).status).toBe(404);

    expect((await call(`/api/v1/compute/jobs/${id}`, { method: 'DELETE', headers: { cookie: theirs, origin: ORIGIN } })).status).toBe(404);
    expect((await call(`/api/v1/compute/jobs/${id}`, { method: 'DELETE', headers: { cookie: mine, origin: ORIGIN } })).status).toBe(204);

    // Cancel while running: the worker learns it at its next progress call.
    redisKeys.add(`frostsim:rl:compute-submit:${owner}:${Math.floor(clock / 60_000)}`);
    const second = (await (await post('/api/v1/compute/jobs', { packId: PACK, request: simRequest() }, { cookie: mine, origin: ORIGIN })).json()).id;
    redisKeys.add(`frostsim:job:${second}:log`).add(`frostsim:job:${second}:seq`);
    expect((await (await post('/api/v1/worker/claim', { freeCores: 32, agentVersion: '1' }, bearer)).json()).jobId).toBe(second);
    expect((await call(`/api/v1/compute/jobs/${second}`, { method: 'DELETE', headers: { cookie: mine, origin: ORIGIN } })).status).toBe(204);
    expect(await (await post(`/api/v1/worker/jobs/${second}/progress`, { lines: [] }, bearer)).json()).toEqual({ cancel: true });
    expect((await post(`/api/v1/worker/jobs/${second}/complete`, { wallSeconds: 1, summary: {} }, bearer)).status).toBe(409);
  });

  it('ends a claim long poll with 204 when the worker hangs up', async () => {
    const w = await addWorker();
    const gone = new AbortController();
    const started = Date.now();
    setTimeout(() => gone.abort(), 150);
    const res = await handle()(new Request(`${ORIGIN}/api/v1/worker/claim`, {
      method: 'POST', signal: gone.signal, body: JSON.stringify({ freeCores: 8, agentVersion: '1' }),
      headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
    }), '10.0.0.1');
    expect(res.status).toBe(204);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it.skipIf(!REDIS)('keeps progress lines in a capped Redis list with a TTL and a cursor (needs FROSTSIM_TEST_REDIS)', async () => {
    const id = ((await enqueue(await user())) as { id: string }).id;
    const w = await addWorker();
    await claimJob(app(), w.id, 32);
    await progressJob(app(), w.id, id, ['one', 'two']);
    await progressJob(app(), w.id, id, ['three']);
    expect(await jobView(app(), id)).toMatchObject({ status: 'running', lines: ['one', 'two', 'three'], next: 3 });
    expect(await jobView(app(), id, 2)).toMatchObject({ lines: ['three'], next: 3 });
    expect(await jobView(app(), id, 3)).toMatchObject({ lines: [], next: 3 });
    const ttl = await raw!.ttl(`frostsim:job:${id}:log`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(await raw!.ttl(`frostsim:job:${id}:seq`)).toBeGreaterThan(0);
    await progressJob(app(), w.id, id, Array.from({ length: 600 }, (_, i) => `l${i}`));
    const view = await jobView(app(), id, 3);
    expect(view!.next).toBe(603);
    expect(view!.lines).toHaveLength(500);
    expect(view!.lines.at(-1)).toBe('l599');
  });

  describe('autoscaler tick', () => {
    it('creates a server when demand exceeds free cores, storing the token hash first', async () => {
      const id = ((await enqueue(await user())) as { id: string }).id;
      await tick(app());
      const create = hcloudCalls.find((c) => c.method === 'POST')!;
      expect(create.body).toMatchObject({ server_type: 'ccx53', location: 'fsn1', image: '42', labels: { frostsim: 'worker' },
        public_net: { enable_ipv4: false, enable_ipv6: true } });
      const token = /FROSTSIM_WORKER_TOKEN=(\S+)/.exec(create.body.user_data)![1];
      expect(create.body.user_data).toContain(`FROSTSIM_COORDINATOR=${ORIGIN}`);
      const [row] = await sql`select * from workers where deleted_at is null`;
      expect(row).toMatchObject({ status: 'booting', cores: 32, server_type: 'ccx53', token_hash: createHash('sha256').update(token).digest('hex') });
      expect(Number(row.hcloud_id)).toBe([...servers.keys()][0]);
      expect(Number(row.hourly_eur)).toBe(0.595);
      expect(create.body.name).toBe(`frostsim-worker-${row.id}`);

      // The booting server's cores already cover the demand.
      await tick(app());
      expect(hcloudCalls.filter((c) => c.method === 'POST')).toHaveLength(1);

      // It boots, claims, then goes silent: the server is deleted and its job goes back to the queue.
      const claimed = await handle()(new Request(`${ORIGIN}/api/v1/worker/claim`, {
        method: 'POST', body: JSON.stringify({ freeCores: 32, agentVersion: '1' }),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      }), '10.0.0.1');
      expect((await claimed.json()).jobId).toBe(id);
      clock += HEARTBEAT_LOSS_MS + 1000;
      await tick(app());
      expect(servers.size).toBe(0);
      expect((await sql`select status, deleted_at from workers where id = ${row.id}`)[0].status).toBe('deleted');
      expect(await jobRow(id)).toMatchObject({ status: 'queued', worker_id: null, attempts: 1 });
      expect(logs).toContain(`compute: deleted hcloud server ${row.hcloud_id} (heartbeat lost)`);
    });

    it('deletes orphans and forgets rows whose server is gone', async () => {
      servers.set(777, { id: 777 });
      const gone = await addWorker({ hcloudId: 555, createdAt: new Date(clock - 10 * 60_000) });
      await tick(app());
      expect(hcloudCalls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/v1/servers/777']);
      expect((await sql`select status from workers where id = ${gone.id}`)[0].status).toBe('deleted');
    });

    it('drains an idle server shortly before its next billed hour, then deletes it', async () => {
      const w = await addWorker({ hcloudId: 900, createdAt: new Date(clock - 50 * 60_000) });
      servers.set(900, { id: 900 });
      await tick(app());
      expect((await sql`select status from workers where id = ${w.id}`)[0].status).toBe('ready');
      clock += 6 * 60_000;
      await sql`update workers set last_seen_at = ${now()} where id = ${w.id}`;
      await tick(app());
      expect((await sql`select status from workers where id = ${w.id}`)[0].status).toBe('draining');
      expect(servers.has(900)).toBe(true);
      // A draining worker is offered nothing.
      await enqueue(await user());
      expect(await claimJob(app(), w.id, 32)).toBe('draining');
      await sql`update compute_jobs set status = 'cancelled' where status = 'queued'`;
      await tick(app());
      expect(servers.has(900)).toBe(false);
      expect((await sql`select status from workers where id = ${w.id}`)[0].status).toBe('deleted');
    });

    it('refuses, and creates no server for, a job wider than the configured server type', async () => {
      const small = { HCLOUD_SERVER_TYPE: 'ccx33' };
      await tick(app(small)); // caches ccx33's 8 cores
      const refused = await enqueueJob(app(small), { userId: await user(), guildId: null, source: 'web', packId: PACK, request: simRequest() });
      expect(refused).toMatchObject({ ok: false, status: 503, code: 'capacity' });
      expect(await enqueue(await user())).toMatchObject({ ok: true }); // 32 threads, queued under the default config
      await tick(app(small));
      expect(hcloudCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('creates nothing once this month\'s worker-hours reach the cap', async () => {
      const busy = await addWorker({ hcloudId: 901 });
      servers.set(901, { id: 901 });
      await enqueue(await user());
      await claimJob(app(), busy.id, 32);
      expect(await enqueue(await user())).toMatchObject({ ok: true });
      await tick(app());
      expect(hcloudCalls.filter((c) => c.method === 'POST')).toHaveLength(1); // demand 32 > 0 free cores
      await sql`update workers set status = 'deleted', deleted_at = ${now()} where hcloud_id <> 901 and deleted_at is null`;
      servers.clear();
      servers.set(901, { id: 901 });
      hcloudCalls.length = 0;
      await sql`insert into workers (server_type, token_hash, cores, status, hourly_eur, created_at, deleted_at)
        values ('ccx53', ${randomUUID()}, 32, 'deleted', 49.9, ${new Date(clock - 2 * 3600_000)}, ${new Date(clock - 3600_000)})`;
      await tick(app());
      expect(hcloudCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });
  });
});
