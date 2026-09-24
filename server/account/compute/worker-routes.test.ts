// Worker bearer checks that run before the database, so a malformed token or a flood costs no query.

import { describe, expect, it } from 'vitest';
import type { RequestCtx } from '../app';
import { resolveWorker } from './worker-routes';

const TOKEN = 'a'.repeat(43);

function ctx(authorization: string, count = 1) {
  const queried: unknown[] = [];
  const redis = { multi: () => ({ incr: () => ({ expire: () => ({ exec: async () => [[null, count], [null, 1]] }) }) }) };
  const sql = async (...args: unknown[]) => { queried.push(args); return [{ id: 'w1' }]; };
  const c = { request: new Request('https://sim.test/', { headers: { authorization } }), sql, redis, log: () => {}, now: () => new Date(), ip: '10.0.0.1' };
  return { c: c as unknown as RequestCtx, queried };
}

describe('resolveWorker', () => {
  it('refuses a malformed token or an IP over its limit without a database query', async () => {
    for (const auth of ['Bearer nope', `Bearer ${TOKEN}a`, `Bearer ${'a'.repeat(42)}!`]) {
      const { c, queried } = ctx(auth);
      expect(await resolveWorker(c)).toBeNull();
      expect(queried).toEqual([]);
    }
    const over = ctx(`Bearer ${TOKEN}`, 3001);
    expect(await resolveWorker(over.c)).toBeNull();
    expect(over.queried).toEqual([]);
    const ok = ctx(`Bearer ${TOKEN}`);
    expect(await resolveWorker(ok.c)).toBe('w1');
    expect(ok.queried).toHaveLength(1);
  });
});
