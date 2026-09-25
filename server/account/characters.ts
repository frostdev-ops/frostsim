// Cloud character slots under /api/v1/characters (CLAUDE.md D15; DESIGN.md C5, P6): the addon export text itself, capped at
// 64 KiB and re-parsed with parseAddonExport on both ends. Gated by `shares`: slots and hosted shares ship as one switch.
//
// POST always adds a character and needs count < entitlements.slots, checked under the user's row lock so concurrent saves cannot
// overshoot. PUT /:id replaces one of the user's characters in place and needs no free slot. Labels need not be unique: two
// characters can share a name, so replacing is always by id.
//
// History: every save whose equipped set differs from the last one adds a gear snapshot, the browser uploads its finished Quick Sims
// of the character (POST /:id/sims), and the patch-resims task queues one cloud Quick Sim per character when the game build of the
// newest engine pack changes. All of it is deleted with the character.

import type { AppCtx, RequestCtx, Route, Task } from './app';
import type { Db } from './db';
import { loadEntitlements } from './entitlements';
import { HttpError, errorSummary, json } from './http';
import { rateLimit } from './ratelimit';
import { enqueueJob } from './compute/queue';
import { defaultPackInfo } from './compute/packs';
import { looksLikeProfile, parseAddonExport, type ImportedCharacter } from '../../src/lib/import/character';
import { gearSnapshot, sameGear, type GearItem } from '../../src/lib/account/history';
import { quickRequest } from '../../src/lib/simc/quick-request';

const MAX_RAW_BYTES = 64 * 1024;
/** Upstream simc profiles reach 1,736 characters a line. The parser's item-comment regex is quadratic in line length. */
const MAX_LINE = 4096;
const MAX_LABEL = 100;
const WRITES_PER_MINUTE = 20;
const ID = '(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const LIST = /^\/api\/v1\/characters$/;
const ONE = new RegExp(`^/api/v1/characters/${ID}$`);
const HISTORY = new RegExp(`^/api/v1/characters/${ID}/history$`);
const SIMS = new RegExp(`^/api/v1/characters/${ID}/sims$`);
/** Kept per character, newest first; older rows are dropped. */
const MAX_SNAPSHOTS = 200;
const MAX_SIMS = 500;
const SIMS_PER_UPLOAD = 50;
/** Patch re-sims: Patchwerk, one target, default length and accuracy, so points on one character compare. */
const PATCH_PRESET = 'target-dummy';
const PATCH_BATCH = 20;

const invalid = (message: string) => new HttpError(400, 'invalid', message);
const notFound = () => new HttpError(404, 'not-found', 'No such character.');
const notProfile = () => invalid('raw is not a /simc addon export.');

/** Untrusted body -> { label, raw, parsed }. Postgres text refuses NUL, so it is a 400 here rather than a 500 at insert. */
function parseSave(body: unknown): { label: string; raw: string; parsed: ImportedCharacter } {
  const { label, raw } = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof label !== 'string') throw invalid('label must be a string.');
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > MAX_LABEL || /\p{Cc}/u.test(trimmed)) {
    throw invalid(`label must be 1-${MAX_LABEL} characters without control characters.`);
  }
  if (typeof raw !== 'string') throw invalid('raw must be the addon export text.');
  if (Buffer.byteLength(raw) > MAX_RAW_BYTES) throw new HttpError(413, 'too-large', `raw is larger than ${MAX_RAW_BYTES} bytes.`);
  if (raw.includes('\u0000')) throw notProfile();
  if (raw.split(/\r\n?|\n/).some((line) => line.length > MAX_LINE)) throw invalid(`raw has a line longer than ${MAX_LINE} characters.`);
  // looksLikeProfile's `\s*` backtracks across runs of blank lines (quadratic). Dropping the whitespace after each newline keeps it
  // linear and changes no line's first word.
  if (!looksLikeProfile(raw.replace(/\n\s*/g, '\n'))) throw notProfile();
  const parsed = parseAddonExport(raw);
  if (parsed.diagnostics.some((d) => d.severity === 'error')) throw notProfile();
  return { label: trimmed, raw, parsed };
}

/** Adds a gear snapshot when the equipped set differs from the newest one, and trims the oldest past MAX_SNAPSHOTS. */
export async function recordSnapshot(db: Db, characterId: string, parsed: ImportedCharacter, now: Date): Promise<void> {
  const snap = gearSnapshot(parsed);
  const [last] = await db`select gear from character_snapshots where character_id = ${characterId} order by created_at desc limit 1`;
  if (last && sameGear(last.gear as GearItem[], snap.gear)) return;
  await db`insert into character_snapshots (character_id, created_at, item_level, gear)
    values (${characterId}, ${now}, ${snap.itemLevel}, ${db.json(snap.gear as never)})`;
  await db`delete from character_snapshots where character_id = ${characterId} and id not in
    (select id from character_snapshots where character_id = ${characterId} order by created_at desc limit ${MAX_SNAPSHOTS})`;
}

const finite = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const shortText = (v: unknown, pattern: RegExp) => (typeof v === 'string' && pattern.test(v) ? v : undefined);

export interface SimUpload { reportId: string; createdAt: Date; dps: number; dpsError?: number; fightStyle?: string; targets?: number; gameBuild?: string }

/** Untrusted POST /:id/sims body -> points. They describe only the uploader's own character, so the check is shape and range. */
export function parseSims(body: unknown, now: Date): SimUpload[] {
  const points = (body !== null && typeof body === 'object' ? (body as Record<string, unknown>).points : undefined);
  if (!Array.isArray(points) || points.length > SIMS_PER_UPLOAD) throw invalid(`points must be an array of at most ${SIMS_PER_UPLOAD}.`);
  return points.map((p: Record<string, unknown>) => {
    const reportId = shortText(p?.reportId, /^[\w-]{1,64}$/);
    const createdAt = typeof p?.createdAt === 'string' ? new Date(p.createdAt) : null;
    const dps = finite(p?.dps, 0.001, 1e9);
    if (!reportId || !createdAt || !(createdAt.getTime() > Date.UTC(2020, 0)) || createdAt.getTime() > now.getTime() + 86_400_000 || !dps) {
      throw invalid('Each point needs a reportId, an ISO createdAt and a positive dps.');
    }
    return {
      reportId, createdAt, dps,
      dpsError: finite(p.dpsError, 0, 1e9),
      fightStyle: shortText(p.fightStyle, /^[A-Za-z]{1,32}$/),
      targets: finite(p.targets, 1, 100),
      gameBuild: shortText(p.gameBuild, /^[\d.]{1,32}$/),
    };
  });
}

/** Stored beside the export as `who`. */
function who(c: ImportedCharacter): { name: string; className: string; spec?: string; server?: string; region?: string } {
  return { name: c.name, className: c.className, spec: c.spec, server: c.server, region: c.region };
}

async function owned(ctx: RequestCtx): Promise<void> {
  const [row] = await ctx.sql`select 1 from cloud_characters where id = ${ctx.params.id} and user_id = ${ctx.session!.userId}`;
  if (!row) throw notFound();
}

/** Queues one Patchwerk Quick Sim per character whose patch_build is behind the newest pack's game build (DESIGN.md C5). The build
 *  is claimed before the run is queued, so a refusal for the plan (402) skips that build; a full queue or no capacity puts it back. */
export async function patchResims(app: AppCtx, env: Record<string, string | undefined> = process.env): Promise<void> {
  await recordPatchResults(app);
  const pack = await defaultPackInfo(app, env);
  if (!pack?.build) return;
  // A character saved before any build was known takes the current one as its baseline, without a run.
  await app.sql`update cloud_characters set patch_build = ${pack.build} where patch_build is null`;
  const rows = await app.sql`select c.id, c.user_id, c.raw, c.patch_build from cloud_characters c join users u on u.id = c.user_id
    where c.patch_build <> ${pack.build} and u.suspended_at is null order by c.updated_at desc limit ${PATCH_BATCH}`;
  for (const row of rows) {
    const [claimed] = await app.sql`update cloud_characters set patch_build = ${pack.build}
      where id = ${row.id} and patch_build = ${row.patch_build} returning id`;
    if (!claimed) continue;
    let request;
    try {
      request = quickRequest(parseAddonExport(row.raw), { presetId: PATCH_PRESET, threads: 1 });
    } catch (err) {
      app.log(`characters: patch re-sim of ${row.id} skipped (${errorSummary(err)})`);
      continue;
    }
    const out = await enqueueJob(app, { userId: row.user_id, guildId: null, source: 'patch', packId: pack.id, request });
    if (out.ok) {
      await app.sql`update compute_jobs set character_id = ${row.id} where id = ${out.id}`;
    } else if (out.status === 429 || out.status === 503) {
      await app.sql`update cloud_characters set patch_build = ${row.patch_build} where id = ${row.id} and patch_build = ${pack.build}`;
      if (out.status === 503) return;
    }
  }
}

/** Finished patch re-sims become history points; the game build is the one the character was claimed for. */
async function recordPatchResults(app: AppCtx): Promise<void> {
  const jobs = await app.sql`select j.id, j.character_id, j.summary, j.request, j.finished_at, c.patch_build from compute_jobs j
    join cloud_characters c on c.id = j.character_id left join character_sims s on s.job_id = j.id
    where j.source = 'patch' and j.status = 'done' and s.id is null and j.finished_at > ${new Date(app.now().getTime() - 7 * 86_400_000)}
    limit 100`;
  for (const j of jobs) {
    const dps = finite(j.summary?.dps, 0.001, 1e9);
    if (!dps) continue;
    const settings = j.request?.settings ?? {};
    await app.sql`insert into character_sims (character_id, created_at, source, dps, dps_error, fight_style, targets, game_build, job_id)
      values (${j.character_id}, ${j.finished_at}, 'patch', ${dps}, ${finite(j.summary?.dpsError, 0, 1e9) ?? null},
        ${shortText(settings.fightStyle, /^[A-Za-z]{1,32}$/) ?? null}, ${finite(settings.targets, 1, 100) ?? null}, ${j.patch_build}, ${j.id})
      on conflict do nothing`;
  }
}

/** Before the body is read: parsing is the costly part of a save. */
async function limitWrites(ctx: RequestCtx): Promise<void> {
  if (!(await rateLimit(ctx, 'characters', ctx.session!.userId, WRITES_PER_MINUTE, 60))) {
    throw new HttpError(429, 'rate-limited', 'Too many character saves. Try again in a minute.');
  }
}

export const routes: Route[] = [
  {
    method: 'GET', path: LIST, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      const userId = ctx.session!.userId;
      const [{ slots }, rows] = await Promise.all([
        loadEntitlements(ctx.sql, { userId }, ctx.now()),
        ctx.sql`select c.id, c.label, c.bytes, c.updated_at, c.who, s.item_level from cloud_characters c
          left join lateral (select item_level from character_snapshots where character_id = c.id order by created_at desc limit 1) s on true
          where c.user_id = ${userId} order by c.updated_at desc`,
      ]);
      // `who` lets the Character page match its open character to a slot without the export.
      return json({ slots, characters: rows.map((r) => ({
        id: r.id, label: r.label, bytes: r.bytes, updatedAt: r.updated_at, itemLevel: r.item_level ?? undefined, who: r.who ?? undefined,
      })) });
    },
  },
  {
    method: 'GET', path: ONE, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      const [row] = await ctx.sql`select id, label, raw, updated_at from cloud_characters
        where id = ${ctx.params.id} and user_id = ${ctx.session!.userId}`;
      if (!row) throw notFound();
      return json({ id: row.id, label: row.label, raw: row.raw, updatedAt: row.updated_at });
    },
  },
  {
    // JSON escaping of quotes and newlines grows the text; the 64 KiB cap applies to raw itself.
    method: 'POST', path: LIST, feature: 'shares', auth: 'session', maxBody: 4 * MAX_RAW_BYTES,
    handler: async (ctx) => {
      await limitWrites(ctx);
      const { label, raw, parsed } = parseSave(await ctx.json());
      const userId = ctx.session!.userId;
      const now = ctx.now();
      const id = await ctx.sql.begin(async (tx) => {
        await tx`select 1 from users where id = ${userId} for update`;
        const { slots } = await loadEntitlements(tx, { userId }, now);
        const [{ used }] = await tx`select count(*)::int as used from cloud_characters where user_id = ${userId}`;
        if (used >= slots) throw new HttpError(402, 'no-slots', 'Every cloud character slot is in use.');
        const [row] = await tx`insert into cloud_characters (user_id, label, raw, bytes, who, created_at, updated_at)
          values (${userId}, ${label}, ${raw}, ${Buffer.byteLength(raw)}, ${tx.json(who(parsed))}, ${now}, ${now}) returning id`;
        await recordSnapshot(tx, row.id, parsed, now);
        return row.id as string;
      });
      return json({ id }, 201);
    },
  },
  {
    method: 'PUT', path: ONE, feature: 'shares', auth: 'session', maxBody: 4 * MAX_RAW_BYTES,
    handler: async (ctx) => {
      await limitWrites(ctx);
      const { label, raw, parsed } = parseSave(await ctx.json());
      const now = ctx.now();
      const row = await ctx.sql.begin(async (tx) => {
        const [updated] = await tx`update cloud_characters set label = ${label}, raw = ${raw}, bytes = ${Buffer.byteLength(raw)},
          who = ${tx.json(who(parsed))}, updated_at = ${now} where id = ${ctx.params.id} and user_id = ${ctx.session!.userId} returning id`;
        if (updated) await recordSnapshot(tx, updated.id, parsed, now);
        return updated;
      });
      if (!row) throw notFound();
      return json({ id: row.id });
    },
  },
  {
    method: 'GET', path: HISTORY, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      await owned(ctx);
      const id = ctx.params.id;
      const [snapshots, sims] = await Promise.all([
        ctx.sql`select id, created_at, item_level, gear from character_snapshots where character_id = ${id} order by created_at`,
        ctx.sql`select created_at, source, dps, dps_error, fight_style, targets, game_build, report_id from character_sims
          where character_id = ${id} order by created_at`,
      ]);
      return json({
        snapshots: snapshots.map((s) => ({ id: s.id, createdAt: s.created_at, itemLevel: s.item_level, gear: s.gear })),
        sims: sims.map((s) => ({
          createdAt: s.created_at, source: s.source, dps: s.dps, dpsError: s.dps_error ?? undefined, fightStyle: s.fight_style ?? undefined,
          targets: s.targets ?? undefined, gameBuild: s.game_build ?? undefined, reportId: s.report_id ?? undefined,
        })),
      });
    },
  },
  {
    method: 'POST', path: SIMS, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      await limitWrites(ctx);
      await owned(ctx);
      const id = ctx.params.id;
      const points = parseSims(await ctx.json(), ctx.now());
      let added = 0;
      for (const p of points) {
        const rows = await ctx.sql`insert into character_sims (character_id, created_at, source, dps, dps_error, fight_style, targets, game_build, report_id)
          values (${id}, ${p.createdAt}, 'run', ${p.dps}, ${p.dpsError ?? null}, ${p.fightStyle ?? null}, ${p.targets ?? null},
            ${p.gameBuild ?? null}, ${p.reportId})
          on conflict (character_id, report_id) do nothing returning id`;
        added += rows.length;
      }
      if (added) {
        await ctx.sql`delete from character_sims where character_id = ${id} and id not in
          (select id from character_sims where character_id = ${id} order by created_at desc limit ${MAX_SIMS})`;
      }
      return json({ added });
    },
  },
  {
    method: 'DELETE', path: ONE, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      const [row] = await ctx.sql`delete from cloud_characters where id = ${ctx.params.id} and user_id = ${ctx.session!.userId} returning id`;
      if (!row) throw notFound();
      return new Response(null, { status: 204 });
    },
  },
];

export const tasks: Task[] = [{ name: 'patch-resims', feature: 'compute', everyMs: 10 * 60_000, run: (app) => patchResims(app) }];
