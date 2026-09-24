// Gated accounts integration (CLAUDE.md D15; DESIGN.md C7, P4, P6): the real SQL of sign-up, login, session, /me, link,
// unlink, export, admin and deletion against the local Postgres (and Redis when set), with the providers, Stripe and R2 faked at fetch.
// Each run owns a fresh schema, a random client IP and its own Redis keys, and removes them, so it can run beside other suites.

import { randomBytes } from 'node:crypto';
import { Redis as RawRedis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppCtx } from './app';
import { routes as adminRoutes } from './admin';
import { loadConfig } from './config';
import { connectDb, type Sql } from './db';
import { migrate } from './migrate';
import { routes as oauthRoutes } from './oauth';
import { createR2 } from './r2';
import { connectRedis, type Redis } from './redis';
import { sha256Hex } from './signed';
import { deleteAccount, routes as userRoutes, tasks as userTasks } from './users';

const PG = process.env.FROSTSIM_TEST_PG;
const REDIS = process.env.FROSTSIM_TEST_REDIS;
const ORIGIN = 'https://sim.test';
const ready = (r: Redis) => (r.status === 'ready' ? Promise.resolve() : new Promise<void>((resolve) => r.once('ready', () => resolve())));

describe.skipIf(!PG)('accounts postgres integration (needs FROSTSIM_TEST_PG; Redis parts need FROSTSIM_TEST_REDIS)', () => {
  const schema = `t_accounts_${randomBytes(4).toString('hex')}`;
  const ip = `10.${randomBytes(3).join('.')}`;
  // Discord subjects the fake provider hands out, one per `code`.
  const run = randomBytes(3).toString('hex');
  const subject = (name: string) => `${name}-${run}`;
  const redisKeys = new Set<string>();
  const r2Deletes: string[] = [];
  let r2Fails = false;
  let admin: Sql;
  let sql: Sql;
  let redis: Redis | null = null;
  let raw: RawRedis | null = null;
  let app: AppCtx;
  let handle: ReturnType<typeof createApp>;

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/token')) {
      const code = new URLSearchParams(await request.text()).get('code');
      return Response.json({ access_token: `at-${code}` });
    }
    const code = request.headers.get('authorization')!.slice('Bearer at-'.length);
    if (url.host === 'discord.com') return Response.json({ id: subject(code), username: code, global_name: `Name ${code}` });
    if (url.host === 'oauth.battle.net') return Response.json({ sub: subject(code), battletag: `${code}#1234` });
    if (url.host.endsWith('r2.cloudflarestorage.com')) {
      if (r2Fails) return new Response(null, { status: 500 });
      r2Deletes.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url.host}`);
  }) as typeof fetch;

  const call = (path: string, init: RequestInit & { jar?: string[] } = {}) => {
    const headers = new Headers(init.headers);
    if (init.jar?.length) headers.set('cookie', init.jar.join('; '));
    return handle(new Request(ORIGIN + path, { ...init, headers }), ip);
  };
  const pair = (setCookie: string) => setCookie.split(';')[0];
  /** The sid pair a response sets, remembering its cache key for cleanup. */
  const sidFrom = (res: Response) => {
    const sid = res.headers.getSetCookie().map(pair).find((c) => c.startsWith('__Host-fs_sid=') && c.length > 15);
    if (sid) redisKeys.add(`frostsim:sess:${sha256Hex(sid.slice('__Host-fs_sid='.length))}`);
    return sid;
  };
  const write = (method: string, jar: string[], body?: unknown) => ({
    method, jar, headers: { origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  /** Full browser round trip: start (optionally signed in), provider redirect, callback. Returns the landing code and the cookie jar. */
  async function signIn(provider: 'discord' | 'battlenet', code: string, opts: { mode?: 'login' | 'link'; jar?: string[] } = {}) {
    return (await begin(provider, code, opts))();
  }

  /** Runs start and returns the callback step, so a test can fire several callbacks at once. */
  async function begin(provider: 'discord' | 'battlenet', code: string, opts: { mode?: 'login' | 'link'; jar?: string[] } = {}) {
    const started = await call(`/api/v1/auth/${provider}/start?mode=${opts.mode ?? 'login'}&return=%23%2Freports`, { jar: opts.jar });
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    redisKeys.add(`frostsim:oauth:${sha256Hex(state)}`);
    const oauth = pair(started.headers.getSetCookie()[0]);
    const callback = `/api/v1/auth/${provider}/callback?code=${code}&state=${state}`;
    return async () => {
      const done = await call(callback, { jar: [oauth, ...(opts.jar ?? [])] });
      const landing = new URL(done.headers.get('location')!);
      expect(landing.origin + landing.pathname + landing.hash).toBe(`${ORIGIN}/#/reports`);
      const sid = sidFrom(done);
      return { account: landing.searchParams.get('account'), jar: sid ? [sid] : [], replay: () => call(callback, { jar: [oauth] }) };
    };
  }

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('./migrations/', import.meta.url));
    if (REDIS) {
      redis = connectRedis(REDIS, () => {});
      raw = new RawRedis(REDIS, { enableReadyCheck: false });
      await ready(redis);
    }
    const config = loadConfig({
      FEATURES: 'accounts', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'x', SESSION_SECRET: randomBytes(32).toString('hex'),
      DISCORD_CLIENT_ID: 'dc', DISCORD_CLIENT_SECRET: 'dc-secret', BATTLENET_CLIENT_ID: 'bn', BATTLENET_CLIENT_SECRET: 'bn-secret',
      ADMIN_IDENTITIES: `discord:${subject('boss')}`,
      R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
    });
    app = { config, sql, redis, r2: createR2(config, fakeFetch), fetch: fakeFetch, now: () => new Date(), log: () => {} };
    handle = createApp(app, [...oauthRoutes, ...userRoutes, ...adminRoutes]);
  });

  afterAll(async () => {
    if (raw) {
      const window = Math.floor(Date.now() / 1000 / 600);
      for (const w of [window - 1, window]) redisKeys.add(`frostsim:rl:oauth-start:${ip}:${w}`);
      const hour = Math.floor(Date.now() / 3_600_000);
      for (const u of await sql`select id from users`) for (const w of [hour - 1, hour]) redisKeys.add(`frostsim:rl:export:${u.id}:${w}`);
      await raw.del(...redisKeys);
    }
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
    redis?.disconnect();
    raw?.disconnect();
  });

  it('signs up, reads /me, renames, links, refuses a foreign identity, unlinks, exports and logs out', async () => {
    const alice = await signIn('discord', 'alice');
    expect(alice.account).toBe('signed-in');
    const me = await (await call('/api/v1/me', { jar: alice.jar })).json();
    expect(me).toMatchObject({ user: { displayName: 'Name alice', role: 'user' }, identities: [{ provider: 'discord', displayName: 'Name alice' }], integrations: [] });
    if (raw) expect(await raw.ttl([...redisKeys][0])).toBeGreaterThan(0);

    expect((await call('/api/v1/me', write('PATCH', alice.jar, { displayName: 'Alice' }))).status).toBe(200);
    expect((await (await call('/api/v1/me', { jar: alice.jar })).json()).user.displayName).toBe('Alice');

    expect((await signIn('battlenet', 'alicebn', { mode: 'link', jar: alice.jar })).account).toBe('linked');
    // Signing in again through the linked identity lands on the same user.
    const again = await signIn('battlenet', 'alicebn');
    expect((await (await call('/api/v1/me', { jar: again.jar })).json()).user.id).toBe(me.user.id);

    const bob = await signIn('discord', 'bob');
    expect((await signIn('battlenet', 'alicebn', { mode: 'link', jar: bob.jar })).account).toBe('error-identity-in-use');
    expect((await signIn('discord', 'bob2', { mode: 'link', jar: bob.jar })).account).toBe('error-already-linked');

    const unlinked = await call('/api/v1/me/identities/discord', write('DELETE', alice.jar));
    expect(unlinked.status).toBe(204);
    // Unlinking ends every session, the other device's too; this browser continues on a fresh one.
    expect((await call('/api/v1/me', { jar: again.jar })).status).toBe(401);
    expect((await call('/api/v1/me', { jar: alice.jar })).status).toBe(401);
    alice.jar = [sidFrom(unlinked)!];
    expect((await call('/api/v1/me', { jar: alice.jar })).status).toBe(200);
    const phone = await signIn('battlenet', 'alicebn');
    const last = await call('/api/v1/me/identities/battlenet', write('DELETE', alice.jar));
    expect(last.status).toBe(409);
    expect((await call('/api/v1/me/identities/discord', write('DELETE', alice.jar))).status).toBe(404);

    expect((await call('/api/v1/me/integrations/loothing', write('PUT', alice.jar))).status).toBe(204);
    expect((await call('/api/v1/me/integrations/loothing', write('PUT', alice.jar))).status).toBe(204);
    const exported = await (await call('/api/v1/me/export', { jar: alice.jar })).json();
    expect(exported.user).toMatchObject({ id: me.user.id, display_name: 'Alice', comp_core_seconds: 0 });
    expect(exported.identities).toEqual([expect.objectContaining({ provider: 'battlenet', subject: subject('alicebn'), display_name: 'alicebn#1234' })]);
    expect(exported.sessions).toHaveLength(2);
    expect(exported.computeJobs).toEqual([]);
    expect(Object.keys(exported.sessions[0]).sort()).toEqual(['created_at', 'expires_at', 'last_seen_at']);
    expect(exported.integrationGrants).toEqual([expect.objectContaining({ integration: 'loothing' })]);
    expect(exported.auditLog.map((a: { action: string }) => a.action)).toEqual(['user.create', 'identity.link', 'identity.unlink', 'integration.grant']);

    const out = await call('/api/v1/auth/logout', write('POST', alice.jar));
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toEqual(['__Host-fs_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
    expect((await call('/api/v1/me', { jar: alice.jar })).status).toBe(401);
    if (raw) expect(await raw.exists(`frostsim:sess:${sha256Hex(alice.jar[0].slice('__Host-fs_sid='.length))}`)).toBe(0);
    // Logout ends only this browser's session.
    expect((await call('/api/v1/me', { jar: phone.jar })).status).toBe(200);
  });

  it('serialises concurrent links: two Battle.net links started at once bind exactly one identity', async () => {
    const frank = await signIn('discord', 'frank');
    const callbacks = await Promise.all(['frankA', 'frankB'].map((code) => begin('battlenet', code, { mode: 'link', jar: frank.jar })));
    const outcomes = await Promise.all(callbacks.map((finish) => finish()));
    expect(outcomes.map((o) => o.account).sort()).toEqual(['error-already-linked', 'linked']);
    const { user } = await (await call('/api/v1/me', { jar: frank.jar })).json();
    expect(await sql`select subject from identities where user_id = ${user.id} and provider = 'battlenet'`).toHaveLength(1);
  });

  it.skipIf(!REDIS)('refuses a replayed callback (Redis): one token exchange per state', async () => {
    const grace = await signIn('discord', 'grace');
    expect(grace.account).toBe('signed-in');
    const replay = await grace.replay();
    expect(new URL(replay.headers.get('location')!).searchParams.get('account')).toBe('error-state');
    expect(replay.headers.getSetCookie().some((c) => c.startsWith('__Host-fs_sid='))).toBe(false);
  });

  it('promotes ADMIN_IDENTITIES, lets the admin search, suspend and restore, and refuses self-demotion', async () => {
    const boss = await signIn('discord', 'boss');
    const carol = await signIn('discord', 'carol');
    const bossMe = await (await call('/api/v1/me', { jar: boss.jar })).json();
    expect(bossMe.user.role).toBe('admin');
    expect((await call('/api/v1/admin/users', { jar: carol.jar })).status).toBe(403);

    const found = await (await call('/api/v1/admin/users?q=name%20car', { jar: boss.jar })).json();
    expect(found.users.map((u: { displayName: string }) => u.displayName)).toEqual(['Name carol']);
    const carolId = found.users[0].id;
    expect((await (await call(`/api/v1/admin/users?q=${carolId}`, { jar: boss.jar })).json()).users).toHaveLength(1);
    expect((await (await call('/api/v1/admin/users?q=%25', { jar: boss.jar })).json()).users).toHaveLength(0);

    const suspended = await call(`/api/v1/admin/users/${carolId}`, write('PATCH', boss.jar, { suspended: true, compCoreSeconds: 3600, compMaxThreads: 8 }));
    expect(suspended.status).toBe(200);
    expect((await suspended.json()).user).toMatchObject({ compCoreSeconds: 3600, compMaxThreads: 8, deletionPending: false });
    expect((await call('/api/v1/me', { jar: carol.jar })).status).toBe(401);
    expect((await signIn('discord', 'carol')).account).toBe('error-suspended');

    expect((await call(`/api/v1/admin/users/${carolId}`, write('PATCH', boss.jar, { suspended: false }))).status).toBe(200);
    expect((await signIn('discord', 'carol')).account).toBe('signed-in');

    expect((await call(`/api/v1/admin/users/${bossMe.user.id}`, write('PATCH', boss.jar, { role: 'user' }))).status).toBe(403);
    const view = await (await call(`/api/v1/admin/users/${carolId}`, { jar: boss.jar })).json();
    expect(view.identities).toEqual([expect.objectContaining({ provider: 'discord', subject: subject('carol') })]);
    const trail = await sql`select actor, action from audit_log where user_id = ${carolId} and action = 'admin.user.update'`;
    expect(trail).toEqual([{ actor: `admin:${bossMe.user.id}`, action: 'admin.user.update' }, { actor: `admin:${bossMe.user.id}`, action: 'admin.user.update' }]);
  });

  it('deletes an account: R2 objects, then the row with everything cascading, and leaves an anonymous audit row', async () => {
    const dave = await signIn('discord', 'dave');
    const { user } = await (await call('/api/v1/me', { jar: dave.jar })).json();
    const shareId = `S${randomBytes(8).toString('hex')}`;
    await sql`insert into shares (id, user_id, title, bytes) values (${shareId}, ${user.id}, 't', 1)`;
    const [job] = await sql`insert into compute_jobs (user_id, source, pack_id, threads, status) values (${user.id}, 'web', 'p', 8, 'done') returning id`;
    const [guildJob] = await sql`insert into compute_jobs (user_id, guild_id, source, pack_id, threads, status, core_seconds, request)
      values (${user.id}, ${`g-${run}`}, 'discord', 'p', 8, 'done', 3600, ${sql.json({ profile: 'x' })}) returning id`;

    const res = await call('/api/v1/me', write('DELETE', dave.jar));
    expect(res.status).toBe(204);
    expect(r2Deletes.sort()).toEqual([`/frostsim-data/results/${guildJob.id}.json.gz`, `/frostsim-data/results/${job.id}.json.gz`,
      `/frostsim-data/shares/${shareId}.json.gz`].sort());
    // The guild keeps its metered seconds, without the deleted user's id or character data.
    expect(await sql`select user_id, request, core_seconds from compute_jobs where id = ${guildJob.id}`)
      .toEqual([{ user_id: null, request: null, core_seconds: 3600 }]);
    for (const table of ['users', 'identities', 'sessions', 'shares', 'compute_jobs']) {
      expect(await sql`select 1 from ${sql(table)} where ${sql(table === 'users' ? 'id' : 'user_id')} = ${user.id}`).toHaveLength(0);
    }
    const [done] = await sql`select user_id, actor, detail from audit_log where action = 'account.deleted' and detail->>'userId' = ${user.id}`;
    expect(done).toMatchObject({ user_id: null, actor: `user:${user.id}`, detail: { r2: 'deleted', r2Objects: 3, stripe: 'none' } });
    expect((await signIn('discord', 'dave')).account).toBe('signed-in');
  });

  it('keeps a half-deleted account locked, refuses to unsuspend it, and lets the retry task finish it', async () => {
    const boss = await signIn('discord', 'boss');
    const erin = await signIn('discord', 'erin');
    const { user } = await (await call('/api/v1/me', { jar: erin.jar })).json();
    await sql`insert into shares (id, user_id, title, bytes) values (${`E${randomBytes(8).toString('hex')}`}, ${user.id}, 't', 1)`;

    r2Fails = true;
    const res = await call('/api/v1/me', write('DELETE', erin.jar));
    expect(res.status).toBe(202);
    const [locked] = await sql`select suspended_at from users where id = ${user.id}`;
    expect(locked.suspended_at).not.toBeNull();
    expect(await sql`select revoked_at from shares where user_id = ${user.id} and revoked_at is null`).toHaveLength(0);
    expect((await signIn('discord', 'erin')).account).toBe('error-suspended');
    expect((await call(`/api/v1/admin/users/${user.id}`, write('PATCH', boss.jar, { suspended: false }))).status).toBe(409);

    r2Fails = false;
    await userTasks.find((t) => t.name === 'account-delete-retry')!.run(app);
    expect(await sql`select 1 from users where id = ${user.id}`).toHaveLength(0);
    expect(await sql`select 1 from audit_log where action = 'account.delete-started' and user_id is not null`).toHaveLength(0);
    expect(await deleteAccount(app, user.id, 'system')).toBe('not-found');
  });
});
