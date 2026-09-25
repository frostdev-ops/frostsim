// Gated integration (CLAUDE.md D15): migrations, sessions, usage, entitlements, audit and Redis TTLs against the local Postgres/Redis.
// Each run owns a fresh schema and unique Redis keys, and removes both, so it can run beside other suites.

import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Redis as RawRedis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { audit } from './audit';
import { loadConfig } from './config';
import { connectDb, type Sql } from './db';
import { loadEntitlements } from './entitlements';
import { migrate } from './migrate';
import { createR2 } from './r2';
import { rateLimit } from './ratelimit';
import { connectRedis, type Redis } from './redis';
import { createSession, destroySession, getSession, tasks as sessionTasks } from './session';
import { usedCoreSeconds } from './usage';

const PG = process.env.FROSTSIM_TEST_PG;
const REDIS = process.env.FROSTSIM_TEST_REDIS;
const MIGRATIONS = new URL('./migrations/', import.meta.url);
const VERSIONS = ['001_init', '002_indexes', '003_character_history', '004_job_idempotency', '005_guild_role_limits'];
const TABLES = ['audit_log', 'character_sims', 'character_snapshots', 'cloud_characters', 'compute_jobs', 'guild_role_limits', 'identities', 'integration_grants', 'schema_migrations',
  'sessions', 'shares', 'stripe_events', 'subscriptions', 'users', 'workers'];

// Commands fail fast until the connection is up (enableOfflineQueue false), so wait for it before asserting.
const ready = (r: Redis) => (r.status === 'ready' ? Promise.resolve() : new Promise<void>((resolve) => r.once('ready', () => resolve())));
const cookieHeader = (cookie: string) => new Request('https://sim.test/', { headers: { cookie: cookie.split(';')[0] } });

describe.skipIf(!PG)('postgres integration (needs FROSTSIM_TEST_PG)', () => {
  const schema = `t_foundation_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;
  let redis: Redis | null = null;
  let raw: RawRedis | null = null;
  const log = () => {};
  const ctx = () => ({ sql, redis: null, log, now: () => new Date(), config: loadConfig({}) });

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    if (REDIS) {
      redis = connectRedis(REDIS, log);
      raw = new RawRedis(REDIS, { enableReadyCheck: false });
      await ready(redis);
    }
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
    redis?.disconnect();
    raw?.disconnect();
  });

  it('applies every migration exactly once when two runners race, and is idempotent after', async () => {
    const [a, b] = await Promise.all([migrate(sql, MIGRATIONS), migrate(sql, MIGRATIONS)]);
    expect([...a, ...b]).toEqual(VERSIONS);
    expect(await migrate(sql, MIGRATIONS)).toEqual([]);
    const tables = await sql`select table_name from information_schema.tables where table_schema = ${schema} order by 1`;
    expect(tables.map((r) => r.table_name)).toEqual(TABLES);
    expect(await sql`select version from schema_migrations order by 1`).toEqual(VERSIONS.map((version) => ({ version })));
  });

  it('applies 002 and 003 on top of a 001 database: the sweep index, one identity per provider, the stripe_updated comment, history', async () => {
    const v1 = `${schema}_v1`;
    const only001 = mkdtempSync(join(tmpdir(), 'frostsim-001-'));
    copyFileSync(new URL('001_init.sql', MIGRATIONS), join(only001, '001_init.sql'));
    await admin.unsafe(`create schema ${v1}`);
    const db = connectDb(PG!, { connection: { search_path: v1 } });
    try {
      expect(await migrate(db, pathToFileURL(`${only001}/`))).toEqual(['001_init']);
      // Rows the 001 release wrote: two providers for one user, one provider for another.
      const [u1] = await db`insert into users (display_name) values ('A') returning id`;
      const [u2] = await db`insert into users (display_name) values ('B') returning id`;
      await db`insert into identities (provider, subject, user_id) values ('battlenet', '1', ${u1.id}), ('discord', '2', ${u1.id}), ('discord', '3', ${u2.id})`;
      expect(await migrate(db, MIGRATIONS)).toEqual(['002_indexes', '003_character_history', '004_job_idempotency']);
      // 003: a 001 character gains history columns, and jobs accept the patch source beside the old ones.
      const [c] = await db`insert into cloud_characters (user_id, label, raw, bytes) values (${u1.id}, 'Main', 'x', 1) returning id, patch_build, who`;
      expect(c).toMatchObject({ patch_build: null, who: null });
      for (const source of ['web', 'patch']) {
        await db`insert into compute_jobs (user_id, source, pack_id, threads, character_id) values (${u1.id}, ${source}, 'p', 1, ${c.id})`;
      }
      await expect(db`insert into compute_jobs (user_id, source, pack_id, threads) values (${u1.id}, 'other', 'p', 1)`).rejects.toThrow();

      const indexes = await db`select indexname, indexdef from pg_indexes where schemaname = ${v1} and indexname in ('compute_jobs_running', 'identities_user_provider') order by 1`;
      expect(indexes.map((r) => r.indexname)).toEqual(['compute_jobs_running', 'identities_user_provider']);
      expect(indexes[0].indexdef).toMatch(/\(lease_until\) WHERE \(status = 'running'::text\)$/);
      expect(indexes[1].indexdef).toMatch(/^CREATE UNIQUE INDEX .*\(user_id, provider\)$/);
      // An empty table always plans a seq scan; with that off, the lease sweep's predicate must be able to use the partial index.
      const plan = await db.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        return tx`explain select id from compute_jobs where status = 'running' and lease_until < now()`;
      });
      expect(JSON.stringify(plan)).toContain('compute_jobs_running');
      const [comment] = await db`select col_description(${`${v1}.subscriptions`}::regclass, attnum) as text from pg_attribute
        where attrelid = ${`${v1}.subscriptions`}::regclass and attname = 'stripe_updated'`;
      expect(comment.text).toMatch(/Epoch ms when billing fetched/);

      await expect(db`insert into identities (provider, subject, user_id) values ('discord', '4', ${u1.id})`).rejects.toMatchObject({ code: '23505' });
      await db`insert into identities (provider, subject, user_id) values ('battlenet', '5', ${u2.id})`;
    } finally {
      await db.end();
      await admin.unsafe(`drop schema if exists ${v1} cascade`);
      rmSync(only001, { recursive: true, force: true });
    }
  });

  it('round-trips a session: create, read, hourly touch, suspend, destroy', async () => {
    const [user] = await sql`insert into users (display_name) values ('Bob') returning id`;
    const first = await createSession(ctx(), user.id);
    const request = cookieHeader(first.cookie);
    expect(await getSession(ctx(), request)).toMatchObject({ idHash: first.idHash, userId: user.id, role: 'user', displayName: 'Bob' });

    const later = Date.now() + 2 * 3600_000;
    await getSession({ ...ctx(), now: () => new Date(later) }, request);
    const [touched] = await sql`select last_seen_at from sessions where id_hash = ${first.idHash}`;
    expect(touched.last_seen_at.getTime()).toBe(later);

    await sql`update users set suspended_at = now() where id = ${user.id}`;
    expect(await getSession(ctx(), request)).toBeNull();
    expect(await sql`select 1 from sessions where user_id = ${user.id}`).toHaveLength(0);

    await sql`update users set suspended_at = null where id = ${user.id}`;
    const second = await createSession(ctx(), user.id);
    await destroySession(ctx(), second.idHash);
    expect(await getSession(ctx(), cookieHeader(second.cookie))).toBeNull();
  });

  it('purges expired sessions and keeps live ones', async () => {
    const [user] = await sql`insert into users (display_name) values ('Purge') returning id`;
    const live = await createSession(ctx(), user.id);
    const old = await createSession({ ...ctx(), now: () => new Date(Date.now() - 31 * 86_400_000) }, user.id);
    await sessionTasks[0].run({ ...ctx(), r2: createR2(loadConfig({}), fetch), fetch });
    const left = await sql`select id_hash from sessions where user_id = ${user.id}`;
    expect(left.map((r) => r.id_hash)).toEqual([live.idHash]);
    expect(old.idHash).not.toBe(live.idHash);
  });

  it.skipIf(!REDIS)('ends a cached session at the hourly touch once its row is gone (needs FROSTSIM_TEST_REDIS)', async () => {
    const withRedis = { ...ctx(), redis };
    const [user] = await sql`insert into users (display_name) values ('Stale') returning id`;
    const { cookie, idHash } = await createSession(withRedis, user.id);
    expect(await getSession(withRedis, cookieHeader(cookie))).not.toBeNull();
    // A revoke whose cache DEL was lost: the row is gone, the copy is not.
    await sql`delete from sessions where id_hash = ${idHash}`;
    expect(await raw!.exists(`frostsim:sess:${idHash}`)).toBe(1);
    expect(await getSession({ ...withRedis, now: () => new Date(Date.now() + 2 * 3600_000) }, cookieHeader(cookie))).toBeNull();
    expect(await raw!.exists(`frostsim:sess:${idHash}`)).toBe(0);
  });

  it('sums metered seconds over [from, to): claimed jobs only (a cancel while running is metered), guild jobs apart', async () => {
    const [user] = await sql`insert into users (display_name) values ('Meter') returning id`;
    const job = (status: string, core: number, created: string, guild: string | null = null) =>
      sql`insert into compute_jobs (user_id, guild_id, source, pack_id, threads, status, core_seconds, created_at)
        values (${user.id}, ${guild}, 'web', 'p', 8, ${status}, ${core}, ${created})`;
    await job('done', 100, '2026-09-15T00:00:00Z');
    await job('failed', 50, '2026-09-15T00:00:00Z');
    await job('running', 0, '2026-09-15T00:00:00Z');
    await job('queued', 999, '2026-09-15T00:00:00Z');
    await job('cancelled', 20, '2026-09-15T00:00:00Z');
    await job('done', 7, '2026-09-01T00:00:00Z');
    await job('done', 1000, '2026-10-01T00:00:00Z');
    await job('done', 300, '2026-09-15T00:00:00Z', 'g1');
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-10-01T00:00:00Z');
    expect(await usedCoreSeconds(sql, { userId: user.id }, from, to)).toBe(177);
    expect(await usedCoreSeconds(sql, { guildId: 'g1' }, from, to)).toBe(300);
    expect(await usedCoreSeconds(sql, { guildId: 'nobody' }, from, to)).toBe(0);
  });

  it('loads entitlements from subscription rows and comped columns', async () => {
    const [user] = await sql`insert into users (display_name, comp_core_seconds, comp_max_threads) values ('Paid', 600, 4) returning id`;
    const start = new Date(Date.now() - 86_400_000);
    const end = new Date(Date.now() + 86_400_000);
    await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items, guild_id) values
      (${`sub_a_${schema}`}, ${user.id}, 'active', ${start}, ${end}, ${sql.json([{ lookupKey: 'compute_m_monthly', quantity: 1, coreHours: 2 }])}, null),
      (${`sub_b_${schema}`}, ${user.id}, 'past_due', ${start}, ${end}, ${sql.json([{ lookupKey: 'discord_guild_monthly', quantity: 1, coreHours: 1 }])}, 'g9')`;
    const mine = await loadEntitlements(sql, { userId: user.id }, new Date());
    expect(mine).toMatchObject({ coreSeconds: 7800, maxThreads: 16, hostedShares: true, periodStart: start, periodEnd: end });
    const guild = await loadEntitlements(sql, { guildId: 'g9' }, new Date());
    expect(guild.guilds).toEqual([{ guildId: 'g9', coreSeconds: 3600, maxThreads: 8, periodStart: start, periodEnd: end }]);
    expect(guild.coreSeconds).toBe(0);
  });

  it('writes audit rows and keeps them when the user goes', async () => {
    const [user] = await sql`insert into users (display_name) values ('Gone') returning id`;
    await audit(sql, { userId: user.id, actor: `admin:${user.id}`, action: 'user.suspend', detail: { reason: 'test' } });
    await sql`delete from users where id = ${user.id}`;
    const rows = await sql`select user_id, action, detail from audit_log where actor = ${`admin:${user.id}`}`;
    expect(rows).toEqual([{ user_id: null, action: 'user.suspend', detail: { reason: 'test' } }]);
  });

  it.skipIf(!REDIS)('caches sessions in Redis with a TTL of at most 300 s, and forgets them on destroy (needs FROSTSIM_TEST_REDIS)', async () => {
    const withRedis = { ...ctx(), redis };
    const [user] = await sql`insert into users (display_name) values ('Cached') returning id`;
    const { cookie, idHash } = await createSession(withRedis, user.id);
    expect(await getSession(withRedis, cookieHeader(cookie))).not.toBeNull();
    const ttl = await raw!.ttl(`frostsim:sess:${idHash}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
    // Served from the cache even when the row is gone, until destroy clears it.
    expect(await getSession({ ...withRedis, sql: (() => Promise.reject(new Error('no db'))) as unknown as Sql }, cookieHeader(cookie))).not.toBeNull();
    await destroySession(withRedis, idHash);
    expect(await raw!.exists(`frostsim:sess:${idHash}`)).toBe(0);
  });

  it.skipIf(!REDIS)('reports db and redis ok on health (needs FROSTSIM_TEST_REDIS)', async () => {
    const config = loadConfig({ FEATURES: 'accounts', DATABASE_URL: 'x', SESSION_SECRET: 's'.repeat(32) });
    const handle = createApp({ config, sql, redis, r2: createR2(config, fetch), fetch, now: () => new Date(), log });
    const res = await handle(new Request('https://sim.frostdev.io/api/v1/health'), '127.0.0.1');
    expect(await res.json()).toEqual({ ok: true, features: ['accounts'], db: 'ok', redis: 'ok' });
  });
});

describe.skipIf(!REDIS)('redis integration (needs FROSTSIM_TEST_REDIS)', () => {
  const bucket = `t${randomBytes(4).toString('hex')}`;
  let redis: Redis;
  let raw: RawRedis;
  const keys: string[] = [];

  beforeAll(async () => {
    redis = connectRedis(REDIS!, () => {});
    raw = new RawRedis(REDIS!, { enableReadyCheck: false });
    await ready(redis);
  });

  afterAll(async () => {
    if (keys.length) await raw.del(...keys);
    redis.disconnect();
    raw.disconnect();
  });

  it('writes every rate-limit key with the window as its TTL', async () => {
    const now = new Date();
    const ctx = { redis, log: () => {}, now: () => now };
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await rateLimit(ctx, bucket, 'who', 2, 60));
    expect(results).toEqual([true, true, false]);
    const key = `frostsim:rl:${bucket}:who:${Math.floor(now.getTime() / 60_000)}`;
    keys.push(key);
    expect(await raw.get(key)).toBe('3');
    const ttl = await raw.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
