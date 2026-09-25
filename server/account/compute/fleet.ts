// The compute fleet across providers (CLAUDE.md D14; DESIGN.md C8, R1): Hetzner servers billed per started hour and EC2 Spot
// instances billed per second. Offers, the cheapest placement, month spend, and what a job costs including its share of idle.
// Money is USD throughout; Hetzner's euros are converted at USD_PER_EUR. Pure except spendRows, loadIdleFactors and providers().

import type { Config } from '../config';
import type { Db } from '../db';
import { calendarMonth } from '../entitlements';
import { ec2Limits, ec2Provider, type Ec2Limits } from './ec2';
import { hetznerLimits, hetznerProvider, type HetznerLimits } from './hetzner';

export type ProviderName = 'hetzner' | 'ec2';
export type Billing = 'hour' | 'second';
export const BILLING: Readonly<Record<ProviderName, Billing>> = { hetzner: 'hour', ec2: 'second' };
export const HOUR_MS = 3600_000;
/** An EC2 worker with nothing it could run is drained after this long; it is billed per second, so idling costs at once. */
export const EC2_IDLE_S = 90;
/** Seconds a job is expected to run when the cloud model cannot tell. */
export const DEFAULT_RUN_S = 300;

/** A server a provider could create now. hourlyUsd is the expected price, used to compare offers. */
export interface Offer {
  provider: ProviderName;
  /** Server or instance type. */
  size: string;
  cores: number;
  hourlyUsd: number;
  /** The most it can be billed per hour; what workers record, spend counts and users are charged at. */
  maxHourlyUsd: number;
  billing: Billing;
  bootS: number;
  /** EC2: the availability zone this price is for. */
  zone?: string;
}

export interface Provider {
  name: ProviderName;
  /** Provider ids of every server labelled or tagged as a frostsim worker. */
  list(): Promise<string[]>;
  /** What it could create now, cheapest first. Cached by the provider. */
  offers(now: Date): Promise<Offer[]>;
  /** Creates one server from the first offer that has capacity, and returns that offer. */
  create(offers: Offer[], spec: { name: string; userData: string }): Promise<{ id: string; offer: Offer }>;
  /** Already gone counts as removed. */
  remove(id: string): Promise<void>;
}

export interface FleetConfig {
  capUsd: number;
  usdPerEur: number | null;
  hetzner: HetznerLimits | null;
  ec2: Ec2Limits | null;
}

/** Null unless a monthly USD cap and at least one fully configured provider exist (DESIGN.md R1: no cap, no servers). The cap is
 *  WORKER_MONTHLY_USD_CAP, or the older WORKER_MONTHLY_EUR_CAP converted. Hetzner needs USD_PER_EUR to be compared at all. */
export function fleetConfig(config: Config): FleetConfig | null {
  const usdPerEur = Number(config.env.USD_PER_EUR) > 0 ? Number(config.env.USD_PER_EUR) : null;
  const eurCap = Number(config.env.WORKER_MONTHLY_EUR_CAP);
  const capUsd = Number(config.env.WORKER_MONTHLY_USD_CAP) || (usdPerEur && eurCap > 0 ? eurCap * usdPerEur : 0);
  const hetzner = usdPerEur ? hetznerLimits(config) : null;
  const ec2 = ec2Limits(config);
  if (!(capUsd > 0) || (!hetzner && !ec2)) return null;
  return { capUsd, usdPerEur, hetzner, ec2 };
}

export function providers(fleet: FleetConfig, fetchFn: typeof fetch): Provider[] {
  return [
    ...(fleet.hetzner ? [hetznerProvider(fleet.hetzner, fleet.usdPerEur!, fetchFn)] : []),
    ...(fleet.ec2 ? [ec2Provider(fleet.ec2, fetchFn)] : []),
  ];
}

/** Whether `offer` fits under its provider's limit next to the live workers: Hetzner counts servers, EC2 counts vCPU (the Spot quota). */
export function roomFor(fleet: Pick<FleetConfig, 'hetzner' | 'ec2'>, live: readonly { provider: ProviderName; cores: number }[], offer: Offer): boolean {
  const mine = live.filter((w) => w.provider === offer.provider);
  if (offer.provider === 'hetzner') return !!fleet.hetzner && mine.length < fleet.hetzner.max;
  return !!fleet.ec2 && mine.reduce((n, w) => n + w.cores, 0) + offer.cores <= fleet.ec2.maxVcpu;
}

// ---- Offers seen last, for callers that must not wait on a provider API (queue.ts) ----

const offerCache = new Map<ProviderName, Offer[]>();
export const rememberOffers = (name: ProviderName, offers: Offer[]) => offerCache.set(name, offers);
/** The offers each configured provider last returned; empty until the autoscaler's first tick. */
export const cachedOffers = (fleet: FleetConfig): Offer[] =>
  (['hetzner', 'ec2'] as const).filter((p) => fleet[p]).flatMap((p) => offerCache.get(p) ?? []);

// ---- Cheapest placement ----

/** USD to serve one job that runs `runS` on a new server: Hetzner bills every started hour of the whole server; EC2 bills its
 *  seconds (60 s minimum) including boot and the idle wait before it is drained. */
export function serveCost(offer: Offer, runS: number): number {
  const seconds = offer.bootS + runS;
  return offer.billing === 'hour'
    ? offer.hourlyUsd * Math.max(1, Math.ceil(seconds / 3600))
    : (offer.hourlyUsd / 3600) * Math.max(60, seconds + EC2_IDLE_S);
}

/** The offer that serves a job of `width` threads cheapest, sharing the server's cost among as many waiting `jobs` as fit on it. */
export function cheapest(offers: readonly Offer[], width: number, runS: number, jobs: number): Offer | null {
  let best: Offer | null = null;
  let bestCost = Infinity;
  for (const offer of offers) {
    if (offer.cores < width) continue;
    const cost = serveCost(offer, runS) / Math.max(1, Math.min(Math.floor(offer.cores / width), jobs));
    if (cost < bestCost) [best, bestCost] = [offer, cost];
  }
  return best;
}

// ---- Spend ----

export interface SpendRow { hourlyUsd: number; billing: Billing; createdAt: Date; deletedAt: Date | null }

/** Seconds billed for a server alive from `start` to `end`. */
export const billedSeconds = (billing: Billing, start: number, end: number): number => {
  const s = Math.max(0, end - start) / 1000;
  return billing === 'hour' ? Math.max(1, Math.ceil(s / 3600)) * 3600 : Math.max(60, s);
};

/** USD billed this calendar month (UTC). ponytail: ignores Hetzner's monthly price cap per server, so it can only overestimate. */
export function monthSpend(rows: readonly SpendRow[], now: Date): number {
  const { periodStart, periodEnd } = calendarMonth(now);
  let total = 0;
  for (const row of rows) {
    const start = Math.max(row.createdAt.getTime(), periodStart.getTime());
    const end = Math.min(row.deletedAt?.getTime() ?? now.getTime(), now.getTime(), periodEnd.getTime());
    if (end < start) continue;
    total += (billedSeconds(row.billing, start, end) / 3600) * row.hourlyUsd;
  }
  return total;
}

/** A worker row's USD per hour: rows from before migration 006 carry only euros. */
export const hourlyUsdSql = (db: Db, usdPerEur: number | null) => db`coalesce(hourly_usd, hourly_eur * ${usdPerEur ?? 0})`;

export async function spendRows(db: Db, now: Date, usdPerEur: number | null): Promise<SpendRow[]> {
  const { periodStart, periodEnd } = calendarMonth(now);
  const rows = await db`select provider, ${hourlyUsdSql(db, usdPerEur)}::float8 as hourly_usd, created_at, deleted_at from workers
    where (hourly_usd is not null or hourly_eur is not null) and created_at < ${periodEnd} and (deleted_at is null or deleted_at >= ${periodStart})`;
  return rows.map((r) => ({ hourlyUsd: r.hourly_usd, billing: BILLING[r.provider as ProviderName], createdAt: r.created_at, deletedAt: r.deleted_at }));
}

// ---- What a job costs ----

/** Idle as a share of used core time, from retired workers: (billed core seconds - used) / used. Until MIN_RETIRED workers exist,
 *  DEFAULT_IDLE; always within [MIN_IDLE, MAX_IDLE] so one odd month cannot make runs free or unaffordable. */
export const DEFAULT_IDLE = 2;
export const MIN_IDLE = 0.25;
export const MAX_IDLE = 5;
const MIN_RETIRED = 10;
const IDLE_WINDOW_MS = 30 * 86_400_000;
const IDLE_TTL_MS = 10 * 60_000;

export interface RetiredWorker { billing: Billing; cores: number; createdAt: Date; deletedAt: Date; usedCoreSeconds: number }

export function idleFactor(rows: readonly RetiredWorker[]): number {
  if (rows.length < MIN_RETIRED) return DEFAULT_IDLE;
  let billed = 0, used = 0;
  for (const r of rows) {
    billed += r.cores * billedSeconds(r.billing, r.createdAt.getTime(), r.deletedAt.getTime());
    used += r.usedCoreSeconds;
  }
  return used > 0 ? Math.min(MAX_IDLE, Math.max(MIN_IDLE, billed / used - 1)) : MAX_IDLE;
}

export type IdleFactors = Record<ProviderName, number>;
let idleCache: { at: number; value: IdleFactors } | null = null;

/** Measured idle per provider over the last 30 days, cached 10 minutes. */
export async function loadIdleFactors(db: Db, now: Date): Promise<IdleFactors> {
  if (idleCache && now.getTime() - idleCache.at < IDLE_TTL_MS) return idleCache.value;
  const rows = await db`select w.provider, w.cores, w.created_at, w.deleted_at,
      coalesce((select sum(j.core_seconds) from compute_jobs j where j.worker_id = w.id), 0)::float8 as used
    from workers w where w.deleted_at >= ${new Date(now.getTime() - IDLE_WINDOW_MS)} and w.cores > 0`;
  const retired = (p: ProviderName) => rows.filter((r) => r.provider === p).map((r) => ({
    billing: BILLING[p], cores: r.cores, createdAt: r.created_at, deletedAt: r.deleted_at, usedCoreSeconds: r.used,
  }));
  idleCache = { at: now.getTime(), value: { hetzner: idleFactor(retired('hetzner')), ec2: idleFactor(retired('ec2')) } };
  return idleCache.value;
}

/** USD per core second on a server of `cores` billed `hourlyUsd`. */
export const coreRate = (hourlyUsd: number, cores: number) => hourlyUsd / cores / 3600;

/** The most a job of `threads` can be charged: every thread for `maxRunS` at `rate`, plus its share of idle. */
export const worstCaseUsd = (threads: number, maxRunS: number, rate: number, idle: number) => threads * maxRunS * rate * (1 + idle);
