// Account-server HTTP layer (CLAUDE.md D15, DESIGN.md C2): routing, feature gates, body caps, CSRF, auth, errors, headers, node adapter. Fakes only.

import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps, type Route } from './app';
import { loadConfig } from './config';
import type { Sql } from './db';
import { HttpError, clientIp, errorSummary, json, nodeHandler, readCookie } from './http';
import { createR2 } from './r2';

const ORIGIN = 'https://sim.test';
const SID = 'a'.repeat(43);

/** Tagged-template stand-in for postgres.js: answers from `rows(queryText)`. */
function fakeSql(rows: (query: string) => unknown[] = () => []): Sql {
  return ((strings: TemplateStringsArray) => Promise.resolve(rows(strings.join('?')))) as unknown as Sql;
}

function sessionRows(role: 'user' | 'admin') {
  return (query: string) => query.includes('from sessions s join users')
    ? [{ user_id: 'u1', role, display_name: 'Bob', suspended_at: null, expires_at: new Date(Date.now() + 3600_000), last_seen_at: new Date() }]
    : [];
}

function deps(over: Partial<AppDeps> = {}, env: Record<string, string> = {}): AppDeps {
  const config = loadConfig({
    FEATURES: 'accounts,billing,shares',
    PUBLIC_ORIGIN: ORIGIN,
    DATABASE_URL: 'postgres://unused',
    SESSION_SECRET: 's'.repeat(32),
    R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
    ...env,
  });
  return { config, sql: fakeSql(), redis: null, r2: createR2(config, fetch), fetch, now: () => new Date(), log: () => {}, ...over };
}

const handled = vi.fn();
let pollStarted = () => {};
let pollAborted = () => {};
const routes: Route[] = [
  { method: 'GET', path: /^\/api\/v1\/global$/g, feature: 'accounts', auth: 'public', handler: () => json({}) },
  { method: 'GET', path: /^\/api\/v1\/poll$/, feature: 'accounts', auth: 'public',
    handler: (ctx) => new Promise<Response>((resolve) => {
      ctx.request.signal.addEventListener('abort', () => {
        pollAborted();
        resolve(json({}));
      });
      pollStarted();
    }) },
  { method: 'GET', path: /^\/api\/v1\/echo\/(?<id>[a-z]+)$/, feature: 'accounts', auth: 'public',
    handler: (ctx) => json({ id: ctx.params.id, ip: ctx.ip, href: ctx.url.href }) },
  { method: 'GET', path: /\/api\/v1\/loose/, feature: 'accounts', auth: 'public', handler: () => json({}) },
  { method: 'POST', path: /^\/api\/v1\/upload$/, feature: 'accounts', auth: 'public', maxBody: 8,
    handler: async (ctx) => {
      handled();
      return json({ bytes: (await ctx.body()).byteLength });
    } },
  { method: 'POST', path: /^\/api\/v1\/me$/, feature: 'accounts', auth: 'session',
    handler: async (ctx) => json({ user: ctx.session!.userId, body: await ctx.json() }) },
  { method: 'PUT', path: /^\/api\/v1\/blob$/, feature: 'shares', auth: 'session', bodyType: 'application/gzip',
    handler: () => new Response(null, { status: 204 }) },
  { method: 'DELETE', path: /^\/api\/v1\/me$/, feature: 'accounts', auth: 'session', handler: () => new Response(null, { status: 204 }) },
  { method: 'GET', path: /^\/api\/v1\/admin$/, feature: 'accounts', auth: 'admin', handler: () => json({}) },
  { method: 'GET', path: /^\/api\/v1\/pay$/, feature: 'billing', auth: 'public', handler: () => json({}) },
  { method: 'GET', path: /^\/api\/v1\/run$/, feature: 'compute', auth: 'public', handler: () => json({}) },
  { method: 'GET', path: /^\/api\/v1\/bot$/, feature: 'discord', auth: 'public', handler: () => json({}) },
  { method: 'POST', path: /^\/api\/v1\/claim$/, feature: 'accounts', auth: 'worker', handler: () => json({}) },
  { method: 'POST', path: /^\/api\/v1\/loothing$/, feature: 'accounts', auth: 'loothing', handler: () => json({}) },
  { method: 'GET', path: /^\/api\/v1\/cookies$/, feature: 'accounts', auth: 'public',
    handler: () => {
      const headers = new Headers({ 'cache-control': 'private, max-age=60' });
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      return new Response('ok', { headers });
    } },
  { method: 'GET', path: /^\/api\/v1\/conflict$/, feature: 'accounts', auth: 'public',
    handler: () => { throw new HttpError(409, 'conflict', 'Already there.'); } },
  { method: 'GET', path: /^\/api\/v1\/boom$/, feature: 'accounts', auth: 'public',
    handler: () => { throw new Error('upstream said https://api.test/x?token=hunter2'); } },
];

const call = (d: AppDeps, path: string, init: RequestInit = {}) => createApp(d, routes)(new Request(ORIGIN + path, init), '10.0.0.1');
const body = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

describe('routing', () => {
  it('matches method and whole path, exposing named groups', async () => {
    const res = await call(deps(), '/api/v1/echo/abc');
    expect(await body(res)).toEqual({ id: 'abc', ip: '10.0.0.1', href: `${ORIGIN}/api/v1/echo/abc` });
    expect((await call(deps(), '/api/v1/echo/abc', { method: 'DELETE' })).status).toBe(404);
    expect(await body(await call(deps(), '/api/v1/nothing'))).toEqual({ error: 'not-found', message: 'No such endpoint.' });
  });

  it('refuses a route regex that matches only part of the path', async () => {
    expect((await call(deps(), '/api/v1/loose/extra')).status).toBe(404);
    expect((await call(deps(), '/api/v1/loose')).status).toBe(200);
  });

  it('matches a /g route on every request, not every other one', async () => {
    const d = deps();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call(d, '/api/v1/global')).status);
    expect(statuses).toEqual([200, 200, 200]);
  });

  it('answers health with states only, even with every feature off', async () => {
    const res = await call(deps({ sql: null }, { FEATURES: '' }), '/api/v1/health');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, features: [], db: 'off', redis: 'off' });
    const on = await body(await call(deps(), '/api/v1/health'));
    expect(on).toEqual({ ok: true, features: ['accounts', 'billing', 'shares'], db: 'ok', redis: 'off' });
    const down = await call(deps({ sql: (() => Promise.reject(new Error('down'))) as unknown as Sql }), '/api/v1/health');
    expect(down.status).toBe(503);
  });

  it('shares health probes for 5 s, so a flood of health checks cannot hold the database pool', async () => {
    let clock = Date.parse('2026-09-24T00:00:00Z');
    let queries = 0;
    const d = deps({ now: () => new Date(clock), sql: (() => { queries++; return Promise.resolve([]) }) as unknown as Sql });
    for (let i = 0; i < 20; i++) expect((await call(d, '/api/v1/health')).status).toBe(200);
    expect(queries).toBe(1);
    clock += 5000;
    await call(d, '/api/v1/health');
    expect(queries).toBe(2);
  });
});

describe('feature gates', () => {
  it('404s a disabled feature, 503s disabled compute, 503s an enabled feature without credentials or database', async () => {
    expect(await body(await call(deps(), '/api/v1/bot'))).toMatchObject({ error: 'feature-off' });
    const compute = await call(deps(), '/api/v1/run');
    expect([compute.status, (await body(compute)).error]).toEqual([503, 'compute-disabled']);
    const billing = await call(deps(), '/api/v1/pay');
    expect([billing.status, (await body(billing)).error]).toEqual([503, 'unconfigured']);
    const paid = await call(deps({}, { STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh' }), '/api/v1/pay');
    expect(paid.status).toBe(200);
    expect((await call(deps({ sql: null }), '/api/v1/echo/abc')).status).toBe(503);
  });
});

describe('body caps', () => {
  it('reads a body up to the cap and refuses one past it while streaming', async () => {
    expect(await body(await call(deps(), '/api/v1/upload', { method: 'POST', body: '12345678' }))).toEqual({ bytes: 8 });
    const over = await call(deps(), '/api/v1/upload', { method: 'POST', body: '123456789' });
    expect([over.status, (await body(over)).error]).toEqual([413, 'too-large']);
  });

  it('refuses a declared oversize body before the handler runs', async () => {
    handled.mockClear();
    const res = await call(deps(), '/api/v1/upload', { method: 'POST', body: '1', headers: { 'content-length': '100' } });
    expect(res.status).toBe(413);
    expect(handled).not.toHaveBeenCalled();
  });
});

describe('csrf and auth', () => {
  const post = (headers: Record<string, string>, data = '{"a":1}') => ({ method: 'POST', body: data, headers });
  const signedIn = (role: 'user' | 'admin' = 'user') => deps({ sql: fakeSql(sessionRows(role)) });

  it('requires the exact public Origin on cookie-authenticated state changes', async () => {
    const none = await call(signedIn(), '/api/v1/me', post({ 'content-type': 'application/json' }));
    expect([none.status, (await body(none)).error]).toEqual([403, 'bad-origin']);
    const other = await call(signedIn(), '/api/v1/me', post({ origin: 'https://evil.test', 'content-type': 'application/json' }));
    expect(other.status).toBe(403);
    const sub = await call(signedIn(), '/api/v1/me', post({ origin: `${ORIGIN}.evil.test`, 'content-type': 'application/json' }));
    expect(sub.status).toBe(403);
  });

  it('requires the declared body type, and none for a bodiless request', async () => {
    const form = await call(signedIn(), '/api/v1/me', post({ origin: ORIGIN, 'content-type': 'text/plain', cookie: `__Host-fs_sid=${SID}` }));
    expect([form.status, (await body(form)).error]).toEqual([400, 'invalid']);
    const gzip = { method: 'PUT', body: new Uint8Array([31, 139]), headers: { origin: ORIGIN, cookie: `__Host-fs_sid=${SID}` } };
    expect((await call(signedIn(), '/api/v1/blob', { ...gzip, headers: { ...gzip.headers, 'content-type': 'application/gzip' } })).status).toBe(204);
    expect((await call(signedIn(), '/api/v1/blob', { ...gzip, headers: { ...gzip.headers, 'content-type': 'application/json' } })).status).toBe(400);
    const del = await call(signedIn(), '/api/v1/me', { method: 'DELETE', headers: { origin: ORIGIN, cookie: `__Host-fs_sid=${SID}` } });
    expect(del.status).toBe(204);
  });

  it('401s without a session and runs the handler with one', async () => {
    const headers = { origin: ORIGIN, 'content-type': 'application/json; charset=utf-8' };
    const out = await call(signedIn(), '/api/v1/me', post(headers));
    expect([out.status, (await body(out)).error]).toEqual([401, 'signed-out']);
    const ok = await call(signedIn(), '/api/v1/me', post({ ...headers, cookie: `x=1; __Host-fs_sid=${SID}` }));
    expect(await body(ok)).toEqual({ user: 'u1', body: { a: 1 } });
    const bad = await call(signedIn(), '/api/v1/me', post({ ...headers, cookie: `__Host-fs_sid=${SID}` }, '{nope'));
    expect([bad.status, (await body(bad)).error]).toEqual([400, 'invalid']);
  });

  it('keeps admin routes to admins and public POSTs free of the Origin rule', async () => {
    const cookie = { cookie: `__Host-fs_sid=${SID}` };
    expect((await call(signedIn('user'), '/api/v1/admin', { headers: cookie })).status).toBe(403);
    expect((await call(signedIn('admin'), '/api/v1/admin', { headers: cookie })).status).toBe(200);
    expect((await call(deps(), '/api/v1/upload', { method: 'POST', body: '1' })).status).toBe(200);
  });

  it('refuses worker and loothing callers with a bad bearer token', async () => {
    expect((await call(deps(), '/api/v1/claim', { method: 'POST', headers: { authorization: 'Bearer t' } })).status).toBe(401);
    expect((await call(deps(), '/api/v1/loothing', { method: 'POST', headers: { authorization: 'Bearer t' } })).status).toBe(401);
  });
});

describe('errors and headers', () => {
  it('cuts URLs of any scheme out of log summaries', () => {
    const err = new Error('connect postgres://frostsim:hunter2@127.0.0.1:5433/db and REDIS://u:hunter2@h:6379 failed');
    expect(errorSummary(err)).toBe('Error: connect <url> and <url> failed');
  });

  it('maps HttpError to its status and anything else to a 500 that logs no URL', async () => {
    expect(await body(await call(deps(), '/api/v1/conflict'))).toEqual({ error: 'conflict', message: 'Already there.' });
    const lines: string[] = [];
    const res = await call(deps({ log: (l) => lines.push(l) }), '/api/v1/boom');
    expect([res.status, await body(res)]).toEqual([500, { error: 'internal', message: 'Request failed.' }]);
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(lines.join('\n')).toContain('<url>');
  });

  it('adds no-store and nosniff, keeps a handler cache policy and every Set-Cookie', async () => {
    const plain = await call(deps(), '/api/v1/echo/abc');
    expect(plain.headers.get('cache-control')).toBe('no-store');
    expect(plain.headers.get('x-content-type-options')).toBe('nosniff');
    const cookies = await call(deps(), '/api/v1/cookies');
    expect(cookies.headers.get('cache-control')).toBe('private, max-age=60');
    expect(cookies.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });
});

describe('node adapter', () => {
  let server: Server;
  let base = '';
  const lines: string[] = [];
  beforeAll(async () => {
    server = createServer(nodeHandler(ORIGIN, createApp(deps(), routes), (l) => lines.push(l)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('sends every Set-Cookie and streams the body', async () => {
    const res = await fetch(`${base}/api/v1/cookies`);
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await res.text()).toBe('ok');
  });

  it('builds URLs on PUBLIC_ORIGIN whatever the Host header says', async () => {
    const res = await fetch(`${base}/api/v1/echo/abc`, { headers: { host: 'evil.test', 'x-forwarded-for': '203.0.113.9, 10.0.0.2' } });
    expect(await res.json()).toEqual({ id: 'abc', ip: '203.0.113.9', href: `${ORIGIN}/api/v1/echo/abc` });
  });

  it('reads request bodies and 413s past the cap', async () => {
    expect(await (await fetch(`${base}/api/v1/upload`, { method: 'POST', body: '1234' })).json()).toEqual({ bytes: 4 });
    expect((await fetch(`${base}/api/v1/upload`, { method: 'POST', body: 'x'.repeat(10_000) })).status).toBe(413);
  });

  /** fetch cannot send a GET body or a TRACE, so these go through node:http. */
  const raw = (method: string, path: string, data?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers: data ? { 'content-length': String(data.length) } : {} }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(data);
  });

  it('ignores a GET body and refuses TRACE with 400, logging neither', async () => {
    lines.length = 0;
    expect((await raw('GET', '/api/v1/echo/abc', 'abc')).status).toBe(200);
    expect(await raw('TRACE', '/api/v1/health')).toEqual({ status: 400, body: JSON.stringify({ error: 'invalid', message: 'Request refused.' }) });
    expect(lines).toEqual([]);
  });

  it('aborts request.signal when the client hangs up, and logs nothing for the dead response', async () => {
    lines.length = 0;
    const started = new Promise<void>((resolve) => (pollStarted = resolve));
    const aborted = new Promise<void>((resolve) => (pollAborted = resolve));
    const req = httpRequest(`${base}/api/v1/poll`);
    req.on('error', () => {});
    req.end();
    await started;
    req.destroy();
    await aborted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lines).toEqual([]);
  });
});

describe('helpers', () => {
  it('reads one cookie by exact name', () => {
    const request = new Request(ORIGIN, { headers: { cookie: 'a__Host-fs_sid=no; __Host-fs_sid=yes; b=2' } });
    expect(readCookie(request, '__Host-fs_sid')).toBe('yes');
    expect(readCookie(request, 'missing')).toBeNull();
  });

  it('prefers CF-Connecting-IP, then the first forwarded hop, then the socket', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }), '3.3.3.3')).toBe('1.1.1.1');
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 2.2.2.2 , 4.4.4.4' }), '3.3.3.3')).toBe('2.2.2.2');
    expect(clientIp(new Headers(), '3.3.3.3')).toBe('3.3.3.3');
  });

  it('skips anything that is not an IP address, so a header cannot mint rate-limit keys', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': 'x'.repeat(8000), 'x-forwarded-for': 'junk' }), '3.3.3.3')).toBe('3.3.3.3');
    expect(clientIp(new Headers({ 'cf-connecting-ip': '1.1.1.1:80' }), 'nope')).toBe('unknown');
  });

  it('keys IPv6 on its /64 and unwraps IPv4-mapped addresses', () => {
    const ip = (v: string) => clientIp(new Headers({ 'cf-connecting-ip': v }), '');
    expect(ip('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(ip('2001:DB8:aa:bb:ffff::9')).toBe('2001:db8:aa:bb::/64');
    expect(ip('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ip('2001:db8:0:0::1')).toBe(ip('2001:0db8::2'));
    expect(ip('::1')).toBe('0:0:0:0::/64');
    expect(ip('1::2:3:4:5:6.7.8.9')).toBe('1:0:2:3::/64');
    expect(ip('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientIp(new Headers(), '::ffff:127.0.0.1')).toBe('127.0.0.1');
  });
});
