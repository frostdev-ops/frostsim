// The standalone Discord bot as an HTTP interactions endpoint (CLAUDE.md D15; DESIGN.md A8, P2, P3, P5): Ed25519
// over the exact raw body, then /sim (deferred, run as a cloud job, answered by editing the reply), /link, /usage and
// /frostsim subscribe. Every reply is ephemeral: it may name the invoker's characters, allowance or a checkout link. A Discord user
// is a Frostsim user through identities(provider 'discord', subject = user id); nothing here reads another user's rows.

import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { AppCtx, RequestCtx, Route, Task } from './app';
import { GUILD_CHECKOUT_PURPOSE } from './billing';
import type { Config } from './config';
import type { Db } from './db';
import { loadEntitlements, type GuildEntitlement } from './entitlements';
import { memberAllowance, memberRefusal, roleLimits } from './guild-roles';
import { HttpError, errorSummary, json } from './http';
import { tryRedis } from './redis';
import { MAX_SHARE_JSON, MAX_UPLOAD, storeShare } from './shares';
import { sign } from './signed';
import { usedCoreSeconds } from './usage';
import { cancelJob, enqueueJob, jobView, resultBytes, type JobView } from './compute/queue';
import { defaultPack } from './compute/packs';
import { submitAllowed } from './compute/routes';
import { ALLOWED_REGIONS, characterProfilePath } from '../../src/lib/battlenet/contract';
import { parseAddonExport } from '../../src/lib/import/character';
import type { SimRequest } from '../../src/lib/simc/assemble';
import { parsePlayerDetail } from '../../src/lib/simc/detail';
import { DEFAULT_ACCURACY, type Accuracy } from '../../src/lib/simc/options';
import { FIGHT_PRESETS, findPreset } from '../../src/lib/simc/presets';
import { quickRequest } from '../../src/lib/simc/quick-request';
import { parseEngineNotice, parseReport, type ReportLog } from '../../src/lib/simc/report';
import { makePortable } from '../../src/lib/store/records';
import { reportSnapshot } from '../../src/lib/store/report-share';

const API = 'https://discord.com/api/v10';
// Interaction and callback types (discord-api-docs interactions/receiving-and-responding).
const PING = 1;
const COMMAND = 2;
const AUTOCOMPLETE = 4;
const PONG = 1;
const MESSAGE = 4;
const DEFERRED = 5;
const CHOICES = 8;
const EPHEMERAL = 64;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
/** A captured request replays only this long. Discord signs every delivery afresh, so a live one is always inside it. */
const SIGNATURE_SKEW_S = 300;
/** Discord's interaction token lifetime; also the TTL of `discord:<jobId>`. */
export const TOKEN_TTL_S = 900;
/** The last edit must land before the token dies, and the task runs every few seconds. */
const EDIT_MARGIN_MS = 60_000;
/** The task posts replies one after another: a slow hosted share must not push the ones behind it past their tokens. */
const LINK_DEADLINE_MS = 20_000;
/** How long /sim waits before its one retry of an edit Discord refused because the deferral had not registered yet. */
const DEFERRAL_WAIT_MS = 1000;
const SNOWFLAKE = /^\d{17,20}$/;
/** An Ed25519 SubjectPublicKeyInfo is this fixed DER header followed by the 32 raw key bytes (RFC 8410). */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** Fights /sim offers. Dungeon Route needs a route export, which a slash command has no way to carry. */
export const SIM_FIGHTS: readonly string[] = FIGHT_PRESETS.filter((p) => p.id !== 'dungeon-route').map((p) => p.id);
/** The two precisions the Quick Sim screen offers: its default and its High Precision toggle. */
export const ACCURACY: Readonly<Record<string, Accuracy>> = {
  standard: DEFAULT_ACCURACY,
  high: { mode: 'targetError', targetError: 0.05, maxIterations: 100_000 },
};

interface Option { name?: string; type?: number; value?: unknown; focused?: boolean; options?: Option[] }
interface Interaction {
  type?: number;
  token?: string;
  guild_id?: string;
  /** Sent in a guild; `permissions` is the member's computed permission bit set, as a decimal string. */
  member?: { permissions?: string; roles?: string[]; user?: { id?: string } };
  /** Sent in a DM. */
  user?: { id?: string };
  data?: { name?: string; options?: Option[] };
}
/** What `discord:<jobId>` holds until the job's reply is edited. `content` is the settled reply when Discord asked for a later try
 *  (429, 5xx, unreachable), and `after` is when that try may happen (its Retry-After). */
interface Pending { token: string; label: string; presetId: string; exp: number; content?: string; after?: number }

const inflate = promisify(gunzip);
const deflate = promisify(gzip);
const replyKey = (jobId: string) => `discord:${jobId}`;
const fightLabel = (presetId: string) => findPreset(presetId)?.label ?? presetId;
/** Character labels are user text: keep Discord markdown from restyling them. */
const plain = (text: string) => text.replace(/[\\*_~`|]/g, '\\$&');
const number = (value: number) => Math.round(value).toLocaleString('en-US');
const hours = (seconds: number) => (seconds / 3600).toFixed(1);

/** Sign-in and linking both start here: the OAuth start refuses a navigation from another site (a click inside discord.com). */
export const manageUrl = (config: Config) => `${config.publicOrigin}/#/account`;

/** Discord's check: Ed25519 over timestamp + raw body with the application's public key, plus a replay window. */
export function verifyInteraction(publicKeyHex: string, signature: string | null, timestamp: string | null, body: Uint8Array, nowS: number): boolean {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || Math.abs(nowS - Number(timestamp)) > SIGNATURE_SKEW_S) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verifySignature(null, Buffer.concat([Buffer.from(timestamp), body]), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** Manage Server, or Administrator (which Discord treats as every permission), from the interaction's own member payload. */
export function canManageGuild(permissions: unknown): boolean {
  if (typeof permissions !== 'string' || !/^\d{1,30}$/.test(permissions)) return false;
  return (BigInt(permissions) & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
}

/** The Frostsim user linked to `discordId`, or null. Suspended (deletion pending included) and, under ADMIN_ONLY, non-admin users
 *  count as unlinked, as getSession treats them. */
export async function linkedUser(app: Pick<AppCtx, 'sql' | 'config'>, discordId: string): Promise<string | null> {
  const [row] = await app.sql`select i.user_id, u.role from identities i join users u on u.id = i.user_id
    where i.provider = 'discord' and i.subject = ${discordId} and u.suspended_at is null`;
  if (!row || (app.config.adminOnly && row.role !== 'admin')) return null;
  return row.user_id;
}

/** One of the user's cloud characters (by id, or by label when typed instead of picked) as a Quick Sim request; null when none. */
export async function characterRequest(
  db: Db, userId: string, character: string, presetId: string, accuracy: Accuracy,
): Promise<{ id: string; label: string; request: SimRequest } | null> {
  const [row] = await db`select id, label, raw from cloud_characters where user_id = ${userId}
    and (id::text = ${character} or lower(label) = lower(${character})) order by (id::text = ${character}) desc, updated_at desc limit 1`;
  if (!row) return null;
  // threads is the server's to decide: enqueueJob replaces it with the plan's width (DESIGN.md C8).
  return { id: row.id, label: row.label, request: quickRequest(parseAddonExport(row.raw), { presetId, threads: 1, accuracy }) };
}

/** An Armory character (src/lib/import/armory.ts, through the Battle.net proxy) as a Quick Sim request, or the reason it cannot be. */
export async function armoryRequest(
  app: Pick<AppCtx, 'config' | 'fetch'>, region: string, realm: string, name: string, presetId: string, accuracy: Accuracy,
): Promise<{ label: string; request: SimRequest } | { error: string }> {
  if (!(ALLOWED_REGIONS as readonly string[]).includes(region)) return { error: 'Pick a region from the list.' };
  const url = app.config.env.WOW_API_ORIGIN + characterProfilePath(region as (typeof ALLOWED_REGIONS)[number], realm, name);
  let body: { profile?: unknown; message?: unknown; name?: unknown; realmSlug?: unknown } | null = null;
  try {
    const res = await app.fetch(url, { signal: AbortSignal.timeout(15_000) });
    body = await res.json().catch(() => null);
  } catch {
    // Unreachable proxy: the message below.
  }
  if (typeof body?.profile !== 'string') {
    return { error: typeof body?.message === 'string' ? body.message : 'The Armory lookup failed. Try again shortly.' };
  }
  const label = `${typeof body.name === 'string' ? body.name : name}-${typeof body.realmSlug === 'string' ? body.realmSlug : realm}`;
  return { label, request: quickRequest(parseAddonExport(body.profile), { presetId, threads: 1, accuracy }) };
}

function option(i: Interaction, name: string): string | undefined {
  const value = i.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

const reply = (content: string) => json({ type: MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

/** Edits the deferred reply: Discord's response, or null when it was not reached. Only the interaction token authorises it; failures
 *  are logged (errorSummary drops the URL and token). */
async function editReply(app: Pick<AppCtx, 'config' | 'fetch' | 'log'>, token: string, content: string): Promise<Response | null> {
  const url = `${API}/webhooks/${app.config.env.DISCORD_APPLICATION_ID}/${encodeURIComponent(token)}/messages/@original`;
  try {
    const res = await app.fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    if (!res.ok) app.log(`discord: editing a reply failed with status ${res.status}`);
    return res;
  } catch (err) {
    app.log(`discord: editing a reply failed (${errorSummary(err)})`);
    return null;
  }
}

/** /sim's own edits can reach Discord before the deferral they edit has registered, which it answers with 404: try once more. */
async function editDeferred(app: Pick<AppCtx, 'config' | 'fetch' | 'log'>, token: string, content: string): Promise<void> {
  if ((await editReply(app, token, content))?.status !== 404) return;
  await new Promise((resolve) => setTimeout(resolve, DEFERRAL_WAIT_MS));
  await editReply(app, token, content);
}

/** The guild's live discord_guild_monthly pool, else null: the run then draws on the user's own allowance. A pool that is used up,
 *  or a member past their role's share of it (guild-roles.ts), also falls back to the member's own allowance (startSim). */
async function activePool(app: AppCtx, guildId: string | undefined): Promise<GuildEntitlement | null> {
  if (!guildId || !SNOWFLAKE.test(guildId)) return null;
  return (await loadEntitlements(app.sql, { guildId }, app.now())).guilds[0] ?? null;
}

/** /sim after the deferred reply: every outcome, refusals included, lands as an edit of that ephemeral reply. */
async function startSim(app: AppCtx, i: Interaction, discordId: string, receivedMs: number): Promise<void> {
  const token = i.token ?? '';
  const edit = (content: string) => editDeferred(app, token, content);
  const userId = await linkedUser(app, discordId);
  if (!userId) return edit(`Link this Discord account to Frostsim first: ${manageUrl(app.config)}`);
  // The web route's limit and bucket: each /sim parses a stored export and checks entitlements and R2 before any refusal.
  if (!(await submitAllowed(app, userId))) return edit('Too many cloud runs; wait a minute.');
  const presetId = option(i, 'fight') ?? 'patchwerk';
  const level = option(i, 'accuracy') ?? 'standard';
  const accuracy = Object.hasOwn(ACCURACY, level) ? ACCURACY[level] : null;
  if (!SIM_FIGHTS.includes(presetId) || !accuracy) return edit('Pick a fight and an accuracy from the list.');
  const name = option(i, 'name')?.trim();
  const realm = option(i, 'realm')?.trim();
  let built: { id?: string; label: string; request: SimRequest };
  if (name || realm) {
    if (!name || !realm) return edit('An Armory lookup needs both the character name and the realm.');
    const armory = await armoryRequest(app, option(i, 'region') ?? 'us', realm, name, presetId, accuracy);
    if ('error' in armory) return edit(armory.error);
    built = armory;
  } else {
    const character = option(i, 'character');
    if (!character) return edit(`Pick one of your cloud characters, or give a name and realm to look one up on the Armory. Save characters at ${manageUrl(app.config)}`);
    const saved = await characterRequest(app.sql, userId, character, presetId, accuracy);
    if (!saved) return edit(`No cloud character by that name. Save characters to your Frostsim account: ${manageUrl(app.config)}`);
    built = saved;
  }
  const packId = await defaultPack(app);
  if (!packId) return edit('Frostsim Cloud has no engine build ready right now. Try again later.');
  const active = await activePool(app, i.guild_id);
  // Past the member's role allowance: straight to their own plan, as when the pool is used up.
  const refusal = active ? await memberRefusal(app, active.guildId, userId, i.member?.roles ?? [], active) : null;
  let guildId = active && !refusal ? active.guildId : null;
  let job = await enqueueJob(app, { userId, guildId, source: 'discord', packId, request: built.request, characterId: built.id });
  // The server's pool is used up for this period: run it on the member's own plan instead, if they have one.
  const fellBack = !job.ok && guildId !== null && job.code === 'no-allowance';
  if (fellBack) {
    guildId = null;
    job = await enqueueJob(app, { userId, guildId, source: 'discord', packId, request: built.request, characterId: built.id });
  }
  if (!job.ok) return edit(`${refusal ? `${refusal} ` : ''}${job.message} ${manageUrl(app.config)}`);
  const pool = refusal ? ` ${refusal} It runs on your own plan.` : fellBack ? " This server's pool is used up, so it runs on your own plan." : '';
  // Before the token is stored: from then on the task may post the result, and a late "Queued" would overwrite it.
  await edit(`Queued **${plain(built.label)}** on ${fightLabel(presetId)} in Frostsim Cloud.${pool} This message updates when it finishes.`);
  const pending: Pending = { token, label: built.label, presetId, exp: receivedMs + TOKEN_TTL_S * 1000 };
  const saved = await tryRedis(app.redis, app.log,
    async (r) => (await r.set(replyKey(job.id), JSON.stringify(pending), 'EX', TOKEN_TTL_S)) === 'OK', false);
  if (saved) return;
  // Nobody could ever see the result: do not spend the user's allowance on it.
  await cancelJob(app, job.id, guildId ? { guildId } : { userId });
  await edit('Frostsim Cloud cannot post results to Discord right now, so the run was cancelled. Try again later.');
}

async function characterChoices(app: AppCtx, discordId: string, typed: string): Promise<{ name: string; value: string }[]> {
  const userId = await linkedUser(app, discordId);
  if (!userId) return [];
  const rows = await app.sql`select id, label from cloud_characters where user_id = ${userId} order by updated_at desc`;
  const needle = typed.toLowerCase();
  return rows.filter((r) => r.label.toLowerCase().includes(needle)).slice(0, 25).map((r) => ({ name: r.label.slice(0, 100), value: r.id }));
}

async function linkText(app: AppCtx, discordId: string): Promise<string> {
  if (await linkedUser(app, discordId)) return `This Discord account is linked to Frostsim. Manage it at ${manageUrl(app.config)}`;
  return `Sign in to Frostsim with Discord, or link Discord to the account you already have, at ${manageUrl(app.config)}`;
}

async function usageLine(app: AppCtx, label: string, who: { userId: string } | { guildId: string; userId?: string },
  pool: { coreSeconds: number; maxThreads: number; periodStart: Date; periodEnd: Date }): Promise<string> {
  const used = await usedCoreSeconds(app.sql, who, pool.periodStart, pool.periodEnd);
  return `${label}: ${hours(used)} of ${hours(pool.coreSeconds)} core-hours used, up to ${pool.maxThreads} threads a run, `
    + `period ends ${pool.periodEnd.toISOString().slice(0, 10)}.`;
}

async function usageText(app: AppCtx, discordId: string, guildId: string | undefined, roleIds: readonly string[]): Promise<string> {
  const userId = await linkedUser(app, discordId);
  if (!userId) return `Link this Discord account to Frostsim first: ${manageUrl(app.config)}`;
  const now = app.now();
  const mine = await loadEntitlements(app.sql, { userId }, now);
  const lines = [mine.maxThreads < 1
    ? `Your account has no Frostsim Cloud plan: ${manageUrl(app.config)}`
    : await usageLine(app, 'You', { userId }, mine)];
  if (guildId && SNOWFLAKE.test(guildId)) {
    const [guild] = (await loadEntitlements(app.sql, { guildId }, now)).guilds;
    if (guild) {
      lines.push(await usageLine(app, "This server's pool", { guildId }, guild));
      const share = memberAllowance(guildId, await roleLimits(app.sql, guildId), roleIds);
      if (share !== null) lines.push(await usageLine(app, 'Your share of it', { guildId, userId }, { ...guild, coreSeconds: share }));
    }
  }
  return lines.join('\n');
}

/** Guild checkout (DESIGN.md P5). Authority comes only from the signed member payload, never from command options. */
function subscribeText(app: AppCtx, i: Interaction, discordId: string): string {
  if (i.data?.options?.[0]?.name !== 'subscribe') return 'Unknown command.';
  const guildId = i.guild_id;
  if (!guildId || !SNOWFLAKE.test(guildId) || !i.member) return 'Run this in the Discord server you want to subscribe.';
  if (!canManageGuild(i.member.permissions)) return 'Only members with the Manage Server permission can subscribe this server.';
  const token = sign(app.config.env.SESSION_SECRET ?? '', GUILD_CHECKOUT_PURPOSE,
    { kind: 'guild-checkout', guildId, discordUserId: discordId }, 900, app.now().getTime());
  return `Subscribe this server to Frostsim Cloud (the link works for 15 minutes): ${app.config.publicOrigin}/#/account/guild/${token}`;
}

async function interactions(ctx: RequestCtx): Promise<Response> {
  const body = await ctx.body();
  const nowMs = ctx.now().getTime();
  const headers = ctx.request.headers;
  if (!verifyInteraction(ctx.config.env.DISCORD_PUBLIC_KEY ?? '', headers.get('x-signature-ed25519'), headers.get('x-signature-timestamp'), body, nowMs / 1000)) {
    throw new HttpError(401, 'signed-out', 'Invalid request signature.');
  }
  const i = await ctx.json<Interaction>();
  if (i?.type === PING) return json({ type: PONG });
  const discordId = i?.member?.user?.id ?? i?.user?.id;
  if (typeof discordId !== 'string' || !SNOWFLAKE.test(discordId)) throw new HttpError(400, 'invalid', 'The interaction has no user.');

  if (i.type === AUTOCOMPLETE) {
    const focused = i.data?.options?.find((o) => o.focused);
    const typed = focused?.name === 'character' && typeof focused.value === 'string' ? focused.value : '';
    return json({ type: CHOICES, data: { choices: focused?.name === 'character' ? await characterChoices(ctx, discordId, typed) : [] } });
  }
  if (i.type !== COMMAND) throw new HttpError(400, 'invalid', 'Unsupported interaction type.');
  switch (i.data?.name) {
    case 'sim':
      // Discord waits 3 s for this answer; the enqueue (R2, entitlement and capacity checks) happens after it.
      void startSim(ctx, i, discordId, nowMs).catch(async (err) => {
        ctx.log(`discord: /sim failed (${errorSummary(err)})`);
        await editDeferred(ctx, i.token ?? '', 'Something went wrong starting this run. Try again later.');
      });
      return json({ type: DEFERRED, data: { flags: EPHEMERAL } });
    case 'link':
      return reply(await linkText(ctx, discordId));
    case 'usage':
      return reply(await usageText(ctx, discordId, i.guild_id, i.member?.roles ?? []));
    case 'frostsim':
      return reply(subscribeText(ctx, i, discordId));
    default:
      return reply('Unknown command.');
  }
}

/** The hosted payload the browser would upload (DESIGN.md C10), built from the worker's raw report. */
export async function shareBytes(reportText: string, view: Pick<JobView, 'notices' | 'effective' | 'createdAt' | 'finishedAt'>): Promise<Uint8Array> {
  const raw: unknown = JSON.parse(reportText);
  const report = parseReport(raw);
  const shared = reportSnapshot({
    report,
    // The assembled profile holds the character lines reportSnapshot reads gear and talents from.
    request: { profile: view.effective?.profile ?? '' },
    appElapsedSeconds: ((view.finishedAt ?? view.createdAt).getTime() - view.createdAt.getTime()) / 1000,
    engineNotices: (view.notices ?? []).map(parseEngineNotice).filter((n): n is ReportLog => n !== null),
    inputWarnings: [],
    profilesetStatus: { missing: [] },
  }, parsePlayerDetail(raw, report.players[0]?.name ?? ''));
  const encode = (rawReport: string | null) => Buffer.from(JSON.stringify(makePortable('report', { shared, rawReport })));
  // storeShare's two caps: past either, the share goes without the raw report.
  const full = encode(reportText);
  if (full.byteLength <= MAX_SHARE_JSON) {
    const gz = new Uint8Array(await deflate(full));
    if (gz.byteLength <= MAX_UPLOAD) return gz;
  }
  return new Uint8Array(await deflate(encode(null)));
}

/** A hosted link only for a user who personally has hostedShares (guild pools carry compute only, shares.ts). Any failure: no link. */
async function hostedLink(app: AppCtx, view: JobView, title: string): Promise<string | null> {
  if (!view.userId) return null;
  try {
    if (!(await loadEntitlements(app.sql, { userId: view.userId }, app.now())).hostedShares) return null;
    const gz = await resultBytes(app, view.id);
    if (!gz) return null;
    const text = (await inflate(gz, { maxOutputLength: MAX_SHARE_JSON })).toString('utf8');
    const { id } = await storeShare(app, { userId: view.userId, title, gzipBytes: await shareBytes(text, view) });
    return `${app.config.publicOrigin}/#/s/${id}`;
  } catch (err) {
    app.log(`discord: hosted share for job ${view.id} failed (${errorSummary(err)})`);
    return null;
  }
}

/** hostedLink, given up after LINK_DEADLINE_MS (the share may still be stored later, unlinked; it shows in the user's share list). */
async function linkInTime(app: AppCtx, view: JobView, title: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      app.log(`discord: hosted share for job ${view.id} took over ${LINK_DEADLINE_MS / 1000} s; posted without it`);
      resolve(null);
    }, LINK_DEADLINE_MS);
  });
  try {
    return await Promise.race([hostedLink(app, view, title), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function resultText(app: AppCtx, view: JobView, p: Pending): Promise<string> {
  const head = `**${plain(p.label)}** on ${fightLabel(p.presetId)}`;
  if (view.status === 'failed') return `${head}: the cloud run failed (${(view.error ?? 'no reason given').slice(0, 300)}).`;
  if (view.status !== 'done') return `${head}: the run was cancelled.`;
  const { dps, dpsError } = view.summary ?? {};
  if (dps === undefined) return `${head}: finished, but the cloud worker reported no DPS.`;
  const link = await linkInTime(app, view, `${p.label} · ${fightLabel(p.presetId)}`);
  // simc's default confidence is 95%, and no request sets another; the worker sends mean_std_dev x that estimator.
  const error = dpsError === undefined ? '' : ` ± ${number(dpsError)} (95%)`;
  return `${head}: **${number(dps)} DPS**${error}${link ? `\nFull report: ${link}` : ''}`;
}

/** Takes the token in one MULTI get+del, so two instances (a deploy switch) never both post. */
const take = (app: AppCtx, key: string) => tryRedis(app.redis, app.log, async (r) => (await r.multi().get(key).del(key).exec())?.[0]?.[1], null);

/** Posts the settled reply. When Discord may take it later (429, 5xx, unreachable) the token goes back with the text, so the next tick
 *  retries it without a second share or cancel. Anything else is final (401/404: the token is dead). */
async function post(app: AppCtx, key: string, pending: Pending, content: string): Promise<void> {
  const res = await editReply(app, pending.token, content);
  if (res && res.status !== 429 && res.status < 500) return;
  const nowMs = app.now().getTime();
  const ttl = pending.exp - nowMs;
  if (ttl <= 0) return;
  const after = nowMs + (Number(res?.headers.get('retry-after')) || 0) * 1000;
  await tryRedis(app.redis, app.log, (r) => r.set(key, JSON.stringify({ ...pending, content, after }), 'PX', ttl), null);
}

/** Posts one job's outcome once it is final, or cancels it when the token is about to die first. */
async function followUp(app: AppCtx, id: string, nowMs: number): Promise<void> {
  const key = replyKey(id);
  const text = await tryRedis(app.redis, app.log, (r) => r.get(key), null);
  if (!text) return;
  const pending = JSON.parse(text) as Pending;
  if (pending.content !== undefined) {
    if (nowMs >= (pending.after ?? 0) && (await take(app, key))) await post(app, key, pending, pending.content);
    return;
  }
  let view = await jobView(app, id);
  if (!view) return;
  const open = view.status === 'queued' || view.status === 'running';
  if (open && nowMs < pending.exp - EDIT_MARGIN_MS) return;
  if (!(await take(app, key))) return;
  if (open) {
    const cancelled = await cancelJob(app, id, view.guildId ? { guildId: view.guildId } : { userId: view.userId ?? '' });
    if (cancelled) {
      return post(app, key, pending, `**${plain(pending.label)}** on ${fightLabel(pending.presetId)} did not finish within the `
        + '15 minutes Discord gives a reply, so it was cancelled and not charged. Try again later.');
    }
    // It finished between the two reads.
    view = (await jobView(app, id)) ?? view;
  }
  await post(app, key, pending, await resultText(app, view, pending));
}

async function postResults(app: AppCtx): Promise<void> {
  // The tokens live only in Redis: without it there is nothing to answer with.
  if (!app.redis) return;
  const nowMs = app.now().getTime();
  // ponytail: filters compute_jobs by source and age with no index on either, every tick; ask for a partial index
  // on (created_at) where source = 'discord' once the ledger reaches tens of thousands of rows.
  const rows = await app.sql`select id from compute_jobs where source = 'discord'
    and created_at > ${new Date(nowMs - TOKEN_TTL_S * 1000 - EDIT_MARGIN_MS)}`;
  for (const { id } of rows) {
    try {
      await followUp(app, id, nowMs);
    } catch (err) {
      app.log(`discord: reply for job ${id} failed (${errorSummary(err)})`);
    }
  }
}

/** Discord's page for adding the bot to a server, with the installation defaults set on the application (guild install,
 *  applications.commands and bot, Send Messages). The app links here, so the client needs no application id. */
export function installUrl(config: Pick<Config, 'env'>): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.env.DISCORD_APPLICATION_ID ?? '')}`;
}

export const routes: Route[] = [
  { method: 'POST', path: /^\/api\/v1\/discord\/interactions$/, feature: 'discord', auth: 'public', handler: interactions },
  {
    method: 'GET', path: /^\/api\/v1\/discord\/install$/, feature: 'discord', auth: 'public',
    handler: (ctx) => new Response(null, { status: 302, headers: { location: installUrl(ctx.config) } }),
  },
];

export const tasks: Task[] = [{ name: 'discord-replies', feature: 'discord', everyMs: 3000, run: postResults }];
