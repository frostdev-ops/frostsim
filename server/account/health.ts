// GET /api/v1/health (CLAUDE.md D15): always on, even with every feature off. Reports states, never values or secrets.

import type { AppDeps } from './app';
import { json } from './http';

type State = 'off' | 'ok' | 'down';

/** Unauthenticated and public: probes are shared for a few seconds so a flood cannot hold the 5-connection pool. */
const PROBE_TTL_MS = 5000;
const probes = new WeakMap<AppDeps, { at: number; db: State; redis: State }>();

export async function health(deps: AppDeps): Promise<Response> {
  const now = deps.now().getTime();
  let last = probes.get(deps);
  if (!last || now - last.at >= PROBE_TTL_MS) {
    last = {
      at: now,
      db: deps.sql ? await probe(() => deps.sql!`select 1`) : 'off',
      redis: deps.redis ? await probe(() => deps.redis!.ping()) : 'off',
    };
    probes.set(deps, last);
  }
  const { db, redis } = last;
  // Redis down is a degraded cache, not an outage; Postgres down is an outage once anything is enabled.
  const ok = deps.config.features.size === 0 || db === 'ok';
  return json({ ok, features: [...deps.config.features], db, redis }, ok ? 200 : 503);
}

async function probe(fn: () => Promise<unknown>): Promise<State> {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'down';
  }
}
