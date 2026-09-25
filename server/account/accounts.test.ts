// Accounts (CLAUDE.md D15; DESIGN.md C7, P4, P6): providers, OAuth start/callback/logout, /me, admin routes and the
// account deletion order. Fake Postgres (query text + values), fake fetch for the providers, Stripe and R2. The real round trip is
// in accounts.integration.test.ts.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppCtx } from './app';
import { createApp } from './app';
import { routes as adminRoutes, parsePatch } from './admin';
import { loadConfig } from './config';
import type { Sql } from './db';
import { createR2 } from './r2';
import type { Redis } from './redis';
import { OAUTH_COOKIE, routes as oauthRoutes, safeReturn } from './oauth';
import { PROVIDERS } from './providers/index';
import { sign, verify } from './signed';
import { deleteAccount, routes as userRoutes, tasks as userTasks } from './users';

const ORIGIN = 'https://sim.test';
const SECRET = 's'.repeat(32);
const SID = 'a'.repeat(43);
const NOW = new Date('2026-09-23T12:00:00Z');
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const ENV = {
  FEATURES: 'accounts',
  PUBLIC_ORIGIN: ORIGIN,
  DATABASE_URL: 'postgres://unused',
  SESSION_SECRET: SECRET,
  BATTLENET_CLIENT_ID: 'bn-id',
  BATTLENET_CLIENT_SECRET: 'bn-secret',
  DISCORD_CLIENT_ID: 'dc-id',
  DISCORD_CLIENT_SECRET: 'dc-secret',
};

type Answer = (query: string, values: unknown[]) => unknown[] | undefined;
type Upstream = (request: Request) => Response | Promise<Response>;

/** Provider, Stripe and R2 stand-in: good answers unless a test overrides one. */
const upstream: Upstream = (request) => {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'at-1', token_type: 'bearer' });
  if (url.host === 'oauth.battle.net') return Response.json({ sub: '4242', id: 4242, battletag: 'Frost#1234' });
  if (url.host === 'discord.com') return Response.json({ id: '8080', username: 'frost', global_name: 'Frosty' });
  if (url.host === 'api.stripe.com') return Response.json({ id: 'cus_1', deleted: true });
  return new Response(null, { status: 204 });
};

function world(answer: Answer = () => undefined, opts: {
  env?: Record<string, string>; role?: 'user' | 'admin' | null; now?: Date; redis?: Redis | null; upstream?: Upstream;
} = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const role = opts.role === undefined ? 'user' : opts.role;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    events.push(`sql ${query} ${JSON.stringify(values)}`);
    if (query.includes('from sessions s join users')) {
      return Promise.resolve(role ? [{ user_id: ME, role, display_name: 'Me', suspended_at: null,
        expires_at: new Date(NOW.getTime() + 86_400_000), last_seen_at: NOW }] : []);
    }
    return Promise.resolve(answer(query, values) ?? []);
  }) as unknown as Sql;
  Object.assign(sql, { begin: (fn: (tx: Sql) => unknown) => fn(sql), json: (v: unknown) => v });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    events.push(`fetch ${request.method} ${request.url}`);
    return (opts.upstream ?? upstream)(request);
  }) as typeof fetch;
  const config = loadConfig({ ...ENV, ...opts.env });
  const app: AppCtx = { config, sql, redis: opts.redis ?? null, r2: createR2(config, fetchFn), fetch: fetchFn,
    now: () => opts.now ?? NOW, log: (line) => logs.push(line) };
  const handle = createApp(app, [...oauthRoutes, ...userRoutes, ...adminRoutes]);
  const call = (path: string, init: RequestInit & { cookies?: string[] } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookies) headers.set('cookie', init.cookies.join('; '));
    return handle(new Request(ORIGIN + path, { ...init, headers }), '10.0.0.1');
  };
  const has = (fragment: string) => events.some((e) => e.includes(fragment));
  const at = (fragment: string) => events.findIndex((e) => e.includes(fragment));
  return { app, call, events, logs, has, at };
}

/** Just enough Redis for SET NX (the OAuth state) and the rate-limit MULTI; `count` is what INCR answers. */
function fakeRedis(count = 1) {
  const keys = new Set<string>();
  return {
    keys,
    set: async (key: string, _v: string, _ex: string, _ttl: number, nx: string) => {
      if (nx === 'NX' && keys.has(key)) return null;
      keys.add(key);
      return 'OK';
    },
    get: async () => null,
    del: async () => 0,
    multi: () => ({ incr() { return this; }, expire() { return this; }, exec: async () => [[null, count], [null, 1]] }),
  };
}

const sid = `__Host-fs_sid=${SID}`;
const state = (over: Record<string, unknown> = {}, now = NOW) => sign(SECRET, 'oauth',
  { state: 'st-1', verifier: 'v'.repeat(43), provider: 'discord', mode: 'login', returnTo: '#/reports', ...over }, 600, now.getTime());
const oauthCookie = (token: string) => `${OAUTH_COOKIE}=${token}`;
const landing = (res: Response) => new URL(res.headers.get('location')!);
const cookies = (res: Response) => res.headers.getSetCookie();
const json = { 'content-type': 'application/json', origin: ORIGIN };

describe('providers', () => {
  const config = loadConfig(ENV);

  it('builds authorize URLs with the documented host, scope, state and an S256 challenge', () => {
    const bn = new URL(PROVIDERS.get('battlenet')!.authorizeUrl(config, { state: 'st', codeChallenge: 'ch', redirectUri: `${ORIGIN}/cb` }));
    expect(bn.origin + bn.pathname).toBe('https://oauth.battle.net/authorize');
    expect(Object.fromEntries(bn.searchParams)).toEqual({ response_type: 'code', client_id: 'bn-id', scope: 'openid', state: 'st',
      redirect_uri: `${ORIGIN}/cb`, code_challenge: 'ch', code_challenge_method: 'S256' });
    const dc = new URL(PROVIDERS.get('discord')!.authorizeUrl(config, { state: 'st', codeChallenge: 'ch', redirectUri: `${ORIGIN}/cb` }));
    expect(dc.origin + dc.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(dc.searchParams.get('scope')).toBe('identify');
    expect(dc.searchParams.get('client_id')).toBe('dc-id');
  });

  it('exchanges the code with Basic auth and the verifier, then reads the profile with the token', async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, auth: request.headers.get('authorization'), body: await request.text() });
      return upstream(request);
    }) as typeof fetch;
    const user = await PROVIDERS.get('battlenet')!.exchange(config, { code: 'c1', codeVerifier: 'ver', redirectUri: `${ORIGIN}/cb` }, fetchFn);
    expect(user).toEqual({ subject: '4242', displayName: 'Frost#1234' });
    expect(seen[0].url).toBe('https://oauth.battle.net/token');
    expect(seen[0].auth).toBe(`Basic ${Buffer.from('bn-id:bn-secret').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(seen[0].body))).toEqual({ grant_type: 'authorization_code', code: 'c1',
      redirect_uri: `${ORIGIN}/cb`, code_verifier: 'ver' });
    expect(seen[1]).toMatchObject({ url: 'https://oauth.battle.net/userinfo', auth: 'Bearer at-1' });

    const dc = await PROVIDERS.get('discord')!.exchange(config, { code: 'c', codeVerifier: 'v', redirectUri: 'r' }, fetchFn);
    expect(dc).toEqual({ subject: '8080', displayName: 'Frosty' });
    expect(seen[2].url).toBe('https://discord.com/api/oauth2/token');
    expect(seen[3].url).toBe('https://discord.com/api/v10/users/@me');
  });

  it('falls back to the username or a label name, strips control characters, and refuses a profile without a subject', async () => {
    const answering = (profile: object) => (async (input: RequestInfo | URL) =>
      String(input).endsWith('/token') ? Response.json({ access_token: 't' }) : Response.json(profile)) as typeof fetch;
    const dc = PROVIDERS.get('discord')!;
    const args = { code: 'c', codeVerifier: 'v', redirectUri: 'r' };
    expect(await dc.exchange(config, args, answering({ id: '1', username: 'u\u0007ser', global_name: null }))).toEqual({ subject: '1', displayName: 'user' });
    expect(await dc.exchange(config, args, answering({ id: '1' }))).toEqual({ subject: '1', displayName: 'Discord user' });
    // Bidi overrides, zero-width space and BOM go; ZWJ inside an emoji sequence stays.
    expect(await dc.exchange(config, args, answering({ id: '1', global_name: '\u202Enimda\u200B\uFEFF \u{1F469}\u200D\u{1F4BB}' })))
      .toEqual({ subject: '1', displayName: 'nimda \u{1F469}\u200D\u{1F4BB}' });
    await expect(dc.exchange(config, args, answering({ username: 'x' }))).rejects.toThrow(/no usable subject/);
  });

  it('never puts an upstream body in the error', async () => {
    const failing = (async () => new Response('{"error":"invalid_grant","code":"c1","secret":"bn-secret"}', { status: 400 })) as typeof fetch;
    const err = await PROVIDERS.get('battlenet')!.exchange(config, { code: 'c1', codeVerifier: 'v', redirectUri: 'r' }, failing).catch((e: Error) => e);
    expect((err as Error).message).toBe('token request failed with status 400');
  });

  it('is configured only with both credentials', () => {
    expect(PROVIDERS.get('discord')!.configured(loadConfig({ ...ENV, DISCORD_CLIENT_SECRET: '' }))).toBe(false);
    expect(PROVIDERS.get('discord')!.configured(config)).toBe(true);
  });
});

describe('GET /auth/providers', () => {
  it('lists configured providers only', async () => {
    const { call } = world(undefined, { env: { BATTLENET_CLIENT_SECRET: '' } });
    expect(await (await call('/api/v1/auth/providers')).json()).toEqual({ providers: [{ id: 'discord', label: 'Discord' }] });
  });
});

describe('GET /auth/:provider/start', () => {
  it('sets the signed state cookie with exact flags and redirects to the provider with the matching challenge', async () => {
    const { call } = world();
    const res = await call('/api/v1/auth/discord/start?mode=login&return=%23%2Freports%2Fabc');
    expect(res.status).toBe(302);
    const [cookie] = cookies(res);
    expect(cookie).toMatch(/^__Host-fs_oauth=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/);
    const token = cookie.split(';')[0].slice(OAUTH_COOKIE.length + 1);
    const saved = verify<Record<string, string>>(SECRET, 'oauth', token, NOW.getTime())!;
    expect(saved).toMatchObject({ provider: 'discord', mode: 'login', returnTo: '#/reports/abc', exp: NOW.getTime() / 1000 + 600 });
    expect(saved.linkUserId).toBeUndefined();
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('state')).toBe(saved.state);
    expect(location.searchParams.get('code_challenge')).toBe(createHash('sha256').update(saved.verifier).digest('base64url'));
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/v1/auth/discord/callback`);
    expect(saved.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('answers 503 unconfigured for a provider without credentials, 404 for an unknown one, 400 for a bad mode', async () => {
    const { call } = world(undefined, { env: { BATTLENET_CLIENT_ID: '' } });
    const off = await call('/api/v1/auth/battlenet/start');
    expect(off.status).toBe(503);
    expect((await off.json()).error).toBe('unconfigured');
    expect((await call('/api/v1/auth/github/start')).status).toBe(404);
    expect((await call('/api/v1/auth/discord/start?mode=merge')).status).toBe(400);
  });

  it('needs a live session to start a link, and binds the cookie to that user', async () => {
    expect((await world(undefined, { role: null }).call('/api/v1/auth/discord/start?mode=link')).status).toBe(401);
    const res = await world().call('/api/v1/auth/discord/start?mode=link', { cookies: [sid] });
    const token = cookies(res)[0].split(';')[0].slice(OAUTH_COOKIE.length + 1);
    expect(verify<Record<string, string>>(SECRET, 'oauth', token, NOW.getTime())).toMatchObject({ mode: 'link', linkUserId: ME });
  });

  it.each([['cross-site', 403], ['same-site', 403], ['same-origin', 302], ['none', 302]])(
    'with Sec-Fetch-Site %s answers %i', async (site, status) => {
      const w = world();
      const res = await w.call('/api/v1/auth/discord/start?mode=link', { headers: { 'sec-fetch-site': site }, cookies: [sid] });
      expect(res.status).toBe(status);
      if (status === 403) expect(cookies(res)).toEqual([]);
    });

  it('rate-limits per client IP', async () => {
    const redis = { multi: () => ({ incr() { return this; }, expire() { return this; }, exec: async () => [[null, 31], [null, 1]] }) };
    const res = await world(undefined, { redis: redis as unknown as Redis }).call('/api/v1/auth/discord/start');
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate-limited');
  });

  it.each(['//evil.test', 'https://evil.test', '\\\\evil.test', '%2F%2Fevil.test', 'javascript:alert(1)', '#/a b', '#/<x>', `#/${'a'.repeat(201)}`])(
    'refuses return=%s and stores #/ instead', async (value) => {
      expect(safeReturn(decodeURIComponent(value))).toBe('#/');
      const res = await world().call(`/api/v1/auth/discord/start?return=${encodeURIComponent(value)}`);
      const token = cookies(res)[0].split(';')[0].slice(OAUTH_COOKIE.length + 1);
      expect(verify<Record<string, string>>(SECRET, 'oauth', token, NOW.getTime())!.returnTo).toBe('#/');
    });

  it('keeps an in-app return path', () => {
    expect(safeReturn('#/reports/r_1.2-x')).toBe('#/reports/r_1.2-x');
  });
});

describe('GET /auth/:provider/callback', () => {
  const newUser: Answer = (q) => (q.startsWith('insert into users') ? [{ id: ME, role: 'user', suspended_at: null }] : undefined);

  it.each([
    ['no cookie', [], 'st-1'],
    ['a state that does not match', [oauthCookie(state())], 'st-2'],
    ['a missing state', [oauthCookie(state())], null],
    ['an expired cookie', [oauthCookie(state({}, new Date(NOW.getTime() - 601_000)))], 'st-1'],
    ['a tampered cookie', [oauthCookie(state().replace(/^./, (c) => (c === 'e' ? 'f' : 'e')))], 'st-1'],
    ['a cookie signed for another purpose', [oauthCookie(sign(SECRET, 'guild-checkout', { state: 'st-1', provider: 'discord' }, 600, NOW.getTime()))], 'st-1'],
    ['a cookie minted for another provider', [oauthCookie(state({ provider: 'battlenet' }))], 'st-1'],
  ])('refuses %s with error-state, clears the cookie and never calls the provider', async (_name, jar, got) => {
    const w = world(newUser);
    const res = await w.call(`/api/v1/auth/discord/callback?code=c1${got ? `&state=${got}` : ''}`, { cookies: jar as string[] });
    expect(res.status).toBe(302);
    expect(landing(res).href).toBe(`${ORIGIN}/?account=error-state#/`);
    expect(cookies(res)).toEqual([`${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);
    expect(w.has('fetch')).toBe(false);
    expect(w.has('insert into')).toBe(false);
  });

  it('signs a new identity up: user + identity + session, back to the saved return path', async () => {
    const w = world(newUser);
    const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(res).href).toBe(`${ORIGIN}/?account=signed-in#/reports`);
    const [clear, session] = cookies(res);
    expect(clear).toBe(`${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    expect(session).toMatch(/^__Host-fs_sid=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    expect(w.at('insert into users')).toBeLessThan(w.at('insert into identities'));
    expect(w.has('["discord","8080","00000000-0000-4000-8000-000000000001","Frosty"]')).toBe(true);
    expect(w.has('insert into sessions')).toBe(true);
    // The token exchange carried the verifier from the cookie.
    expect(w.has('fetch POST https://discord.com/api/oauth2/token')).toBe(true);
  });

  it('signs an existing identity in without creating a user', async () => {
    const w = world((q) => (q.startsWith('select u.id, u.role, u.suspended_at from identities') ? [{ id: ME, role: 'user', suspended_at: null }] : undefined));
    const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(res).searchParams.get('account')).toBe('signed-in');
    expect(w.has('insert into users')).toBe(false);
    expect(w.has('insert into sessions')).toBe(true);
  });

  it('refuses a suspended user without creating a session', async () => {
    const w = world((q) => (q.startsWith('select u.id, u.role, u.suspended_at from identities') ? [{ id: ME, role: 'user', suspended_at: NOW }] : undefined));
    const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(res).href).toBe(`${ORIGIN}/?account=error-suspended#/reports`);
    expect(cookies(res)).toHaveLength(1);
    expect(w.has('insert into sessions')).toBe(false);
  });

  it('under ADMIN_ONLY refuses strangers before creating anything, and existing non-admins', async () => {
    const stranger = world(newUser, { env: { ADMIN_ONLY: '1' } });
    const res = await stranger.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(res).searchParams.get('account')).toBe('error-admin-only');
    expect(stranger.has('insert into')).toBe(false);

    const member = world((q) => (q.startsWith('select u.id') ? [{ id: ME, role: 'user', suspended_at: null }] : undefined), { env: { ADMIN_ONLY: '1' } });
    const again = await member.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(again).searchParams.get('account')).toBe('error-admin-only');
    expect(member.has('insert into sessions')).toBe(false);
  });

  it('promotes an ADMIN_IDENTITIES identity and lets it in under ADMIN_ONLY', async () => {
    const w = world((q) => (q.startsWith('select u.id') ? [{ id: ME, role: 'user', suspended_at: null }] : undefined),
      { env: { ADMIN_ONLY: '1', ADMIN_IDENTITIES: 'battlenet:1, discord:8080' } });
    const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(res).searchParams.get('account')).toBe('signed-in');
    expect(w.at("update users set role = 'admin'")).toBeLessThan(w.at('insert into sessions'));
    expect(w.has('"user.promote"')).toBe(true);
  });

  it('maps a denied consent to error-denied and a failed exchange to error-provider without logging the body', async () => {
    const denied = await world().call('/api/v1/auth/discord/callback?error=access_denied&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(denied).href).toBe(`${ORIGIN}/?account=error-denied#/reports`);

    const w = world(newUser, { upstream: () => new Response('{"access_token":"leaked-token"}', { status: 500 }) });
    const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(res).searchParams.get('account')).toBe('error-provider');
    expect(w.logs.join('\n')).toContain('token request failed with status 500');
    expect(w.logs.join('\n')).not.toContain('leaked-token');
    expect(w.has('insert into')).toBe(false);
  });

  it('consumes the state once: a replay with the same cookie is error-state and makes no second token call', async () => {
    const redis = fakeRedis();
    const w = world(newUser, { redis: redis as unknown as Redis });
    const go = () => w.call('/api/v1/auth/discord/callback?code=bad&state=st-1', { cookies: [oauthCookie(state())] });
    expect(landing(await go()).searchParams.get('account')).toBe('signed-in');
    const replay = await go();
    expect(landing(replay).href).toBe(`${ORIGIN}/?account=error-state#/`);
    expect(cookies(replay)).toEqual([`${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);
    expect(w.events.filter((e) => e.startsWith('fetch POST https://discord.com/api/oauth2/token'))).toHaveLength(1);
    expect([...redis.keys]).toEqual([`oauth:${createHash('sha256').update('st-1').digest('hex')}`]);
  });

  it('turns a storage failure after the exchange into the error-provider landing, clearing the cookie', async () => {
    const w = world((q) => {
      if (q.startsWith('insert into users')) throw new Error('connection terminated');
      return undefined;
    });
    const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [oauthCookie(state())] });
    expect(res.status).toBe(302);
    expect(landing(res).href).toBe(`${ORIGIN}/?account=error-provider#/reports`);
    expect(cookies(res)).toEqual([`${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);
    expect(w.logs.join('\n')).toContain('connection terminated');
  });

  describe('link mode', () => {
    const link = (over: Record<string, unknown> = {}) => oauthCookie(state({ mode: 'link', linkUserId: ME, ...over }));

    it('refuses an identity bound to another user and never merges', async () => {
      const w = world((q) => (q.startsWith('select u.id') ? [{ id: OTHER, role: 'user', suspended_at: null }] : undefined));
      const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [link(), sid] });
      expect(landing(res).href).toBe(`${ORIGIN}/?account=error-identity-in-use#/reports`);
      expect(w.has('insert into')).toBe(false);
      expect(w.events.some((e) => e.startsWith('sql update'))).toBe(false);
    });

    it('needs the live session of the user the flow started for', async () => {
      const signedOut = await world(undefined, { role: null }).call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [link()] });
      expect(landing(signedOut).searchParams.get('account')).toBe('error-signed-out');
      const someoneElse = world();
      const res = await someoneElse.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [link({ linkUserId: OTHER }), sid] });
      expect(landing(res).searchParams.get('account')).toBe('error-signed-out');
      expect(someoneElse.has('insert into')).toBe(false);
    });

    it('links a free identity, refuses a second one from the same provider, and never creates a session', async () => {
      const w = world((q) => (q.includes('on conflict do nothing returning user_id') ? [{ user_id: ME }] : undefined));
      const res = await w.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [link(), sid] });
      expect(landing(res).href).toBe(`${ORIGIN}/?account=linked#/reports`);
      expect(cookies(res)).toHaveLength(1);
      expect(w.has('"identity.link"')).toBe(true);
      expect(w.has('insert into sessions')).toBe(false);
      // The user row is locked before the one-per-provider check, so two concurrent links cannot both pass it.
      const lock = w.at(`select 1 from users where id = ? for update ["${ME}"]`);
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(w.at('select 1 from identities where user_id'));

      const twice = world((q) => (q.startsWith('select 1 from identities where user_id') ? [{}] : undefined));
      const again = await twice.call('/api/v1/auth/discord/callback?code=c1&state=st-1', { cookies: [link(), sid] });
      expect(landing(again).searchParams.get('account')).toBe('error-already-linked');
      expect(twice.has('insert into')).toBe(false);
    });
  });
});

describe('POST /auth/logout', () => {
  it('destroys the session and clears the cookie', async () => {
    const w = world();
    const res = await w.call('/api/v1/auth/logout', { method: 'POST', headers: { origin: ORIGIN }, cookies: [sid] });
    expect(res.status).toBe(204);
    expect(cookies(res)).toEqual(['__Host-fs_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
    expect(w.has('delete from sessions where id_hash')).toBe(true);
  });

  it('refuses a cross-site logout', async () => {
    const res = await world().call('/api/v1/auth/logout', { method: 'POST', headers: { origin: 'https://evil.test' }, cookies: [sid] });
    expect(res.status).toBe(403);
  });
});

describe('/me', () => {
  const view: Answer = (q) => q.startsWith('select id, display_name, role, created_at from users') ? [{ id: ME, display_name: 'Me', role: 'user', created_at: NOW }]
    : q.startsWith('select provider, display_name') ? [{ provider: 'discord', display_name: 'Frosty', created_at: NOW }]
    : q.startsWith('select integration from') ? [{ integration: 'loothing' }] : undefined;

  it('answers the /me shape, and 401 when signed out', async () => {
    const res = await world(view).call('/api/v1/me', { cookies: [sid] });
    expect(await res.json()).toEqual({ user: { id: ME, displayName: 'Me', role: 'user', createdAt: NOW.toISOString() },
      identities: [{ provider: 'discord', displayName: 'Frosty', createdAt: NOW.toISOString() }], integrations: ['loothing'] });
    expect((await world(view, { role: null }).call('/api/v1/me')).status).toBe(401);
  });

  it.each([[''], ['   '], [42], ['a'.repeat(65)], ['bad\nname'], [null], ['\u202Enimda'], ['ad\u200Bmin'], ['a\u2066b']])('refuses displayName %j', async (name) => {
    const w = world(view);
    const res = await w.call('/api/v1/me', { method: 'PATCH', headers: json, cookies: [sid], body: JSON.stringify({ displayName: name }) });
    expect(res.status).toBe(400);
    expect(w.has('update users')).toBe(false);
  });

  it('renames, trimmed, and answers the new view', async () => {
    const w = world(view);
    const res = await w.call('/api/v1/me', { method: 'PATCH', headers: json, cookies: [sid], body: JSON.stringify({ displayName: '  Frost  ' }) });
    expect(res.status).toBe(200);
    expect(w.has(`update users set display_name = ? where id = ? ["Frost","${ME}"]`)).toBe(true);
  });

  it('exports every table about the user without the session hash', async () => {
    const w = world((q) => q.startsWith('select id, display_name, role, suspended_at') ? [{ id: ME, display_name: 'Me' }]
      : q.startsWith('select created_at, expires_at, last_seen_at from sessions') ? [{ created_at: NOW, expires_at: NOW, last_seen_at: NOW }] : undefined);
    const res = await w.call('/api/v1/me/export', { cookies: [sid] });
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="frostsim-account.json"');
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['exportedAt', 'user', 'identities', 'sessions', 'subscriptions', 'computeJobs', 'cloudCharacters', 'characterSnapshots', 'characterSims',
      'shares', 'integrationGrants', 'auditLog']);
    expect(body.sessions).toEqual([{ created_at: NOW.toISOString(), expires_at: NOW.toISOString(), last_seen_at: NOW.toISOString() }]);
    expect(w.events.filter((e) => e.includes('id_hash') && !e.includes('from sessions s join users'))).toEqual([]);
    // Job request/payload bodies (up to 1 MiB each) are exported as sizes only.
    const jobs = w.events.find((e) => e.includes('from compute_jobs'))!;
    expect(jobs).toContain('octet_length(request::text) as request_bytes');
    expect(jobs).not.toMatch(/threads, request,|, payload,/);
  });

  it('rate-limits exports per user', async () => {
    const w = world(undefined, { redis: fakeRedis(6) as unknown as Redis });
    const res = await w.call('/api/v1/me/export', { cookies: [sid] });
    expect(res.status).toBe(429);
    expect(w.has('from compute_jobs')).toBe(false);
  });

  it('refuses to unlink the last identity, unlinks one of two, 404s an unlinked provider', async () => {
    const counts = (mine: number, others: number): Answer => (q) => (q.startsWith('select count(*)') ? [{ mine, others }] : undefined);
    const del = { method: 'DELETE', headers: { origin: ORIGIN }, cookies: [sid] };
    const last = world(counts(1, 0));
    const refused = await last.call('/api/v1/me/identities/discord', del);
    expect(refused.status).toBe(409);
    expect(last.has('delete from identities')).toBe(false);
    expect(last.at('for update')).toBeLessThan(last.at('select count(*)'));

    const two = world(counts(1, 1));
    const unlinked = await two.call('/api/v1/me/identities/discord', del);
    expect(unlinked.status).toBe(204);
    expect(two.has(`delete from identities where user_id = ? and provider = ? ["${ME}","discord"]`)).toBe(true);
    expect(two.has('"identity.unlink"')).toBe(true);
    // Every session goes (one may have come through the removed method); this browser gets a new one.
    expect(two.at('delete from identities')).toBeLessThan(two.at(`delete from sessions where user_id = ? returning id_hash ["${ME}"]`));
    expect(two.at('delete from sessions where user_id')).toBeLessThan(two.at('insert into sessions'));
    expect(cookies(unlinked)).toEqual([expect.stringMatching(/^__Host-fs_sid=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/)]);
    expect(last.has('delete from sessions')).toBe(false);

    expect((await world(counts(0, 1)).call('/api/v1/me/identities/battlenet', del)).status).toBe(404);
  });

  it('grants and revokes Loothing, audit-logging only real changes', async () => {
    const on = world((q) => (q.startsWith('insert into integration_grants') ? [{}] : undefined));
    expect((await on.call('/api/v1/me/integrations/loothing', { method: 'PUT', headers: { origin: ORIGIN }, cookies: [sid] })).status).toBe(204);
    expect(on.has('"integration.grant"')).toBe(true);
    const off = world();
    expect((await off.call('/api/v1/me/integrations/loothing', { method: 'DELETE', headers: { origin: ORIGIN }, cookies: [sid] })).status).toBe(204);
    expect(off.has('delete from integration_grants')).toBe(true);
    expect(off.has('insert into audit_log')).toBe(false);
  });
});

describe('deleteAccount', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_x', R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' };
  const account = (pending = false): Answer => (q) => q.startsWith('update users set suspended_at') ? [{ stripe_customer_id: 'cus_1' }]
    : q.startsWith("select 1 from audit_log") ? (pending ? [{}] : [])
    : q.startsWith('delete from sessions') ? [{ id_hash: 'h1' }]
    : q.startsWith('select id from shares') ? [{ id: 'AbCdEfGhIj' }]
    : q.startsWith('select id from compute_jobs') ? [{ id: 'job-1' }]
    : q.startsWith('select stripe_customer_id from users') ? [{ stripe_customer_id: 'cus_1' }] : undefined;

  it('locks, then Stripe, then R2, then the row', async () => {
    const w = world(account(), { env });
    expect(await deleteAccount(w.app, ME, `user:${ME}`)).toBe('deleted');
    const order = [
      w.at('update users set suspended_at'),
      w.at('"account.delete-started"'),
      w.at('update shares set revoked_at'),
      w.at('delete from sessions where user_id'),
      w.at('fetch DELETE https://api.stripe.com/v1/customers/cus_1'),
      w.at('fetch DELETE https://acct.r2.cloudflarestorage.com/frostsim-data/shares/AbCdEfGhIj.json.gz'),
      w.at('fetch DELETE https://acct.r2.cloudflarestorage.com/frostsim-data/results/job-1.json.gz'),
      w.at('delete from users'),
      w.at('"account.deleted"'),
    ];
    const [lock, started, revoke, sessions, customer, share, result, row, deleted] = order;
    const increasing = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));
    // The two R2 DELETEs run in one parallel batch: only their place between Stripe and the row matters.
    expect(increasing([lock, started, revoke, sessions, customer, Math.min(share, result)])).toBe(true);
    expect(increasing([Math.max(share, result), row, deleted])).toBe(true);
    expect(w.has(`"account.deleted",{"userId":"${ME}","stripe":"deleted","r2":"deleted","r2Objects":2}`)).toBe(true);
  });

  it('stays locked and pending when Stripe fails, touching neither R2 nor the row; a retry finishes it', async () => {
    const failing = world(account(), { env, upstream: (r) => (new URL(r.url).host === 'api.stripe.com'
      ? Response.json({ error: { type: 'api_error', message: 'secret detail' } }, { status: 500 }) : upstream(r)) });
    expect(await deleteAccount(failing.app, ME, `user:${ME}`)).toBe('pending');
    expect(failing.has('update users set suspended_at')).toBe(true);
    expect(failing.has('r2.cloudflarestorage.com')).toBe(false);
    expect(failing.has('delete from users')).toBe(false);
    expect(failing.logs.join('\n')).not.toContain('secret detail');

    // Stripe already deleted it (404), and the marker exists, so no second started row.
    const retry = world(account(true), { env, upstream: (r) => (new URL(r.url).host === 'api.stripe.com'
      ? Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 }) : upstream(r)) });
    expect(await deleteAccount(retry.app, ME, 'system')).toBe('deleted');
    expect(retry.has('"account.delete-started"')).toBe(false);
    expect(retry.has('delete from users')).toBe(true);
  });

  it('stays pending when R2 fails, keeping the row that indexes the objects', async () => {
    const w = world(account(), { env, upstream: (r) => (r.url.includes('r2.cloudflarestorage.com') ? new Response(null, { status: 500 }) : upstream(r)) });
    expect(await deleteAccount(w.app, ME, `user:${ME}`)).toBe('pending');
    expect(w.has('fetch DELETE https://api.stripe.com')).toBe(true);
    expect(w.has('delete from users')).toBe(false);
  });

  it('stays pending while Stripe or R2 is unconfigured and still has something to delete: the row is the only pointer', async () => {
    const noStripe = world(account(), { env: { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' } });
    expect(await deleteAccount(noStripe.app, ME, `user:${ME}`)).toBe('pending');
    expect(noStripe.has('delete from users')).toBe(false);
    expect(noStripe.has('r2.cloudflarestorage.com')).toBe(false);
    expect(noStripe.logs.join('\n')).toContain('Billing is not configured');

    const noR2 = world(account(), { env: { STRIPE_SECRET_KEY: 'sk_test_x' } });
    expect(await deleteAccount(noR2.app, ME, `user:${ME}`)).toBe('pending');
    expect(noR2.has('fetch DELETE https://api.stripe.com/v1/customers/cus_1')).toBe(true);
    expect(noR2.has('delete from users')).toBe(false);

    // Nothing in Stripe or R2: neither is needed.
    const bare = world((q, v) => q.startsWith('update users set suspended_at') || q.startsWith('select stripe_customer_id from users')
      ? [{ stripe_customer_id: null }] : q.startsWith('select id from') ? [] : account()(q, v));
    expect(await deleteAccount(bare.app, ME, `user:${ME}`)).toBe('deleted');
    expect(bare.has('fetch')).toBe(false);
    expect(bare.has('"stripe":"none","r2":"none","r2Objects":0')).toBe(true);
  });

  it('stays pending when a customer or share appeared after the lock, so the retry removes it', async () => {
    const lateCustomer = world((q, v) => (q.startsWith('select stripe_customer_id from users') ? [{ stripe_customer_id: 'cus_2' }] : account()(q, v)), { env });
    expect(await deleteAccount(lateCustomer.app, ME, `user:${ME}`)).toBe('pending');
    expect(lateCustomer.at('select stripe_customer_id from users where id = ? for update')).toBeGreaterThan(-1);
    expect(lateCustomer.has('delete from users')).toBe(false);

    let shareReads = 0;
    const lateShare = world((q, v) => (q.startsWith('select id from shares')
      ? (++shareReads === 1 ? [{ id: 'AbCdEfGhIj' }] : [{ id: 'AbCdEfGhIj' }, { id: 'NewShare01' }]) : account()(q, v)), { env });
    expect(await deleteAccount(lateShare.app, ME, `user:${ME}`)).toBe('pending');
    expect(lateShare.has('delete from users')).toBe(false);
    expect(lateShare.logs.join('\n')).toContain('added during deletion');
  });

  it('reports a missing user without side effects beyond the lock query', async () => {
    const w = world();
    expect(await deleteAccount(w.app, ME, 'system')).toBe('not-found');
    expect(w.has('delete from')).toBe(false);
  });

  it('DELETE /me clears the cookie: 204 when done, 202 pending when a later step failed', async () => {
    const done = await world(account(), { env }).call('/api/v1/me', { method: 'DELETE', headers: { origin: ORIGIN }, cookies: [sid] });
    expect(done.status).toBe(204);
    expect(cookies(done)).toEqual(['__Host-fs_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
    const stuck = await world(account(), { env, upstream: () => new Response(null, { status: 500 }) })
      .call('/api/v1/me', { method: 'DELETE', headers: { origin: ORIGIN }, cookies: [sid] });
    expect(stuck.status).toBe(202);
    expect(await stuck.json()).toEqual({ pending: true });
    expect(cookies(stuck)).toEqual(['__Host-fs_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
  });

  it('the retry task resumes every locked account that carries the marker', async () => {
    const base = account(true);
    const w = world((q, v) => (q.startsWith('select u.id from users u') ? [{ id: ME }] : base(q, v)), { env });
    await userTasks[0].run(w.app);
    expect(w.has('delete from users')).toBe(true);
  });
});

describe('admin', () => {
  const target = (suspended: Date | null = null, pending = false): Answer => (q) =>
    q.startsWith('select role, suspended_at from users') ? [{ role: 'user', suspended_at: suspended }]
    : q.startsWith('select 1 from audit_log') ? (pending ? [{}] : [])
    : q.startsWith('select id, display_name, role, suspended_at') ? [{ id: OTHER, display_name: 'Other', role: 'user', suspended_at: suspended }]
    : undefined;
  const patch = (w: ReturnType<typeof world>, id: string, body: unknown) =>
    w.call(`/api/v1/admin/users/${id}`, { method: 'PATCH', headers: json, cookies: [sid], body: JSON.stringify(body) });

  it('refuses non-admins and signed-out callers', async () => {
    expect((await world(undefined, { role: 'user' }).call('/api/v1/admin/users', { cookies: [sid] })).status).toBe(403);
    expect((await world(undefined, { role: null }).call('/api/v1/admin/users')).status).toBe(401);
    const del = await world(undefined, { role: 'user' }).call(`/api/v1/admin/users/${OTHER}`, { method: 'DELETE', headers: { origin: ORIGIN }, cookies: [sid] });
    expect(del.status).toBe(403);
  });

  it('refuses self-demotion, self-suspension and self-deletion', async () => {
    const w = world(target(), { role: 'admin' });
    expect((await patch(w, ME, { role: 'user' })).status).toBe(403);
    expect((await patch(w, ME, { suspended: true })).status).toBe(403);
    expect((await w.call(`/api/v1/admin/users/${ME}`, { method: 'DELETE', headers: { origin: ORIGIN }, cookies: [sid] })).status).toBe(403);
    expect(w.has('update users')).toBe(false);
    expect(w.has('delete from users')).toBe(false);
    // Changing one's own comped allowance is fine.
    expect((await patch(w, ME, { compCoreSeconds: 60 })).status).toBe(200);
  });

  it('suspends another user: row first, then every session, audit-logged with the admin', async () => {
    const w = world(target(), { role: 'admin' });
    const res = await patch(w, OTHER, { suspended: true, compMaxThreads: 16 });
    expect(res.status).toBe(200);
    expect(w.at('update users set suspended_at')).toBeLessThan(w.at('delete from sessions where user_id'));
    expect(w.has(`"${OTHER}","admin:${ME}","admin.user.update",{"suspended":true,"compMaxThreads":16}`)).toBe(true);
    expect((await res.json()).user).toMatchObject({ id: OTHER, deletionPending: false });
  });

  it('refuses to unsuspend an account whose deletion is pending', async () => {
    const w = world(target(NOW, true), { role: 'admin' });
    const res = await patch(w, OTHER, { suspended: false });
    expect(res.status).toBe(409);
    expect(w.has('update users')).toBe(false);
  });

  it('404s an unknown user and validates the patch', async () => {
    const w = world(undefined, { role: 'admin' });
    expect((await patch(w, OTHER, { role: 'admin' })).status).toBe(404);
    expect((await patch(w, OTHER, { role: 'owner' })).status).toBe(400);
    for (const bad of [{}, [], { name: 'x' }, { suspended: 'yes' }, { compCoreSeconds: -1 }, { compCoreSeconds: 1.5 }, { compMaxThreads: 0 }, { compMaxThreads: 65 }]) {
      expect(() => parsePatch(bad)).toThrow();
    }
    expect(parsePatch({ compMaxThreads: null, compCoreSeconds: 0 })).toEqual({ compMaxThreads: null, compCoreSeconds: 0 });
  });

  it('searches by id, escaping LIKE wildcards in names', async () => {
    const w = world(undefined, { role: 'admin' });
    await w.call(`/api/v1/admin/users?q=${OTHER.toUpperCase()}`, { cookies: [sid] });
    expect(w.has(`["${OTHER.toUpperCase()}","${OTHER}","%${OTHER.toUpperCase()}%"`)).toBe(true);
    await w.call('/api/v1/admin/users?q=50%25_off', { cookies: [sid] });
    expect(w.has('["50%_off",null,"%50\\\\%\\\\_off%"')).toBe(true);
  });
});
