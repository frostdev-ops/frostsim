// Hetzner Cloud for compute workers (CLAUDE.md D14; DESIGN.md C8): the few API calls the autoscaler makes, its caps, and this month's
// spend. Prices come from the server_types API, never from code. Plain fetch; error bodies are never read (they can echo the request).
// API shapes checked 2026-09-23 via ctx7 (/smrezvani/hetzner-cloud-api-document, /websites/hetzner_cloud): POST /servers with
// public_net.enable_ipv4/enable_ipv6, labels, user_data (<= 32 KiB); GET /servers?label_selector=&page=&per_page= with
// meta.pagination.next_page; GET /server_types?name= with cores and prices[].{location, price_hourly.gross}.

import type { Config } from '../config';
import type { Db } from '../db';
import { calendarMonth } from '../entitlements';

const API = 'https://api.hetzner.cloud/v1';
const TIMEOUT_MS = 15_000;
export const WORKER_LABEL = 'frostsim=worker';
export const HOUR_MS = 3600_000;

export interface FleetLimits { token: string; location: string; snapshot: string; serverType: string; max: number; capEur: number }

/** Null unless every value the autoscaler needs is set. A missing or zero cap means no servers are ever created (DESIGN.md R1). */
export function fleetLimits(config: Config): FleetLimits | null {
  const { HCLOUD_TOKEN: token, HCLOUD_LOCATION: location, HCLOUD_SNAPSHOT_ID: snapshot, HCLOUD_SERVER_TYPE: serverType } = config.env;
  const max = Math.floor(Number(config.env.WORKER_MAX));
  const capEur = Number(config.env.WORKER_MONTHLY_EUR_CAP);
  if (!token || !location || !snapshot || !serverType || !(max >= 1) || !(capEur > 0)) return null;
  return { token, location, snapshot, serverType, max, capEur };
}

export interface ServerSpec { name: string; serverType: string; location: string; image: string; userData: string }

export function hcloud(token: string, fetchFn: typeof fetch) {
  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<any> {
    const res = await fetchFn(API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (method === 'DELETE' && res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`hcloud ${method} ${path.split('?')[0]} failed with status ${res.status}`);
    }
    return res.json();
  }

  return {
    /** Ids of every server labelled frostsim=worker, all pages. */
    async workerServers(): Promise<number[]> {
      const ids: number[] = [];
      for (let page: number | null = 1; page; ) {
        const data = await call('GET', `/servers?label_selector=${encodeURIComponent(WORKER_LABEL)}&per_page=50&page=${page}`);
        for (const server of data?.servers ?? []) if (Number.isSafeInteger(server?.id)) ids.push(server.id);
        const next = data?.meta?.pagination?.next_page;
        page = Number.isSafeInteger(next) && next > page ? next : null;
      }
      return ids;
    },
    async createServer(spec: ServerSpec): Promise<number> {
      const data = await call('POST', '/servers', {
        name: spec.name,
        server_type: spec.serverType,
        location: spec.location,
        image: spec.image,
        labels: { frostsim: 'worker' },
        // IPv6 only: the agent only makes outbound HTTPS calls, and a primary IPv4 is billed.
        public_net: { enable_ipv4: false, enable_ipv6: true },
        user_data: spec.userData,
      });
      const id = data?.server?.id;
      if (!Number.isSafeInteger(id)) throw new Error('hcloud POST /servers returned no server id');
      return id;
    },
    /** 404 counts as deleted. */
    async deleteServer(id: number): Promise<void> {
      await call('DELETE', `/servers/${id}`);
    },
    async serverType(name: string): Promise<{ cores: number; prices: { location: string; price_hourly: { gross: string } }[] } | null> {
      const data = await call('GET', `/server_types?name=${encodeURIComponent(name)}`);
      return data?.server_types?.[0] ?? null;
    },
  };
}

export type Hcloud = ReturnType<typeof hcloud>;

export interface Price { hourlyEur: number; cores: number }

let priceCache: { key: string; until: number; value: Price } | null = null;

/** Gross hourly price (VAT included: the cap must hold whatever the invoice says) and cores of the configured type, cached 1 h. */
export async function serverPrice(api: Hcloud, limits: FleetLimits, now: Date): Promise<Price> {
  const key = `${limits.serverType}@${limits.location}`;
  if (priceCache?.key === key && priceCache.until > now.getTime()) return priceCache.value;
  const type = await api.serverType(limits.serverType);
  const hourlyEur = Number(type?.prices?.find((p) => p.location === limits.location)?.price_hourly?.gross);
  if (!type || !Number.isInteger(type.cores) || !(hourlyEur > 0)) {
    throw new Error(`hcloud has no hourly price for ${limits.serverType} in ${limits.location}`);
  }
  priceCache = { key, until: now.getTime() + HOUR_MS, value: { hourlyEur, cores: type.cores } };
  return priceCache.value;
}

/** The last price serverPrice fetched for this type and location, even if stale (cores do not change), without an API call. */
export const cachedPrice = (limits: FleetLimits): Price | null =>
  priceCache?.key === `${limits.serverType}@${limits.location}` ? priceCache.value : null;

export interface SpendRow { hourlyEur: number; createdAt: Date; deletedAt: Date | null }

/** EUR billed this calendar month (UTC) for these servers: every started hour counts, as Hetzner bills per started hour.
 *  ponytail: ignores Hetzner's monthly price cap per server, so it can only overestimate. */
export function monthSpend(rows: readonly SpendRow[], now: Date): number {
  const { periodStart, periodEnd } = calendarMonth(now);
  let total = 0;
  for (const row of rows) {
    const start = Math.max(row.createdAt.getTime(), periodStart.getTime());
    const end = Math.min(row.deletedAt?.getTime() ?? now.getTime(), now.getTime(), periodEnd.getTime());
    if (end < start) continue;
    total += Math.max(1, Math.ceil((end - start) / HOUR_MS)) * row.hourlyEur;
  }
  return total;
}

export async function spendRows(db: Db, now: Date): Promise<SpendRow[]> {
  const { periodStart, periodEnd } = calendarMonth(now);
  const rows = await db`select hourly_eur::float8 as hourly_eur, created_at, deleted_at from workers
    where hourly_eur is not null and created_at < ${periodEnd} and (deleted_at is null or deleted_at >= ${periodStart})`;
  return rows.map((r) => ({ hourlyEur: r.hourly_eur, createdAt: r.created_at, deletedAt: r.deleted_at }));
}
