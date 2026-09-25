// The standalone Discord bot as an HTTP interactions endpoint (CLAUDE.md D15; DESIGN.md A8, P2, P3, P5): Ed25519
// over the exact raw body, then /sim and /compare (deferred, run as cloud jobs, answered by editing the reply: a live progress embed,
// then a result embed), /link, /usage and /frostsim subscribe. Every reply is ephemeral: it may name the invoker's characters,
// allowance or a checkout link. The exceptions are a finished run with share:true, posted to the channel as a new message, and its
// "Post in channel" button, which does the same later at the invoker's click. A Discord user is a Frostsim user through
// identities(provider 'discord', subject = user id); nothing here reads another user's rows.

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
import { compareEmbed, plain, progressEmbed, simEmbed, type Embed } from './discord-embeds';
import { MAX_SHARE_JSON, MAX_UPLOAD, storeShare } from './shares';
import { sign } from './signed';
import { usedCoreSeconds } from './usage';
import { cancelJob, enqueueJob, jobView, resultBytes, type JobView } from './compute/queue';
import { defaultPack } from './compute/packs';
import { submitAllowed } from './compute/routes';
import { ALLOWED_REGIONS, characterProfilePath, characterSearchPath, realmsPath, type CharacterMatch } from '../../src/lib/battlenet/contract';
import { parseAddonExport, type ImportedCharacter } from '../../src/lib/import/character';
import type { SimRequest } from '../../src/lib/simc/assemble';
import { parsePlayerDetail } from '../../src/lib/simc/detail';
import { DEFAULT_ACCURACY, type Accuracy } from '../../src/lib/simc/options';
import { FIGHT_PRESETS, findPreset } from '../../src/lib/simc/presets';
import { compareRequest, quickRequest } from '../../src/lib/simc/quick-request';
import { latestProgress } from '../../src/lib/simc/progress';
import { roleGroups, roleNote } from '../../src/lib/simc/role-share';
import { parseEngineNotice, parseReport, type ReportLog, type SimReport } from '../../src/lib/simc/report';
import { makePortable } from '../../src/lib/store/records';
import { reportSnapshot } from '../../src/lib/store/report-share';

const API = 'https://discord.com/api/v10';
// Interaction and callback types (discord-api-docs interactions/receiving-and-responding).
const PING = 1;
const COMMAND = 2;
const COMPONENT = 3;
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

/** Fights /sim and /compare offer by name. Dungeon Route runs through the `route` option, which picks one of the site's routes. */
export const SIM_FIGHTS: readonly string[] = FIGHT_PRESETS.filter((p) => p.id !== 'dungeon-route').map((p) => p.id);
/** The two precisions the Quick Sim screen offers: its default and its High Precision toggle. */
export const ACCURACY: Readonly<Record<string, Accuracy>> = {
  standard: DEFAULT_ACCURACY,
  high: { mode: 'targetError', targetError: 0.05, maxIterations: 100_000 },
};
/** /compare takes two to four characters. */
export const COMPARE_SLOTS = ['character1', 'character2', 'character3', 'character4'] as const;
/** An Armory character picked from autocomplete: `armory:<region>:<realm slug>:<name>`. */
const ARMORY_VALUE = /^armory:(us|eu|kr|tw):([a-z0-9-]{1,80}):([^:]{1,24})$/;
/** Progress edits: at most one per this long per run, and only when the bar moved. */
const PROGRESS_EVERY_MS = 5000;
/** A result's "Post in channel" button works this long. */
const POST_TTL_S = 86_400;

interface Option { name?: string; type?: number; value?: unknown; focused?: boolean; options?: Option[] }
type RegionId = (typeof ALLOWED_REGIONS)[number];
interface Interaction {
  type?: number;
  token?: string;
  guild_id?: string;
  /** Sent in a guild; `permissions` is the member's computed permission bit set, as a decimal string. */
  member?: { permissions?: string; roles?: string[]; user?: { id?: string } };
  /** Sent in a DM. */
  user?: { id?: string };
  data?: { name?: string; options?: Option[]; custom_id?: string };
}
/** A message body: text, embeds and buttons. */
export interface Message { content?: string; embeds?: Embed[]; components?: unknown[] }
/** What `discord:<jobId>` holds until the run's reply is settled. `message` is the settled reply when Discord asked for a later try
 *  (429, 5xx, unreachable), and `after` is when that try may happen (its Retry-After). */
interface Pending {
  token: string; label: string; presetId: string; exp: number;
  /** The fight as shown: the preset's label, or the route's name. */
  fight?: string;
  kind?: 'sim' | 'compare';
  /** Every job of the run, this key's first: a Dungeon Route compare with tanks or healers runs one job per role (role-share.ts). */
  jobs?: string[];
  /** What the role split did, shown with the result. */
  note?: string;
  /** The invoker's Discord id: only they can post an ephemeral result to the channel. */
  owner?: string;
  /** share:true: a finished result goes to the channel as a new message, not into the ephemeral reply. Holds the invoker's Discord
   *  id, shown there as a mention (allowed_mentions is empty, so it never pings). */
  share?: string;
  message?: Message; after?: number;
  /** Set with `message`: whether that settled reply is the public one. */
  public?: boolean;
  /** The progress last shown ("q<position>" or a percentage) and when. */
  shown?: string; shownAt?: number;
}

const inflate = promisify(gunzip);
const deflate = promisify(gzip);
const replyKey = (jobId: string) => `discord:${jobId}`;
const postKey = (jobId: string) => `discord:post:${jobId}`;
const fightLabel = (presetId: string) => findPreset(presetId)?.label ?? presetId;
const fightOf = (p: Pending) => p.fight ?? fightLabel(p.presetId);
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

interface Picked { id?: string; label: string; character: ImportedCharacter }

/** One of the user's cloud characters, by id or by label when typed instead of picked. */
async function savedCharacter(db: Db, userId: string, character: string): Promise<Picked | null> {
  const [row] = await db`select id, label, raw from cloud_characters where user_id = ${userId}
    and (id::text = ${character} or lower(label) = lower(${character})) order by (id::text = ${character}) desc, updated_at desc limit 1`;
  return row ? { id: row.id, label: row.label, character: parseAddonExport(row.raw) } : null;
}

/** One of the user's cloud characters (by id, or by label when typed instead of picked) as a Quick Sim request; null when none. */
export async function characterRequest(
  db: Db, userId: string, character: string, presetId: string, accuracy: Accuracy,
): Promise<{ id: string; label: string; request: SimRequest } | null> {
  const saved = await savedCharacter(db, userId, character);
  // threads is the server's to decide: enqueueJob replaces it with the plan's width (DESIGN.md C8).
  return saved ? { id: saved.id!, label: saved.label, request: quickRequest(saved.character, { presetId, threads: 1, accuracy }) } : null;
}

/** An Armory character (src/lib/import/armory.ts, through the Battle.net proxy), or the reason it cannot be had. */
async function armoryCharacter(app: Pick<AppCtx, 'config' | 'fetch'>, region: string, realm: string, name: string): Promise<Picked | { error: string }> {
  if (!(ALLOWED_REGIONS as readonly string[]).includes(region)) return { error: 'Pick a region from the list.' };
  const url = app.config.env.WOW_API_ORIGIN + characterProfilePath(region as RegionId, realm, name);
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
  return { label, character: parseAddonExport(body.profile) };
}

/** A /compare slot: an Armory pick from autocomplete, a cloud character, or a typed Name-Realm looked up in `region`. */
async function pickCharacter(app: AppCtx, userId: string, value: string, region: string): Promise<Picked | { error: string }> {
  const armory = ARMORY_VALUE.exec(value);
  if (armory) return armoryCharacter(app, armory[1], armory[2], armory[3]);
  const saved = await savedCharacter(app.sql, userId, value);
  if (saved) return saved;
  const typed = /^([^\s-][^-]{1,23})-(.{2,80})$/.exec(value.trim());
  if (typed) return armoryCharacter(app, region, typed[2].trim(), typed[1].trim());
  return { error: `No cloud character called "${value.slice(0, 40)}". Pick one from the list, or type Name-Realm to look one up on the Armory.` };
}

function option(i: Interaction, name: string): string | undefined {
  const value = i.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

/** Up to 25 of the region's realms matching what is typed, names starting with it first; valued by slug. Empty when the proxy
 *  cannot answer in time: Discord drops an autocomplete answer after 3 s. */
export async function realmChoices(app: Pick<AppCtx, 'config' | 'fetch'>, region: string, typed: string): Promise<{ name: string; value: string }[]> {
  if (!(ALLOWED_REGIONS as readonly string[]).includes(region)) return [];
  try {
    const res = await app.fetch(app.config.env.WOW_API_ORIGIN + realmsPath(region as RegionId), { signal: AbortSignal.timeout(2000) });
    const realms = ((await res.json()) as { realms?: { name: string; slug: string }[] }).realms ?? [];
    const needle = typed.trim().toLowerCase();
    const hits = realms.filter((r) => r.name.toLowerCase().includes(needle) || r.slug.includes(needle));
    const starts = (r: { name: string }) => (r.name.toLowerCase().startsWith(needle) ? 0 : 1);
    return hits.sort((a, b) => starts(a) - starts(b)).slice(0, 25).map((r) => ({ name: r.name.slice(0, 100), value: r.slug }));
  } catch {
    return [];
  }
}

/** Armory characters Frostsim has seen (the shared index behind the site's lookup), valued for pickCharacter. */
async function armoryChoices(app: Pick<AppCtx, 'config' | 'fetch'>, region: string, typed: string): Promise<{ name: string; value: string }[]> {
  if (typed.trim().length < 2 || !(ALLOWED_REGIONS as readonly string[]).includes(region)) return [];
  try {
    const res = await app.fetch(app.config.env.WOW_API_ORIGIN + characterSearchPath(region as RegionId, typed.trim().slice(0, 24)),
      { signal: AbortSignal.timeout(1500) });
    const matches = ((await res.json()) as { matches?: CharacterMatch[] }).matches ?? [];
    return matches.map((m) => ({
      name: `${m.name} · ${m.realm} (${m.region.toUpperCase()})${m.spec ? ` · ${m.spec}` : ''}${m.className ? ` ${m.className}` : ''}`.slice(0, 100),
      value: `armory:${m.region}:${m.realmSlug}:${m.name}`,
    })).filter((c) => ARMORY_VALUE.test(c.value));
  } catch {
    return [];
  }
}

interface RouteEntry { id: string; name: string; path: string }
let routeIndex: { at: number; routes: RouteEntry[] } | null = null;

/** The site's own dungeon routes (public/routes/index.json), cached for an hour. */
async function siteRoutes(app: Pick<AppCtx, 'config' | 'fetch' | 'now'>): Promise<RouteEntry[]> {
  const now = app.now().getTime();
  if (routeIndex && now - routeIndex.at < 3_600_000) return routeIndex.routes;
  const res = await app.fetch(`${app.config.publicOrigin}/routes/index.json`, { signal: AbortSignal.timeout(2000) });
  const list = ((await res.json()) as { routes?: RouteEntry[] }).routes ?? [];
  const valid = list.filter((r) => /^[a-z0-9-]{1,80}$/.test(r.id) && /^\/routes\/[a-z0-9-]+\.simc$/.test(r.path) && typeof r.name === 'string');
  routeIndex = { at: now, routes: valid };
  return valid;
}

async function routeChoices(app: AppCtx, typed: string): Promise<{ name: string; value: string }[]> {
  const needle = typed.trim().toLowerCase();
  return (await siteRoutes(app).catch(() => [])).filter((r) => r.name.toLowerCase().includes(needle)).slice(0, 25)
    .map((r) => ({ name: r.name.slice(0, 100), value: r.id }));
}

/** The route's export text and name, or null when it is not one of the site's. */
async function routeText(app: AppCtx, id: string): Promise<{ name: string; text: string } | null> {
  const entry = (await siteRoutes(app)).find((r) => r.id === id);
  if (!entry) return null;
  const res = await app.fetch(`${app.config.publicOrigin}${entry.path}`, { signal: AbortSignal.timeout(5000) });
  return res.ok ? { name: entry.name, text: await res.text() } : null;
}

const reply = (content: string) => json({ type: MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

const asMessage = (m: string | Message): Message => (typeof m === 'string' ? { content: m } : m);
/** Every edit replaces text, embeds and buttons together, so a result never keeps the progress embed. */
const body = (m: Message) => JSON.stringify({
  content: (m.content ?? '').slice(0, 2000), embeds: m.embeds ?? [], components: m.components ?? [], allowed_mentions: { parse: [] },
});

/** Edits the deferred reply: Discord's response, or null when it was not reached. Only the interaction token authorises it; failures
 *  are logged (errorSummary drops the URL and token). */
async function editReply(app: Pick<AppCtx, 'config' | 'fetch' | 'log'>, token: string, message: string | Message): Promise<Response | null> {
  const url = `${API}/webhooks/${app.config.env.DISCORD_APPLICATION_ID}/${encodeURIComponent(token)}/messages/@original`;
  try {
    const res = await app.fetch(url, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: body(asMessage(message)), signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    if (!res.ok) app.log(`discord: editing a reply failed with status ${res.status}`);
    return res;
  } catch (err) {
    app.log(`discord: editing a reply failed (${errorSummary(err)})`);
    return null;
  }
}

/** A new, public message in the interaction's channel (a follow-up without the ephemeral flag; the original reply was already
 *  edited, so this does not replace it). Same logging and failure shape as editReply. */
async function publicReply(app: Pick<AppCtx, 'config' | 'fetch' | 'log'>, token: string, message: Message): Promise<Response | null> {
  const url = `${API}/webhooks/${app.config.env.DISCORD_APPLICATION_ID}/${encodeURIComponent(token)}`;
  try {
    const res = await app.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(message), signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    if (!res.ok) app.log(`discord: posting a shared result failed with status ${res.status}`);
    return res;
  } catch (err) {
    app.log(`discord: posting a shared result failed (${errorSummary(err)})`);
    return null;
  }
}

/** The run's own edits can reach Discord before the deferral they edit has registered, which it answers with 404: try once more. */
async function editDeferred(app: Pick<AppCtx, 'config' | 'fetch' | 'log'>, token: string, message: string | Message): Promise<void> {
  if ((await editReply(app, token, message))?.status !== 404) return;
  await new Promise((resolve) => setTimeout(resolve, DEFERRAL_WAIT_MS));
  await editReply(app, token, message);
}

/** The guild's live discord_guild_monthly pool, else null: the run then draws on the user's own allowance. A pool that is used up,
 *  or a member past their role's share of it (guild-roles.ts), also falls back to the member's own allowance (startRun). */
async function activePool(app: AppCtx, guildId: string | undefined): Promise<GuildEntitlement | null> {
  if (!guildId || !SNOWFLAKE.test(guildId)) return null;
  return (await loadEntitlements(app.sql, { guildId }, app.now())).guilds[0] ?? null;
}

/** The fight a command asked for: a route when one is named, else a preset; or the reason it cannot run. */
async function scenario(app: AppCtx, i: Interaction): Promise<{ presetId: string; fight: string; routeText?: string } | { error: string }> {
  const route = option(i, 'route');
  if (route) {
    const found = await routeText(app, route).catch(() => null);
    return found ? { presetId: 'dungeon-route', fight: found.name, routeText: found.text } : { error: 'Pick a dungeon route from the list.' };
  }
  const presetId = option(i, 'fight') ?? 'patchwerk';
  return SIM_FIGHTS.includes(presetId) ? { presetId, fight: fightLabel(presetId) } : { error: 'Pick a fight and an accuracy from the list.' };
}

/** /sim and /compare after the deferred reply: every outcome, refusals included, lands as an edit of that ephemeral reply. */
async function startRun(app: AppCtx, i: Interaction, discordId: string, receivedMs: number): Promise<void> {
  const token = i.token ?? '';
  const edit = (message: string | Message) => editDeferred(app, token, message);
  const compare = i.data?.name === 'compare';
  const userId = await linkedUser(app, discordId);
  if (!userId) return edit(`Link this Discord account to Frostsim first: ${manageUrl(app.config)}`);
  // The web route's limit and bucket: each run parses stored exports and checks entitlements and R2 before any refusal.
  if (!(await submitAllowed(app, userId))) return edit('Too many cloud runs; wait a minute.');
  const level = option(i, 'accuracy') ?? 'standard';
  const accuracy = Object.hasOwn(ACCURACY, level) ? ACCURACY[level] : null;
  const fight = await scenario(app, i);
  if ('error' in fight || !accuracy) return edit('error' in fight ? fight.error : 'Pick a fight and an accuracy from the list.');
  const region = option(i, 'region') ?? 'us';
  const quick = { presetId: fight.presetId, threads: 1, accuracy, routeText: fight.routeText };

  let picked: Picked[];
  if (compare) {
    const values = COMPARE_SLOTS.map((name) => option(i, name)?.trim()).filter((v): v is string => !!v);
    if (values.length < 2) return edit('Pick at least two characters to compare.');
    const found = await Promise.all(values.map((v) => pickCharacter(app, userId, v, region)));
    const missing = found.find((f): f is { error: string } => 'error' in f);
    if (missing) return edit(missing.error);
    picked = found as Picked[];
  } else {
    const name = option(i, 'name')?.trim();
    const realm = option(i, 'realm')?.trim();
    if (name || realm) {
      if (!name || !realm) return edit('An Armory lookup needs both the character name and the realm.');
      const armory = await armoryCharacter(app, region, realm, name);
      if ('error' in armory) return edit(armory.error);
      picked = [armory];
    } else {
      const character = option(i, 'character');
      if (!character) return edit(`Pick one of your cloud characters, or give a name and realm to look one up on the Armory. Save characters at ${manageUrl(app.config)}`);
      const saved = await savedCharacter(app.sql, userId, character);
      if (!saved) return edit(`No cloud character by that name. Save characters to your Frostsim account: ${manageUrl(app.config)}`);
      picked = [saved];
    }
  }
  let request: SimRequest;
  try {
    request = compareRequest(picked.map((p) => p.character), quick);
  } catch (err) {
    return edit(err instanceof Error ? err.message.slice(0, 300) : 'That run could not be built.');
  }
  // A Dungeon Route compare with tanks or healers: one job per role, each facing its share of the route's health.
  const groups = roleGroups(request);
  const requests = groups ? groups.map((g) => g.request) : [request];
  const label = compare ? picked.map((p) => p.label).join(' vs ') : picked[0].label;

  const packId = await defaultPack(app);
  if (!packId) return edit('Frostsim Cloud has no engine build ready right now. Try again later.');
  const active = await activePool(app, i.guild_id);
  // Past the member's role allowance: straight to their own plan, as when the pool is used up.
  const refusal = active ? await memberRefusal(app, active.guildId, userId, i.member?.roles ?? [], active) : null;
  let guildId = active && !refusal ? active.guildId : null;
  const characterId = compare ? undefined : picked[0].id;
  const ids: string[] = [];
  let fellBack = false;
  for (const r of requests) {
    let job = await enqueueJob(app, { userId, guildId, source: 'discord', packId, request: r, characterId });
    // The server's pool is used up for this period: run it on the member's own plan instead, if they have one.
    if (!job.ok && guildId !== null && job.code === 'no-allowance' && !ids.length) {
      fellBack = true;
      guildId = null;
      job = await enqueueJob(app, { userId, guildId, source: 'discord', packId, request: r, characterId });
    }
    if (!job.ok) {
      for (const id of ids) await cancelJob(app, id, guildId ? { guildId } : { userId });
      return edit(`${refusal ? `${refusal} ` : ''}${job.message} ${manageUrl(app.config)}`);
    }
    ids.push(job.id);
  }
  const pool = refusal ? ` ${refusal} It runs on your own plan.` : fellBack ? " This server's pool is used up, so it runs on your own plan." : '';
  // Before the token is stored: from then on the task may post the result, and a late "Queued" would overwrite it.
  const share = i.data?.options?.find((o) => o.name === 'share')?.value === true;
  const then = share ? 'The result will be posted in this channel.' : '';
  await edit({ content: `${pool.trim()} ${then}`.trim(), embeds: [progressEmbed({ label, fight: fight.fight })] });
  const pending: Pending = {
    token, label, presetId: fight.presetId, fight: fight.fight, exp: receivedMs + TOKEN_TTL_S * 1000, kind: compare ? 'compare' : 'sim', owner: discordId,
    ...(ids.length > 1 ? { jobs: ids } : {}), ...(groups ? { note: roleNote(groups) } : {}), ...(share ? { share: discordId } : {}),
  };
  const saved = await tryRedis(app.redis, app.log,
    async (r) => (await r.set(replyKey(ids[0]), JSON.stringify(pending), 'EX', TOKEN_TTL_S)) === 'OK', false);
  if (saved) return;
  // Nobody could ever see the result: do not spend the user's allowance on it.
  for (const id of ids) await cancelJob(app, id, guildId ? { guildId } : { userId });
  await edit('Frostsim Cloud cannot post results to Discord right now, so the run was cancelled. Try again later.');
}

/** The user's cloud characters matching what is typed; for /compare, Armory characters Frostsim has seen after them. */
async function characterChoices(app: AppCtx, discordId: string, typed: string, region?: string): Promise<{ name: string; value: string }[]> {
  const userId = await linkedUser(app, discordId);
  if (!userId) return [];
  const rows = await app.sql`select id, label from cloud_characters where user_id = ${userId} order by updated_at desc`;
  const needle = typed.toLowerCase();
  const saved = rows.filter((r) => r.label.toLowerCase().includes(needle)).slice(0, 25).map((r) => ({ name: r.label.slice(0, 100), value: r.id }));
  return region === undefined ? saved : [...saved, ...(await armoryChoices(app, region, typed))].slice(0, 25);
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
    const typed = typeof focused?.value === 'string' ? focused.value : '';
    const name = focused?.name ?? '';
    const choices = name === 'character' ? await characterChoices(ctx, discordId, typed)
      : (COMPARE_SLOTS as readonly string[]).includes(name) ? await characterChoices(ctx, discordId, typed, option(i, 'region') ?? 'us')
        : name === 'realm' ? await realmChoices(ctx, option(i, 'region') ?? 'us', typed)
          : name === 'route' ? await routeChoices(ctx, typed) : [];
    return json({ type: CHOICES, data: { choices } });
  }
  if (i.type === COMPONENT) return postToChannel(ctx, i, discordId);
  if (i.type !== COMMAND) throw new HttpError(400, 'invalid', 'Unsupported interaction type.');
  switch (i.data?.name) {
    case 'sim':
    case 'compare':
      // Discord waits 3 s for this answer; the enqueue (R2, entitlement and capacity checks) happens after it.
      void startRun(ctx, i, discordId, nowMs).catch(async (err) => {
        ctx.log(`discord: /${i.data?.name} failed (${errorSummary(err)})`);
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
async function hostedLink(app: AppCtx, view: JobView, title: string, text: string): Promise<string | null> {
  if (!view.userId) return null;
  try {
    if (!(await loadEntitlements(app.sql, { userId: view.userId }, app.now())).hostedShares) return null;
    const { id } = await storeShare(app, { userId: view.userId, title, gzipBytes: await shareBytes(text, view) });
    return `${app.config.publicOrigin}/#/s/${id}`;
  } catch (err) {
    app.log(`discord: hosted share for job ${view.id} failed (${errorSummary(err)})`);
    return null;
  }
}

/** `work`, or null once it outlasts LINK_DEADLINE_MS (logged as `what`): the task posts replies one after another, and one slow
 *  storage read must not push the ones behind it past their tokens. */
async function inTime<T>(app: AppCtx, work: Promise<T | null>, what: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      app.log(`discord: ${what} took over ${LINK_DEADLINE_MS / 1000} s; posted without it`);
      resolve(null);
    }, LINK_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Each job's raw report as text, merged into one when the run was split by role (each character was its own sim). Null when any is
 *  missing. */
async function reportText(app: AppCtx, ids: readonly string[]): Promise<string | null> {
  const texts: string[] = [];
  for (const id of ids) {
    const gz = await resultBytes(app, id).catch(() => null);
    if (!gz) return null;
    texts.push((await inflate(gz, { maxOutputLength: MAX_SHARE_JSON })).toString('utf8'));
  }
  if (texts.length === 1) return texts[0];
  const merged = JSON.parse(texts[0]);
  merged.sim.players = texts.flatMap((t) => JSON.parse(t).sim?.players ?? []);
  return JSON.stringify(merged);
}

/** The settled reply for a finished run: an embed (and buttons) from the report, or a line saying why there is none. */
async function resultMessage(app: AppCtx, views: JobView[], p: Pending, forChannel: boolean): Promise<Message> {
  const head = `**${plain(p.label)}** on ${fightOf(p)}`;
  const failed = views.find((v) => v.status === 'failed');
  if (failed) return { content: `${head}: the cloud run failed (${(failed.error ?? 'no reason given').slice(0, 300)}).` };
  if (views.some((v) => v.status !== 'done')) return { content: `${head}: the run was cancelled.` };
  const text = await inTime(app, reportText(app, views.map((v) => v.id)).catch(() => null), `the report for job ${views[0].id}`);
  let report: SimReport | null = null;
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
    report = raw ? parseReport(raw) : null;
  } catch {
    report = null;
  }
  if (!report?.players.length) {
    // The summary alone, as before embeds: the worker's DPS for the first character.
    const { dps, dpsError } = views[0].summary ?? {};
    if (dps === undefined) return { content: `${head}: finished, but the cloud worker reported no DPS.` };
    return { content: `${head}: **${number(dps)} DPS**${dpsError === undefined ? '' : ` ± ${number(dpsError)} (95%)`}` };
  }
  const now = app.now();
  const invoker = forChannel ? p.share : undefined;
  const embed = p.kind === 'compare'
    ? compareEmbed({ fight: fightOf(p), report, note: p.note, invoker, now })
    : simEmbed({ label: p.label, fight: fightOf(p), report, raw, invoker, now });
  const link = await inTime(app, hostedLink(app, views[0], `${p.label} · ${fightOf(p)}`, text!), `hosted share for job ${views[0].id}`);
  const buttons: unknown[] = [];
  if (link) buttons.push({ type: 2, style: 5, label: 'Full report', url: link });
  if (!forChannel && p.owner) buttons.push({ type: 2, style: 1, label: 'Post in channel', custom_id: `post:${views[0].id}` });
  return { embeds: [embed], components: buttons.length ? [{ type: 1, components: buttons }] : [] };
}

/** Takes the token in one MULTI get+del, so two instances (a deploy switch) never both post. */
const take = (app: AppCtx, key: string) => tryRedis(app.redis, app.log, async (r) => (await r.multi().get(key).del(key).exec())?.[0]?.[1], null);

/** Posts the settled reply. When Discord may take it later (429, 5xx, unreachable) the token goes back with the message, so the next
 *  tick retries it without a second share or cancel. Anything else is final (401/404: the token is dead). */
async function post(app: AppCtx, key: string, pending: Pending, message: Message, isPublic = false): Promise<void> {
  const res = isPublic ? await publicReply(app, pending.token, message) : await editReply(app, pending.token, message);
  if (res && res.status !== 429 && res.status < 500) return;
  const nowMs = app.now().getTime();
  const ttl = pending.exp - nowMs;
  if (ttl <= 0) return;
  const after = nowMs + (Number(res?.headers.get('retry-after')) || 0) * 1000;
  await tryRedis(app.redis, app.log,
    (r) => r.set(key, JSON.stringify({ ...pending, message, after, ...(isPublic ? { public: true } : {}) }), 'PX', ttl), null);
}

/** How far the engine's own progress bar is, 0-100, across the run's phases (one per character under single_actor_batch). */
export function progressPct(lines: readonly string[]): number | undefined {
  const p = latestProgress(lines);
  const bar = [...lines].reverse().map((l) => /\[([=>.]+)\]/.exec(l)?.[1]).find(Boolean);
  if (!p || !bar) return undefined;
  const within = p.finished ? 1 : bar.replace(/\./g, '').length / bar.length;
  return Math.min(100, ((p.phaseIndex - 1 + within) / Math.max(1, p.phaseTotal)) * 100);
}

/** Edits the reply with the run's queue place or progress bar, when it moved and the last edit is old enough. */
async function showProgress(app: AppCtx, key: string, pending: Pending, views: JobView[], nowMs: number): Promise<void> {
  if (nowMs - (pending.shownAt ?? 0) < PROGRESS_EVERY_MS) return;
  const queued = views.find((v) => v.status === 'queued');
  const pcts = views.map((v) => (v.status === 'done' ? 100 : v.status === 'running' ? progressPct(v.lines) ?? 0 : 0));
  const pct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const running = views.some((v) => v.status === 'running');
  const shown = queued && !running ? `q${queued.position ?? ''}` : String(Math.floor(pct / 5) * 5);
  if (shown === pending.shown) return;
  const res = await editReply(app, pending.token, { embeds: [progressEmbed({
    label: pending.label, fight: fightOf(pending), position: queued && !running ? queued.position : undefined, pct: running ? pct : undefined,
  })] });
  if (!res?.ok) return;
  // XX: never recreate a key another instance has just taken.
  await tryRedis(app.redis, app.log, (r) => r.set(key, JSON.stringify({ ...pending, shown, shownAt: nowMs }), 'PX', Math.max(1, pending.exp - nowMs), 'XX'), null);
}

/** Posts one run's outcome once every job is final, shows its progress until then, or cancels it when the token is about to die. */
async function followUp(app: AppCtx, id: string, nowMs: number): Promise<void> {
  const key = replyKey(id);
  const text = await tryRedis(app.redis, app.log, (r) => r.get(key), null);
  if (!text) return;
  const pending = JSON.parse(text) as Pending & { content?: string };
  // `content`: a settled reply stored by the release before embeds.
  const settled = pending.message ?? (pending.content !== undefined ? { content: pending.content } : undefined);
  if (settled) {
    if (nowMs >= (pending.after ?? 0) && (await take(app, key))) await post(app, key, pending, settled, pending.public);
    return;
  }
  const ids = pending.jobs ?? [id];
  let views = (await Promise.all(ids.map((j) => jobView(app, j)))).filter((v): v is JobView => !!v);
  if (views.length !== ids.length) return;
  const isOpen = (v: JobView) => v.status === 'queued' || v.status === 'running';
  if (views.some(isOpen) && nowMs < pending.exp - EDIT_MARGIN_MS) return showProgress(app, key, pending, views, nowMs);
  if (!(await take(app, key))) return;
  if (views.some(isOpen)) {
    let cancelled = false;
    for (const v of views.filter(isOpen)) cancelled = (await cancelJob(app, v.id, v.guildId ? { guildId: v.guildId } : { userId: v.userId ?? '' })) || cancelled;
    if (cancelled) {
      return post(app, key, pending, { content: `**${plain(pending.label)}** on ${fightOf(pending)} did not finish within the `
        + '15 minutes Discord gives a reply, so it was cancelled and not charged. Try again later.' });
    }
    // It finished between the two reads.
    views = (await Promise.all(ids.map((j) => jobView(app, j)))).filter((v): v is JobView => !!v);
  }
  // Only a finished result is shared; a failure or cancel stays in the invoker's ephemeral reply.
  const shared = pending.share !== undefined && views.every((v) => v.status === 'done');
  const message = await resultMessage(app, views, pending, shared);
  // The button on an ephemeral result posts this same result to the channel later.
  if (!shared && message.embeds?.length && pending.owner) {
    const forChannel = { ...message, components: (message.components as { components: { style: number }[] }[] | undefined)
      ?.map((row) => ({ ...row, components: row.components.filter((b) => b.style === 5) })).filter((row) => row.components.length) };
    await tryRedis(app.redis, app.log, (r) => r.set(postKey(id), JSON.stringify({ owner: pending.owner, message: forChannel }), 'EX', POST_TTL_S), null);
  }
  await post(app, key, pending, message, shared);
}

/** "Post in channel" on an ephemeral result: the invoker's result as a new public message, once. */
async function postToChannel(app: AppCtx, i: Interaction, discordId: string): Promise<Response> {
  const jobId = /^post:([0-9a-f-]{36})$/.exec(i.data?.custom_id ?? '')?.[1];
  if (!jobId) return reply('Unknown button.');
  const text = await tryRedis(app.redis, app.log, (r) => r.get(postKey(jobId)), null);
  const saved = text ? (JSON.parse(text) as { owner: string; message: Message }) : null;
  if (!saved) return reply('This result can no longer be posted. Run it again with share:true.');
  if (saved.owner !== discordId) return reply('Only the person who ran this can post it.');
  await tryRedis(app.redis, app.log, (r) => r.multi().del(postKey(jobId)).exec(), null);
  const embeds = (saved.message.embeds ?? []).map((e) => ({ ...e, description: `<@${discordId}> shared\n${e.description ?? ''}`.slice(0, 4096) }));
  return json({ type: MESSAGE, data: { ...saved.message, embeds, allowed_mentions: { parse: [] } } });
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
