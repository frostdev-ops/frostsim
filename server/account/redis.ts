// Redis for the account server (CLAUDE.md D15, DESIGN.md C4): keys under `frostsim:`, EVERY key written with a TTL because the shared
// instance has noeviction and no maxmemory. Redis is a cache: when it is down, callers fall back instead of failing the request.

import { Redis } from 'ioredis';
import type { Log } from './config';

export type { Redis };

export function connectRedis(url: string, log: Log): Redis {
  const redis = new Redis(url, {
    keyPrefix: 'frostsim:',
    // v5 wire protocol: ioredis 6 otherwise opens with HELLO 3 (carrying AUTH) and fails the connection when the ACL user may not
    // run HELLO, leaving the server silently on its fallbacks.
    protocol: 2,
    // Fail fast instead of queueing: a request must never wait on a dead cache.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
    connectTimeout: 2000,
    // The ACL user may not run INFO, which the ready check needs.
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  redis.on('error', (err: Error) => warnDown(log, err));
  return redis;
}

let lastWarn = 0;

/** At most one line a minute: a dead Redis must not flood the journal. Only the error code is logged; messages can carry URLs. */
export function warnDown(log: Log, err: unknown, now = Date.now()): void {
  if (now - lastWarn < 60_000) return;
  lastWarn = now;
  const code = (err as { code?: string })?.code ?? (err as Error)?.name ?? 'Error';
  log(`redis unavailable (${code}): sessions read Postgres, rate limits fail open, progress lines are dropped`);
}

/** Run a Redis call, or return `fallback` when Redis is absent or failing. */
export async function tryRedis<T>(redis: Redis | null, log: Log, fn: (r: Redis) => Promise<T>, fallback: T): Promise<T> {
  if (!redis) return fallback;
  try {
    return await fn(redis);
  } catch (err) {
    warnDown(log, err);
    return fallback;
  }
}
