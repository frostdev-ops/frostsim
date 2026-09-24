// Session helpers (CLAUDE.md D15, DESIGN.md C7): exact cookie flags, lookups that never reach the database for a bad cookie,
// suspension, ADMIN_ONLY, the hourly last_seen write, revocation versus the cache, and the expiry purge. Fake Postgres and Redis;
// the real round trip is in integration.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { AppCtx } from './app';
import { loadConfig } from './config';
import type { Sql } from './db';
import type { Redis } from './redis';
import { clearSessionCookie, createSession, destroySession, getSession, SESSION_COOKIE, tasks } from './session';
import { sha256Hex } from './signed';

function recorder(rows: (query: string) => unknown[] = () => []) {
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join('?');
    queries.push(query);
    return Promise.resolve(rows(query));
  }) as unknown as Sql;
  return { sql, queries };
}

const NOW = new Date('2026-09-23T12:00:00Z');
const ctx = (sql: Sql, adminOnly = '0', redis: Redis | null = null) =>
  ({ sql, redis, log: () => {}, now: () => NOW, config: loadConfig({ ADMIN_ONLY: adminOnly }) });
const COOKIE = 'a'.repeat(43);
const KEY = `sess:${sha256Hex(COOKIE)}`;

/** Redis stand-in: an empty cache that accepts writes; `del` may be made to fail. */
function fakeRedis(delFails = false) {
  const del = vi.fn(async () => {
    if (delFails) throw Object.assign(new Error('down'), { code: 'ECONNRESET' });
    return 1;
  });
  const set = vi.fn(async () => 'OK');
  return { redis: { get: async () => null, set, del } as unknown as Redis, set, del };
}
const withCookie = (value: string) => new Request('https://sim.test/', { headers: { cookie: `${SESSION_COOKIE}=${value}` } });

function row(over: Record<string, unknown> = {}) {
  return (query: string) => query.includes('from sessions s join users')
    ? [{ user_id: 'u1', role: 'user', display_name: 'Bob', suspended_at: null,
      expires_at: new Date(NOW.getTime() + 86_400_000), last_seen_at: new Date(NOW.getTime() - 60_000), ...over }]
    : query.includes('returning id_hash') ? [{ id_hash: 'h1' }]
    : query.includes('update sessions') ? [{ '?column?': 1 }] : [];
}

describe('cookies', () => {
  it('sets __Host-fs_sid with exactly the contract flags and a 30-day Max-Age', async () => {
    const { sql, queries } = recorder();
    const { cookie, idHash } = await createSession(ctx(sql), 'u1');
    expect(cookie).toMatch(/^__Host-fs_sid=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    expect(idHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toContain(idHash);
    expect(queries[0]).toContain('insert into sessions');
    expect(clearSessionCookie()).toBe('__Host-fs_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  });
});

describe('getSession', () => {
  it('never queries for a missing or malformed cookie', async () => {
    const { sql, queries } = recorder(row());
    expect(await getSession(ctx(sql), new Request('https://sim.test/'))).toBeNull();
    expect(await getSession(ctx(sql), withCookie('short'))).toBeNull();
    expect(await getSession(ctx(sql), withCookie(`${'a'.repeat(42)}!`))).toBeNull();
    expect(queries).toEqual([]);
  });

  it('returns the session from Postgres when Redis is absent, without a last_seen write inside the hour', async () => {
    const { sql, queries } = recorder(row());
    const session = await getSession(ctx(sql), withCookie('a'.repeat(43)));
    expect(session).toMatchObject({ userId: 'u1', role: 'user', displayName: 'Bob' });
    expect(queries.some((q) => q.includes('update sessions'))).toBe(false);
  });

  it('writes last_seen_at once an hour has passed', async () => {
    const { sql, queries } = recorder(row({ last_seen_at: new Date(NOW.getTime() - 3600_000) }));
    expect((await getSession(ctx(sql), withCookie('a'.repeat(43))))?.lastSeenAt).toBe(NOW.getTime());
    expect(queries.some((q) => q.includes('update sessions set last_seen_at'))).toBe(true);
  });

  it('gives a suspended user no session and deletes theirs', async () => {
    const { sql, queries } = recorder(row({ suspended_at: new Date() }));
    expect(await getSession(ctx(sql), withCookie('a'.repeat(43)))).toBeNull();
    expect(queries.some((q) => q.includes('delete from sessions where user_id'))).toBe(true);
  });

  it('hides non-admin sessions under ADMIN_ONLY', async () => {
    expect(await getSession(ctx(recorder(row()).sql, '1'), withCookie('a'.repeat(43)))).toBeNull();
    expect(await getSession(ctx(recorder(row({ role: 'admin' })).sql, '1'), withCookie('a'.repeat(43)))).not.toBeNull();
  });

  it('refuses a suspended user even when Redis cannot drop their other cached sessions', async () => {
    const { redis } = fakeRedis(true);
    expect(await getSession(ctx(recorder(row({ suspended_at: new Date() })).sql, '0', redis), withCookie(COOKIE))).toBeNull();
  });
});

describe('revocation versus the cache', () => {
  it('caches a miss and keeps it when a second read agrees', async () => {
    const { sql, queries } = recorder(row());
    const { redis, set, del } = fakeRedis();
    expect(await getSession(ctx(sql, '0', redis), withCookie(COOKIE))).toMatchObject({ userId: 'u1' });
    expect(set).toHaveBeenCalledWith(KEY, expect.any(String), 'EX', 300);
    expect(queries.filter((q) => q.includes('from sessions s join users'))).toHaveLength(2);
    expect(del).not.toHaveBeenCalled();
  });

  it('drops the copy it just cached when the row was revoked or changed in between', async () => {
    let reads = 0;
    const revoked = recorder((q) => (q.includes('from sessions s join users') && reads++ > 0 ? [] : row()(q)));
    const gone = fakeRedis();
    expect(await getSession(ctx(revoked.sql, '0', gone.redis), withCookie(COOKIE))).toBeNull();
    expect(gone.del).toHaveBeenCalledWith(KEY);

    let reads2 = 0;
    const demoted = recorder((q) => row(q.includes('from sessions s join users') && reads2++ > 0 ? { role: 'user' } : { role: 'admin' })(q));
    const changed = fakeRedis();
    expect(await getSession(ctx(demoted.sql, '0', changed.redis), withCookie(COOKIE))).toMatchObject({ role: 'user' });
    expect(changed.del).toHaveBeenCalledWith(KEY);
  });

  it('ends a cached session whose row is gone at the hourly touch', async () => {
    const cached = { idHash: sha256Hex(COOKIE), userId: 'u1', role: 'user', displayName: 'Bob',
      expiresAt: NOW.getTime() + 86_400_000, lastSeenAt: NOW.getTime() - 3600_000 };
    const del = vi.fn(async () => 1);
    const redis = { get: async () => JSON.stringify(cached), del } as unknown as Redis;
    const { sql, queries } = recorder(() => []);
    expect(await getSession(ctx(sql, '0', redis), withCookie(COOKIE))).toBeNull();
    expect(queries[0]).toContain('update sessions set last_seen_at');
    expect(del).toHaveBeenCalledWith(KEY);
  });

  it('makes a failed cache DEL on sign-out loud, and is quiet without Redis', async () => {
    const { sql, queries } = recorder();
    await expect(destroySession(ctx(sql, '0', fakeRedis(true).redis), 'h1')).rejects.toThrow('down');
    expect(queries[0]).toContain('delete from sessions where id_hash');
    await expect(destroySession(ctx(sql), 'h1')).resolves.toBeUndefined();
  });
});

describe('sessions-purge task', () => {
  it('deletes expired rows hourly under the accounts feature', async () => {
    const { sql, queries } = recorder();
    const [purge] = tasks;
    expect(purge).toMatchObject({ name: 'sessions-purge', feature: 'accounts', everyMs: 3600_000 });
    await purge.run({ ...ctx(sql), r2: null, fetch } as unknown as AppCtx);
    expect(queries).toEqual(['delete from sessions where expires_at <= ?']);
  });
});
