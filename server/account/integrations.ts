// The Loothing integration under /api/v1/integrations/loothing (CLAUDE.md D15; DESIGN.md P2, P3): Loothing's bot
// calls with one bearer token (only its sha256 is configured) on behalf of a Discord user, who must have linked Discord to Frostsim
// AND allowed Loothing in the account dialog. Jobs draw on that user's own allowance through the same enqueueJob as every source, and
// Loothing can read back only the jobs it created for that Discord user. Every call leaves one audit row (actor 'loothing').

import type { RequestCtx, Route, Task } from './app';
import { audit } from './audit';
import { HttpError, bearer, errorSummary, json } from './http';
import { rateLimit } from './ratelimit';
import { safeEqual, sha256Hex } from './signed';
import { enqueueJob, jobView } from './compute/queue';
import { defaultPack } from './compute/packs';
import { ACCURACY, SIM_FIGHTS, characterRequest, linkedUser, manageUrl } from './discord';

const SNOWFLAKE = /^\d{17,20}$/;
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
    throw new HttpError(429, 'rate-limited', 'Too many requests for this Discord user. Try again in a minute.');
  }
  const userId = await linkedUser(ctx, discordId);
  if (!userId) return refusal('not-linked', 'This Discord account is not linked to Frostsim.', manageUrl(ctx.config));
  call.userId = userId;
  const [grant] = await ctx.sql`select 1 from integration_grants where user_id = ${userId} and integration = 'loothing'`;
  if (!grant) return refusal('not-granted', 'This Frostsim account has not allowed Loothing.', manageUrl(ctx.config));
  return userId;
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
      const rows = await ctx.sql`select id, label, updated_at from cloud_characters where user_id = ${userId} order by updated_at desc`;
      return json({ characters: rows.map((r) => ({ id: r.id, label: r.label, updatedAt: r.updated_at })) });
    }),
  },
  {
    method: 'POST', path: /^\/api\/v1\/integrations\/loothing\/jobs$/, feature: 'discord', auth: 'loothing',
    handler: audited('loothing.job.create', async (ctx, call) => {
      const { discordId, characterId, preset } = await body(ctx);
      const userId = await account(ctx, call, discordId);
      if (typeof userId !== 'string') return userId;
      if (typeof preset !== 'string' || !SIM_FIGHTS.includes(preset)) throw new HttpError(400, 'invalid', `preset must be one of ${SIM_FIGHTS.join(', ')}.`);
      if (typeof characterId !== 'string' || !characterId) throw new HttpError(400, 'invalid', 'characterId must be a cloud character id.');
      call.detail.preset = preset;
      const built = await characterRequest(ctx.sql, userId, characterId, preset, ACCURACY.standard);
      if (!built) throw new HttpError(404, 'not-found', 'No such cloud character.');
      const packId = await defaultPack(ctx);
      if (!packId) throw new HttpError(409, 'no-native-engine', 'Frostsim Cloud has no engine build ready.');
      const job = await enqueueJob(ctx, { userId, guildId: null, source: 'loothing', packId, request: built.request });
      if (!job.ok) return json({ error: job.code, message: job.message }, job.status);
      call.detail.jobId = job.id;
      return json({ id: job.id }, 201);
    }),
  },
  {
    method: 'GET', path: /^\/api\/v1\/integrations\/loothing\/jobs\/(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    feature: 'discord', auth: 'loothing',
    handler: audited('loothing.job.read', async (ctx, call) => {
      call.detail.jobId = ctx.params.id;
      const userId = await account(ctx, call, ctx.url.searchParams.get('discordId'));
      if (typeof userId !== 'string') return userId;
      const view = await jobView(ctx, ctx.params.id);
      // Only what Loothing itself started for this Discord user: never a web or Discord job, nor a guild's.
      if (!view || view.source !== 'loothing' || view.userId !== userId || view.guildId) throw new HttpError(404, 'not-found', 'No such job.');
      const { id, status, position, error, summary, createdAt, finishedAt } = view;
      return json({ id, status, position, error, summary, createdAt, finishedAt });
    }),
  },
];

export const tasks: Task[] = [];
