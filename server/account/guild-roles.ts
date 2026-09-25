// Per-role compute allowances inside a Discord server's pool (CLAUDE.md D15). The member who pays for the server's plan sets, per
// Discord role, how much of the pool each member may use a month. A role set explicitly overrides @everyone; among a member's
// explicit roles the largest allowance wins. /sim checks it before a run draws on the pool (discord.ts).

import type { AppCtx, RequestCtx, Route, Task } from './app';
import { audit } from './audit';
import type { Db } from './db';
import { loadEntitlements } from './entitlements';
import { HttpError, errorSummary, json } from './http';
import { usedCoreSeconds } from './usage';

const API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
/** Discord allows 250 roles a server. */
const MAX_ROLES = 250;
/** A month of 32 cores: far past any plan, small enough for an integer column. */
const MAX_CORE_SECONDS = 32 * 31 * 86_400;
const LIVE = ['active', 'trialing', 'past_due'];

/** role id -> core-seconds a month, null for "up to the pool". */
export type RoleLimits = Record<string, number | null>;

/** A member's monthly allowance from the server's limits and their role ids: null when unlimited (up to the pool). */
export function memberAllowance(guildId: string, limits: RoleLimits, roleIds: readonly string[]): number | null {
  const explicit = roleIds.filter((id) => id !== guildId && Object.hasOwn(limits, id)).map((id) => limits[id]);
  const apply = explicit.length ? explicit : Object.hasOwn(limits, guildId) ? [limits[guildId]] : [null];
  return apply.includes(null) ? null : Math.max(...(apply as number[]));
}

export async function roleLimits(db: Db, guildId: string): Promise<RoleLimits> {
  const rows = await db`select role_id, core_seconds from guild_role_limits where guild_id = ${guildId}`;
  return Object.fromEntries(rows.map((r) => [r.role_id, r.core_seconds]));
}

/** Why this member may not draw on the pool right now, or null. `pool` is the guild's live entitlement. */
export async function memberRefusal(app: Pick<AppCtx, 'sql'>, guildId: string, userId: string, roleIds: readonly string[],
  pool: { periodStart: Date; periodEnd: Date }): Promise<string | null> {
  const allowance = memberAllowance(guildId, await roleLimits(app.sql, guildId), roleIds);
  if (allowance === null) return null;
  if (allowance === 0) return "Your roles in this server don't include its cloud runs.";
  // ponytail: checked before the enqueue, so two /sim at once can both pass and overrun by one run; lock per member if that matters.
  const used = await usedCoreSeconds(app.sql, { guildId, userId }, pool.periodStart, pool.periodEnd);
  return used >= allowance ? "You've used your share of this server's cloud runs this month." : null;
}

/** Guilds whose live subscription this user pays for: only the payer configures them. */
async function paidGuilds(db: Db, userId: string): Promise<string[]> {
  const rows = await db`select distinct guild_id from subscriptions where user_id = ${userId} and guild_id is not null and status in ${db(LIVE)}`;
  return rows.map((r) => r.guild_id);
}

interface DiscordRole { id: string; name: string; color: number; position: number; managed: boolean }

/** The server's name and roles through the bot; null when the bot is not in it (or Discord is unreachable). */
async function discordGuild(app: AppCtx, guildId: string): Promise<{ name: string; icon: string | null; roles: DiscordRole[] } | null> {
  const get = (path: string) => app.fetch(`${API}${path}`, {
    headers: { authorization: `Bot ${app.config.env.DISCORD_BOT_TOKEN ?? ''}` }, signal: AbortSignal.timeout(10_000),
  });
  try {
    const [g, r] = await Promise.all([get(`/guilds/${guildId}`), get(`/guilds/${guildId}/roles`)]);
    if (!g.ok || !r.ok) {
      await Promise.all([g.body?.cancel(), r.body?.cancel()]);
      return null;
    }
    const guild = (await g.json()) as { name?: string; icon?: string | null };
    const roles = (await r.json()) as DiscordRole[];
    return { name: String(guild.name ?? guildId), icon: guild.icon ?? null, roles };
  } catch (err) {
    app.log(`discord: reading guild ${guildId} failed (${errorSummary(err)})`);
    return null;
  }
}

async function guildView(ctx: RequestCtx, guildId: string) {
  const [pool] = (await loadEntitlements(ctx.sql, { guildId }, ctx.now())).guilds;
  const [discord, limits, used] = await Promise.all([
    discordGuild(ctx, guildId),
    roleLimits(ctx.sql, guildId),
    pool ? usedCoreSeconds(ctx.sql, { guildId }, pool.periodStart, pool.periodEnd) : 0,
  ]);
  // Bot-managed roles belong to integrations, never to members; highest first, as Discord lists them.
  const roles = (discord?.roles ?? []).filter((r) => !r.managed).sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.id === guildId ? '@everyone' : r.name, color: r.color }));
  return {
    guildId, name: discord?.name ?? null, icon: discord?.icon ?? null, botPresent: discord !== null, roles, limits,
    pool: pool ? { coreSeconds: pool.coreSeconds, usedCoreSeconds: used, periodEnd: pool.periodEnd } : null,
  };
}

export function parseLimits(body: unknown): RoleLimits {
  const limits = (body as { limits?: unknown } | null)?.limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new HttpError(400, 'invalid', 'limits must be an object.');
  const entries = Object.entries(limits);
  if (entries.length > MAX_ROLES) throw new HttpError(400, 'invalid', `At most ${MAX_ROLES} roles.`);
  for (const [roleId, value] of entries) {
    if (!SNOWFLAKE.test(roleId)) throw new HttpError(400, 'invalid', 'A role id is not a Discord id.');
    if (value !== null && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CORE_SECONDS)) {
      throw new HttpError(400, 'invalid', 'An allowance is not a whole number of core-seconds.');
    }
  }
  return Object.fromEntries(entries) as RoleLimits;
}

async function ownGuild(ctx: RequestCtx): Promise<string> {
  const guildId = ctx.params.guildId;
  if (!(await paidGuilds(ctx.sql, ctx.session!.userId)).includes(guildId)) {
    throw new HttpError(404, 'not-found', 'You do not pay for a Frostsim plan on this server.');
  }
  return guildId;
}

const ONE = /^\/api\/v1\/discord\/guilds\/(?<guildId>\d{17,20})$/;

export const routes: Route[] = [
  {
    method: 'GET', path: /^\/api\/v1\/discord\/guilds$/, feature: 'discord', auth: 'session',
    handler: async (ctx) => json({ guilds: await Promise.all((await paidGuilds(ctx.sql, ctx.session!.userId)).map((id) => guildView(ctx, id))) }),
  },
  {
    method: 'PUT', path: ONE, feature: 'discord', auth: 'session',
    handler: async (ctx) => {
      const guildId = await ownGuild(ctx);
      const limits = parseLimits(await ctx.json());
      await ctx.sql.begin(async (tx) => {
        await tx`delete from guild_role_limits where guild_id = ${guildId}`;
        const rows = Object.entries(limits).map(([role_id, core_seconds]) => ({ guild_id: guildId, role_id, core_seconds }));
        if (rows.length) await tx`insert into guild_role_limits ${tx(rows)}`;
        await audit(tx, { userId: ctx.session!.userId, actor: `user:${ctx.session!.userId}`, action: 'discord.roles.update', detail: { guildId, limits } });
      });
      return json(await guildView(ctx, guildId));
    },
  },
];

export const tasks: Task[] = [];
