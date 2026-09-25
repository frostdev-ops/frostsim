// The Loothing integration under /api/v1/integrations/loothing (CLAUDE.md D15; DESIGN.md P2, P3): Loothing's bot
// calls with one bearer token (only its sha256 is configured) on behalf of a Discord user, who must have linked Discord to Frostsim
// AND allowed Loothing in the account dialog. Jobs draw on that user's own allowance through the same enqueueJob as every source, and
// Loothing can read back, list and cancel only the jobs it created for that Discord user. Every call leaves one audit row (actor 'loothing').
//
// Contract agreed with the Loothing bot (2026-09-25): POST /jobs takes an Idempotency-Key (the Discord interaction id), so a retried
// create maps to the first job (200) instead of a second paid run; 429 and 503 carry Retry-After; the job object echoes the slot and
// fight; DELETE cancels; GET /jobs lists the last day's jobs so a restarted bot worker can recover a reply it lost.
//
// Extended for Loothing's Discord agent (2026-09-25): POST /jobs takes `characterIds` (2-4 slots, one compare job) in place of
// `characterId`, and an optional `origin` ('agent' | 'command') kept in the audit row only; GET /jobs takes `days` (1-30) and `limit`
// (1-100); GET /jobs/:id/detail is the compact report (loothing-detail.ts) while the result is kept (1 day, then 410); /resolve
// also returns each slot's name, class, spec, realm, region and item level.

import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import type { RequestCtx, Route, Task } from './app';
import { audit } from './audit';
import { HttpError, bearer, errorSummary, json } from './http';
import { rateLimit } from './ratelimit';
import { safeEqual, sha256Hex } from './signed';
import { cancelJob, enqueueJob, resultBytes } from './compute/queue';
import { defaultPack } from './compute/packs';
import { ACCURACY, COMPARE_SLOTS, SIM_FIGHTS, characterRequest, linkedUser, manageUrl } from './discord';
import { loothingDetail } from './loothing-detail';
import { MAX_SHARE_JSON } from './shares';
import { parseAddonExport } from '../../src/lib/import/character';
import type { SimRequest } from '../../src/lib/simc/assemble';
import { compareRequest } from '../../src/lib/simc/quick-request';

const inflate = promisify(gunzip);

const SNOWFLAKE = /^\d{17,20}$/;
const JOB_ID = '(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** Seconds a caller should wait, by refusal code. A hint: capacity can free up sooner. */
export const RETRY_AFTER: Readonly<Record<string, number>> = { 'rate-limited': 60, 'too-many-jobs': 15, capacity: 30, 'compute-disabled': 30 };
const retryHeaders = (code: string): HeadersInit => (RETRY_AFTER[code] ? { 'retry-after': String(RETRY_AFTER[code]) } : {});
const DAY_MS = 24 * 3600_000;
/** GET /jobs: `days` 1-30 (default 1) and `limit` 1-100 (default 20). The summary is kept for good; the full result for a day. */
const LIST_DAYS_MAX = 30;
const LIST_DEFAULT = 20;
const LIST_MAX = 100;
const ORIGINS = ['agent', 'command'];
/** Per Discord user: about one status poll a second plus the odd resolve and job. */
const CALLS_PER_MINUTE = 120;

/** `auth: 'loothing'`: the bearer token's sha256 equals LOOTHING_TOKEN_SHA256, compared in constant time. */
export async function resolveLoothing(ctx: RequestCtx): Promise<boolean> {
  const expected = ctx.config.env.LOOTHING_TOKEN_SHA256?.toLowerCase();
  const token = bearer(ctx.request);
  if (!expected || !token) return false;
  return safeEqual(sha256Hex(token), expected);
}

interface Call { userId: string | null; detail: Record<string, string | number> }

/** Wraps a handler so every outcome, refusals and errors included, is audited with its status. */
function audited(action: string, run: (ctx: RequestCtx, call: Call) => Promise<Response>): (ctx: RequestCtx) => Promise<Response> {
  return async (ctx) => {
    const call: Call = { userId: null, detail: {} };
    let status = 500;
    try {
      const res = await run(ctx, call);
      status = res.status;
      return res;
    } catch (err) {
      if (err instanceof HttpError) status = err.status;
      throw err;
    } finally {
      // The call's own answer stands: a lost audit row must not turn a created job into a 500 that Loothing retries (a second charge).
      await audit(ctx.sql, { userId: call.userId, actor: 'loothing', action, detail: { ...call.detail, status } })
        .catch((err) => ctx.log(`loothing: audit of ${action} failed (${errorSummary(err)})`));
    }
  };
}

/** 403 with where the user can fix it: Loothing shows the url to that Discord user. */
const refusal = (error: 'not-linked' | 'not-granted', message: string, url: string) => json({ error, message, url }, 403);

/** The Frostsim user behind `discordId`, or the refusal to send. */
async function account(ctx: RequestCtx, call: Call, discordId: unknown): Promise<string | Response> {
  if (typeof discordId !== 'string' || !SNOWFLAKE.test(discordId)) throw new HttpError(400, 'invalid', 'discordId must be a Discord user id.');
  call.detail.discordId = discordId;
  if (!(await rateLimit(ctx, 'loothing', discordId, CALLS_PER_MINUTE, 60))) {
    throw new HttpError(429, 'rate-limited', 'Too many requests for this Discord user. Try again in a minute.', retryHeaders('rate-limited'));
  }
  const userId = await linkedUser(ctx, discordId);
  if (!userId) return refusal('not-linked', 'This Discord account is not linked to Frostsim.', manageUrl(ctx.config));
  call.userId = userId;
  const [grant] = await ctx.sql`select 1 from integration_grants where user_id = ${userId} and integration = 'loothing'`;
  if (!grant) return refusal('not-granted', 'This Frostsim account has not allowed Loothing.', manageUrl(ctx.config));
  return userId;
}

/** What Loothing sees of a job: its own fields plus the slot and fight, so a reply can be rebuilt from the job alone. */
export interface LoothingJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  position?: number;
  error?: string;
  summary?: { dps?: number; dpsError?: number; iterations?: number };
  characterId: string | null;
  characterLabel: string | null;
  fightStyle: string | null;
  createdAt: Date;
  finishedAt?: Date;
}

/** Loothing's own jobs for one user: by id, or the last `days` newest first. Never a web, Discord or guild job. */
async function loothingJobs(ctx: RequestCtx, userId: string, id?: string, days = 1, limit = LIST_DEFAULT): Promise<LoothingJob[]> {
  const since = new Date(ctx.now().getTime() - days * DAY_MS);
  const rows = await ctx.sql`select j.id, j.status, j.error, j.summary, j.character_id, c.label, j.request->'settings'->>'fightStyle' as fight_style,
      j.created_at, j.finished_at,
      case when j.status = 'queued' then (select count(*)::int from compute_jobs q where q.status = 'queued' and q.created_at <= j.created_at) end as position
    from compute_jobs j left join cloud_characters c on c.id = j.character_id and c.user_id = j.user_id
    where j.source = 'loothing' and j.user_id = ${userId} and j.guild_id is null
      and ${id ? ctx.sql`j.id = ${id}` : ctx.sql`j.created_at > ${since}`}
    order by j.created_at desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    ...(r.position != null ? { position: r.position } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.summary && Object.keys(r.summary).length ? { summary: r.summary } : {}),
    characterId: r.character_id ?? null,
    characterLabel: r.label ?? null,
    fightStyle: r.fight_style ?? null,
    createdAt: r.created_at,
    ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
  }));
}

/** An integer query parameter in [1, max], or `fallback` when absent. */
function bounded(ctx: RequestCtx, name: string, max: number, fallback: number): number {
  const value = ctx.url.searchParams.get(name);
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, 'invalid', `${name} must be a whole number from 1 to ${max}.`);
  return n;
}

/** One compare job's request from 2-4 of the user's slots; null when any id is not theirs. */
async function compareOf(ctx: RequestCtx, userId: string, ids: string[], presetId: string): Promise<SimRequest | null> {
  // A user has a handful of slots: read them all rather than bind an array.
  const rows = await ctx.sql`select id, raw from cloud_characters where user_id = ${userId}`;
  const byId = new Map(rows.map((r) => [String(r.id), r.raw as string]));
  if (!ids.every((id) => byId.has(id))) return null;
  return compareRequest(ids.map((id) => parseAddonExport(byId.get(id)!)), { presetId, threads: 1, accuracy: ACCURACY.standard });
}

const body = async (ctx: RequestCtx) => {
  const value = await ctx.json<unknown>();
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
};

export const routes: Route[] = [
  {
    method: 'POST', path: /^\/api\/v1\/integrations\/loothing\/resolve$/, feature: 'discord', auth: 'loothing',
    handler: audited('loothing.resolve', async (ctx, call) => {
      const userId = await account(ctx, call, (await body(ctx)).discordId);
      if (typeof userId !== 'string') return userId;
      const rows = await ctx.sql`select c.id, c.label, c.updated_at, c.who, s.item_level from cloud_characters c
        left join lateral (select item_level from character_snapshots where character_id = c.id order by created_at desc limit 1) s on true
        where c.user_id = ${userId} order by c.updated_at desc`;
      // `who` is read from the export at save time (characters.ts); older slots may lack it.
      return json({ characters: rows.map((r) => ({
        id: r.id, label: r.label, updatedAt: r.updated_at,
        ...(r.who?.name ? { name: r.who.name } : {}), ...(r.who?.className ? { class: r.who.className } : {}),
        ...(r.who?.spec ? { spec: r.who.spec } : {}), ...(r.who?.server ? { realm: r.who.server } : {}),
        ...(r.who?.region ? { region: r.who.region } : {}), ...(r.item_level != null ? { itemLevel: r.item_level } : {}),
      })) });
    }),
  },
  {
    method: 'POST', path: /^\/api\/v1\/integrations\/loothing\/jobs$/, feature: 'discord', auth: 'loothing',
    handler: audited('loothing.job.create', async (ctx, call) => {
      const { discordId, characterId, characterIds, preset, origin } = await body(ctx);
      const key = ctx.request.headers.get('idempotency-key');
      if (key !== null && !IDEMPOTENCY_KEY.test(key)) throw new HttpError(400, 'invalid', 'Idempotency-Key must be 1-64 of A-Z, a-z, 0-9, _ and -.');
      const userId = await account(ctx, call, discordId);
      if (typeof userId !== 'string') return userId;
      const repeat = async () => {
        if (key === null) return null;
        const [row] = await ctx.sql`select id from compute_jobs where source = 'loothing' and user_id = ${userId} and idempotency_key = ${key}`;
        if (row) call.detail.jobId = row.id;
        return row ? json({ id: row.id }, 200) : null;
      };
      const earlier = await repeat();
      if (earlier) {
        call.detail.repeat = 1;
        return earlier;
      }
      if (typeof preset !== 'string' || !SIM_FIGHTS.includes(preset)) throw new HttpError(400, 'invalid', `preset must be one of ${SIM_FIGHTS.join(', ')}.`);
      if (origin !== undefined && !ORIGINS.includes(origin as string)) throw new HttpError(400, 'invalid', `origin must be one of ${ORIGINS.join(', ')}.`);
      call.detail.preset = preset;
      if (origin) call.detail.origin = origin as string;
      let built: { id?: string; request: SimRequest } | null;
      if (characterIds !== undefined) {
        const ids = Array.isArray(characterIds) ? characterIds : [];
        if (characterId !== undefined || ids.length < 2 || ids.length > COMPARE_SLOTS.length || new Set(ids).size !== ids.length
          || !ids.every((id) => typeof id === 'string' && id)) {
          throw new HttpError(400, 'invalid', `characterIds must be 2-${COMPARE_SLOTS.length} different cloud character ids, without characterId.`);
        }
        call.detail.characters = ids.length;
        try {
          const request = await compareOf(ctx, userId, ids as string[], preset);
          built = request && { request };
        } catch (err) {
          // compareRequest refuses a set it cannot run together (multi-actor.ts), with a reason the user can act on.
          throw new HttpError(422, 'unbuildable', err instanceof Error ? err.message.slice(0, 300) : 'That comparison could not be built.');
        }
      } else {
        if (typeof characterId !== 'string' || !characterId) throw new HttpError(400, 'invalid', 'characterId must be a cloud character id.');
        built = await characterRequest(ctx.sql, userId, characterId, preset, ACCURACY.standard);
      }
      if (!built) throw new HttpError(404, 'not-found', 'No such cloud character.');
      const packId = await defaultPack(ctx);
      if (!packId) throw new HttpError(409, 'no-native-engine', 'Frostsim Cloud has no engine build ready.');
      let job;
      try {
        job = await enqueueJob(ctx, { userId, guildId: null, source: 'loothing', packId, request: built.request, characterId: built.id, idempotencyKey: key });
      } catch (err) {
        // Two concurrent creates with one key: the unique index lets one in; this one answers with it.
        const winner = (err as { code?: string })?.code === '23505' ? await repeat() : null;
        if (winner) return winner;
        throw err;
      }
      if (!job.ok) return json({ error: job.code, message: job.message }, job.status, retryHeaders(job.code));
      call.detail.jobId = job.id;
      return json({ id: job.id }, 201);
    }),
  },
  {
    method: 'GET', path: /^\/api\/v1\/integrations\/loothing\/jobs$/, feature: 'discord', auth: 'loothing',
    handler: audited('loothing.job.list', async (ctx, call) => {
      const userId = await account(ctx, call, ctx.url.searchParams.get('discordId'));
      if (typeof userId !== 'string') return userId;
      const days = bounded(ctx, 'days', LIST_DAYS_MAX, 1);
      const limit = bounded(ctx, 'limit', LIST_MAX, LIST_DEFAULT);
      return json({ jobs: await loothingJobs(ctx, userId, undefined, days, limit) });
    }),
  },
  {
    method: 'GET', path: new RegExp(`^/api/v1/integrations/loothing/jobs/${JOB_ID}$`), feature: 'discord', auth: 'loothing',
    handler: audited('loothing.job.read', async (ctx, call) => {
      call.detail.jobId = ctx.params.id;
      const userId = await account(ctx, call, ctx.url.searchParams.get('discordId'));
      if (typeof userId !== 'string') return userId;
      // Only what Loothing itself started for this Discord user: never a web or Discord job, nor a guild's.
      const [job] = await loothingJobs(ctx, userId, ctx.params.id);
      if (!job) throw new HttpError(404, 'not-found', 'No such job.');
      return json(job);
    }),
  },
  {
    method: 'GET', path: new RegExp(`^/api/v1/integrations/loothing/jobs/${JOB_ID}/detail$`), feature: 'discord', auth: 'loothing',
    handler: audited('loothing.job.detail', async (ctx, call) => {
      call.detail.jobId = ctx.params.id;
      const userId = await account(ctx, call, ctx.url.searchParams.get('discordId'));
      if (typeof userId !== 'string') return userId;
      const [job] = await loothingJobs(ctx, userId, ctx.params.id);
      if (!job) throw new HttpError(404, 'not-found', 'No such job.');
      if (job.status !== 'done') throw new HttpError(409, 'not-done', `The run is ${job.status}; detail exists only for a finished run.`);
      const gz = await resultBytes(ctx, job.id);
      if (!gz) throw new HttpError(410, 'expired', 'The full result is kept for one day; only the summary remains.');
      const raw = JSON.parse((await inflate(gz, { maxOutputLength: MAX_SHARE_JSON })).toString('utf8'));
      return json({ id: job.id, ...loothingDetail(raw) });
    }),
  },
  {
    method: 'DELETE', path: new RegExp(`^/api/v1/integrations/loothing/jobs/${JOB_ID}$`), feature: 'discord', auth: 'loothing',
    handler: audited('loothing.job.cancel', async (ctx, call) => {
      call.detail.jobId = ctx.params.id;
      const userId = await account(ctx, call, ctx.url.searchParams.get('discordId'));
      if (typeof userId !== 'string') return userId;
      const [job] = await loothingJobs(ctx, userId, ctx.params.id);
      if (!job) throw new HttpError(404, 'not-found', 'No such job.');
      // A queued job cancels free; a running one is metered to now (queue.ts cancelJob).
      if (!(await cancelJob(ctx, job.id, { userId }))) throw new HttpError(409, 'finished', 'That run has already finished.');
      return json({ id: job.id, status: 'cancelled' });
    }),
  },
];

export const tasks: Task[] = [];
