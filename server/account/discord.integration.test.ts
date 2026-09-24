// Gated Discord and Loothing integration (CLAUDE.md D15; DESIGN.md P2, P3): the Loothing routes against the local Postgres (link and
// grant refusals, audit rows, a real enqueue and read-back), and one Discord /sim end to end against Postgres and Redis (signed
// interaction, real enqueueJob, the token in Redis with its TTL, a worker completing the job, the reply task posting DPS and a hosted
// share). R2 and Discord are a fake fetch. Each run owns a fresh schema, a temp engine index and unique Redis keys, and removes them.

import { generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Redis as RawRedis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, type AppCtx } from './app';
import { loadConfig } from './config';
import { connectDb, type Sql } from './db';
import { migrate } from './migrate';
import { createR2 } from './r2';
import { connectRedis, type Redis } from './redis';
import { sha256Hex } from './signed';
import { linkedUser, routes as discordRoutes, tasks as discordTasks } from './discord';
import { routes as loothingRoutes } from './integrations';
import { claimJob, completeJob } from './compute/queue';
import { report as REPORT } from '../../src/lib/simc/__fixtures__/protocol.mjs';

const PG = process.env.FROSTSIM_TEST_PG;
const REDIS = process.env.FROSTSIM_TEST_REDIS;
const ORIGIN = 'https://sim.test';
const PACK = `discordtest-${randomBytes(4).toString('hex')}`;
const TOKEN = 'loothing-bearer-token';
const APP_ID = '111111111111111111';
const RAW = readFileSync(new URL('../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8');
const RESULT = new Uint8Array(gzipSync(JSON.stringify(REPORT)));
const NOW = Date.now();
const PERIOD = { start: new Date(NOW - 86_400_000), end: new Date(NOW + 29 * 86_400_000) };
const snowflake = () => String(100_000_000_000_000_000n + BigInt(randomBytes(6).readUIntBE(0, 6)));

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

describe.skipIf(!PG)('discord postgres integration (needs FROSTSIM_TEST_PG; the /sim test also needs FROSTSIM_TEST_REDIS)', () => {
  const schema = `t_discord_${randomBytes(4).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'frostsim-discord-'));
  const savedEnv = { ENGINE_INDEX_PATH: process.env.ENGINE_INDEX_PATH, ENGINE_COMPAT: process.env.ENGINE_COMPAT };
  let admin: Sql;
  let sql: Sql;
  let redis: Redis | null = null;
  let raw: RawRedis | null = null;
  const redisKeys = new Set<string>([`frostsim:native:${PACK}`]);
  const objects = new Map<string, Uint8Array>();
  const edits: { url: string; content: string }[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === 'discord.com') {
      edits.push({ url: url.pathname, content: (await req.json()).content });
      return new Response('{}');
    }
    const path = url.pathname.slice(1);
    if (req.method === 'HEAD' && path === `frostsim-engines/engines/${PACK}/simc-linux-x64.zst`) {
      return new Response(null, { headers: { 'x-amz-meta-sha256': 'e'.repeat(64) } });
    }
    if (req.method === 'PUT') {
      objects.set(path, new Uint8Array(await req.arrayBuffer()));
      return new Response(null);
    }
    const object = objects.get(path);
    if (!object) return new Response(null, { status: 404 });
    return new Response(req.method === 'HEAD' ? null : (object as Uint8Array<ArrayBuffer>), { headers: { 'content-length': String(object.byteLength) } });
  }) as typeof fetch;

  const app = (): AppCtx => {
    const config = loadConfig({
      FEATURES: 'discord,compute,shares', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: 's'.repeat(32),
      R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
      DISCORD_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), DISCORD_APPLICATION_ID: APP_ID,
      LOOTHING_TOKEN_SHA256: sha256Hex(TOKEN),
    });
    return { config, sql, redis, r2: createR2(config, fakeFetch), fetch: fakeFetch, now: () => new Date(), log: () => {} };
  };

  /** A user with a compute plan (hosted shares included), a cloud character and, optionally, a linked Discord id and the grant. */
  async function user(discordId: string | null, grant: boolean) {
    const [u] = await sql`insert into users (display_name) values ('T') returning id`;
    await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items)
      values (${`sub_${randomUUID()}`}, ${u.id}, 'active', ${PERIOD.start}, ${PERIOD.end},
        ${sql.json([{ lookupKey: 'compute_m_monthly', quantity: 1, coreHours: 10 }])})`;
    const [c] = await sql`insert into cloud_characters (user_id, label, raw, bytes) values (${u.id}, 'Main', ${RAW}, ${RAW.length}) returning id`;
    if (discordId) await sql`insert into identities (provider, subject, user_id) values ('discord', ${discordId}, ${u.id})`;
    if (grant) await sql`insert into integration_grants (user_id, integration) values (${u.id}, 'loothing')`;
    return { userId: u.id as string, characterId: c.id as string };
  }

  const loothing = (method: string, path: string, body?: unknown) => createApp(app(), loothingRoutes)(new Request(ORIGIN + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), '127.0.0.1');

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('./migrations/', import.meta.url));
    await sql`insert into workers (server_type, token_hash, cores, status, last_seen_at) values ('ccx53', ${sha256Hex(randomUUID())}, 32, 'ready', now())`;
    writeFileSync(join(dir, 'engine-versions.json'), JSON.stringify({ packs: [{ id: PACK, compat: 'discord-test', commitDate: '2026-09-20T00:00:00Z' }] }));
    process.env.ENGINE_INDEX_PATH = join(dir, 'engine-versions.json');
    process.env.ENGINE_COMPAT = 'discord-test';
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    if (raw) await raw.del(...redisKeys);
    redis?.disconnect();
    raw?.disconnect();
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  it('Loothing: refuses unlinked and ungranted users, enqueues for a granted one, reads back only its own job, and audits every call', async () => {
    const stranger = snowflake();
    const ungranted = snowflake();
    const granted = snowflake();
    const other = snowflake();
    const a = await user(ungranted, false);
    const b = await user(granted, true);
    await user(other, true);

    const notLinked = await loothing('POST', '/api/v1/integrations/loothing/resolve', { discordId: stranger });
    expect(notLinked.status).toBe(403);
    expect(await notLinked.json()).toMatchObject({ error: 'not-linked', url: `${ORIGIN}/#/account` });
    const notGranted = await loothing('POST', '/api/v1/integrations/loothing/resolve', { discordId: ungranted });
    expect(await notGranted.json()).toMatchObject({ error: 'not-granted', url: `${ORIGIN}/#/account` });

    expect(await (await loothing('POST', '/api/v1/integrations/loothing/resolve', { discordId: granted })).json())
      .toEqual({ characters: [{ id: b.characterId, label: 'Main', updatedAt: expect.any(String) }] });
    const created = await loothing('POST', '/api/v1/integrations/loothing/jobs', { discordId: granted, characterId: b.characterId, preset: 'patchwerk' });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const [job] = await sql`select user_id, guild_id, source, pack_id, threads, status from compute_jobs where id = ${id}`;
    expect(job).toEqual({ user_id: b.userId, guild_id: null, source: 'loothing', pack_id: PACK, threads: 16, status: 'queued' });

    const read = (jobId: string, discordId = granted) => loothing('GET', `/api/v1/integrations/loothing/jobs/${jobId}?discordId=${discordId}`);
    expect(await (await read(id)).json()).toMatchObject({ id, status: 'queued', position: 1 });
    expect((await read(id, other)).status).toBe(404);
    const [web] = await sql`insert into compute_jobs (user_id, source, pack_id, threads, status) values (${b.userId}, 'web', ${PACK}, 16, 'done') returning id`;
    expect((await read(web.id)).status).toBe(404);

    const rows = await sql`select user_id, actor, action, detail from audit_log order by id`;
    expect(rows.map((r) => [r.user_id, r.actor, r.action, r.detail.status])).toEqual([
      [null, 'loothing', 'loothing.resolve', 403],
      [a.userId, 'loothing', 'loothing.resolve', 403],
      [b.userId, 'loothing', 'loothing.resolve', 200],
      [b.userId, 'loothing', 'loothing.job.create', 201],
      [b.userId, 'loothing', 'loothing.job.read', 200],
      [expect.any(String), 'loothing', 'loothing.job.read', 404],
      [b.userId, 'loothing', 'loothing.job.read', 404],
    ]);
    expect(rows[3].detail).toEqual({ discordId: granted, preset: 'patchwerk', jobId: id, status: 201 });
  });

  it('treats a suspended user, and under ADMIN_ONLY a non-admin, as not linked', async () => {
    const suspended = snowflake();
    const member = snowflake();
    const a = await user(suspended, true);
    const b = await user(member, true);
    await sql`update users set suspended_at = now() where id = ${a.userId}`;
    const res = await loothing('POST', '/api/v1/integrations/loothing/resolve', { discordId: suspended });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'not-linked' });

    const base = app();
    const adminOnly = { ...base, config: { ...base.config, adminOnly: true } };
    expect(await linkedUser(base, member)).toBe(b.userId);
    expect(await linkedUser(adminOnly, member)).toBeNull();
    await sql`update users set role = 'admin' where id = ${b.userId}`;
    expect(await linkedUser(adminOnly, member)).toBe(b.userId);
  });

  it.skipIf(!REDIS)('Discord: /sim enqueues, keeps the token 900 s in Redis, and the reply task posts DPS and a hosted share once done', async () => {
    redis = connectRedis(REDIS!, () => {});
    raw = new RawRedis(REDIS!, { enableReadyCheck: false });
    await (redis.status === 'ready' ? Promise.resolve() : new Promise<void>((resolve) => redis!.once('ready', () => resolve())));
    const discordId = snowflake();
    const { userId, characterId } = await user(discordId, false);
    const interaction = JSON.stringify({ type: 2, token: 'tok_en', user: { id: discordId },
      data: { name: 'sim', options: [{ name: 'character', type: 3, value: characterId }, { name: 'fight', type: 3, value: 'cleave-add' }] } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    // /sim counts against the web route's per-user limit; both possible windows are removed afterwards.
    for (const at of [Date.now(), Date.now() + 60_000]) redisKeys.add(`frostsim:rl:compute-submit:${userId}:${Math.floor(at / 60_000)}`);
    const res = await createApp(app(), discordRoutes)(new Request(`${ORIGIN}/api/v1/discord/interactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature-timestamp': timestamp,
        'x-signature-ed25519': edSign(null, Buffer.from(timestamp + interaction), privateKey).toString('hex') },
      body: interaction,
    }), '127.0.0.1');
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    await vi.waitFor(() => expect(edits).toHaveLength(1), { timeout: 5000 });
    expect(edits[0]).toEqual({ url: `/api/v10/webhooks/${APP_ID}/tok_en/messages/@original`, content: expect.stringMatching(/^Queued \*\*Main\*\* on Cleave Add/) });

    const [job] = await sql`select id, source, user_id from compute_jobs where source = 'discord'`;
    expect(job.user_id).toBe(userId);
    redisKeys.add(`frostsim:discord:${job.id}`);
    // The token is stored just after the "Queued" edit.
    await vi.waitFor(async () => expect(await raw!.ttl(`frostsim:discord:${job.id}`)).toBeGreaterThan(890));

    // Still running: the task leaves the reply alone.
    const [{ run }] = discordTasks;
    await run(app());
    expect(edits).toHaveLength(1);

    const [worker] = await sql`select id from workers limit 1`;
    await sql`update compute_jobs set status = 'cancelled' where source = 'loothing' and status = 'queued'`;
    const claimed = await claimJob(app(), worker.id, 32);
    expect(claimed).toMatchObject({ id: job.id });
    objects.set(`frostsim-data/results/${job.id}.json.gz`, RESULT);
    expect(await completeJob(app(), worker.id, job.id, 10, { dps: 223973.7, dpsError: 2137.6, iterations: 53 })).toBe('ok');

    await run(app());
    expect(edits).toHaveLength(2);
    const [share] = await sql`select id, title, bytes from shares where user_id = ${userId}`;
    expect(share.title).toBe('Main · Cleave Add');
    expect(share.bytes).toBeGreaterThan(0);
    expect(edits[1].content).toBe(`**Main** on Cleave Add: **223,974 DPS** ± 2,138 (95%)\nFull report: ${ORIGIN}/#/s/${share.id}`);
    expect(await raw.exists(`frostsim:discord:${job.id}`)).toBe(0);
    await run(app());
    expect(edits).toHaveLength(2);
  });
});
