// Hetzner Cloud for compute workers (CLAUDE.md D14; DESIGN.md C8): the few API calls the autoscaler makes, as a fleet provider
// (fleet.ts). Prices come from the server_types API, never from code. Plain fetch; error bodies are never read (they can echo the request).
// API shapes checked 2026-09-23 via ctx7 (/smrezvani/hetzner-cloud-api-document, /websites/hetzner_cloud): POST /servers with
// public_net.enable_ipv4/enable_ipv6, labels, user_data (<= 32 KiB); GET /servers?label_selector=&page=&per_page= with
// meta.pagination.next_page; GET /server_types?name= with cores and prices[].{location, price_hourly.gross}.

import type { Config } from '../config';
import type { Offer, Provider } from './fleet';

const API = 'https://api.hetzner.cloud/v1';
const TIMEOUT_MS = 15_000;
const HOUR_MS = 3600_000;
export const WORKER_LABEL = 'frostsim=worker';
/** Seconds from create to a worker's first claim: 32-42 s to SSH in Phase 0, then the agent's start. */
const BOOT_S = 45;

export interface HetznerLimits { token: string; location: string; snapshot: string; serverType: string; max: number }

/** Null unless every value Hetzner needs is set (fleet.ts fleetConfig holds the spend cap). */
export function hetznerLimits(config: Config): HetznerLimits | null {
  const { HCLOUD_TOKEN: token, HCLOUD_LOCATION: location, HCLOUD_SNAPSHOT_ID: snapshot, HCLOUD_SERVER_TYPE: serverType } = config.env;
  const max = Math.floor(Number(config.env.WORKER_MAX));
  if (!token || !location || !snapshot || !serverType || !(max >= 1)) return null;
  return { token, location, snapshot, serverType, max };
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
      const seen = new Set<number>();
      for (let page = 1; page <= 100; page++) {
        const data = await call('GET', `/servers?label_selector=${encodeURIComponent(WORKER_LABEL)}&per_page=50&page=${page}`);
        if (!Array.isArray(data?.servers) || !data?.meta?.pagination || !Object.hasOwn(data.meta.pagination, 'next_page')) {
          throw new Error('hcloud inventory is malformed or incomplete');
        }
        for (const server of data.servers) {
          if (!Number.isSafeInteger(server?.id) || server.id <= 0 || seen.has(server.id)) throw new Error('hcloud inventory contains invalid or duplicate server ids');
          ids.push(server.id);
          seen.add(server.id);
        }
        const next = data?.meta?.pagination?.next_page;
        if (next === null) return ids;
        if (next !== page + 1) throw new Error('hcloud inventory pagination is malformed or incomplete');
      }
      throw new Error('hcloud inventory exceeds the complete-listing page limit');
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
    async pricing(): Promise<{ currency: string; primary_ips: { type: string; prices: { location: string; price_hourly: { gross: string } }[] }[] }> {
      const data = await call('GET', '/pricing');
      return data?.pricing;
    },
  };
}

export type Hcloud = ReturnType<typeof hcloud>;

export interface Price { hourly: number; currency: 'USD' | 'EUR'; cores: number }

// Provider clients own their credentials/fetch surface. Cache only the server's base quote; IP pricing is read fresh every time.
// Never share a quote across projects or currencies.
const priceCache = new WeakMap<Hcloud, { key: string; until: number; value: Price }>();

/** Gross hourly price (VAT included: the cap must hold whatever the invoice says) and cores of the configured type, cached 1 h. */
export async function serverPrice(api: Hcloud, limits: HetznerLimits, now: Date): Promise<Price> {
  const pricing = await api.pricing();
  if (pricing?.currency !== 'USD' && pricing?.currency !== 'EUR') throw new Error('hcloud pricing currency is unsupported or missing');
  const key = `${limits.serverType}@${limits.location}:${pricing.currency}`;
  // Primary IPv6 is free and the real /pricing response omits its type entirely:
  // https://docs.hetzner.com/cloud/servers/primary-ips/overview/#pricing
  // createServer disables IPv4/backups/volumes. Still honor an explicit IPv6 quote and refuse malformed/missing prices in it.
  if (!Array.isArray(pricing.primary_ips) || !pricing.primary_ips.every((ip) => ip &&
    (ip.type === 'ipv4' || ip.type === 'ipv6') && Array.isArray(ip.prices))) throw new Error('hcloud Primary IP pricing is malformed or missing');
  const ipv6 = pricing.primary_ips.filter((p) => p.type === 'ipv6');
  if (ipv6.length > 1) throw new Error('hcloud Primary IPv6 pricing is duplicated');
  if (ipv6[0]?.prices.some((p) => !p || typeof p.location !== 'string')) throw new Error('hcloud Primary IPv6 prices are malformed');
  const local = ipv6[0]?.prices.filter((p) => p.location === limits.location) ?? [];
  if (ipv6.length && local.length !== 1) throw new Error(`hcloud has no hourly price for ${limits.serverType} in ${limits.location} (Primary IPv6 price missing or duplicated)`);
  const gross = local[0]?.price_hourly?.gross;
  const extra = !ipv6.length ? 0 : typeof gross === 'string' && gross.trim() ? Number(gross) : NaN;
  if (!Number.isFinite(extra) || extra < 0) throw new Error('hcloud Primary IPv6 price is invalid');
  const cached = priceCache.get(api);
  if (cached?.key === key && cached.until > now.getTime()) return { ...cached.value, hourly: cached.value.hourly + extra };
  const type = await api.serverType(limits.serverType);
  const base = Number(type?.prices?.find((p) => p.location === limits.location)?.price_hourly?.gross);
  if (!type || !Number.isInteger(type.cores) || type.cores <= 0 || !Number.isFinite(base) || !(base > 0)) {
    throw new Error(`hcloud has no hourly price for ${limits.serverType} in ${limits.location}`);
  }
  const value: Price = { hourly: base, currency: pricing.currency, cores: type.cores };
  priceCache.set(api, { key, until: now.getTime() + HOUR_MS, value });
  return { ...value, hourly: value.hourly + extra };
}

/** The configured server type as a fleet provider. Its offer is priced in USD at `usdPerEur`, gross, as the invoice bills it. */
export function hetznerProvider(limits: HetznerLimits, usdPerEur: number, fetchFn: typeof fetch): Provider {
  const api = hcloud(limits.token, fetchFn);
  return {
    name: 'hetzner',
    list: async () => (await api.workerServers()).map(String),
    async offers(now) {
      const price = await serverPrice(api, limits, now);
      const hourlyUsd = price.hourly * (price.currency === 'EUR' ? usdPerEur : 1);
      if (!Number.isFinite(hourlyUsd) || hourlyUsd <= 0) throw new Error('hcloud price conversion is unavailable');
      const offer: Offer = { provider: 'hetzner', size: limits.serverType, cores: price.cores, hourlyUsd, maxHourlyUsd: hourlyUsd, billing: 'hour', bootS: BOOT_S };
      return [offer];
    },
    async create([offer], spec) {
      const id = await api.createServer({ ...spec, serverType: limits.serverType, location: limits.location, image: limits.snapshot });
      return { id: String(id), offer };
    },
    remove: (id) => api.deleteServer(Number(id)),
  };
}
