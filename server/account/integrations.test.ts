// Loothing integration (CLAUDE.md D15; DESIGN.md P3): bearer auth, link and grant refusals with their fix-it URLs, the per-Discord-user
// rate limit, job creation through enqueueJob with an Idempotency-Key, Retry-After hints, read-back, listing and cancel limited to
// Loothing's own jobs, and one audit row per call; the agent additions: compare jobs from 2-4 slots, `origin`, the list window and
// limit, the compact detail of a finished job, and slot context on resolve. Compute and packs
// are fakes; SQL and Redis are stand-ins. The same routes run against real Postgres in integrations.integration.test.ts.

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type RequestCtx } from './app';
import { loadConfig } from './config';
import type { Sql } from './db';
import { createR2 } from './r2';
import type { Redis } from './redis';
import { sha256Hex } from './signed';
import { resolveLoothing, routes } from './integrations';

const mocks = vi.hoisted(() => ({ enqueueJob: vi.fn(), cancelJob: vi.fn(), defaultPack: vi.fn(), resultBytes: vi.fn() }));
vi.mock('./compute/queue', async (original) => ({
  ...(await original<typeof import('./compute/queue')>()), enqueueJob: mocks.enqueueJob, cancelJob: mocks.cancelJob, resultBytes: mocks.resultBytes,
}));
vi.mock('./compute/packs', async (original) => ({ ...(await original<typeof import('./compute/packs')>()), defaultPack: mocks.defaultPack }));

const ORIGIN = 'https://sim.test';
const TOKEN = 'loothing-bearer-token';
const DISCORD = '222222222222222222';
const STRANGER = '333333333333333333';
const USER = '0f000000-0000-4000-8000-000000000001';
const CHAR = '0c000000-0000-4000-8000-000000000001';
const JOB = '0a000000-0000-4000-8000-000000000001';
const CHAR2 = '0c000000-0000-4000-8000-000000000002';
const RAW = 'warlock=Testchar\nlevel=90\nrace=dracthyr\nspec=demonology\nhead=,id=212077,bonus_id=6652\n';
const RAW2 = 'warlock=Otherchar\nlevel=90\nrace=orc\nspec=destruction\nhead=,id=212077,bonus_id=6652\n';
/** A real simc v2 report (MID2_Warlock_Affliction, 20 iterations, crit and haste weights), trimmed of sequences and timelines. */
const REPORT = readFileSync(new URL('../../tests/fixtures/simc-report-affliction.json', import.meta.url), 'utf8');

const config = loadConfig({
  FEATURES: 'discord', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: 's'.repeat(32),
  DISCORD_PUBLIC_KEY: 'a'.repeat(64), DISCORD_APPLICATION_ID: '111111111111111111', LOOTHING_TOKEN_SHA256: sha256Hex(TOKEN).toUpperCase(),
});

let linked: boolean;
let granted: boolean;
let audits: { userId: unknown; actor: unknown; action: unknown; detail: Record<string, unknown> }[];
let auditDown: boolean;
let logs: string[];
/** Rows the Loothing job query answers with, and the job an Idempotency-Key already names. */
let jobRows: Record<string, unknown>[];
let keyed: string | null;
let jobQueries: { query: string; values: unknown[] }[];

function fakeSql(): Sql {
  const answer = (q: string, v: unknown[]): unknown[] => {
    if (q.includes("from identities i join users u on u.id = i.user_id")) return linked && v[0] === DISCORD ? [{ user_id: USER }] : [];
    if (q.includes('from integration_grants')) return granted ? [{ '?column?': 1 }] : [];
    if (q.includes('select c.id, c.label, c.updated_at, c.who, s.item_level from cloud_characters')) return [
      { id: CHAR, label: 'Main', updated_at: new Date('2026-09-20T00:00:00Z'), item_level: 341.5,
        who: { name: 'Testchar', className: 'warlock', spec: 'demonology', server: 'area52', region: 'us' } },
      { id: CHAR2, label: 'Old slot', updated_at: new Date('2026-09-19T00:00:00Z'), item_level: null, who: null },
    ];
    if (q.includes('select id, raw from cloud_characters')) return [{ id: CHAR, raw: RAW }, { id: CHAR2, raw: RAW2 }];
    if (q.includes('select id, label, raw from cloud_characters')) return v[1] === CHAR ? [{ id: CHAR, label: 'Main', raw: RAW }] : [];
    if (q.includes('select id from compute_jobs where source = \'loothing\'')) return keyed && v[1] === keyed ? [{ id: JOB }] : [];
    if (q.includes('from compute_jobs j left join cloud_characters')) {
      jobQueries.push({ query: q, values: v });
      return jobRows;
    }
    if (q.includes('insert into audit_log') && auditDown) throw new Error('connection terminated');
    if (q.includes('insert into audit_log')) audits.push({ userId: v[0], actor: v[1], action: v[2], detail: v[3] as Record<string, unknown> });
    return [];
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve(answer(strings.join('?'), values))) as unknown as Sql;
  return Object.assign(sql, { json: (value: unknown) => value });
}

/** A Redis whose rate-limit counter reads `count`. */
const countingRedis = (count: number) => ({
  multi: () => ({ incr: () => ({ expire: () => ({ exec: async () => [[null, count], [null, 1]] }) }) }),
}) as unknown as Redis;

function send(method: string, path: string, body?: unknown, { token = TOKEN, redis = null as Redis | null, headers = {} as Record<string, string> } = {}) {
  const app = createApp({ config, sql: fakeSql(), redis, r2: createR2(config, fetch), fetch, now: () => new Date(), log: (l: string) => logs.push(l) }, routes);
  return app(new Request(ORIGIN + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), '127.0.0.1');
}

/** One row of the Loothing job query: a done job on the user's Main slot. */
const row = (over: Record<string, unknown> = {}) => ({
  id: JOB, status: 'done', error: null, summary: { dps: 1000, dpsError: 10, iterations: 100 }, character_id: CHAR, label: 'Main',
  fight_style: 'Patchwerk', created_at: new Date('2026-09-24T10:00:00Z'), finished_at: new Date('2026-09-24T10:01:00Z'), position: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  linked = true;
  granted = true;
  audits = [];
  auditDown = false;
  jobRows = [row()];
  keyed = null;
  jobQueries = [];
  logs = [];
  mocks.defaultPack.mockResolvedValue('c97e14c7a5ad-dc0508afe741');
  mocks.enqueueJob.mockResolvedValue({ ok: true, id: JOB });
  mocks.cancelJob.mockResolvedValue(true);
  mocks.resultBytes.mockResolvedValue(gzipSync(REPORT));
});

describe('resolveLoothing', () => {
  const ctx = (headers: HeadersInit, hash = config.env.LOOTHING_TOKEN_SHA256) =>
    ({ config: { ...config, env: { ...config.env, LOOTHING_TOKEN_SHA256: hash } }, request: new Request(ORIGIN, { headers }) }) as unknown as RequestCtx;

  it('accepts only the token whose sha256 is configured (hex in either case)', async () => {
    expect(await resolveLoothing(ctx({ authorization: `Bearer ${TOKEN}` }))).toBe(true);
    expect(await resolveLoothing(ctx({ authorization: `Bearer ${TOKEN}x` }))).toBe(false);
    expect(await resolveLoothing(ctx({}))).toBe(false);
    expect(await resolveLoothing(ctx({ authorization: `Bearer ${TOKEN}` }, ''))).toBe(false);
    expect(await resolveLoothing(ctx({ authorization: 'Bearer ' }, sha256Hex('')))).toBe(false);
  });

  it('401s every route without it, before any lookup or audit', async () => {
    expect((await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD }, { token: 'wrong' })).status).toBe(401);
    expect(audits).toEqual([]);
  });
});

describe('link and grant', () => {
  it('403s an unlinked Discord user with the sign-in URL, and audits it without a user', async () => {
    linked = false;
    const res = await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not-linked', message: 'This Discord account is not linked to Frostsim.',
      url: `${ORIGIN}/#/account` });
    expect(audits).toEqual([{ userId: null, actor: 'loothing', action: 'loothing.resolve', detail: { discordId: DISCORD, status: 403 } }]);
  });

  it('403s a user who has not allowed Loothing with the account URL, on every route', async () => {
    granted = false;
    for (const [method, path, body] of [
      ['POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD }],
      ['POST', '/api/v1/integrations/loothing/jobs', { discordId: DISCORD, characterId: CHAR, preset: 'patchwerk' }],
      ['GET', `/api/v1/integrations/loothing/jobs/${JOB}?discordId=${DISCORD}`, undefined],
      ['GET', `/api/v1/integrations/loothing/jobs?discordId=${DISCORD}`, undefined],
      ['DELETE', `/api/v1/integrations/loothing/jobs/${JOB}?discordId=${DISCORD}`, undefined],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'not-granted', url: `${ORIGIN}/#/account` });
    }
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(mocks.cancelJob).not.toHaveBeenCalled();
    expect(jobQueries).toEqual([]);
    expect(audits.map((a) => [a.userId, a.action, a.detail.status])).toEqual([
      [USER, 'loothing.resolve', 403], [USER, 'loothing.job.create', 403], [USER, 'loothing.job.read', 403],
      [USER, 'loothing.job.list', 403], [USER, 'loothing.job.cancel', 403],
    ]);
  });

  it('400s a malformed discordId and 429s past 120 calls a minute per Discord user, auditing both', async () => {
    expect((await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: '12' })).status).toBe(400);
    expect((await send('POST', '/api/v1/integrations/loothing/resolve', null)).status).toBe(400);
    const limited = await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD }, { redis: countingRedis(121) });
    expect(limited.status).toBe(429);
    expect((await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD }, { redis: countingRedis(120) })).status).toBe(200);
    expect(audits.map((a) => a.detail)).toEqual([{ status: 400 }, { status: 400 }, { discordId: DISCORD, status: 429 }, { discordId: DISCORD, status: 200 }]);
  });
});

describe('resolve and jobs', () => {
  it('resolve lists the user\'s cloud characters with who they are, where the slot recorded it', async () => {
    const res = await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD });
    expect(await res.json()).toEqual({ characters: [
      { id: CHAR, label: 'Main', updatedAt: '2026-09-20T00:00:00.000Z', name: 'Testchar', class: 'warlock', spec: 'demonology',
        realm: 'area52', region: 'us', itemLevel: 341.5 },
      { id: CHAR2, label: 'Old slot', updatedAt: '2026-09-19T00:00:00.000Z' },
    ] });
  });

  it('creates one compare job from 2-4 of the user\'s slots, and records an agent origin in the audit row', async () => {
    const create = (over: object) => send('POST', '/api/v1/integrations/loothing/jobs', { discordId: DISCORD, preset: 'patchwerk', ...over });
    const res = await create({ characterIds: [CHAR, CHAR2], origin: 'agent' });
    expect(res.status).toBe(201);
    const [, job] = mocks.enqueueJob.mock.calls[0];
    expect(job).toMatchObject({ userId: USER, source: 'loothing', characterId: undefined });
    expect(job.request.profile).toContain('Testchar');
    expect(job.request.profile).toContain('Otherchar');
    expect(audits[0].detail).toEqual({ discordId: DISCORD, preset: 'patchwerk', origin: 'agent', characters: 2, jobId: JOB, status: 201 });
    for (const bad of [{ characterIds: [CHAR] }, { characterIds: [CHAR, CHAR] }, { characterIds: [CHAR, CHAR2], characterId: CHAR },
      { characterIds: [CHAR, 7] }, { characterIds: 'x' }, { characterId: CHAR, origin: 'robot' }]) {
      expect((await create(bad)).status).toBe(400);
    }
    expect((await create({ characterIds: [CHAR, '0c000000-0000-4000-8000-00000000000f'] })).status).toBe(404);
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);
  });

  it('lists up to `limit` jobs from the last `days`, and 400s either out of range', async () => {
    const list = (q: string) => send('GET', `/api/v1/integrations/loothing/jobs?discordId=${DISCORD}${q}`);
    expect((await list('&days=30&limit=100')).status).toBe(200);
    expect(jobQueries[0].values.at(-1)).toBe(100);
    for (const q of ['&days=0', '&days=31', '&limit=101', '&limit=2.5', '&days=x']) expect((await list(q)).status).toBe(400);
  });

  it('returns the compact detail of a finished job, 409 while it is not done and 410 once the result has expired', async () => {
    const detail = () => send('GET', `/api/v1/integrations/loothing/jobs/${JOB}/detail?discordId=${DISCORD}`);
    const res = await detail();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: JOB, fight: { style: 'Patchwerk', targets: 1 }, characters: [{ spec: 'Affliction Warlock' }] });
    expect(JSON.stringify(body).length).toBeLessThan(8000);
    expect(mocks.resultBytes).toHaveBeenCalledWith(expect.anything(), JOB);
    jobRows = [row({ status: 'running' })];
    expect(await (await detail()).json()).toMatchObject({ error: 'not-done' });
    jobRows = [row()];
    mocks.resultBytes.mockResolvedValueOnce(null);
    const gone = await detail();
    expect([gone.status, (await gone.json()).error]).toEqual([410, 'expired']);
    jobRows = [];
    expect((await detail()).status).toBe(404);
    expect(audits.map((a) => [a.action, a.detail.status])).toEqual([200, 409, 410, 404].map((s) => ['loothing.job.detail', s]));
  });

  it('creates a personal loothing job from the cloud character and preset', async () => {
    const res = await send('POST', '/api/v1/integrations/loothing/jobs', { discordId: DISCORD, characterId: CHAR, preset: 'execute-patchwerk' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: JOB });
    const [, job] = mocks.enqueueJob.mock.calls[0];
    expect(job).toMatchObject({ userId: USER, guildId: null, source: 'loothing', packId: 'c97e14c7a5ad-dc0508afe741' });
    expect(job.request.extraProfileLines).toContain('enemy_fixed_health_percentage=20');
    expect(audits).toEqual([{ userId: USER, actor: 'loothing', action: 'loothing.job.create',
      detail: { discordId: DISCORD, preset: 'execute-patchwerk', jobId: JOB, status: 201 } }]);
  });

  it('keeps a created job\'s 201 when its audit row cannot be written, so Loothing does not retry into a second charge', async () => {
    auditDown = true;
    const res = await send('POST', '/api/v1/integrations/loothing/jobs', { discordId: DISCORD, characterId: CHAR, preset: 'patchwerk' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: JOB });
    expect(logs).toEqual(['loothing: audit of loothing.job.create failed (Error: connection terminated)']);
  });

  it('refuses an unknown preset or character, a missing engine, and passes enqueue refusals through', async () => {
    const create = (over: object) => send('POST', '/api/v1/integrations/loothing/jobs', { discordId: DISCORD, characterId: CHAR, preset: 'patchwerk', ...over });
    expect((await create({ preset: 'dungeon-route' })).status).toBe(400);
    expect((await create({ characterId: 42 })).status).toBe(400);
    expect((await create({ characterId: '0c000000-0000-4000-8000-00000000000f' })).status).toBe(404);
    mocks.defaultPack.mockResolvedValueOnce(null);
    expect(await (await create({})).json()).toMatchObject({ error: 'no-native-engine' });
    mocks.enqueueJob.mockResolvedValueOnce({ ok: false, status: 402, code: 'no-allowance', message: 'The cloud allowance for this period is used up.' });
    const refused = await create({});
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: 'no-allowance', message: 'The cloud allowance for this period is used up.' });
    expect(audits.map((a) => a.detail.status)).toEqual([400, 400, 404, 409, 402]);
  });

  it('reads back a job with its slot and fight, scoped in SQL to Loothing\'s own jobs for that user', async () => {
    const read = (discordId = DISCORD) => send('GET', `/api/v1/integrations/loothing/jobs/${JOB}?discordId=${discordId}`);
    const res = await read();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: JOB, status: 'done', summary: { dps: 1000, dpsError: 10, iterations: 100 }, characterId: CHAR,
      characterLabel: 'Main', fightStyle: 'Patchwerk', createdAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z' });
    // The id or time-window fragment is a nested query here; the Postgres test runs it for real.
    expect(jobQueries[0].query).toMatch(/j\.source = 'loothing' and j\.user_id = \? and j\.guild_id is null/);
    expect(jobQueries[0].values[0]).toBe(USER);
    jobRows = [row({ status: 'queued', summary: null, finished_at: null, position: 2, label: null })];
    expect(await (await read()).json()).toEqual({ id: JOB, status: 'queued', position: 2, characterId: CHAR, characterLabel: null,
      fightStyle: 'Patchwerk', createdAt: '2026-09-24T10:00:00.000Z' });
    jobRows = [];
    expect((await read()).status).toBe(404);
    expect((await read(STRANGER)).status).toBe(403);
    expect((await send('GET', `/api/v1/integrations/loothing/jobs/${JOB}`)).status).toBe(400);
    expect(audits.map((a) => [a.action, a.detail.status, a.detail.jobId]))
      .toEqual([200, 200, 404, 403, 400].map((status) => ['loothing.job.read', status, JOB]));
  });

  it('lists the last day\'s jobs for that user, newest first', async () => {
    jobRows = [row(), row({ id: '0a000000-0000-4000-8000-000000000002', status: 'failed', error: 'simc refused the input.', summary: null })];
    const res = await send('GET', `/api/v1/integrations/loothing/jobs?discordId=${DISCORD}`);
    const body = await res.json();
    expect(body.jobs.map((j: { id: string; status: string; error?: string }) => [j.status, j.error])).toEqual([['done', undefined], ['failed', 'simc refused the input.']]);
    expect(jobQueries[0].query).toMatch(/order by j\.created_at desc limit \?$/);
    expect(jobQueries[0].values.at(-1)).toBe(20);
  });

  it('cancels its own queued or running job, 404s any other and 409s a finished one', async () => {
    const cancel = () => send('DELETE', `/api/v1/integrations/loothing/jobs/${JOB}?discordId=${DISCORD}`);
    jobRows = [row({ status: 'running' })];
    const ok = await cancel();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: JOB, status: 'cancelled' });
    expect(mocks.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB, { userId: USER });
    mocks.cancelJob.mockResolvedValueOnce(false);
    const late = await cancel();
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'finished' });
    jobRows = [];
    expect((await cancel()).status).toBe(404);
    expect(mocks.cancelJob).toHaveBeenCalledTimes(2);
    expect(audits.map((a) => [a.action, a.detail.status])).toEqual([['loothing.job.cancel', 200], ['loothing.job.cancel', 409], ['loothing.job.cancel', 404]]);
  });

  it('maps a repeated Idempotency-Key to the first job with 200, also when a concurrent create wins the unique index', async () => {
    const create = (key: string) => send('POST', '/api/v1/integrations/loothing/jobs', { discordId: DISCORD, characterId: CHAR, preset: 'patchwerk' }, { headers: { 'idempotency-key': key } });
    const first = await create('1420000000000000001');
    expect(first.status).toBe(201);
    expect(mocks.enqueueJob.mock.calls[0][1]).toMatchObject({ characterId: CHAR, idempotencyKey: '1420000000000000001' });
    keyed = '1420000000000000001';
    const again = await create('1420000000000000001');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: JOB });
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);
    // The race: the pre-check saw nothing, the insert hit the unique index.
    keyed = null;
    mocks.enqueueJob.mockImplementationOnce(async () => { keyed = '1420000000000000002'; throw Object.assign(new Error('duplicate key'), { code: '23505' }); });
    const raced = await create('1420000000000000002');
    expect(raced.status).toBe(200);
    expect(await raced.json()).toEqual({ id: JOB });
    expect((await create('not a key!')).status).toBe(400);
    expect((await create('x'.repeat(65))).status).toBe(400);
    expect(audits.map((a) => [a.detail.status, a.detail.repeat])).toEqual([[201, undefined], [200, 1], [200, undefined], [400, undefined], [400, undefined]]);
  });

  it('sends Retry-After on a 429 or 503 refusal', async () => {
    const create = () => send('POST', '/api/v1/integrations/loothing/jobs', { discordId: DISCORD, characterId: CHAR, preset: 'patchwerk' });
    for (const [status, code, after] of [[429, 'too-many-jobs', '15'], [503, 'capacity', '30'], [503, 'compute-disabled', '30'], [402, 'no-allowance', null]] as const) {
      mocks.enqueueJob.mockResolvedValueOnce({ ok: false, status, code, message: 'x' });
      const res = await create();
      expect([res.status, res.headers.get('retry-after')]).toEqual([status, after]);
    }
    const limited = await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD }, { redis: countingRedis(121) });
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '60']);
  });
});
