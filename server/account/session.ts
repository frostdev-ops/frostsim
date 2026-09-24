// Sessions (CLAUDE.md D15, DESIGN.md C7): 32 random bytes in `__Host-fs_sid`, only the sha256 stored, Redis `sess:<hash>` caches the
// Postgres row for 300 s. Suspended users have no session; ADMIN_ONLY staging hides every non-admin session.

import { randomBytes } from 'node:crypto';
import type { AppCtx, Task } from './app';
import { readCookie, setCookie } from './http';
import { tryRedis } from './redis';
import { sha256Hex } from './signed';

export const SESSION_COOKIE = '__Host-fs_sid';
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
const CACHE_TTL_S = 300;
const LAST_SEEN_EVERY_MS = 3600_000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/;

export interface Session {
  idHash: string;
  userId: string;
  role: 'user' | 'admin';
  displayName: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  lastSeenAt: number;
}

type SessionCtx = Pick<AppCtx, 'sql' | 'redis' | 'log' | 'now' | 'config'>;

const cacheKey = (idHash: string) => `sess:${idHash}`;

/** Inserts the session and returns the Set-Cookie value. The caller decides who may sign in (suspended, ADMIN_ONLY). */
export async function createSession(ctx: SessionCtx, userId: string): Promise<{ idHash: string; cookie: string }> {
  const id = randomBytes(32).toString('base64url');
  const idHash = sha256Hex(id);
  const now = ctx.now();
  await ctx.sql`insert into sessions (id_hash, user_id, created_at, expires_at, last_seen_at)
    values (${idHash}, ${userId}, ${now}, ${new Date(now.getTime() + SESSION_MAX_AGE_S * 1000)}, ${now})`;
  return { idHash, cookie: setCookie(SESSION_COOKIE, id, SESSION_MAX_AGE_S) };
}

export function clearSessionCookie(): string {
  return setCookie(SESSION_COOKIE, '', 0);
}

export async function getSession(ctx: SessionCtx, request: Request): Promise<Session | null> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id || !COOKIE_VALUE.test(id)) return null;
  const idHash = sha256Hex(id);
  const now = ctx.now().getTime();

  const load = async (): Promise<Session | null> => {
    const [row] = await ctx.sql`select s.user_id, s.expires_at, s.last_seen_at, u.role, u.display_name, u.suspended_at
      from sessions s join users u on u.id = s.user_id
      where s.id_hash = ${idHash} and s.expires_at > ${new Date(now)}`;
    if (!row) return null;
    if (row.suspended_at) {
      // Suspension should already have removed these; a missed one is removed now. This request is refused whether or not the
      // cache could be cleared, so a Redis failure here changes nothing.
      await destroyUserSessions(ctx, row.user_id).catch(() => {});
      return null;
    }
    return {
      idHash,
      userId: row.user_id,
      role: row.role,
      displayName: row.display_name,
      expiresAt: row.expires_at.getTime(),
      lastSeenAt: row.last_seen_at.getTime(),
    };
  };

  let session: Session | null = await tryRedis(ctx.redis, ctx.log, async (r) => {
    const cached = await r.get(cacheKey(idHash));
    return cached ? (JSON.parse(cached) as Session) : null;
  }, null);

  if (!session || session.expiresAt <= now) {
    session = await load();
    if (!session) return null;
    session = await store(ctx, session, load);
    if (!session) return null;
  }

  if (ctx.config.adminOnly && session.role !== 'admin') return null;

  if (now - session.lastSeenAt >= LAST_SEEN_EVERY_MS) {
    const touched = await ctx.sql`update sessions set last_seen_at = ${new Date(now)} where id_hash = ${idHash} returning 1`;
    if (!touched.length) {
      // Revoked while a cached copy was still being served.
      await tryRedis(ctx.redis, ctx.log, (r) => r.del(cacheKey(idHash)), 0);
      return null;
    }
    session = await store(ctx, { ...session, lastSeenAt: now }, load);
  }
  return session;
}

/** Caches the session, then reads the row again: a revoke landing between our read and this write would otherwise live on in the
 *  cache for up to 300 s. Revokers change the row first and clear the cache second, so one of the two always catches it. */
async function store(ctx: SessionCtx, session: Session, load: () => Promise<Session | null>): Promise<Session | null> {
  const ttl = Math.min(CACHE_TTL_S, Math.floor((session.expiresAt - ctx.now().getTime()) / 1000));
  if (ttl < 1) return session;
  const written = await tryRedis(ctx.redis, ctx.log, async (r) => {
    await r.set(cacheKey(session.idHash), JSON.stringify(session), 'EX', ttl);
    return true;
  }, false);
  if (!written) return session;
  const again = await load();
  if (JSON.stringify(again) === JSON.stringify(session)) return session;
  await tryRedis(ctx.redis, ctx.log, (r) => r.del(cacheKey(session.idHash)), 0);
  return again;
}

/** Sign-out of one session. Throws when Redis refuses to drop the cached copy (the row is already gone); see forget. */
export async function destroySession(ctx: SessionCtx, idHash: string): Promise<void> {
  await ctx.sql`delete from sessions where id_hash = ${idHash}`;
  await forget(ctx, [idHash]);
}

/** Every session of a user, e.g. on suspend or before deleting the account. Rows first, cache second; throws like destroySession. */
export async function destroyUserSessions(ctx: SessionCtx, userId: string): Promise<void> {
  const rows = await ctx.sql`delete from sessions where user_id = ${userId} returning id_hash`;
  await forget(ctx, rows.map((r) => r.id_hash as string));
}

/** Drop cached copies so a role or name change is seen on the next request instead of within 5 minutes. Call it AFTER the row change. */
export async function forgetCachedSessions(ctx: SessionCtx, userId: string): Promise<void> {
  const rows = await ctx.sql`select id_hash from sessions where user_id = ${userId}`;
  await forget(ctx, rows.map((r) => r.id_hash as string));
}

/** Not tryRedis: a copy left behind keeps a revoked session alive for up to 300 s, so the caller must hear that the DEL failed. */
async function forget(ctx: SessionCtx, hashes: string[]): Promise<void> {
  if (ctx.redis && hashes.length) await ctx.redis.del(...hashes.map(cacheKey));
}

/** Expired rows are otherwise only removed by logout, suspension or account deletion. */
export const tasks: Task[] = [{
  name: 'sessions-purge',
  feature: 'accounts',
  everyMs: 3600_000,
  run: async (ctx) => {
    await ctx.sql`delete from sessions where expires_at <= ${ctx.now()}`;
  },
}];
