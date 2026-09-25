// Hosted shares (CLAUDE.md D15, DESIGN.md C10): entitlement, id format, upload checks, blob headers, revoke order, rate limits and the
// storeShare helper with a fake SQL and a fake R2; the 404 states, the upload/revoke race, retention and storeShare's personal-only
// entitlement against the local Postgres (gated on FROSTSIM_TEST_PG).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppCtx } from './app';
import { loadConfig } from './config';
import { connectDb, type Sql } from './db';
import { migrate } from './migrate';
import { createR2 } from './r2';
import type { Redis } from './redis';
import { createSession } from './session';
import { routes, storeShare, tasks } from './shares';
import { makePortable } from '../../src/lib/store/records';
import { DICTIONARY, decodeReport } from '../../src/lib/store/report-share';

const ORIGIN = 'https://sim.test';
const SID = 'a'.repeat(43);
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const config = loadConfig({
  FEATURES: 'shares', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: 's'.repeat(32),
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
});
const OBJECT = `/frostsim-data/shares/${ID}.json.gz`;

const portable = (payload: unknown, over: Record<string, unknown> = {}) => ({ ...makePortable('report', payload), ...over });
/** A real snapshot: the frozen version-one report link, decoded by the viewer's own codec. */
const SHARED = await decodeReport(
  readFileSync(new URL('../../tests/fixtures/shared-report-v1.txt', import.meta.url), 'utf8').trim(),
  JSON.parse(readFileSync(new URL(`../../public/share/${DICTIONARY}.json`, import.meta.url), 'utf8')) as string[],
);
const REPORT = portable({ shared: SHARED, rawReport: '{"sim":{}}' });
const gz = (value: unknown) => new Uint8Array(gzipSync(typeof value === 'string' ? value : JSON.stringify(value)));

/** R2 over a Map, answering GETs with headers that must never reach a viewer. `onPut` runs before a PUT is acknowledged. */
function fakeR2(onPut: (path: string) => Promise<void> = async () => {}) {
  const objects = new Map<string, Uint8Array>();
  const seen: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    seen.push(`${request.method} ${path} ${request.headers.get('content-type') ?? ''}`.trim());
    if (request.method === 'PUT') {
      objects.set(path, new Uint8Array(await request.arrayBuffer()));
      await onPut(path);
      return new Response(null, { status: 200 });
    }
    if (request.method === 'GET') {
      const object = objects.get(path);
      if (!object) return new Response(null, { status: 404 });
      return new Response(object as Uint8Array<ArrayBuffer>, {
        headers: { 'content-encoding': 'gzip', 'content-type': 'text/html', etag: '"e"', 'x-amz-meta-owner': 'u1' },
      });
    }
    if (request.method === 'DELETE') {
      objects.delete(path);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  }) as typeof fetch;
  return { objects, seen, fetchFn };
}

interface State {
  entitled: boolean; owned: { bytes: number | null } | null; stored: boolean; live: boolean; revocable: boolean;
  /** The users row storeShare reads; null when the account does not exist. */
  user: { suspended_at: Date | null } | null;
  /** Thrown by the next share insert, like a foreign-key violation from a racing account deletion. */
  insertError: Error | null;
}
type Call = { query: string; values: unknown[] };
const LIVE_ROW = { id: ID, title: 'Frost Mage', bytes: 42, created_at: new Date('2026-09-20T00:00:00Z'), expires_at: null };

/** Tagged-template stand-in for postgres.js that answers by query text. */
function fakeSql(state: State, calls: Call[]): Sql {
  const answer = (q: string): unknown[] => {
    if (q.includes('from sessions s join users')) {
      return [{ user_id: 'u1', role: 'user', display_name: 'Bob', suspended_at: null, expires_at: new Date(Date.now() + 3600_000), last_seen_at: new Date() }];
    }
    if (q.includes('from subscriptions')) {
      const period = { current_period_start: new Date(Date.now() - 86_400_000), current_period_end: new Date(Date.now() + 86_400_000) };
      return state.entitled ? [{ status: 'active', ...period, guild_id: null, items: [{ lookupKey: 'compute_s_monthly', quantity: 1 }] }] : [];
    }
    if (q.includes('comp_core_seconds')) return [{ core_seconds: 0, max_threads: null }];
    if (q.includes('select suspended_at from users')) return state.user ? [state.user] : [];
    if (q.includes('insert into shares') && state.insertError) throw state.insertError;
    if (q.includes('select bytes from shares')) return state.owned ? [state.owned] : [];
    if (q.includes('update shares set bytes')) return state.stored ? [{ id: ID }] : [];
    if (q.includes('from shares where id')) return state.live ? [LIVE_ROW] : [];
    if (q.includes('from shares where user_id')) return [LIVE_ROW];
    if (q.includes('update shares set revoked_at')) return state.revocable ? [{ id: ID }] : [];
    return [];
  };
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });
    try {
      return Promise.resolve(answer(query));
    } catch (err) {
      return Promise.reject(err);
    }
  }) as unknown as Sql;
}

/** Every rate-limit counter comes back far past its limit; the session cache calls it lacks fall back to SQL. */
const exhausted = { multi: () => ({ incr() { return this; }, expire() { return this; }, exec: async () => [[null, 1e9], [null, 1]] }) } as unknown as Redis;

function setup(over: Partial<State> = {}, redis: Redis | null = null) {
  const state: State = { entitled: true, owned: { bytes: null }, stored: true, live: true, revocable: true, user: { suspended_at: null }, insertError: null, ...over };
  const calls: Call[] = [];
  const r2 = fakeR2();
  const lines: string[] = [];
  const app: AppCtx = { config, sql: fakeSql(state, calls), redis, r2: createR2(config, r2.fetchFn), fetch: r2.fetchFn, now: () => new Date(), log: (l) => lines.push(l) };
  const handle = createApp(app, routes);
  const send = (method: string, path: string, init: { body?: BodyInit; type?: string; cookie?: boolean } = {}) => handle(new Request(ORIGIN + path, {
    method,
    headers: {
      ...(init.cookie === false ? {} : { cookie: `__Host-fs_sid=${SID}` }),
      origin: ORIGIN,
      ...(init.body === undefined ? {} : { 'content-type': init.type ?? 'application/json' }),
    },
    body: init.body,
  }), '10.0.0.1');
  const upload = (body: Uint8Array, type = 'application/gzip') => send('PUT', `/api/v1/shares/${ID}/blob`, { body: body as Uint8Array<ArrayBuffer>, type });
  return { state, calls, r2, lines, send, upload, app };
}

describe('hosted shares', () => {
  it('creates a share only for hostedShares, with a fresh 22-character base62 id', async () => {
    const { send, calls } = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const res = await send('POST', '/api/v1/shares', { body: JSON.stringify({ title: '  Frost Mage  ' }) });
      expect(res.status).toBe(201);
      ids.add(((await res.json()) as { id: string }).id);
    }
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(calls.find((c) => c.query.includes('insert into shares'))!.values.slice(1, 3)).toEqual(['u1', 'Frost Mage']);

    const free = setup({ entitled: false });
    const res = await free.send('POST', '/api/v1/shares', { body: JSON.stringify({ title: 'Frost Mage' }) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'not-entitled' });
    expect(free.calls.some((c) => c.query.includes('insert into'))).toBe(false);
  });

  it('refuses a missing, empty, long or control-character title', async () => {
    for (const body of [{}, { title: '  ' }, { title: 'x'.repeat(201) }, { title: 'a\nb' }, { title: 7 }]) {
      const { send, calls } = setup();
      expect((await send('POST', '/api/v1/shares', { body: JSON.stringify(body) })).status).toBe(400);
      expect(calls.some((c) => c.query.includes('insert into'))).toBe(false);
    }
  });

  it('stores a valid upload once, as application/gzip at shares/<id>.json.gz in the data bucket', async () => {
    const { upload, r2, calls } = setup();
    const bytes = gz(REPORT);
    expect((await upload(bytes)).status).toBe(204);
    expect(r2.seen).toEqual([`PUT ${OBJECT} application/gzip`]);
    expect(r2.objects.get(OBJECT)).toEqual(bytes);
    const update = calls.find((c) => c.query.includes('update shares set bytes'))!;
    expect(update.query).toContain('revoked_at is null');
    expect(update.values).toEqual([bytes.byteLength, ID, 'u1']);

    const again = setup({ owned: { bytes: 42 } });
    expect((await again.upload(bytes)).status).toBe(409);
    const stranger = setup({ owned: null });
    expect((await stranger.upload(bytes)).status).toBe(404);
    expect([...again.r2.seen, ...stranger.r2.seen]).toEqual([]);
  });

  it('refuses anything but a bounded gzip of a portable report, before storing it', async () => {
    const cases: [string, Uint8Array, string?][] = [
      ['not gzip', new TextEncoder().encode('hello')],
      ['empty', new Uint8Array(0)],
      ['gzip of text', gz('not json')],
      // A valid report padded past 32 MiB compresses to about 33 KB; maxOutputLength stops the inflate.
      ['gzip bomb', gz(portable({ shared: SHARED, rawReport: ' '.repeat(33 << 20) }))],
      ['wrong format', gz(portable(REPORT.payload, { format: 'other' }))],
      ['newer version', gz(portable(REPORT.payload, { version: 2 }))],
      ['character file', gz(portable(REPORT.payload, { kind: 'character' }))],
      ['no snapshot', gz(portable({ rawReport: null }))],
      ['snapshot of another version', gz(portable({ shared: { ...SHARED, v: 2 }, rawReport: null }))],
      // validateReport: the version tag alone is not a snapshot, and one bad field fails the whole one.
      ['bare snapshot tag', gz(portable({ shared: { v: 1, n: 'Name' }, rawReport: null }))],
      ['snapshot with negative dps', gz(portable({ shared: { ...SHARED, d: -1 }, rawReport: null }))],
      ['snapshot with an unknown gear slot', gz(portable({ shared: { ...SHARED, gear: [['bad', ...SHARED.gear[0].slice(1)]] }, rawReport: null }))],
      ['rawReport not text', gz(portable({ shared: SHARED, rawReport: { sim: {} } }))],
      ['array', gz([REPORT])],
      ['declared as json', gz(REPORT), 'application/json'],
    ];
    for (const [name, body, type] of cases) {
      const { upload, r2 } = setup();
      const res = await upload(body, type);
      expect([name, res.status]).toEqual([name, 400]);
      expect([name, r2.seen]).toEqual([name, []]);
    }
    const nullRaw = setup();
    expect((await nullRaw.upload(gz(portable({ shared: SHARED, rawReport: null })))).status).toBe(204);
  });

  it('removes its own object when the share was revoked while uploading', async () => {
    const { upload, r2 } = setup({ stored: false });
    expect((await upload(gz(REPORT))).status).toBe(404);
    expect(r2.seen).toEqual([`PUT ${OBJECT} application/gzip`, `DELETE ${OBJECT}`]);
    expect(r2.objects.size).toBe(0);
  });

  it('serves public metadata and the blob with only our headers, and 404s a share that is not live', async () => {
    const { send, upload } = setup();
    const bytes = gz(REPORT);
    await upload(bytes);
    const meta = await send('GET', `/api/v1/shares/${ID}`, { cookie: false });
    expect(await meta.json()).toEqual({ id: ID, title: 'Frost Mage', bytes: 42, createdAt: '2026-09-20T00:00:00.000Z', expiresAt: null });

    const blob = await send('GET', `/api/v1/shares/${ID}/blob`, { cookie: false });
    expect(blob.status).toBe(200);
    expect(Object.fromEntries(blob.headers)).toEqual({
      'content-type': 'application/gzip',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'attachment',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);

    const gone = setup({ live: false });
    for (const path of [`/api/v1/shares/${ID}`, `/api/v1/shares/${ID}/blob`]) {
      const res = await gone.send('GET', path, { cookie: false });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not-found', message: 'No such share.' });
    }
    expect(gone.r2.seen).toEqual([]);
    // A live row whose object is missing.
    expect((await setup().send('GET', `/api/v1/shares/${ID}/blob`, { cookie: false })).status).toBe(404);
  });

  it('lists only the caller\'s live shares', async () => {
    const { send, calls } = setup();
    const res = await send('GET', '/api/v1/shares');
    expect(await res.json()).toEqual({ shares: [{ id: ID, title: 'Frost Mage', bytes: 42, createdAt: '2026-09-20T00:00:00.000Z', expiresAt: null }] });
    const list = calls.find((c) => c.query.includes('from shares where user_id'))!;
    expect(list.query).toContain('revoked_at is null');
    expect(list.values[0]).toBe('u1');
  });

  it('revokes before removing the object and the row; only the owner, and a failed purge still answers 204', async () => {
    const { send, calls, r2 } = setup();
    expect((await send('DELETE', `/api/v1/shares/${ID}`)).status).toBe(204);
    const order = calls.map((c) => c.query).filter((q) => /update shares set revoked_at|delete from shares/.test(q));
    expect(order.map((q) => q.split(' ').slice(0, 3).join(' '))).toEqual(['update shares set', 'delete from shares']);
    expect(calls.find((c) => c.query.includes('set revoked_at'))!.values.slice(1)).toEqual([ID, 'u1']);
    expect(r2.seen).toEqual([`DELETE ${OBJECT}`]);

    expect((await setup({ revocable: false }).send('DELETE', `/api/v1/shares/${ID}`)).status).toBe(404);

    const failing = setup();
    const handle = createApp({
      config, sql: fakeSql(failing.state, []), redis: null, fetch,
      r2: createR2(config, (async () => new Response(null, { status: 500 })) as unknown as typeof fetch),
      now: () => new Date(), log: (l) => failing.lines.push(l),
    }, routes);
    const res = await handle(new Request(`${ORIGIN}/api/v1/shares/${ID}`, { method: 'DELETE', headers: { cookie: `__Host-fs_sid=${SID}`, origin: ORIGIN } }), '10.0.0.1');
    expect(res.status).toBe(204);
    expect(failing.lines).toEqual(['shares: purge after revoke failed (Error: R2 DELETE failed with status 500)']);
  });

  it('rate-limits writes per user and reads per IP, before the body or the database', async () => {
    const { send, upload, calls, r2 } = setup({}, exhausted);
    const answers = [
      await send('POST', '/api/v1/shares', { body: JSON.stringify({ title: 'x' }) }),
      await upload(gz(REPORT)),
      await send('GET', `/api/v1/shares/${ID}`, { cookie: false }),
      await send('GET', `/api/v1/shares/${ID}/blob`, { cookie: false }),
    ];
    expect(answers.map((r) => r.status)).toEqual([429, 429, 429, 429]);
    expect(calls.filter((c) => c.query.includes('shares'))).toEqual([]);
    expect(r2.seen).toEqual([]);
  });

  it('storeShare creates and uploads in one call: entitlement, validation, then row before object', async () => {
    const { app, calls, r2 } = setup();
    const bytes = gz(REPORT);
    const { id } = await storeShare(app, { userId: 'u1', title: '  Frost Mage  ', gzipBytes: bytes });
    expect(id).toMatch(/^[0-9A-Za-z]{22}$/);
    const object = `/frostsim-data/shares/${id}.json.gz`;
    expect(r2.seen).toEqual([`PUT ${object} application/gzip`]);
    expect(r2.objects.get(object)).toEqual(bytes);
    const at = (text: string) => calls.findIndex((c) => c.query.includes(text));
    expect(at('from subscriptions')).toBeGreaterThanOrEqual(0);
    expect(at('from subscriptions')).toBeLessThan(at('insert into shares'));
    expect(at('insert into shares')).toBeLessThan(at('update shares set bytes'));
    expect(calls[at('insert into shares')].values.slice(0, 3)).toEqual([id, 'u1', 'Frost Mage']);
    expect(calls[at('update shares set bytes')].values).toEqual([bytes.byteLength, id, 'u1']);
  });

  it('storeShare refuses what the routes refuse, before any row or object', async () => {
    const bytes = gz(REPORT);
    const cases: [string, Partial<State>, { title?: string; gzipBytes?: Uint8Array }, number, string][] = [
      ['suspended', { user: { suspended_at: new Date() } }, {}, 403, 'suspended'],
      ['no such account', { user: null }, {}, 404, 'not-found'],
      ['not entitled', { entitled: false }, {}, 402, 'not-entitled'],
      ['control character in title', {}, { title: 'a\nb' }, 400, 'invalid'],
      ['bare snapshot tag', {}, { gzipBytes: gz(portable({ shared: { v: 1 }, rawReport: null })) }, 400, 'invalid'],
      ['not gzip', {}, { gzipBytes: new TextEncoder().encode('hello') }, 400, 'invalid'],
      ['over 16 MiB', {}, { gzipBytes: new Uint8Array((16 << 20) + 1) }, 413, 'too-large'],
    ];
    for (const [name, state, input, status, code] of cases) {
      const { app, calls, r2 } = setup(state);
      const err = await storeShare(app, { userId: 'u1', title: 'Frost Mage', gzipBytes: bytes, ...input }).catch((e: unknown) => e);
      expect([name, err]).toMatchObject([name, { status, code }]);
      expect([name, calls.some((c) => c.query.includes('insert into'))]).toEqual([name, false]);
      expect([name, r2.seen]).toEqual([name, []]);
    }
  });

  it('answers 404, not 500, when the account is deleted between the checks and the insert', async () => {
    const fk = () => Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
    const direct = setup({ insertError: fk() });
    const err = await storeShare(direct.app, { userId: 'u1', title: 'Frost Mage', gzipBytes: gz(REPORT) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, code: 'not-found' });
    expect(direct.r2.seen).toEqual([]);
    const route = setup({ insertError: fk() });
    const res = await route.send('POST', '/api/v1/shares', { body: JSON.stringify({ title: 'x' }) });
    expect([res.status, (await res.json()).error]).toEqual([404, 'not-found']);
    // Any other database error is still a 500.
    const other = setup({ insertError: new Error('connection terminated') });
    expect((await other.send('POST', '/api/v1/shares', { body: JSON.stringify({ title: 'x' }) })).status).toBe(500);
  });

  it('storeShare removes its object and answers 404 when the row went away mid-store', async () => {
    const { app, r2 } = setup({ stored: false });
    const err = await storeShare(app, { userId: 'u1', title: 'Frost Mage', gzipBytes: gz(REPORT) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, code: 'not-found' });
    expect(r2.seen.map((s) => s.split(' ')[0])).toEqual(['PUT', 'DELETE']);
    expect(r2.objects.size).toBe(0);
  });

  it('needs a session for the owner routes and routes only 22-character ids', async () => {
    const { send } = setup();
    for (const [method, path] of [['GET', '/api/v1/shares'], ['POST', '/api/v1/shares'], ['PUT', `/api/v1/shares/${ID}/blob`], ['DELETE', `/api/v1/shares/${ID}`]]) {
      expect((await send(method, path, { cookie: false })).status).toBe(401);
    }
    for (const id of [ID.slice(1), `${ID}x`, `${ID.slice(1)}-`]) expect((await send('GET', `/api/v1/shares/${id}`)).status).toBe(404);
  });
});

const PG = process.env.FROSTSIM_TEST_PG;

describe.skipIf(!PG)('hosted shares postgres integration (needs FROSTSIM_TEST_PG)', () => {
  const schema = `t_shares_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;
  let app: AppCtx;
  let r2: ReturnType<typeof fakeR2>;
  let raceRevoke: string | null = null;
  const lines: string[] = [];

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('./migrations/', import.meta.url));
  });

  beforeEach(() => {
    // The race test revokes its share in R2's PUT window, after the upload's own checks and before it records the size.
    r2 = fakeR2(async (path) => {
      if (raceRevoke && path.endsWith(`/${raceRevoke}.json.gz`)) await sql`update shares set revoked_at = now() where id = ${raceRevoke}`;
    });
    app = { config, sql, redis: null, r2: createR2(config, r2.fetchFn), fetch: r2.fetchFn, now: () => new Date(), log: (l) => lines.push(l) };
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  /** A signed-in user, entitled to hosted shares when `entitled`, and a request helper carrying their cookie. */
  async function user(entitled: boolean) {
    const [row] = await sql`insert into users (display_name) values ('Sharer') returning id`;
    const sub = `sub_${randomBytes(6).toString('hex')}`;
    if (entitled) {
      await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items)
        values (${sub}, ${row.id}, 'active', ${new Date(Date.now() - 86_400_000)}, ${new Date(Date.now() + 86_400_000)},
          ${sql.json([{ lookupKey: 'compute_s_monthly', quantity: 1 }])})`;
    }
    const { cookie } = await createSession(app, row.id);
    const send = (method: string, path: string, init: { body?: BodyInit; type?: string } = {}) => createApp(app, routes)(new Request(ORIGIN + path, {
      method,
      headers: { cookie: cookie.split(';')[0], origin: ORIGIN, ...(init.body === undefined ? {} : { 'content-type': init.type ?? 'application/json' }) },
      body: init.body,
    }), '10.0.0.1');
    const create = async () => ((await (await send('POST', '/api/v1/shares', { body: JSON.stringify({ title: 'Frost Mage' }) })).json()) as { id: string }).id;
    const upload = (id: string, bytes = gz(REPORT)) => send('PUT', `/api/v1/shares/${id}/blob`, { body: bytes as Uint8Array<ArrayBuffer>, type: 'application/gzip' });
    return { id: row.id as string, sub, send, create, upload };
  }
  const anonymous = (path: string) => createApp(app, routes)(new Request(ORIGIN + path), '10.0.0.9');
  const retention = () => tasks.find((t) => t.name === 'shares-retention')!.run(app);

  it('round-trips create, upload, public read and revoke', async () => {
    const u = await user(true);
    const id = await u.create();
    const bytes = gz(REPORT);
    expect((await u.upload(id, bytes)).status).toBe(204);
    expect((await u.upload(id, bytes)).status).toBe(409);

    const mine = (await (await u.send('GET', '/api/v1/shares')).json()) as { shares: { id: string; bytes: number }[] };
    expect(mine.shares).toEqual([{ id, title: 'Frost Mage', bytes: bytes.byteLength, createdAt: expect.any(String), expiresAt: null }]);
    expect(await (await anonymous(`/api/v1/shares/${id}`)).json()).toMatchObject({ id, title: 'Frost Mage', bytes: bytes.byteLength });
    expect(new Uint8Array(await (await anonymous(`/api/v1/shares/${id}/blob`)).arrayBuffer())).toEqual(bytes);

    const other = await user(true);
    expect((await other.send('DELETE', `/api/v1/shares/${id}`)).status).toBe(404);
    expect((await other.upload(id)).status).toBe(404);
    expect((await u.send('DELETE', `/api/v1/shares/${id}`)).status).toBe(204);
    expect((await anonymous(`/api/v1/shares/${id}`)).status).toBe(404);
    expect((await anonymous(`/api/v1/shares/${id}/blob`)).status).toBe(404);
    expect(r2.objects.size).toBe(0);
    expect(await sql`select id from shares where id = ${id}`).toEqual([]);
  });

  it('refuses to create without hostedShares', async () => {
    const u = await user(false);
    expect((await u.send('POST', '/api/v1/shares', { body: JSON.stringify({ title: 'x' }) })).status).toBe(402);
  });

  it('answers one 404 for missing, never-uploaded, revoked and expired shares', async () => {
    const u = await user(true);
    const [pending, revoked, expired] = [await u.create(), await u.create(), await u.create()];
    await u.upload(revoked);
    await u.upload(expired);
    await sql`update shares set revoked_at = now() where id = ${revoked}`;
    await sql`update shares set expires_at = now() - interval '1 second' where id = ${expired}`;
    const bodies = new Set<string>();
    for (const id of ['0000000000000000000000', pending, revoked, expired]) {
      for (const path of [`/api/v1/shares/${id}`, `/api/v1/shares/${id}/blob`]) {
        const res = await anonymous(path);
        expect(res.status).toBe(404);
        bodies.add(await res.text());
      }
    }
    expect(bodies.size).toBe(1);
    expect((await u.upload(expired)).status).toBe(404);
  });

  it('removes the object of an upload whose share was revoked mid-upload', async () => {
    const u = await user(true);
    const id = await u.create();
    raceRevoke = id;
    try {
      expect((await u.upload(id)).status).toBe(404);
    } finally {
      raceRevoke = null;
    }
    expect(r2.seen.filter((s) => s.includes(id)).map((s) => s.split(' ')[0])).toEqual(['PUT', 'DELETE']);
    expect(r2.objects.size).toBe(0);
    const [row] = await sql`select bytes, revoked_at from shares where id = ${id}`;
    expect(row.bytes).toBeNull();
    expect(row.revoked_at).not.toBeNull();
  });

  it('storeShare hosts for a user with personal hostedShares, and not for one whose only plan is a guild pool', async () => {
    const u = await user(true);
    const bytes = gz(REPORT);
    const { id } = await storeShare(app, { userId: u.id, title: 'Discord sim', gzipBytes: bytes });
    expect(await (await anonymous(`/api/v1/shares/${id}`)).json()).toMatchObject({ id, title: 'Discord sim', bytes: bytes.byteLength });
    expect(new Uint8Array(await (await anonymous(`/api/v1/shares/${id}/blob`)).arrayBuffer())).toEqual(bytes);
    // An ordinary share afterwards: listed for its owner and revocable over HTTP.
    expect(((await (await u.send('GET', '/api/v1/shares')).json()) as { shares: { id: string }[] }).shares.map((s) => s.id)).toEqual([id]);
    expect((await u.send('DELETE', `/api/v1/shares/${id}`)).status).toBe(204);

    const payer = await user(false);
    await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items, guild_id)
      values (${`sub_${randomBytes(6).toString('hex')}`}, ${payer.id}, 'active', ${new Date(Date.now() - 86_400_000)},
        ${new Date(Date.now() + 86_400_000)}, ${sql.json([{ lookupKey: 'discord_guild_monthly', quantity: 1 }])}, '123456789012345678')`;
    const err = await storeShare(app, { userId: payer.id, title: 'Discord sim', gzipBytes: bytes }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 402, code: 'not-entitled' });
    expect(await sql`select id from shares where user_id = ${payer.id}`).toEqual([]);

    // Suspended (the bot has no session to refuse it) or gone: refused before anything is stored.
    const suspended = await user(true);
    await sql`update users set suspended_at = now() where id = ${suspended.id}`;
    const refusals = [
      await storeShare(app, { userId: suspended.id, title: 'Discord sim', gzipBytes: bytes }).catch((e: unknown) => e),
      await storeShare(app, { userId: '00000000-0000-4000-8000-000000000000', title: 'Discord sim', gzipBytes: bytes }).catch((e: unknown) => e),
    ];
    expect(refusals).toMatchObject([{ status: 403, code: 'suspended' }, { status: 404, code: 'not-found' }]);
    expect(await sql`select id from shares where user_id = ${suspended.id}`).toEqual([]);
  });

  it('retention: a lapse starts 30 days, resubscribing clears them, and dead shares lose object then row', async () => {
    // Retention sweeps the whole table; start from this test's rows only.
    await sql`delete from shares`;
    const u = await user(true);
    const [kept, fresh] = [await u.create(), await u.create()];
    await u.upload(kept);
    const stale = await u.create();
    await sql`update shares set created_at = now() - interval '2 days' where id = ${stale}`;

    await retention();
    // Sorted in JS: the database collation orders mixed-case ids differently.
    expect((await sql`select id from shares where user_id = ${u.id}`).map((r) => r.id).sort()).toEqual([kept, fresh].sort());
    expect((await sql`select expires_at from shares where id = ${kept}`)[0].expires_at).toBeNull();

    await sql`update subscriptions set status = 'canceled' where stripe_subscription_id = ${u.sub}`;
    const before = Date.now();
    await retention();
    const [{ expires_at: lapse }] = await sql`select expires_at from shares where id = ${kept}`;
    expect(lapse.getTime()).toBeGreaterThanOrEqual(before + 30 * 86_400_000 - 1000);
    expect(lapse.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 1000);
    // An hour later the lapse is still the one first seen.
    await tasks.find((t) => t.name === 'shares-retention')!.run({ ...app, now: () => new Date(Date.now() + 3_600_000) });
    expect((await sql`select expires_at from shares where id = ${kept}`)[0].expires_at).toEqual(lapse);

    await sql`update subscriptions set status = 'active' where stripe_subscription_id = ${u.sub}`;
    await retention();
    expect((await sql`select expires_at from shares where id = ${kept}`)[0].expires_at).toBeNull();

    await sql`update subscriptions set status = 'canceled' where stripe_subscription_id = ${u.sub}`;
    await retention();
    await sql`update shares set expires_at = now() - interval '1 second' where id = ${kept}`;
    await retention();
    expect((await sql`select id from shares where user_id = ${u.id}`).map((r) => r.id)).toEqual([fresh]);
    expect(r2.seen.filter((s) => s.startsWith('DELETE')).map((s) => s.split('/').at(-1))).toEqual([`${stale}.json.gz`, `${kept}.json.gz`]);
    expect(r2.objects.size).toBe(0);
  });
});
