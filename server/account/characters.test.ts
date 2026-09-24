// Cloud character slots (CLAUDE.md D15, DESIGN.md C5): validation, parser cost bounds, rate limit, owner scoping and slot limits with a
// fake SQL, and the slot race and replace-by-id against the local Postgres (gated on FROSTSIM_TEST_PG).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { routes } from './characters';
import { loadConfig } from './config';
import { connectDb, type Sql } from './db';
import { migrate } from './migrate';
import { createR2 } from './r2';
import type { Redis } from './redis';
import { createSession } from './session';

const ORIGIN = 'https://sim.test';
const SID = 'a'.repeat(43);
const EXPORT = readFileSync(new URL('../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8');
const ID = '0b1e7a52-6a8c-4b0e-9b3e-5d7f1c2a9e40';
const config = loadConfig({
  FEATURES: 'shares', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: 's'.repeat(32),
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
});

interface State { slots: number; used: number; row: Record<string, unknown> | null }
type Call = { query: string; values: unknown[] };

/** Tagged-template stand-in for postgres.js that answers by query text; `begin` runs the callback on the same fake. */
function fakeSql(state: State, calls: Call[]): Sql {
  const period = { current_period_start: new Date(Date.now() - 86_400_000), current_period_end: new Date(Date.now() + 86_400_000) };
  const answer = (q: string): unknown[] => {
    if (q.includes('from sessions s join users')) {
      return [{ user_id: 'u1', role: 'user', display_name: 'Bob', suspended_at: null, expires_at: new Date(Date.now() + 3600_000), last_seen_at: new Date() }];
    }
    if (q.includes('from subscriptions')) {
      return state.slots ? [{ status: 'active', ...period, guild_id: null, items: [{ lookupKey: 'slots_5_monthly', quantity: state.slots / 5 }] }] : [];
    }
    if (q.includes('comp_core_seconds')) return [{ core_seconds: 0, max_threads: null }];
    if (q.includes('update cloud_characters')) return state.row ? [{ id: ID }] : [];
    if (q.includes('count(*)')) return [{ used: state.used }];
    if (q.includes('insert into cloud_characters')) return [{ id: ID }];
    if (q.includes('select id, label, bytes')) return [{ id: ID, label: 'Main', bytes: 10, updated_at: new Date('2026-09-20T00:00:00Z') }];
    if (q.includes('from cloud_characters') || q.includes('delete from cloud_characters')) return state.row ? [state.row] : [];
    return [];
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });
    return Promise.resolve(answer(query));
  }) as unknown as Sql;
  return Object.assign(sql, { begin: (fn: (tx: Sql) => unknown) => fn(sql) });
}

/** Answers every rate-limit counter with a count far past any limit; the session cache calls it lacks fall back to SQL. */
const exhausted = { multi: () => ({ incr() { return this; }, expire() { return this; }, exec: async () => [[null, 1e9], [null, 1]] }) } as unknown as Redis;

function setup(over: Partial<State> = {}, redis: Redis | null = null) {
  const state: State = { slots: 5, used: 0, row: null, ...over };
  const calls: Call[] = [];
  const handle = createApp({ config, sql: fakeSql(state, calls), redis, r2: createR2(config, fetch), fetch, now: () => new Date(), log: () => {} }, routes);
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => handle(new Request(ORIGIN + path, {
    method,
    headers: { cookie: `__Host-fs_sid=${SID}`, origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), '10.0.0.1');
  const wrote = () => calls.some((c) => /insert into|update cloud_characters/.test(c.query));
  return { state, calls, send, wrote };
}

describe('cloud characters', () => {
  it('lists characters without raw, with the slot count', async () => {
    const { send, calls } = setup({ slots: 10 });
    const res = await send('GET', '/api/v1/characters');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slots: 10, characters: [{ id: ID, label: 'Main', bytes: 10, updatedAt: '2026-09-20T00:00:00.000Z' }] });
    const list = calls.find((c) => c.query.includes('select id, label, bytes'))!;
    expect(list.query).not.toContain('raw');
    expect(list.values).toEqual(['u1']);
  });

  it('returns one character with raw, scoped to its owner, and 404s otherwise', async () => {
    const found = setup({ row: { id: ID, label: 'Main', raw: EXPORT, updated_at: new Date('2026-09-20T00:00:00Z') } });
    const res = await found.send('GET', `/api/v1/characters/${ID}`);
    expect(await res.json()).toEqual({ id: ID, label: 'Main', raw: EXPORT, updatedAt: '2026-09-20T00:00:00.000Z' });
    expect(found.calls.at(-1)).toMatchObject({ values: [ID, 'u1'] });
    expect(found.calls.at(-1)!.query).toContain('user_id = ?');
    expect((await setup().send('GET', `/api/v1/characters/${ID}`)).status).toBe(404);
  });

  it('creates with 201 under the user row lock, and never replaces a same-label character', async () => {
    const created = setup();
    const res = await created.send('POST', '/api/v1/characters', { label: '  Main  ', raw: EXPORT });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: ID });
    const insert = created.calls.find((c) => c.query.includes('insert into cloud_characters'))!;
    expect(insert.values.slice(0, 4)).toEqual(['u1', 'Main', EXPORT, Buffer.byteLength(EXPORT)]);
    expect(created.calls.some((c) => c.query.includes('for update'))).toBe(true);
    expect(created.calls.some((c) => c.query.includes('update cloud_characters'))).toBe(false);
  });

  it('replaces one character by id with PUT: owner only, no slot needed, same validation', async () => {
    const mine = setup({ row: { id: ID }, slots: 0, used: 3 });
    const res = await mine.send('PUT', `/api/v1/characters/${ID}`, { label: 'Alt', raw: EXPORT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID });
    const update = mine.calls.find((c) => c.query.includes('update cloud_characters'))!;
    expect(update.query).toContain('user_id = ?');
    expect(update.values).toEqual(['Alt', EXPORT, Buffer.byteLength(EXPORT), expect.any(Date), ID, 'u1']);
    expect(mine.calls.some((c) => c.query.includes('from subscriptions'))).toBe(false);

    expect((await setup().send('PUT', `/api/v1/characters/${ID}`, { label: 'Alt', raw: EXPORT })).status).toBe(404);
    const bad = setup({ row: { id: ID } });
    expect((await bad.send('PUT', `/api/v1/characters/${ID}`, { label: 'Alt', raw: 'hello world' })).status).toBe(400);
    expect(bad.wrote()).toBe(false);
  });

  it('refuses a new character with 402 no-slots when every slot is used, and on the free tier', async () => {
    for (const state of [{ slots: 5, used: 5 }, { slots: 0, used: 0 }]) {
      const { send, calls } = setup(state);
      const res = await send('POST', '/api/v1/characters', { label: 'Alt', raw: EXPORT });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'no-slots' });
      expect(calls.some((c) => c.query.includes('insert into'))).toBe(false);
    }
  });

  it('rejects invalid saves before touching the table', async () => {
    const cases: [unknown, number][] = [
      [{ raw: EXPORT }, 400],
      [{ label: '   ', raw: EXPORT }, 400],
      [{ label: 'x'.repeat(101), raw: EXPORT }, 400],
      [{ label: 'a\u0007b', raw: EXPORT }, 400],
      [{ label: 'Main' }, 400],
      [{ label: 'Main', raw: 42 }, 400],
      [{ label: 'Main', raw: 'hello world' }, 400],
      [{ label: 'Main', raw: `${EXPORT}\u0000` }, 400],
      // Passes looksLikeProfile (\s matches \r) but the parser finds no class line: an error diagnostic.
      [{ label: 'Main', raw: 'warlock\r=Name' }, 400],
      [{ label: 'Main', raw: `${EXPORT}\n${'#'.repeat(64 * 1024)}` }, 413],
      [{ label: 'Main', raw: `${EXPORT}\n# ${'x'.repeat(4095)}` }, 400],
      [[1, 2], 400],
      ['null', 400],
      ['{not json', 400],
    ];
    for (const [body, status] of cases) {
      const { send, wrote } = setup();
      const res = await send('POST', '/api/v1/characters', body);
      expect([JSON.stringify(body).slice(0, 40), res.status]).toEqual([JSON.stringify(body).slice(0, 40), status]);
      expect(wrote()).toBe(false);
    }
  });

  it('deletes only the owner\'s character: 204, else 404', async () => {
    const mine = setup({ row: { id: ID } });
    expect((await mine.send('DELETE', `/api/v1/characters/${ID}`)).status).toBe(204);
    expect(mine.calls.at(-1)).toMatchObject({ values: [ID, 'u1'] });
    expect((await setup().send('DELETE', `/api/v1/characters/${ID}`)).status).toBe(404);
  });

  it('bounds parser cost: over-long lines are refused, and blank-line runs no longer hide the class line', async () => {
    // One 65 KB comment line kept the parser's item-comment regex busy for about 1.9 s; the line cap refuses it unparsed.
    const long = setup();
    expect((await long.send('POST', '/api/v1/characters', { label: 'Main', raw: `warlock=x\n# a${' '.repeat(65400)}(1` })).status).toBe(400);
    expect(long.wrote()).toBe(false);
    // looksLikeProfile reads the first 4000 characters; 3990 blank lines there cost about 180 ms and hid the class line.
    expect((await setup().send('POST', '/api/v1/characters', { label: 'Main', raw: `${'\n'.repeat(3990)}${EXPORT}` })).status).toBe(201);
  });

  it('rate-limits saves per user before reading the body', async () => {
    const { send, wrote } = setup({ row: { id: ID } }, exhausted);
    for (const [method, path] of [['POST', '/api/v1/characters'], ['PUT', `/api/v1/characters/${ID}`]]) {
      const res = await send(method, path, { label: 'Main', raw: 'not an export' });
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: 'rate-limited' });
    }
    expect(wrote()).toBe(false);
  });

  it('needs a session and routes only uuid ids', async () => {
    const { send } = setup();
    for (const [method, path] of [['GET', '/api/v1/characters'], ['GET', `/api/v1/characters/${ID}`], ['PUT', `/api/v1/characters/${ID}`], ['DELETE', `/api/v1/characters/${ID}`]]) {
      expect((await send(method, path, undefined, { cookie: '' })).status).toBe(401);
    }
    expect((await send('GET', '/api/v1/characters/not-a-uuid')).status).toBe(404);
    expect((await send('GET', `/api/v1/characters/${ID.toUpperCase()}`)).status).toBe(404);
  });
});

const PG = process.env.FROSTSIM_TEST_PG;

describe.skipIf(!PG)('cloud characters postgres integration (needs FROSTSIM_TEST_PG)', () => {
  const schema = `t_characters_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;
  const log = () => {};

  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('./migrations/', import.meta.url));
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  /** A signed-in user holding `units` of slots_5_monthly, and a request helper carrying their cookie. */
  async function user(units: number) {
    const [row] = await sql`insert into users (display_name) values ('Slots') returning id`;
    if (units) {
      await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items)
        values (${`sub_${randomBytes(6).toString('hex')}`}, ${row.id}, 'active', ${new Date(Date.now() - 86_400_000)},
          ${new Date(Date.now() + 86_400_000)}, ${sql.json([{ lookupKey: 'slots_5_monthly', quantity: units }])})`;
    }
    const deps = { config, sql, redis: null, log, now: () => new Date() };
    const { cookie } = await createSession(deps, row.id);
    const handle = createApp({ ...deps, r2: createR2(config, fetch), fetch }, routes);
    const send = (method: string, path: string, body?: unknown) => handle(new Request(ORIGIN + path, {
      method,
      headers: { cookie: cookie.split(';')[0], origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), '10.0.0.1');
    return { id: row.id as string, send };
  }

  it('never exceeds the slot limit under concurrent saves', async () => {
    const u = await user(1);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => u.send('POST', '/api/v1/characters', { label: `Alt ${i}`, raw: EXPORT })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 402)).toHaveLength(7);
    const [{ n }] = await sql`select count(*)::int as n from cloud_characters where user_id = ${u.id}`;
    expect(n).toBe(5);
  });

  it('keeps two characters with one label apart, and PUT replaces only the one named by id', async () => {
    const u = await user(1);
    const other = await user(1);
    const ids = await Promise.all([1, 2].map(async () => {
      const res = await u.send('POST', '/api/v1/characters', { label: 'Bob', raw: EXPORT });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }));
    expect(new Set(ids).size).toBe(2);

    const edited = EXPORT.replace('warlock=', 'warlock = ');
    expect((await other.send('PUT', `/api/v1/characters/${ids[0]}`, { label: 'Stolen', raw: edited })).status).toBe(404);
    const res = await u.send('PUT', `/api/v1/characters/${ids[0]}`, { label: 'Bob (Realm A)', raw: edited });
    expect(await res.json()).toEqual({ id: ids[0] });
    const rows = await sql`select id, label, raw, bytes from cloud_characters where user_id = ${u.id}`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[ids[0]]).toMatchObject({ label: 'Bob (Realm A)', raw: edited, bytes: Buffer.byteLength(edited) });
    expect(byId[ids[1]]).toMatchObject({ label: 'Bob', raw: EXPORT });
  });

  it('round-trips list, read and delete, and hides one user\'s characters from another', async () => {
    const owner = await user(1);
    const other = await user(1);
    const { id } = (await (await owner.send('POST', '/api/v1/characters', { label: 'Main', raw: EXPORT })).json()) as { id: string };
    const list = (await (await owner.send('GET', '/api/v1/characters')).json()) as { slots: number; characters: unknown[] };
    expect(list.slots).toBe(5);
    expect(list.characters).toEqual([{ id, label: 'Main', bytes: Buffer.byteLength(EXPORT), updatedAt: expect.any(String) }]);
    expect(await (await owner.send('GET', `/api/v1/characters/${id}`)).json()).toMatchObject({ id, label: 'Main', raw: EXPORT });

    expect((await other.send('GET', `/api/v1/characters/${id}`)).status).toBe(404);
    expect((await other.send('DELETE', `/api/v1/characters/${id}`)).status).toBe(404);
    expect(((await (await other.send('GET', '/api/v1/characters')).json()) as { characters: unknown[] }).characters).toEqual([]);

    expect((await owner.send('DELETE', `/api/v1/characters/${id}`)).status).toBe(204);
    expect((await owner.send('GET', `/api/v1/characters/${id}`)).status).toBe(404);
  });
});
