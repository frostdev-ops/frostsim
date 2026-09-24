// Cloud character slots under /api/v1/characters (CLAUDE.md D15; DESIGN.md C5, P6): the addon export text itself, capped at
// 64 KiB and re-parsed with parseAddonExport on both ends. Gated by `shares`: slots and hosted shares ship as one switch.
//
// POST always adds a character and needs count < entitlements.slots, checked under the user's row lock so concurrent saves cannot
// overshoot. PUT /:id replaces one of the user's characters in place and needs no free slot. Labels need not be unique: two
// characters can share a name, so replacing is always by id.

import type { RequestCtx, Route, Task } from './app';
import { loadEntitlements } from './entitlements';
import { HttpError, json } from './http';
import { rateLimit } from './ratelimit';
import { looksLikeProfile, parseAddonExport } from '../../src/lib/import/character';

const MAX_RAW_BYTES = 64 * 1024;
/** Upstream simc profiles reach 1,736 characters a line. The parser's item-comment regex is quadratic in line length. */
const MAX_LINE = 4096;
const MAX_LABEL = 100;
const WRITES_PER_MINUTE = 20;
const ID = '(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const LIST = /^\/api\/v1\/characters$/;
const ONE = new RegExp(`^/api/v1/characters/${ID}$`);

const invalid = (message: string) => new HttpError(400, 'invalid', message);
const notFound = () => new HttpError(404, 'not-found', 'No such character.');
const notProfile = () => invalid('raw is not a /simc addon export.');

/** Untrusted body -> { label, raw }. Postgres text refuses NUL, so it is a 400 here rather than a 500 at insert. */
function parseSave(body: unknown): { label: string; raw: string } {
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
  if (parseAddonExport(raw).diagnostics.some((d) => d.severity === 'error')) throw notProfile();
  return { label: trimmed, raw };
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
        ctx.sql`select id, label, bytes, updated_at from cloud_characters where user_id = ${userId} order by updated_at desc`,
      ]);
      return json({ slots, characters: rows.map((r) => ({ id: r.id, label: r.label, bytes: r.bytes, updatedAt: r.updated_at })) });
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
      const { label, raw } = parseSave(await ctx.json());
      const userId = ctx.session!.userId;
      const now = ctx.now();
      const id = await ctx.sql.begin(async (tx) => {
        await tx`select 1 from users where id = ${userId} for update`;
        const { slots } = await loadEntitlements(tx, { userId }, now);
        const [{ used }] = await tx`select count(*)::int as used from cloud_characters where user_id = ${userId}`;
        if (used >= slots) throw new HttpError(402, 'no-slots', 'Every cloud character slot is in use.');
        const [row] = await tx`insert into cloud_characters (user_id, label, raw, bytes, created_at, updated_at)
          values (${userId}, ${label}, ${raw}, ${Buffer.byteLength(raw)}, ${now}, ${now}) returning id`;
        return row.id as string;
      });
      return json({ id }, 201);
    },
  },
  {
    method: 'PUT', path: ONE, feature: 'shares', auth: 'session', maxBody: 4 * MAX_RAW_BYTES,
    handler: async (ctx) => {
      await limitWrites(ctx);
      const { label, raw } = parseSave(await ctx.json());
      const [row] = await ctx.sql`update cloud_characters set label = ${label}, raw = ${raw}, bytes = ${Buffer.byteLength(raw)},
        updated_at = ${ctx.now()} where id = ${ctx.params.id} and user_id = ${ctx.session!.userId} returning id`;
      if (!row) throw notFound();
      return json({ id: row.id });
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

export const tasks: Task[] = [];
