// Loothing integration (CLAUDE.md D15; DESIGN.md P3): bearer auth, link and grant refusals with their fix-it URLs, the per-Discord-user
// rate limit, job creation through enqueueJob, read-back limited to Loothing's own jobs, and one audit row per call. Compute and packs
// are fakes; SQL and Redis are stand-ins. The same routes run against real Postgres in integrations.integration.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type RequestCtx } from './app';
import { loadConfig } from './config';
import type { Sql } from './db';
import { createR2 } from './r2';
import type { Redis } from './redis';
import { sha256Hex } from './signed';
import { resolveLoothing, routes } from './integrations';
import type { JobView } from './compute/queue';

const mocks = vi.hoisted(() => ({ enqueueJob: vi.fn(), jobView: vi.fn(), defaultPack: vi.fn() }));
vi.mock('./compute/queue', async (original) => ({
  ...(await original<typeof import('./compute/queue')>()), enqueueJob: mocks.enqueueJob, jobView: mocks.jobView,
}));
vi.mock('./compute/packs', async (original) => ({ ...(await original<typeof import('./compute/packs')>()), defaultPack: mocks.defaultPack }));

const ORIGIN = 'https://sim.test';
const TOKEN = 'loothing-bearer-token';
const DISCORD = '222222222222222222';
const STRANGER = '333333333333333333';
const USER = '0f000000-0000-4000-8000-000000000001';
const CHAR = '0c000000-0000-4000-8000-000000000001';
const JOB = '0a000000-0000-4000-8000-000000000001';
const RAW = 'warlock=Testchar\nlevel=90\nrace=dracthyr\nspec=demonology\nhead=,id=212077,bonus_id=6652\n';

const config = loadConfig({
  FEATURES: 'discord', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: 's'.repeat(32),
  DISCORD_PUBLIC_KEY: 'a'.repeat(64), DISCORD_APPLICATION_ID: '111111111111111111', LOOTHING_TOKEN_SHA256: sha256Hex(TOKEN).toUpperCase(),
});

let linked: boolean;
let granted: boolean;
let audits: { userId: unknown; actor: unknown; action: unknown; detail: Record<string, unknown> }[];
let auditDown: boolean;
let logs: string[];

function fakeSql(): Sql {
  const answer = (q: string, v: unknown[]): unknown[] => {
    if (q.includes("from identities i join users u on u.id = i.user_id")) return linked && v[0] === DISCORD ? [{ user_id: USER }] : [];
    if (q.includes('from integration_grants')) return granted ? [{ '?column?': 1 }] : [];
    if (q.includes('select id, label, updated_at from cloud_characters')) return [{ id: CHAR, label: 'Main', updated_at: new Date('2026-09-20T00:00:00Z') }];
    if (q.includes('select label, raw from cloud_characters')) return v[1] === CHAR ? [{ label: 'Main', raw: RAW }] : [];
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

function send(method: string, path: string, body?: unknown, { token = TOKEN, redis = null as Redis | null } = {}) {
  const app = createApp({ config, sql: fakeSql(), redis, r2: createR2(config, fetch), fetch, now: () => new Date(), log: (l: string) => logs.push(l) }, routes);
  return app(new Request(ORIGIN + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), '127.0.0.1');
}

const view = (over: Partial<JobView> = {}): JobView => ({
  id: JOB, userId: USER, guildId: null, source: 'loothing', status: 'done', lines: ['progress'], next: 1,
  summary: { dps: 1000, dpsError: 10, iterations: 100 }, notices: ['Moderate: x'], effective: { threads: 16, args: ['a'], profile: 'p' },
  createdAt: new Date('2026-09-24T10:00:00Z'), finishedAt: new Date('2026-09-24T10:01:00Z'), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  linked = true;
  granted = true;
  audits = [];
  auditDown = false;
  logs = [];
  mocks.defaultPack.mockResolvedValue('c97e14c7a5ad-dc0508afe741');
  mocks.enqueueJob.mockResolvedValue({ ok: true, id: JOB });
  mocks.jobView.mockResolvedValue(view());
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
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'not-granted', url: `${ORIGIN}/#/account` });
    }
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(mocks.jobView).not.toHaveBeenCalled();
    expect(audits.map((a) => [a.userId, a.action, a.detail.status])).toEqual([
      [USER, 'loothing.resolve', 403], [USER, 'loothing.job.create', 403], [USER, 'loothing.job.read', 403],
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
  it('resolve lists the user\'s cloud characters', async () => {
    const res = await send('POST', '/api/v1/integrations/loothing/resolve', { discordId: DISCORD });
    expect(await res.json()).toEqual({ characters: [{ id: CHAR, label: 'Main', updatedAt: '2026-09-20T00:00:00.000Z' }] });
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

  it('reads back only a job Loothing created for that Discord user, without lines, notices or the profile', async () => {
    const read = (discordId = DISCORD) => send('GET', `/api/v1/integrations/loothing/jobs/${JOB}?discordId=${discordId}`);
    const res = await read();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: JOB, status: 'done', summary: { dps: 1000, dpsError: 10, iterations: 100 },
      createdAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z' });
    for (const other of [view({ source: 'web' }), view({ source: 'discord' }), view({ userId: 'someone-else' }), view({ guildId: '444444444444444444' }), null]) {
      mocks.jobView.mockResolvedValueOnce(other);
      expect((await read()).status).toBe(404);
    }
    expect((await read(STRANGER)).status).toBe(403);
    expect((await send('GET', `/api/v1/integrations/loothing/jobs/${JOB}`)).status).toBe(400);
    expect(audits.map((a) => [a.action, a.detail.status, a.detail.jobId]))
      .toEqual([200, 404, 404, 404, 404, 404, 403, 400].map((status) => ['loothing.job.read', status, JOB]));
  });
});
