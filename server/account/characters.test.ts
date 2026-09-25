// Cloud character slots (CLAUDE.md D15, DESIGN.md C5): validation, parser cost bounds, rate limit, owner scoping and slot limits with a
// fake SQL, and the slot race and replace-by-id against the local Postgres (gated on FROSTSIM_TEST_PG).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { parseSims, routes } from './characters';
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
/** The fixture as another character: one account holds one slot per character in the game. */
const named = (name: string) => EXPORT.replace(/^warlock=.*$/m, `warlock=${name}`);
const config = loadConfig({
  FEATURES: 'shares', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: 's'.repeat(32),
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
});

/** `plan`: the lookup key of the user's one live subscription, or null for a free account (FREE_SLOTS only). */
interface State { plan: string | null; used: number; row: Record<string, unknown> | null; lastGear?: unknown }
type Call = { query: string; values: unknown[] };

/** Tagged-template stand-in for postgres.js that answers by query text; `begin` runs the callback on the same fake. */
function fakeSql(state: State, calls: Call[]): Sql {
  const period = { current_period_start: new Date(Date.now() - 86_400_000), current_period_end: new Date(Date.now() + 86_400_000) };
  const answer = (q: string): unknown[] => {
    if (q.includes('from sessions s join users')) {
      return [{ user_id: 'u1', role: 'user', display_name: 'Bob', suspended_at: null, expires_at: new Date(Date.now() + 3600_000), last_seen_at: new Date() }];
    }
    if (q.includes('from subscriptions')) {
      return state.plan ? [{ status: 'active', ...period, guild_id: null, items: [{ lookupKey: state.plan, quantity: 1 }] }] : [];
    }
    if (q.includes('comp_core_seconds')) return [{ core_seconds: 0, max_threads: null }];
    if (q.includes('update cloud_characters')) return state.row ? [{ id: ID }] : [];
    if (q.includes('count(*)')) return [{ used: state.used }];
    if (q.includes('insert into cloud_characters')) return [{ id: ID }];
    if (q.includes('select c.id, c.label, c.bytes')) {
      return [{ id: ID, label: 'Main', bytes: 10, updated_at: new Date('2026-09-20T00:00:00Z'), who: { name: 'Bob', className: 'warlock' }, item_level: 640.5 }];
    }
    if (q.includes('select gear from character_snapshots')) return state.lastGear ? [{ gear: state.lastGear }] : [];
    if (q.includes('insert into character_sims')) return [{ id: 's1' }];
    if (q.includes('from cloud_characters') || q.includes('delete from cloud_characters')) return state.row ? [state.row] : [];
    return [];
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });
    return Promise.resolve(answer(query));
  }) as unknown as Sql;
  return Object.assign(sql, { begin: (fn: (tx: Sql) => unknown) => fn(sql), json: (v: unknown) => v });
}

/** Answers every rate-limit counter with a count far past any limit; the session cache calls it lacks fall back to SQL. */
const exhausted = { multi: () => ({ incr() { return this; }, expire() { return this; }, exec: async () => [[null, 1e9], [null, 1]] }) } as unknown as Redis;

function setup(over: Partial<State> = {}, redis: Redis | null = null) {
  const state: State = { plan: 'compute_s_monthly', used: 0, row: null, ...over };
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
  it('lists characters without raw, with the slot count, who each one is and its latest item level', async () => {
    const { send, calls } = setup({ plan: 'compute_m_monthly' });
    const res = await send('GET', '/api/v1/characters');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slots: 3, characters: [{
      id: ID, label: 'Main', bytes: 10, updatedAt: '2026-09-20T00:00:00.000Z', itemLevel: 640.5, who: { name: 'Bob', className: 'warlock' },
    }] });
    const list = calls.find((c) => c.query.includes('select c.id, c.label, c.bytes'))!;
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
    const created = setup({ row: { id: 'other', who: { name: 'Someone', className: 'warlock', region: 'us', server: 'testrealm' } } });
    const res = await created.send('POST', '/api/v1/characters', { label: '  Main  ', raw: EXPORT });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: ID, updatedAt: expect.any(String) });
    const insert = created.calls.find((c) => c.query.includes('insert into cloud_characters'))!;
    expect(insert.values.slice(0, 4)).toEqual(['u1', 'Main', EXPORT, Buffer.byteLength(EXPORT)]);
    expect(created.calls.some((c) => c.query.includes('for update'))).toBe(true);
    expect(created.calls.some((c) => c.query.includes('update cloud_characters'))).toBe(false);
  });

  it('replaces the same character with POST instead of taking another slot, even with every slot in use', async () => {
    const same = setup({ plan: null, used: 1, row: { id: ID, who: { name: 'testchar', className: 'warlock', region: 'US', server: 'Testrealm' } } });
    const res = await same.send('POST', '/api/v1/characters', { label: 'Main', raw: EXPORT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, updatedAt: expect.any(String) });
    const update = same.calls.find((c) => c.query.includes('update cloud_characters'))!;
    expect(update.values.at(-1)).toBe(ID);
    expect(same.calls.some((c) => c.query.includes('insert into cloud_characters') || c.query.includes('count(*)'))).toBe(false);
  });

  it('replaces one character by id with PUT: owner only, no slot needed, same validation', async () => {
    const mine = setup({ row: { id: ID }, plan: null, used: 3 });
    const res = await mine.send('PUT', `/api/v1/characters/${ID}`, { label: 'Alt', raw: EXPORT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, updatedAt: expect.any(String) });
    const update = mine.calls.find((c) => c.query.includes('update cloud_characters'))!;
    expect(update.query).toContain('user_id = ?');
    expect(update.values).toEqual(['Alt', EXPORT, Buffer.byteLength(EXPORT), expect.objectContaining({ className: 'warlock' }), expect.any(Date), ID, 'u1']);
    expect(mine.calls.some((c) => c.query.includes('from subscriptions'))).toBe(false);

    expect((await setup().send('PUT', `/api/v1/characters/${ID}`, { label: 'Alt', raw: EXPORT })).status).toBe(404);
    const bad = setup({ row: { id: ID } });
    expect((await bad.send('PUT', `/api/v1/characters/${ID}`, { label: 'Alt', raw: 'hello world' })).status).toBe(400);
    expect(bad.wrote()).toBe(false);
  });

  it('refuses a new character with 402 no-slots when every slot is used: 2 on compute_s, the 1 free slot without a plan', async () => {
    expect((await setup({ plan: 'compute_s_monthly', used: 1 }).send('POST', '/api/v1/characters', { label: 'Alt', raw: EXPORT })).status).toBe(201);
    expect((await setup({ plan: null, used: 0 }).send('POST', '/api/v1/characters', { label: 'Alt', raw: EXPORT })).status).toBe(201);
    for (const state of [{ plan: 'compute_s_monthly', used: 2 }, { plan: null, used: 1 }]) {
      const { send, calls } = setup(state);
      const res = await send('POST', '/api/v1/characters', { label: 'Alt', raw: EXPORT });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'no-slots' });
      expect(calls.some((c) => c.query.includes('insert into'))).toBe(false);
    }
  });

  it('adds a gear snapshot on save only when the equipped set changed', async () => {
    const first = setup();
    await first.send('POST', '/api/v1/characters', { label: 'Main', raw: EXPORT });
    const snap = first.calls.find((c) => c.query.includes('insert into character_snapshots'))!;
    expect(snap.values[0]).toBe(ID);
    const gear = snap.values[3] as { slot: string }[];
    expect(gear.length).toBeGreaterThan(10);

    const same = setup({ row: { id: ID }, lastGear: gear });
    expect((await same.send('PUT', `/api/v1/characters/${ID}`, { label: 'Main', raw: EXPORT })).status).toBe(200);
    expect(same.calls.some((c) => c.query.includes('insert into character_snapshots'))).toBe(false);

    const changed = setup({ row: { id: ID }, lastGear: gear.slice(1) });
    await changed.send('PUT', `/api/v1/characters/${ID}`, { label: 'Main', raw: EXPORT });
    expect(changed.calls.some((c) => c.query.includes('insert into character_snapshots'))).toBe(true);
  });

  it('serves history and takes sim uploads only for the owner\'s character', async () => {
    expect((await setup().send('GET', `/api/v1/characters/${ID}/history`)).status).toBe(404);
    expect((await setup().send('POST', `/api/v1/characters/${ID}/sims`, { points: [] })).status).toBe(404);
    const mine = setup({ row: { id: ID } });
    const point = { reportId: 'r-1', createdAt: '2026-09-20T00:00:00Z', dps: 220000, dpsError: 400, fightStyle: 'Patchwerk', targets: 1, gameBuild: '12.1.0.69814' };
    const res = await mine.send('POST', `/api/v1/characters/${ID}/sims`, { points: [point] });
    expect(await res.json()).toEqual({ added: 1 });
    const insert = mine.calls.find((c) => c.query.includes('insert into character_sims'))!;
    expect(insert.query).toContain('on conflict (character_id, report_id) do nothing');
    expect(insert.values).toEqual([ID, new Date(point.createdAt), 220000, 400, 'Patchwerk', 1, '12.1.0.69814', 'r-1']);
  });

  it('checks uploaded sim points: shape, range and at most 50', () => {
    const now = new Date('2026-09-24T00:00:00Z');
    const ok = { reportId: 'abc_1', createdAt: '2026-09-20T00:00:00Z', dps: 1000 };
    expect(parseSims({ points: [{ ...ok, fightStyle: 'Patch werk', targets: 0, dpsError: -1, gameBuild: 'x' }] }, now))
      .toEqual([{ reportId: 'abc_1', createdAt: new Date(ok.createdAt), dps: 1000, dpsError: undefined, fightStyle: undefined, targets: undefined, gameBuild: undefined }]);
    for (const bad of [{ ...ok, dps: 0 }, { ...ok, dps: 'x' }, { ...ok, reportId: 'a b' }, { ...ok, createdAt: '2019-01-01T00:00:00Z' },
      { ...ok, createdAt: '2026-10-24T00:00:00Z' }, { ...ok, createdAt: 'soon' }, null]) {
      expect(() => parseSims({ points: [bad] }, now), JSON.stringify(bad)).toThrow();
    }
    expect(() => parseSims({ points: Array(51).fill(ok) }, now)).toThrow();
    expect(() => parseSims({}, now)).toThrow();
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

  /** A signed-in user holding one `plan` subscription (null: a free account), and a request helper carrying their cookie. */
  async function user(plan: string | null) {
    const [row] = await sql`insert into users (display_name) values ('Slots') returning id`;
    if (plan) {
      await sql`insert into subscriptions (stripe_subscription_id, user_id, status, current_period_start, current_period_end, items)
        values (${`sub_${randomBytes(6).toString('hex')}`}, ${row.id}, 'active', ${new Date(Date.now() - 86_400_000)},
          ${new Date(Date.now() + 86_400_000)}, ${sql.json([{ lookupKey: plan, quantity: 1 }])})`;
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
    // compute_m: the free slot plus 2.
    const u = await user('compute_m_monthly');
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => u.send('POST', '/api/v1/characters', { label: `Alt ${i}`, raw: named(`Alt${i}`) })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 402)).toHaveLength(9);
    const [{ n }] = await sql`select count(*)::int as n from cloud_characters where user_id = ${u.id}`;
    expect(n).toBe(3);
  });

  it('keeps two characters with one label apart, and PUT replaces only the one named by id', async () => {
    const u = await user('compute_s_monthly');
    const other = await user(null);
    const ids = await Promise.all([1, 2].map(async (i) => {
      const res = await u.send('POST', '/api/v1/characters', { label: 'Bob', raw: named(`Bob${i}`) });
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
    expect(byId[ids[1]]).toMatchObject({ label: 'Bob', raw: named('Bob2') });
  });

  it('keeps gear and DPS history per character, dedupes uploads, and deletes both with the character', async () => {
    const u = await user('compute_s_monthly');
    const other = await user(null);
    const { id } = (await (await u.send('POST', '/api/v1/characters', { label: 'Main', raw: EXPORT })).json()) as { id: string };
    await u.send('PUT', `/api/v1/characters/${id}`, { label: 'Main', raw: EXPORT });
    // One trinket upgraded: a second snapshot.
    const upgraded = EXPORT.replace(/^(trinket1=[^\n]*)$/m, '$1,ilevel=700');
    expect(upgraded).not.toBe(EXPORT);
    await u.send('PUT', `/api/v1/characters/${id}`, { label: 'Main', raw: upgraded });
    const point = { reportId: 'r1', createdAt: new Date().toISOString(), dps: 200000, fightStyle: 'Patchwerk', targets: 1 };
    expect(await (await u.send('POST', `/api/v1/characters/${id}/sims`, { points: [point] })).json()).toEqual({ added: 1 });
    expect(await (await u.send('POST', `/api/v1/characters/${id}/sims`, { points: [point] })).json()).toEqual({ added: 0 });
    expect((await other.send('GET', `/api/v1/characters/${id}/history`)).status).toBe(404);

    const h = (await (await u.send('GET', `/api/v1/characters/${id}/history`)).json()) as { snapshots: { gear: { slot: string; ilvl?: number }[] }[]; sims: unknown[] };
    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots[1].gear.find((g) => g.slot === 'trinket1')?.ilvl).toBe(700);
    expect(h.sims).toEqual([expect.objectContaining({ source: 'run', dps: 200000, reportId: 'r1', fightStyle: 'Patchwerk' })]);

    expect((await u.send('DELETE', `/api/v1/characters/${id}`)).status).toBe(204);
    const [{ n }] = await sql`select (select count(*) from character_snapshots where character_id = ${id})
      + (select count(*) from character_sims where character_id = ${id}) as n`;
    expect(Number(n)).toBe(0);
  });

  it('round-trips list, read and delete, and hides one user\'s characters from another', async () => {
    const owner = await user('compute_s_monthly');
    const other = await user(null);
    const { id } = (await (await owner.send('POST', '/api/v1/characters', { label: 'Main', raw: EXPORT })).json()) as { id: string };
    const list = (await (await owner.send('GET', '/api/v1/characters')).json()) as { slots: number; characters: unknown[] };
    expect(list.slots).toBe(2);
    expect(list.characters).toEqual([{
      id, label: 'Main', bytes: Buffer.byteLength(EXPORT), updatedAt: expect.any(String), itemLevel: expect.any(Number),
      who: expect.objectContaining({ className: 'warlock' }),
    }]);
    expect(await (await owner.send('GET', `/api/v1/characters/${id}`)).json()).toMatchObject({ id, label: 'Main', raw: EXPORT });

    expect((await other.send('GET', `/api/v1/characters/${id}`)).status).toBe(404);
    expect((await other.send('DELETE', `/api/v1/characters/${id}`)).status).toBe(404);
    expect(((await (await other.send('GET', '/api/v1/characters')).json()) as { characters: unknown[] }).characters).toEqual([]);

    expect((await owner.send('DELETE', `/api/v1/characters/${id}`)).status).toBe(204);
    expect((await owner.send('GET', `/api/v1/characters/${id}`)).status).toBe(404);
  });
});
