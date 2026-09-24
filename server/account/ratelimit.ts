// Fixed-window rate limits in Redis (CLAUDE.md D15, DESIGN.md C4): key `rl:<bucket>:<who>:<window>` with TTL = window.
// Fails open when Redis is down: losing the cache must not lock every user out.

import type { Log } from './config';
import { tryRedis, type Redis } from './redis';

/** True when the call is within `limit` per `windowS`. Key authenticated limits on the user id, unauthenticated ones on the client IP. */
export async function rateLimit(
  ctx: { redis: Redis | null; log: Log; now: () => Date },
  bucket: string,
  who: string,
  limit: number,
  windowS: number,
): Promise<boolean> {
  const key = `rl:${bucket}:${who}:${Math.floor(ctx.now().getTime() / 1000 / windowS)}`;
  const count = await tryRedis(ctx.redis, ctx.log, async (r) => {
    // One MULTI so the counter never exists without its TTL.
    const replies = await r.multi().incr(key).expire(key, windowS).exec();
    const [err, value] = replies?.[0] ?? [new Error('multi aborted'), 0];
    if (err) throw err;
    return Number(value);
  }, 0);
  return count <= limit;
}
