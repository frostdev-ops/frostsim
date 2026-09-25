// Per-role guild allowances (CLAUDE.md D15): the allowance rule, body validation and the payer-only boundary, with a fake SQL.

import { describe, expect, it } from 'vitest';
import type { RequestCtx } from './app';
import { memberAllowance, parseLimits, routes } from './guild-roles';

const G = '715706763176837131';
const RAIDER = '800000000000000001';
const OFFICER = '800000000000000002';

describe('memberAllowance', () => {
  it('uses @everyone, unlimited when unset', () => {
    expect(memberAllowance(G, {}, [])).toBeNull();
    expect(memberAllowance(G, { [G]: 100 }, [RAIDER])).toBe(100);
  });

  it('lets a set role override @everyone, the largest set role winning', () => {
    expect(memberAllowance(G, { [G]: 0, [RAIDER]: 500 }, [RAIDER])).toBe(500);
    expect(memberAllowance(G, { [G]: 1000, [RAIDER]: 0 }, [RAIDER])).toBe(0);
    expect(memberAllowance(G, { [RAIDER]: 500, [OFFICER]: 900 }, [RAIDER, OFFICER])).toBe(900);
    expect(memberAllowance(G, { [G]: 0, [RAIDER]: 500, [OFFICER]: null }, [RAIDER, OFFICER])).toBeNull();
  });
});

describe('parseLimits', () => {
  it('accepts role ids to whole core-seconds or null', () => {
    expect(parseLimits({ limits: { [G]: 0, [RAIDER]: null } })).toEqual({ [G]: 0, [RAIDER]: null });
  });

  it.each([
    [null], [{}], [{ limits: [] }], [{ limits: { abc: 1 } }], [{ limits: { [G]: -1 } }], [{ limits: { [G]: 1.5 } }], [{ limits: { [G]: '5' } }],
    [{ limits: Object.fromEntries(Array.from({ length: 251 }, (_, i) => [`8000000000000${String(i).padStart(5, '0')}`, 1])) }],
  ])('refuses %j', (body) => {
    expect(() => parseLimits(body)).toThrow();
  });
});

describe('PUT /discord/guilds/:id', () => {
  const put = routes.find((r) => r.method === 'PUT')!;
  function ctx(paysFor: string[]) {
    const writes: string[] = [];
    const sql = ((first: unknown, ...values: unknown[]) => {
      if (!Array.isArray(first) || !('raw' in first)) return first;
      const q = (first as unknown as string[]).join('?');
      if (/insert|delete/.test(q)) writes.push(q);
      if (q.includes('from subscriptions')) return Promise.resolve(paysFor.map((guild_id) => ({ guild_id })));
      void values;
      return Promise.resolve([]);
    }) as unknown as RequestCtx['sql'];
    Object.assign(sql, { begin: (fn: (tx: unknown) => unknown) => fn(sql), json: (v: unknown) => v });
    return {
      writes,
      ctx: {
        params: { guildId: G }, session: { userId: 'u1' }, sql, now: () => new Date(), log: () => {},
        config: { env: {} }, fetch: async () => new Response(null, { status: 403 }), json: async () => ({ limits: { [G]: 0 } }),
      } as unknown as RequestCtx,
    };
  }

  it('refuses a server the user does not pay for, before writing', async () => {
    const { ctx: c, writes } = ctx(['111111111111111111']);
    await expect(put.handler(c)).rejects.toMatchObject({ status: 404 });
    expect(writes).toEqual([]);
  });

  it('replaces the limits of a server the user pays for', async () => {
    const { ctx: c, writes } = ctx([G]);
    await put.handler(c);
    expect(writes.map((q) => q.split(' ').slice(0, 3).join(' '))).toEqual(['delete from guild_role_limits', 'insert into guild_role_limits', 'insert into audit_log']);
  });
});
