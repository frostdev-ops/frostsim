// Discord interactions (CLAUDE.md D15; DESIGN.md P2, P3, P5): Ed25519 verification with a generated key pair, PING, each command's
// happy path and refusals, the MANAGE_GUILD check, the reply-editing task and its token expiry, the hosted snapshot and the command
// JSON the register script sends. Compute, packs and storeShare are fakes; SQL, Redis and Discord's API are stand-ins.

import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { GUILD_CHECKOUT_PURPOSE } from './billing';
import { loadConfig } from './config';
import type { Sql } from './db';
import { createR2 } from './r2';
import type { Redis } from './redis';
import { verify } from './signed';
import { ACCURACY, SIM_FIGHTS, TOKEN_TTL_S, canManageGuild, routes, shareBytes, tasks, verifyInteraction } from './discord';
import type { JobView } from './compute/queue';
import { findPreset } from '../../src/lib/simc/presets';
import { validateReport } from '../../src/lib/store/report-share';
import { report as REPORT } from '../../src/lib/simc/__fixtures__/protocol.mjs';
import { ACCURACIES, COMMANDS, FIGHTS, register } from '../../scripts/discord-register-commands.mjs';

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(), cancelJob: vi.fn(), jobView: vi.fn(), resultBytes: vi.fn(), defaultPack: vi.fn(), storeShare: vi.fn(),
}));
vi.mock('./compute/queue', async (original) => ({
  ...(await original<typeof import('./compute/queue')>()),
  enqueueJob: mocks.enqueueJob, cancelJob: mocks.cancelJob, jobView: mocks.jobView, resultBytes: mocks.resultBytes,
}));
vi.mock('./compute/packs', async (original) => ({ ...(await original<typeof import('./compute/packs')>()), defaultPack: mocks.defaultPack }));
vi.mock('./shares', async (original) => ({ ...(await original<typeof import('./shares')>()), storeShare: mocks.storeShare }));

const ORIGIN = 'https://sim.test';
const APP_ID = '111111111111111111';
const SECRET = 's'.repeat(32);
const NOW = Date.parse('2026-09-24T12:00:00Z');
const NOW_S = NOW / 1000;
const ALICE = '222222222222222222';
const STRANGER = '333333333333333333';
const GUILD = '444444444444444444';
const POOL_GUILD = '555555555555555555';
const USER = '0f000000-0000-4000-8000-000000000001';
const CHAR = '0c000000-0000-4000-8000-000000000001';
const JOB = '0a000000-0000-4000-8000-000000000001';
const PACK = 'c97e14c7a5ad-dc0508afe741';
const TOKEN = 'aW50ZXJhY3Rpb246dG9rZW4';
const RAW = readFileSync(new URL('../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8');
const REPORT_TEXT = JSON.stringify(REPORT);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const config = loadConfig({
  FEATURES: 'discord', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: SECRET,
  DISCORD_PUBLIC_KEY: PUBLIC_HEX, DISCORD_APPLICATION_ID: APP_ID,
});

const period = { current_period_start: new Date(NOW - 86_400_000), current_period_end: new Date(NOW + 29 * 86_400_000) };
const sub = (lookupKey: string, guildId: string | null = null, coreHours = 50) =>
  ({ status: 'active', ...period, guild_id: guildId, items: [{ lookupKey, quantity: 1, coreHours }] });

/** The rows the fake SQL answers from. */
let world: {
  identities: Record<string, string>;
  characters: { id: string; user_id: string; label: string; raw: string }[];
  subscriptions: Record<string, ReturnType<typeof sub>[]>;
  usedCoreSeconds: number;
  discordJobs: string[];
  /** The rate-limit counter every INCR returns, and the keys it was asked for. */
  submits: number;
  rateKeys: string[];
};

function fakeSql(): Sql {
  const answer = (q: string, v: unknown[]): unknown[] => {
    if (q.includes("from identities i join users u on u.id = i.user_id")) return world.identities[v[0] as string] ? [{ user_id: world.identities[v[0] as string] }] : [];
    if (q.includes('select label, raw from cloud_characters')) {
      const [userId, wanted] = v as string[];
      return world.characters.filter((c) => c.user_id === userId && (c.id === wanted || c.label.toLowerCase() === wanted.toLowerCase()));
    }
    if (q.includes('select id, label from cloud_characters')) return world.characters.filter((c) => c.user_id === v[0]);
    if (q.includes('from subscriptions where user_id') || q.includes('from subscriptions where guild_id')) return world.subscriptions[v[0] as string] ?? [];
    if (q.includes('comp_core_seconds')) return [{ core_seconds: 0, max_threads: null }];
    if (q.includes('sum(core_seconds)')) return [{ used: world.usedCoreSeconds }];
    if (q.includes("from compute_jobs where source = 'discord'")) return world.discordJobs.map((id) => ({ id }));
    return [];
  };
  return ((strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve(answer(strings.join('?'), values))) as unknown as Sql;
}

/** Map-backed Redis with the few commands this module sends. */
function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  const redis = {
    set: async (key: string, value: string, _ex: string, ttl: number) => (store.set(key, { value, ttl }), 'OK'),
    get: async (key: string) => store.get(key)?.value ?? null,
    multi() {
      const ops: (() => [null, unknown])[] = [];
      const chain = {
        get: (key: string) => (ops.push(() => [null, store.get(key)?.value ?? null]), chain),
        del: (key: string) => (ops.push(() => [null, store.delete(key) ? 1 : 0]), chain),
        incr: (key: string) => (ops.push(() => (world.rateKeys.push(key), [null, ++world.submits])), chain),
        expire: () => (ops.push(() => [null, 1]), chain),
        exec: async () => ops.map((op) => op()),
      };
      return chain;
    },
  };
  return { store, redis: redis as unknown as Redis };
}

let edits: { url: string; body: { content: string; allowed_mentions: unknown } }[];
/** Discord's answer to each edit in turn, then 200. 0 = unreachable; 429 carries Retry-After: 5. */
let editStatuses: number[];
let logs: string[];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  edits.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  const status = editStatuses.shift() ?? 200;
  if (status === 0) throw new TypeError('fetch failed');
  return new Response('{}', { status, headers: status === 429 ? { 'retry-after': '5' } : {} });
}) as typeof fetch;

function deps(redis: Redis | null, now = NOW) {
  return { config, sql: fakeSql(), redis, r2: createR2(config, fakeFetch), fetch: fakeFetch, now: () => new Date(now), log: (l: string) => logs.push(l) };
}

function signed(interaction: unknown, { timestamp = String(NOW_S), body }: { timestamp?: string; body?: string } = {}): Request {
  const text = JSON.stringify(interaction);
  const signature = edSign(null, Buffer.from(timestamp + text), privateKey).toString('hex');
  return new Request(`${ORIGIN}/api/v1/discord/interactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
    body: body ?? text,
  });
}

const inGuild = (discordId: string, guildId: string, permissions = '0') => ({ guild_id: guildId, member: { permissions, user: { id: discordId } } });
const command = (name: string, options: unknown[] = [], where: object = { user: { id: ALICE } }) =>
  ({ type: 2, token: TOKEN, data: { name, options }, ...where });

async function call(redis: Redis | null, interaction: unknown) {
  const res = await createApp(deps(redis), routes)(signed(interaction), '10.0.0.1');
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  world = {
    identities: { [ALICE]: USER },
    characters: [
      { id: CHAR, user_id: USER, label: 'Main_Warlock', raw: RAW },
      { id: '0c000000-0000-4000-8000-000000000002', user_id: USER, label: 'Alt Priest', raw: RAW },
      { id: '0c000000-0000-4000-8000-000000000003', user_id: 'someone-else', label: 'Main Rogue', raw: RAW },
    ],
    subscriptions: { [USER]: [sub('compute_m_monthly')], [POOL_GUILD]: [sub('discord_guild_monthly', POOL_GUILD, 200)] },
    usedCoreSeconds: 3600 * 5,
    discordJobs: [],
    submits: 0,
    rateKeys: [],
  };
  edits = [];
  editStatuses = [];
  logs = [];
  mocks.defaultPack.mockResolvedValue(PACK);
  mocks.enqueueJob.mockResolvedValue({ ok: true, id: JOB });
  mocks.cancelJob.mockResolvedValue(true);
});

describe('verifyInteraction', () => {
  const body = new TextEncoder().encode('{"type":1}');
  const sig = (timestamp: string, bytes: Uint8Array) => edSign(null, Buffer.concat([Buffer.from(timestamp), bytes]), privateKey).toString('hex');
  const ts = String(NOW_S);

  it('accepts Discord\'s signature over timestamp + exact body', () => {
    expect(verifyInteraction(PUBLIC_HEX, sig(ts, body), ts, body, NOW_S)).toBe(true);
  });

  it('refuses a tampered body or timestamp, a stale or future timestamp and malformed input', () => {
    expect(verifyInteraction(PUBLIC_HEX, sig(ts, body), ts, new TextEncoder().encode('{"type":2}'), NOW_S)).toBe(false);
    expect(verifyInteraction(PUBLIC_HEX, sig(ts, body), String(NOW_S + 1), body, NOW_S)).toBe(false);
    const stale = String(NOW_S - 301);
    expect(verifyInteraction(PUBLIC_HEX, sig(stale, body), stale, body, NOW_S)).toBe(false);
    const future = String(NOW_S + 301);
    expect(verifyInteraction(PUBLIC_HEX, sig(future, body), future, body, NOW_S)).toBe(false);
    expect(verifyInteraction(PUBLIC_HEX, null, ts, body, NOW_S)).toBe(false);
    expect(verifyInteraction(PUBLIC_HEX, 'zz'.repeat(64), ts, body, NOW_S)).toBe(false);
    expect(verifyInteraction('', sig(ts, body), ts, body, NOW_S)).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    expect(verifyInteraction(other, sig(ts, body), ts, body, NOW_S)).toBe(false);
  });
});

describe('interactions endpoint', () => {
  it('answers PING with PONG', async () => {
    expect(await call(null, { type: 1 })).toEqual({ status: 200, body: { type: 1 } });
  });

  it('401s a bad signature before reading the interaction', async () => {
    const tampered = signed({ type: 1 }, { body: JSON.stringify({ type: 1, x: 1 }) });
    const res = await createApp(deps(null), routes)(tampered, '10.0.0.1');
    expect(res.status).toBe(401);
    const stale = await createApp(deps(null), routes)(signed({ type: 1 }, { timestamp: String(NOW_S - 600) }), '10.0.0.1');
    expect(stale.status).toBe(401);
  });

  it('400s an interaction without a user', async () => {
    expect((await call(null, { type: 2, data: { name: 'link' } })).status).toBe(400);
  });
});

describe('/sim', () => {
  const sim = (options: unknown[], where?: object) => command('sim', options, where);

  it('defers ephemerally, enqueues the character as a discord job, says it is queued, then remembers the token for 900 s', async () => {
    const { store, redis } = fakeRedis();
    let editsAtSave = -1;
    const set = redis.set.bind(redis);
    redis.set = (async (...args: Parameters<Redis['set']>) => ((editsAtSave = edits.length), set(...args))) as Redis['set'];
    const res = await call(redis, sim([
      { name: 'character', type: 3, value: CHAR }, { name: 'fight', type: 3, value: 'hectic-add-cleave' }, { name: 'accuracy', type: 3, value: 'high' },
    ]));
    expect(res).toEqual({ status: 200, body: { type: 5, data: { flags: 64 } } });
    await vi.waitFor(() => expect(store.has(`discord:${JOB}`)).toBe(true));
    // "Queued" went out first, so it can never land on top of a posted result.
    expect(editsAtSave).toBe(1);
    expect(world.rateKeys).toEqual([`rl:compute-submit:${USER}:${Math.floor(NOW_S / 60)}`]);
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);
    const [, job] = mocks.enqueueJob.mock.calls[0];
    expect(job).toMatchObject({ userId: USER, guildId: null, source: 'discord', packId: PACK });
    expect(job.request.settings.fightStyle).toBe('HecticAddCleave');
    expect(job.request.accuracy).toEqual(ACCURACY.high);
    expect(job.request.profile).toContain('warlock=');
    expect(store.get(`discord:${JOB}`)).toEqual({ ttl: TOKEN_TTL_S, value: JSON.stringify({ token: TOKEN, label: 'Main_Warlock', presetId: 'hectic-add-cleave', exp: NOW + 900_000 }) });
    expect(edits[0].url).toBe(`https://discord.com/api/v10/webhooks/${APP_ID}/${TOKEN}/messages/@original`);
    expect(edits[0].body).toEqual({ content: expect.stringContaining('Queued **Main\\_Warlock** on Hectic Add Cleave'), allowed_mentions: { parse: [] } });
  });

  it('accepts a typed label, defaults to Patchwerk at standard accuracy, and uses a guild pool only when the guild has one', async () => {
    const { redis } = fakeRedis();
    await call(redis, sim([{ name: 'character', type: 3, value: 'alt priest' }], inGuild(ALICE, POOL_GUILD)));
    await vi.waitFor(() => expect(edits).toHaveLength(1));
    const [, pooled] = mocks.enqueueJob.mock.calls[0];
    expect(pooled).toMatchObject({ userId: USER, guildId: POOL_GUILD });
    expect(pooled.request.settings.fightStyle).toBe('Patchwerk');
    expect(pooled.request.accuracy).toEqual(ACCURACY.standard);

    await call(redis, sim([{ name: 'character', type: 3, value: CHAR }], inGuild(ALICE, GUILD)));
    await vi.waitFor(() => expect(edits).toHaveLength(2));
    expect(mocks.enqueueJob.mock.calls[1][1]).toMatchObject({ userId: USER, guildId: null });
  });

  const refusals: [string, () => void, unknown[], RegExp][] = [
    ['an unlinked user', () => {}, [{ name: 'character', value: CHAR }], new RegExp(`^Link this Discord account to Frostsim first: ${ORIGIN}/#/account$`)],
    ['a user past 30 runs a minute', () => (world.submits = 30), [{ name: 'character', value: CHAR }], /^Too many cloud runs; wait a minute\.$/],
    ['an accuracy /sim does not offer', () => {}, [{ name: 'character', value: CHAR }, { name: 'accuracy', value: 'constructor' }], /Pick a fight/],
    ['an inherited accuracy key', () => {}, [{ name: 'character', value: CHAR }, { name: 'accuracy', value: '__proto__' }], /Pick a fight/],
    ['another user\'s character', () => {}, [{ name: 'character', value: 'Main Rogue' }], /No cloud character.*\/#\/account/],
    ['no character given', () => {}, [], /No cloud character/],
    ['a fight /sim does not offer', () => {}, [{ name: 'character', value: CHAR }, { name: 'fight', value: 'dungeon-route' }], /Pick a fight/],
    ['no engine pack', () => mocks.defaultPack.mockResolvedValue(null), [{ name: 'character', value: CHAR }], /no engine build ready/],
    ...([
      [402, 'not-entitled', 'No Frostsim Cloud plan covers this run.'],
      [402, 'no-allowance', 'The cloud allowance for this period is used up.'],
      [409, 'no-native-engine', 'This engine version has no cloud build yet.'],
      [429, 'too-many-jobs', 'At most 3 cloud runs can wait at once.'],
      [503, 'capacity', 'Every cloud worker is busy.'],
    ] as const).map(([status, code, message]): [string, () => void, unknown[], RegExp] => [
      `enqueue ${status} ${code}`,
      () => mocks.enqueueJob.mockResolvedValue({ ok: false, status, code, message }),
      [{ name: 'character', value: CHAR }],
      new RegExp(`^${message.replace(/[.]/g, '\\.')} ${ORIGIN}/#/account$`),
    ]),
  ];
  it.each(refusals)('refuses %s by editing the ephemeral reply, with a link', async (name, arrange, options, expected) => {
    arrange();
    const { store, redis } = fakeRedis();
    const who = name === 'an unlinked user' ? { user: { id: STRANGER } } : { user: { id: ALICE } };
    expect((await call(redis, sim(options, who))).body).toEqual({ type: 5, data: { flags: 64 } });
    await vi.waitFor(() => expect(edits).toHaveLength(1));
    expect(edits[0].body.content).toMatch(expected);
    expect(store.size).toBe(0);
  });

  it('cancels the job when the token cannot be kept, so nobody pays for a result that cannot be posted', async () => {
    await call(null, sim([{ name: 'character', value: CHAR }]));
    await vi.waitFor(() => expect(edits).toHaveLength(2));
    expect(mocks.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB, { userId: USER });
    expect(edits[1].body.content).toMatch(/cannot post results.*cancelled/);
  });

  it('retries an edit once when Discord has not registered the deferral yet (404)', async () => {
    editStatuses = [404];
    await call(null, sim([{ name: 'character', value: CHAR }], { user: { id: STRANGER } }));
    await vi.waitFor(() => expect(edits).toHaveLength(2), { timeout: 3000 });
    expect(edits[1].body).toEqual(edits[0].body);
    expect(edits[1].body.content).toMatch(/^Link this Discord account/);
  });

  it('turns an unexpected failure into an edit and a log line', async () => {
    mocks.defaultPack.mockRejectedValue(new Error('index unreadable'));
    await call(null, sim([{ name: 'character', value: CHAR }]));
    await vi.waitFor(() => expect(edits).toHaveLength(1));
    expect(edits[0].body.content).toMatch(/Something went wrong/);
    expect(logs).toEqual(['discord: /sim failed (Error: index unreadable)']);
  });
});

describe('character autocomplete', () => {
  const typing = (value: string, id = ALICE) =>
    ({ type: 4, data: { name: 'sim', options: [{ name: 'character', type: 3, value, focused: true }] }, user: { id } });

  it('offers only the invoker\'s own cloud characters matching what is typed, valued by id', async () => {
    expect((await call(null, typing('main'))).body).toEqual({ type: 8, data: { choices: [{ name: 'Main_Warlock', value: CHAR }] } });
    expect((await call(null, typing(''))).body.data.choices).toHaveLength(2);
  });

  it('offers nothing to an unlinked user', async () => {
    expect((await call(null, typing('main', STRANGER))).body).toEqual({ type: 8, data: { choices: [] } });
  });
});

describe('/link and /usage', () => {
  it('/link gives an unlinked user the Discord sign-in link and a linked one the account link, ephemerally', async () => {
    const unlinked = await call(null, command('link', [], { user: { id: STRANGER } }));
    expect(unlinked.body.type).toBe(4);
    expect(unlinked.body.data.flags).toBe(64);
    expect(unlinked.body.data.content).toBe(`Sign in to Frostsim with Discord, or link Discord to the account you already have, at ${ORIGIN}/#/account`);
    expect((await call(null, command('link'))).body.data.content).toBe(`This Discord account is linked to Frostsim. Manage it at ${ORIGIN}/#/account`);
  });

  it('/usage shows the personal allowance and, in a pooled guild, the guild pool', async () => {
    const res = await call(null, command('usage', [], inGuild(ALICE, POOL_GUILD)));
    expect(res.body.data).toMatchObject({ flags: 64 });
    expect(res.body.data.content).toBe([
      'You: 5.0 of 50.0 core-hours used, up to 16 threads a run, period ends 2026-10-23.',
      "This server's pool: 5.0 of 200.0 core-hours used, up to 8 threads a run, period ends 2026-10-23.",
    ].join('\n'));
  });

  it('/usage says so when there is no plan, and never shows a guild without a pool', async () => {
    world.subscriptions[USER] = [];
    const res = await call(null, command('usage', [], inGuild(ALICE, GUILD)));
    expect(res.body.data.content).toBe(`Your account has no Frostsim Cloud plan: ${ORIGIN}/#/account`);
    expect((await call(null, command('usage', [], { user: { id: STRANGER } }))).body.data.content).toMatch(/^Link this Discord account/);
  });
});

describe('/frostsim subscribe', () => {
  const subscribe = (where: object, extra: unknown[] = []) => command('frostsim', [{ name: 'subscribe', type: 1, options: extra }], where);

  it('mints a 15-minute guild-checkout token for a member with Manage Server', async () => {
    const res = await call(null, subscribe(inGuild(ALICE, GUILD, String(1 << 5))));
    expect(res.body.data.flags).toBe(64);
    const token = /#\/account\/guild\/(\S+)$/.exec(res.body.data.content)![1];
    expect(verify(SECRET, GUILD_CHECKOUT_PURPOSE, token, NOW)).toEqual({ kind: 'guild-checkout', guildId: GUILD, discordUserId: ALICE, exp: NOW_S + 900 });
  });

  it('accepts Administrator, refuses everyone else whatever the options claim, and refuses DMs', async () => {
    expect((await call(null, subscribe(inGuild(ALICE, GUILD, '8')))).body.data.content).toMatch(/#\/account\/guild\//);
    const noBit = (BigInt('0xFFFFFFFFFFFF') & ~(32n | 8n)).toString();
    const forged = await call(null, subscribe(inGuild(ALICE, GUILD, noBit), [{ name: 'permissions', type: 3, value: '32' }]));
    expect(forged.body.data.content).toBe('Only members with the Manage Server permission can subscribe this server.');
    expect((await call(null, subscribe({ user: { id: ALICE } }))).body.data.content).toBe('Run this in the Discord server you want to subscribe.');
  });

  it('reads the Manage Server bit from the decimal permission string', () => {
    expect(canManageGuild('32')).toBe(true);
    expect(canManageGuild((1n << 45n | 32n).toString())).toBe(true);
    expect(canManageGuild('8')).toBe(true);
    expect(canManageGuild('16')).toBe(false);
    expect(canManageGuild('0')).toBe(false);
    expect(canManageGuild(32)).toBe(false);
    expect(canManageGuild('0x20')).toBe(false);
    expect(canManageGuild(undefined)).toBe(false);
  });
});

describe('reply task', () => {
  const [task] = tasks;
  const done = (over: Partial<JobView> = {}): JobView => ({
    id: JOB, userId: USER, guildId: null, source: 'discord', status: 'done', lines: [], next: 0,
    summary: { dps: 223973.73, dpsError: 2137.6, iterations: 53 }, notices: [],
    effective: { threads: 16, args: [], profile: RAW }, createdAt: new Date(NOW - 120_000), finishedAt: new Date(NOW - 5000), ...over,
  });
  const pending = (exp = NOW + 600_000) => JSON.stringify({ token: TOKEN, label: 'Main_Warlock', presetId: 'patchwerk', exp });

  async function run(view: JobView | null, exp?: number) {
    const { store, redis } = fakeRedis();
    world.discordJobs = [JOB];
    store.set(`discord:${JOB}`, { value: pending(exp), ttl: TOKEN_TTL_S });
    mocks.jobView.mockResolvedValue(view);
    await task.run(deps(redis));
    return store;
  }

  it('posts DPS ± error with a hosted link for a personally entitled user, and forgets the token', async () => {
    world.subscriptions[USER] = [sub('compute_m_monthly')];
    mocks.resultBytes.mockResolvedValue(new Uint8Array(gzipSync(REPORT_TEXT)));
    mocks.storeShare.mockResolvedValue({ id: 'AbCdEfGhIjKlMnOpQrStUv' });
    const store = await run(done());
    expect(edits).toHaveLength(1);
    expect(edits[0].body.content).toBe(`**Main\\_Warlock** on Patchwerk: **223,974 DPS** ± 2,138 (95%)\nFull report: ${ORIGIN}/#/s/AbCdEfGhIjKlMnOpQrStUv`);
    expect(mocks.storeShare).toHaveBeenCalledWith(expect.anything(), { userId: USER, title: 'Main_Warlock · Patchwerk', gzipBytes: expect.any(Uint8Array) });
    expect(store.size).toBe(0);
  });

  it('posts no link without a hosted-shares plan, or when storing the share fails', async () => {
    world.subscriptions[USER] = [];
    await run(done());
    expect(mocks.storeShare).not.toHaveBeenCalled();
    expect(edits[0].body.content).toBe('**Main\\_Warlock** on Patchwerk: **223,974 DPS** ± 2,138 (95%)');

    edits = [];
    world.subscriptions[USER] = [sub('shares_plus_monthly')];
    mocks.resultBytes.mockResolvedValue(new Uint8Array(gzipSync(REPORT_TEXT)));
    mocks.storeShare.mockRejectedValue(new Error('R2 PUT failed with status 500'));
    await run(done());
    expect(edits[0].body.content).not.toContain('Full report');
    expect(logs.at(-1)).toBe(`discord: hosted share for job ${JOB} failed (Error: R2 PUT failed with status 500)`);
  });

  it('reports a failed or cancelled run', async () => {
    await run(done({ status: 'failed', summary: undefined, error: 'No cloud worker became available in time.' }));
    expect(edits[0].body.content).toBe('**Main\\_Warlock** on Patchwerk: the cloud run failed (No cloud worker became available in time.).');
    edits = [];
    await run(done({ status: 'cancelled', summary: undefined }));
    expect(edits[0].body.content).toBe('**Main\\_Warlock** on Patchwerk: the run was cancelled.');
  });

  it('waits on an unfinished job while the token has time left', async () => {
    const store = await run(done({ status: 'running', summary: undefined }));
    expect(edits).toHaveLength(0);
    expect(mocks.cancelJob).not.toHaveBeenCalled();
    expect(store.has(`discord:${JOB}`)).toBe(true);
  });

  it('cancels an unfinished job uncharged a minute before the token expires, and says so', async () => {
    const store = await run(done({ status: 'queued', summary: undefined }), NOW + 59_000);
    expect(mocks.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB, { userId: USER });
    expect(edits[0].body.content).toMatch(/did not finish within the 15 minutes.*cancelled and not charged/);
    expect(store.size).toBe(0);
  });

  it('posts the result instead when the job finished just before the cancel, and cancels guild jobs by guild', async () => {
    mocks.cancelJob.mockResolvedValue(false);
    const { store, redis } = fakeRedis();
    world.discordJobs = [JOB];
    world.subscriptions[USER] = [];
    store.set(`discord:${JOB}`, { value: pending(NOW + 1000), ttl: 60 });
    mocks.jobView.mockResolvedValueOnce(done({ status: 'running', guildId: POOL_GUILD, summary: undefined })).mockResolvedValueOnce(done({ guildId: POOL_GUILD }));
    await task.run(deps(redis));
    expect(mocks.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB, { guildId: POOL_GUILD });
    expect(edits[0].body.content).toMatch(/223,974 DPS/);
  });

  it('posts nothing when another instance takes the token between the read and the take', async () => {
    const { store, redis } = fakeRedis();
    world.discordJobs = [JOB];
    store.set(`discord:${JOB}`, { value: pending(), ttl: TOKEN_TTL_S });
    const read = redis.get.bind(redis);
    redis.get = (async (key: string) => {
      const value = await read(key);
      store.delete(key);
      return value;
    }) as Redis['get'];
    mocks.jobView.mockResolvedValue(done());
    await task.run(deps(redis));
    expect(edits).toHaveLength(0);
  });

  it('does nothing once the token has expired from Redis, and nothing at all without Redis', async () => {
    world.discordJobs = [JOB];
    await task.run(deps(fakeRedis().redis));
    expect(mocks.jobView).not.toHaveBeenCalled();
    await task.run(deps(null));
    expect(edits).toHaveLength(0);
  });

  it('logs a refused edit (the token already dead) without throwing, and still forgets it', async () => {
    editStatuses = [404];
    world.subscriptions[USER] = [];
    const store = await run(done());
    expect(logs).toEqual(['discord: editing a reply failed with status 404']);
    expect(store.size).toBe(0);
  });
});

describe('reply task retries and deadlines', () => {
  const [task] = tasks;
  const key = `discord:${JOB}`;
  const view: JobView = {
    id: JOB, userId: USER, guildId: null, source: 'discord', status: 'done', lines: [], next: 0,
    summary: { dps: 223973.73, dpsError: 2137.6, iterations: 53 }, notices: [],
    effective: { threads: 16, args: [], profile: RAW }, createdAt: new Date(NOW - 120_000), finishedAt: new Date(NOW - 5000),
  };
  const RESULT = `**Main\\_Warlock** on Patchwerk: **223,974 DPS** ± 2,138 (95%)`;

  it('keeps the settled reply for a later tick when Discord answers 5xx, 429 (after Retry-After) or is unreachable, with one share', async () => {
    const { store, redis } = fakeRedis();
    world.discordJobs = [JOB];
    mocks.resultBytes.mockResolvedValue(new Uint8Array(gzipSync(REPORT_TEXT)));
    mocks.storeShare.mockResolvedValue({ id: 'AbCdEfGhIjKlMnOpQrStUv' });
    mocks.jobView.mockResolvedValue(view);
    const posted = `${RESULT}\nFull report: ${ORIGIN}/#/s/AbCdEfGhIjKlMnOpQrStUv`;
    const exp = NOW + 600_000;
    store.set(key, { value: JSON.stringify({ token: TOKEN, label: 'Main_Warlock', presetId: 'patchwerk', exp }), ttl: TOKEN_TTL_S });

    editStatuses = [503, 429, 0];
    await task.run(deps(redis));
    expect(JSON.parse(store.get(key)!.value)).toMatchObject({ token: TOKEN, content: posted, after: NOW });
    expect(store.get(key)!.ttl).toBe(exp - NOW);
    await task.run(deps(redis));
    expect(JSON.parse(store.get(key)!.value)).toMatchObject({ content: posted, after: NOW + 5000 });
    await task.run(deps(redis, NOW + 4000));
    expect(edits).toHaveLength(2);
    await task.run(deps(redis, NOW + 5000));
    expect(store.has(key)).toBe(true);
    await task.run(deps(redis, NOW + 5000));
    expect(edits.map((e) => e.body.content)).toEqual([posted, posted, posted, posted]);
    expect(store.size).toBe(0);
    expect(mocks.jobView).toHaveBeenCalledTimes(1);
    expect(mocks.storeShare).toHaveBeenCalledTimes(1);
  });

  it('posts without the link when the hosted share outlasts its deadline', async () => {
    const { store, redis } = fakeRedis();
    world.discordJobs = [JOB];
    mocks.resultBytes.mockReturnValue(new Promise(() => {}));
    mocks.jobView.mockResolvedValue(view);
    store.set(key, { value: JSON.stringify({ token: TOKEN, label: 'Main_Warlock', presetId: 'patchwerk', exp: NOW + 600_000 }), ttl: TOKEN_TTL_S });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const running = task.run(deps(redis));
      await vi.advanceTimersByTimeAsync(20_000);
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(edits.map((e) => e.body.content)).toEqual([RESULT]);
    expect(logs).toContain(`discord: hosted share for job ${JOB} took over 20 s; posted without it`);
  });
});

describe('shareBytes', () => {
  it('builds the portable hosted payload the viewer validates, with the raw report', async () => {
    const view = { notices: ['Moderate: something odd'], effective: { threads: 16, args: [], profile: RAW }, createdAt: new Date(NOW - 60_000), finishedAt: new Date(NOW) };
    const file = JSON.parse(gunzipSync(await shareBytes(REPORT_TEXT, view)).toString('utf8'));
    expect(file).toMatchObject({ format: 'frostsim', version: 1, kind: 'report' });
    expect(file.payload.rawReport).toBe(REPORT_TEXT);
    const shared = validateReport(file.payload.shared);
    expect(shared.d).toBe(REPORT.sim.players[0].collected_data.dps.mean);
    expect(shared.c).toBe('Frost Mage');
    expect(shared.elapsed).toBe(60);
    expect(shared.gear.length).toBeGreaterThan(0);
    expect(shared.w).toContainEqual({ level: 'moderate', message: 'something odd', kind: 'problem' });
  });
});

describe('shareBytes caps', () => {
  it('drops the raw report when the inflated payload would pass storeShare\'s 32 MiB JSON cap, though it gzips small', async () => {
    const view = { notices: [], effective: { threads: 16, args: [], profile: RAW }, createdAt: new Date(NOW - 60_000), finishedAt: new Date(NOW) };
    // Trailing whitespace keeps it valid JSON and compresses to almost nothing.
    const gz = await shareBytes(REPORT_TEXT + ' '.repeat(32 << 20), view);
    expect(gz.byteLength).toBeLessThan(1 << 20);
    expect(JSON.parse(gunzipSync(gz).toString('utf8')).payload.rawReport).toBeNull();
  });
});

describe('command registration (scripts/discord-register-commands.mjs)', () => {
  it('offers exactly the fights and accuracies the handler accepts, under the preset labels', () => {
    expect(FIGHTS.map(([id]: string[]) => id)).toEqual(SIM_FIGHTS);
    for (const [id, label] of FIGHTS) expect(label).toBe(findPreset(id)?.label);
    expect(ACCURACIES.map(([id]: string[]) => id)).toEqual(Object.keys(ACCURACY));
  });

  it('names the options the handler reads and keeps within Discord\'s limits', () => {
    const sim = COMMANDS[0] as { options: { name: string; choices?: unknown[] }[] };
    expect(sim.options.map((o: { name: string }) => o.name)).toEqual(['character', 'fight', 'accuracy']);
    expect(sim.options[0]).toMatchObject({ required: true, autocomplete: true });
    expect(COMMANDS.find((c: { name: string }) => c.name === 'frostsim')).toMatchObject({ default_member_permissions: '32', options: [{ type: 1, name: 'subscribe' }] });
    const texts = JSON.stringify(COMMANDS).match(/"(description|name)":"[^"]*"/g) ?? [];
    for (const t of texts) expect(t.length).toBeLessThan(120);
    expect(sim.options[1].choices?.length).toBeLessThanOrEqual(25);
  });

  it('registers only commands the handler answers', async () => {
    for (const { name } of COMMANDS) {
      const options = name === 'frostsim' ? [{ name: 'subscribe', type: 1 }] : [];
      const { body } = await call(fakeRedis().redis, command(name, options, inGuild(ALICE, GUILD, '32')));
      expect(body.type === 5 || body.data.content !== 'Unknown command.').toBe(true);
    }
    // /sim's background edit, so it cannot land in the next test.
    await vi.waitFor(() => expect(edits).toHaveLength(1));
  });

  it('PUTs the list globally, or to one guild, with the bot token', async () => {
    const seen: Request[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => (seen.push(new Request(input, init)), new Response('[]'))) as typeof fetch;
    await register({ applicationId: APP_ID, botToken: 'bot-token', fetchFn });
    await register({ applicationId: APP_ID, botToken: 'bot-token', guildId: GUILD, fetchFn });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT https://discord.com/api/v10/applications/${APP_ID}/commands`,
      `PUT https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands`,
    ]);
    expect(seen[0].headers.get('authorization')).toBe('Bot bot-token');
    expect(await seen[0].json()).toEqual(COMMANDS);
  });
});
