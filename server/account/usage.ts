// Metered compute use (CLAUDE.md D14; DESIGN.md C6): compute_jobs is the ledger. A job counts once it is claimed; its core_seconds
// are written when it finishes or is cancelled while running (claim to now), so a running job contributes 0 until then. A job
// cancelled while still queued meters 0.

import type { Db } from './db';

type Who = { userId: string } | { guildId: string; userId?: string };
const scopeOf = (db: Db, who: Who) => !('guildId' in who) ? db`user_id = ${who.userId} and guild_id is null`
  : who.userId ? db`guild_id = ${who.guildId} and user_id = ${who.userId}` : db`guild_id = ${who.guildId}`;

/** SUM(core_seconds) for jobs created in [from, to). Guild jobs never count against the personal allowance; with both ids, one
 *  member's use of a guild pool. */
export async function usedCoreSeconds(db: Db, who: Who, from: Date, to: Date): Promise<number> {
  const scope = scopeOf(db, who);
  const [row] = await db`select coalesce(sum(core_seconds), 0)::float8 as used from compute_jobs
    where ${scope} and status in ('running', 'done', 'failed', 'cancelled') and created_at >= ${from} and created_at < ${to}`;
  return Number(row.used);
}

/** USD our servers cost for the jobs created in [from, to): finished jobs at their cost_usd, a running job at the worst case reserved
 *  for it at claim (queue.ts costProblem). Same scopes as usedCoreSeconds. */
export async function usedCostUsd(db: Db, who: Who, from: Date, to: Date): Promise<number> {
  const [row] = await db`select coalesce(sum(case when status = 'running' then coalesce(reserve_usd, 0) else cost_usd end), 0)::float8 as used
    from compute_jobs where ${scopeOf(db, who)} and status in ('running', 'done', 'failed', 'cancelled') and created_at >= ${from} and created_at < ${to}`;
  return Number(row.used);
}
