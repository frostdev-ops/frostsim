// Fixed-window rate limiter (CLAUDE.md D15, DESIGN.md C4): counts per window, keys carry a TTL, fails open without Redis.

import { describe, expect, it } from 'vitest';
import { rateLimit } from './ratelimit';
import type { Redis } from './redis';

/** Minimal MULTI stand-in recording each key's TTL. */
function fakeRedis() {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  const redis = {
    multi() {
      const ops: (() => [null, number])[] = [];
      const chain = {
        incr: (key: string) => (ops.push(() => [null, counts.set(key, (counts.get(key) ?? 0) + 1).get(key)!]), chain),
        expire: (key: string, s: number) => (ops.push(() => [null, (ttls.set(key, s), 1)]), chain),
        exec: async () => ops.map((op) => op()),
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Redis, ttls };
}

const at = (iso: string) => () => new Date(iso);

describe('rateLimit', () => {
  it('allows `limit` calls per window, then refuses until the next window', async () => {
    const { redis, ttls } = fakeRedis();
    const ctx = { redis, log: () => {}, now: at('2026-09-23T12:00:10Z') };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(ctx, 'login', '1.2.3.4', 3, 60));
    expect(results).toEqual([true, true, true, false]);
    expect(await rateLimit({ ...ctx, now: at('2026-09-23T12:01:00Z') }, 'login', '1.2.3.4', 3, 60)).toBe(true);
    expect([...ttls.values()].every((s) => s === 60)).toBe(true);
    expect([...ttls.keys()][0]).toBe(`rl:login:1.2.3.4:${Math.floor(Date.parse('2026-09-23T12:00:10Z') / 60_000)}`);
  });

  it('fails open when Redis is absent or failing, and says so in the log', async () => {
    const lines: string[] = [];
    const broken = { multi: () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } } as unknown as Redis;
    expect(await rateLimit({ redis: null, log: (l) => lines.push(l), now: () => new Date() }, 'b', 'w', 0, 60)).toBe(true);
    expect(await rateLimit({ redis: broken, log: (l) => lines.push(l), now: () => new Date() }, 'b', 'w', 0, 60)).toBe(true);
    expect(lines.join('\n')).toMatch(/redis unavailable \(ECONNREFUSED\)/);
  });
});
