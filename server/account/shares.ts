// Hosted report shares under /api/v1/shares (CLAUDE.md D15; DESIGN.md C4, C10, P6). Unlisted: anyone holding the id can read
// the share, and nothing lists it but its owner. The blob is the client's gzip(JSON portable report) at an immutable R2 attempt key,
// proxied through our origin as an attachment under a sandbox CSP, so nothing in it ever runs on this origin.
//
// A share is live while it is uploaded, not revoked and not expired. Every other state answers the same 404. Revoking sets revoked_at
// before the object goes, and an upload stores its size only `where revoked_at is null`, so a revoke or an account deletion racing an
// upload never leaves an object without a row. Retention (hourly): a user who lost hostedShares gets expires_at = now + 30 days on their
// live shares, cleared again if they resubscribe in time; expired shares and shares never uploaded within a day are revoked; revoked
// shares lose their object, then their row. storeShare does create and upload in one call for the Discord bot, which may host a report
// only for a user who personally has hostedShares: guild pools carry compute only.

import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { AppCtx, RequestCtx, Route, Task } from './app';
import { loadEntitlements } from './entitlements';
import { HttpError, errorSummary, json } from './http';
import { rateLimit } from './ratelimit';
import { PORTABLE_FORMAT, PORTABLE_VERSION } from '../../src/lib/store/records';
import { validateReport } from '../../src/lib/store/report-share';

/** Compressed upload cap (DESIGN.md C10); nginx raises client_max_body_size to 16m for the blob path only. */
export const MAX_UPLOAD = 16 << 20;
/** Decompressed cap, for the client's decoder too. Real reports measure about 0.7 MB. */
export const MAX_SHARE_JSON = 32 << 20;
/** 22 base62 characters: about 131 random bits. */
const ID_LENGTH = 22;
const MAX_TITLE = 200;
const LAPSE_MS = 30 * 86_400_000;
const UNUSED_MS = 86_400_000;
/** Longer than R2's 30-second request timeout; a crashed upload can be retried without reusing its object key. */
export const UPLOAD_LEASE_MS = 5 * 60_000;
const WRITES_PER_MINUTE = 10;
const VIEWS_PER_MINUTE = 120;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID = `(?<id>[0-9A-Za-z]{${ID_LENGTH}})`;
const LIST = /^\/api\/v1\/shares$/;
const ONE = new RegExp(`^/api/v1/shares/${ID}$`);
const BLOB = new RegExp(`^/api/v1/shares/${ID}/blob$`);

const inflate = promisify(gunzip);
const objectKey = (id: string) => `shares/${id}.json.gz`;
const bucket = (app: AppCtx) => app.config.env.R2_DATA_BUCKET!;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = (message: string) => new HttpError(400, 'invalid', message);
/** One answer for missing, revoked, expired and never-uploaded shares, and for another user's. */
const notFound = () => new HttpError(404, 'not-found', 'No such share.');

/** Uniform base62: bytes from 248 up are skipped so that every character is equally likely. */
function newId(): string {
  let id = '';
  while (id.length < ID_LENGTH) {
    for (const b of randomBytes(32)) if (b < 248 && id.length < ID_LENGTH) id += BASE62[b % 62];
  }
  return id;
}

async function limit(ctx: RequestCtx, bucketName: string, who: string, max: number): Promise<void> {
  if (!(await rateLimit(ctx, bucketName, who, max, 60))) throw new HttpError(429, 'rate-limited', 'Too many requests. Try again in a minute.');
}

function parseTitle(body: unknown): string {
  const title = isObject(body) ? body.title : undefined;
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed || trimmed.length > MAX_TITLE || /\p{Cc}/u.test(trimmed)) {
    throw invalid(`title must be 1-${MAX_TITLE} characters without control characters.`);
  }
  return trimmed;
}

/** Bounded inflate, then the portable-report envelope and snapshot the viewer reads (DESIGN.md C10). */
async function checkPayload(gz: Uint8Array): Promise<void> {
  // The route's maxBody already caps HTTP uploads; this covers storeShare's callers.
  if (gz.byteLength > MAX_UPLOAD) throw new HttpError(413, 'too-large', `The upload is larger than ${MAX_UPLOAD} bytes.`);
  let file: unknown;
  try {
    file = JSON.parse((await inflate(gz, { maxOutputLength: MAX_SHARE_JSON })).toString('utf8'));
  } catch {
    throw invalid(`The upload must be gzip of at most ${MAX_SHARE_JSON} bytes of JSON.`);
  }
  const envelope = isObject(file) ? file : {};
  const payload = isObject(envelope.payload) ? envelope.payload : {};
  if (envelope.format !== PORTABLE_FORMAT || envelope.version !== PORTABLE_VERSION || envelope.kind !== 'report') {
    throw invalid('The upload is not a Frostsim portable report.');
  }
  try {
    validateReport(payload.shared);
  } catch {
    throw invalid('The upload has no valid report snapshot.');
  }
  if (typeof payload.rawReport !== 'string' && payload.rawReport !== null) throw invalid('rawReport must be a string or null.');
}

// ponytail: one upload is inflated and parsed at a time per process, because a crafted 32 MiB JSON parses to a few hundred MB against
// the unit's MemoryMax=512M. Real uploads take milliseconds; bound the wait if uploads ever queue.
let checking: Promise<unknown> = Promise.resolve();

/** `read` runs inside that queue, so a waiting HTTP upload has not buffered its body yet. */
function checkedUpload(read: () => Promise<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const checked = checking.then(async () => {
    // readBody returns a Buffer.concat copy, never a view of a SharedArrayBuffer, which BodyInit refuses.
    const gz = (await read()) as Uint8Array<ArrayBuffer>;
    await checkPayload(gz);
    return gz;
  });
  checking = checked.catch(() => {});
  return checked;
}

async function requireHostedShares(app: AppCtx, userId: string): Promise<void> {
  if (!(await loadEntitlements(app.sql, { userId }, app.now())).hostedShares) {
    throw new HttpError(402, 'not-entitled', 'Hosted links need a plan that includes them.');
  }
}

async function insertShare(app: AppCtx, userId: string, title: string): Promise<string> {
  const id = newId();
  try {
    await app.sql`insert into shares (id, user_id, title, created_at) values (${id}, ${userId}, ${title}, ${app.now()})`;
  } catch (err) {
    // foreign_key_violation: the account was deleted after its checks passed.
    if ((err as { code?: string }).code === '23503') throw notFound();
    throw err;
  }
  return id;
}

/** Claim once before touching R2. A fresh attempt has its own durable key, so a late losing PUT/cleanup cannot touch the winner. */
async function storeBlob(app: AppCtx, userId: string, id: string, gz: Uint8Array<ArrayBuffer>): Promise<void> {
  const token = newId();
  const key = `shares/${id}/${token}.json.gz`;
  const now = app.now();
  await app.sql.begin(async (tx) => {
    const [claimed] = await tx`update shares set upload_token = ${token}, upload_started_at = ${now}
      where id = ${id} and user_id = ${userId} and bytes is null and revoked_at is null
        and (expires_at is null or expires_at > ${now})
        and (upload_token is null or upload_started_at <= ${new Date(now.getTime() - UPLOAD_LEASE_MS)}) returning id`;
    if (!claimed) {
      const [row] = await tx`select id from shares where id = ${id} and user_id = ${userId} and revoked_at is null
        and (expires_at is null or expires_at > ${now})`;
      if (!row) throw notFound();
      throw new HttpError(409, 'conflict', 'This share is already uploaded or an upload is in progress.');
    }
    await tx`insert into share_uploads (token, share_id, object_key, started_at) values (${token}, ${id}, ${key}, ${now})`;
  });
  const abandon = async () => {
    // Keep the staged-key index if R2 cleanup fails; retention/revoke/account deletion can retry it.
    try {
      await app.r2.delete(bucket(app), key);
      await app.sql`delete from share_uploads where token = ${token}`;
    } catch (cleanup) {
      app.log(`shares: upload cleanup failed (${errorSummary(cleanup)})`);
    }
    await app.sql`update shares set upload_token = null, upload_started_at = null where id = ${id} and upload_token = ${token}`;
  };
  try {
    // No Content-Encoding on the object: fetch would inflate it on the way back out.
    await app.r2.put(bucket(app), key, gz, { 'content-type': 'application/gzip' });
  } catch (err) {
    await abandon();
    throw err;
  }
  // A database error may mean COMMIT succeeded but its acknowledgment was lost. Leave the object and its durable index alone:
  // the next retry observes a completed share or, after the lease, chooses a new key; retention removes uncommitted old staging.
  const stored = await app.sql.begin(async (tx) => {
    const [row] = await tx`update shares set bytes = ${gz.byteLength}, object_key = ${key}, upload_token = null, upload_started_at = null
      where id = ${id} and user_id = ${userId} and upload_token = ${token} and bytes is null
        and revoked_at is null and (expires_at is null or expires_at > ${app.now()}) returning id`;
    if (!row) return false;
    await tx`delete from share_uploads where token = ${token}`;
    return true;
  });
  if (!stored) {
    await abandon();
    throw notFound();
  }
}

/**
 * Create and upload in one call, with the HTTP routes' checks, for server-side callers (the Discord bot). `gzipBytes` is what the
 * browser would PUT: gzip(JSON.stringify(makePortable('report', { shared, rawReport }))). Throws HttpError: 400 invalid, 402
 * not-entitled, 403 suspended, 413 too-large, 404 not-found when the account does not exist or went away mid-store. No rate limit: the
 * caller owns that. A failed R2 write leaves a never-uploaded row, which retention revokes after a day.
 */
export async function storeShare(app: AppCtx, share: { userId: string; title: string; gzipBytes: Uint8Array }): Promise<{ id: string }> {
  const title = parseTitle(share);
  // The routes get this from getSession; a bot caller names the user directly (compute's enqueueJob refuses the same way).
  const [user] = await app.sql`select suspended_at from users where id = ${share.userId}`;
  if (!user) throw notFound();
  if (user.suspended_at) throw new HttpError(403, 'suspended', 'This account is suspended.');
  await requireHostedShares(app, share.userId);
  // A copy: a plain ArrayBuffer for fetch, and the caller cannot change the bytes between the check and the write.
  const gz = await checkedUpload(async () => new Uint8Array(share.gzipBytes));
  const id = await insertShare(app, share.userId, title);
  await storeBlob(app, share.userId, id, gz);
  return { id };
}

/** The row a public read may serve, or 404. */
async function live(ctx: RequestCtx) {
  const [row] = await ctx.sql`select id, title, bytes, created_at, expires_at, object_key from shares where id = ${ctx.params.id}
    and revoked_at is null and bytes is not null and (expires_at is null or expires_at > ${ctx.now()})`;
  if (!row) throw notFound();
  return row;
}

const view = (r: Record<string, unknown>) => ({ id: r.id, title: r.title, bytes: r.bytes, createdAt: r.created_at, expiresAt: r.expires_at });

/** Object first, then row: a row left behind by a failed delete is retried, an object without a row would never be found again. */
async function purge(app: AppCtx, id: string): Promise<void> {
  const [row] = await app.sql`select object_key from shares where id = ${id}`;
  const staged = await app.sql`select object_key, started_at from share_uploads where share_id = ${id}`;
  for (const key of new Set([row?.object_key ?? objectKey(id), ...staged.map((r) => r.object_key as string)])) {
    await app.r2.delete(bucket(app), key);
  }
  // A PUT already in flight can finish after this DELETE. Keep its durable key index until it cleans up or its lease expires.
  if (staged.some((r) => r.started_at > new Date(app.now().getTime() - UPLOAD_LEASE_MS))) return;
  await app.sql`delete from shares where id = ${id}`;
}

async function retention(app: AppCtx): Promise<void> {
  const now = app.now();
  // Revoked rather than purged here, so an upload racing this run finds the row revoked and removes its own object.
  await app.sql`update shares set revoked_at = ${now} where revoked_at is null
    and (expires_at <= ${now} or (bytes is null and created_at < ${new Date(now.getTime() - UNUSED_MS)}))`;
  // ponytail: one entitlement lookup per owner of live shares; a set-based query if those owners reach many thousands.
  for (const { user_id: userId } of await app.sql`select distinct user_id from shares where revoked_at is null`) {
    if ((await loadEntitlements(app.sql, { userId }, now)).hostedShares) {
      // Resubscribed before the 30 days ran out: the shares stay.
      await app.sql`update shares set expires_at = null where user_id = ${userId} and revoked_at is null and expires_at > ${now}`;
    } else {
      // The first run that sees the lapse starts the 30 days, so expiry lands up to one run late, never early.
      await app.sql`update shares set expires_at = ${new Date(now.getTime() + LAPSE_MS)}
        where user_id = ${userId} and revoked_at is null and expires_at is null`;
    }
  }
  for (const { id } of await app.sql`select id from shares where revoked_at is not null limit 500`) await purge(app, id);
  // Failed cleanup can outlive a successful retry. Expire ownership before deleting old staged attempts, never a published key.
  const stale = new Date(now.getTime() - UNUSED_MS);
  await app.sql`update shares set upload_token = null, upload_started_at = null where upload_started_at <= ${stale}`;
  for (const upload of await app.sql`select u.token, u.object_key from share_uploads u join shares s on s.id = u.share_id
    where u.started_at <= ${stale} and u.object_key is distinct from s.object_key limit 500`) {
    await app.r2.delete(bucket(app), upload.object_key);
    await app.sql`delete from share_uploads where token = ${upload.token}`;
  }
}

export const routes: Route[] = [
  {
    method: 'GET', path: LIST, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      const rows = await ctx.sql`select id, title, bytes, created_at, expires_at from shares where user_id = ${ctx.session!.userId}
        and revoked_at is null and (expires_at is null or expires_at > ${ctx.now()}) order by created_at desc`;
      return json({ shares: rows.map(view) });
    },
  },
  {
    method: 'POST', path: LIST, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      const userId = ctx.session!.userId;
      await limit(ctx, 'shares', userId, WRITES_PER_MINUTE);
      const title = parseTitle(await ctx.json());
      await requireHostedShares(ctx, userId);
      return json({ id: await insertShare(ctx, userId, title) }, 201);
    },
  },
  {
    method: 'PUT', path: BLOB, feature: 'shares', auth: 'session', maxBody: MAX_UPLOAD, bodyType: 'application/gzip',
    handler: async (ctx) => {
      const userId = ctx.session!.userId;
      const { id } = ctx.params;
      // Rate limit and ownership before the body: each upload buffers up to 16 MiB.
      await limit(ctx, 'shares', userId, WRITES_PER_MINUTE);
      const [row] = await ctx.sql`select bytes from shares where id = ${id} and user_id = ${userId} and revoked_at is null
        and (expires_at is null or expires_at > ${ctx.now()})`;
      if (!row) throw notFound();
      if (row.bytes !== null) throw new HttpError(409, 'conflict', 'This share is already uploaded.');
      await storeBlob(ctx, userId, id, await checkedUpload(() => ctx.body()));
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'GET', path: ONE, feature: 'shares', auth: 'public',
    handler: async (ctx) => {
      await limit(ctx, 'share-views', ctx.ip, VIEWS_PER_MINUTE);
      return json(view(await live(ctx)));
    },
  },
  {
    method: 'GET', path: BLOB, feature: 'shares', auth: 'public',
    handler: async (ctx) => {
      await limit(ctx, 'share-views', ctx.ip, VIEWS_PER_MINUTE);
      const { id, object_key: key } = await live(ctx);
      const object = await ctx.r2.get(bucket(ctx), key ?? objectKey(id));
      if (!object) throw notFound();
      // Our headers only, never R2's. The app adds nosniff and no-store, so a revoke takes effect at once.
      return new Response(object.body, {
        headers: {
          'content-type': 'application/gzip',
          'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': 'attachment',
        },
      });
    },
  },
  {
    method: 'DELETE', path: ONE, feature: 'shares', auth: 'session',
    handler: async (ctx) => {
      const [row] = await ctx.sql`update shares set revoked_at = ${ctx.now()} where id = ${ctx.params.id}
        and user_id = ${ctx.session!.userId} and revoked_at is null returning id`;
      if (!row) throw notFound();
      // Revoked already stops it being served. A failed purge is retried by the retention task.
      await purge(ctx, row.id).catch((err) => ctx.log(`shares: purge after revoke failed (${errorSummary(err)})`));
      return new Response(null, { status: 204 });
    },
  },
];

export const tasks: Task[] = [{ name: 'shares-retention', feature: 'shares', everyMs: 3_600_000, run: retention }];
