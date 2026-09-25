// Worker autoscaler (CLAUDE.md D14; DESIGN.md C8, P1, R1): a 15 s tick that reconciles every provider's servers (Hetzner labelled,
// EC2 Spot tagged frostsim=worker) with the workers table, retires lost and idle ones, and creates the cheapest server for claimable
// demand that running cores cannot take, within each provider's limit and the monthly cap.
// decide() is pure; tick() loads the state, applies the plan and logs every server it touches.

import { randomBytes } from 'node:crypto';
import type { AppCtx, Task } from '../app';
import { errorSummary } from '../http';
import { sha256Hex } from '../signed';
import { cloudModel, expectedRunS, forgetWorker, liteColumns, liteWork } from './queue';
import {
  BILLING, DEFAULT_RUN_S, EC2_IDLE_S, HOUR_MS, cheapest, fleetConfig, hourlyUsdSql, monthSpend, providers, rememberOffers, roomFor, spendRows,
  type FleetConfig, type Offer, type Provider, type ProviderName,
} from './fleet';

/** A worker calls in at least every 25 s (claim long poll) or every second (progress); silence this long means it is gone. */
export const HEARTBEAT_LOSS_MS = 3 * 60_000;
/** A new server has this long to boot and make its first call. */
export const BOOT_GRACE_MS = 10 * 60_000;
/** Idle hour-billed workers are drained inside this window before their next billed hour starts (Hetzner bills per started hour).
 *  Second-billed workers reserve this much of their price ahead against the monthly cap. */
export const DRAIN_BEFORE_MS = 5 * 60_000;
/** A server missing from a listing right after it was created is not treated as gone yet. */
const LISTING_GRACE_MS = 60_000;

export interface FleetWorker {
  id: string;
  provider: ProviderName;
  providerId: string | null;
  cores: number;
  status: string;
  hourlyUsd: number;
  createdAt: Date;
  lastSeenAt: Date | null;
  /** Threads of the jobs it is running. */
  busy: number;
  /** When it last had nothing to run: its creation, or its last job's end. */
  idleSince: Date;
}

/** A claimable queued job: the oldest per scope, for scopes with nothing running. */
export interface QueuedJob { threads: number; runS: number }

export interface Fleet {
  now: Date;
  /** Rows not yet deleted. */
  workers: FleetWorker[];
  /** Provider ids of every labelled server, per configured provider; null when its listing failed this tick. */
  servers: Partial<Record<ProviderName, string[] | null>>;
  /** Oldest first. */
  queued: QueuedJob[];
  /** USD billed this month so far (monthSpend). */
  spend: number;
  /** What every provider could create now. */
  offers: Offer[];
}

export interface Plan {
  remove: { provider: ProviderName; id: string; reason: 'orphan' | 'heartbeat lost' | 'idle' }[];
  /** Rows to mark deleted, releasing their jobs. */
  forget: string[];
  drain: string[];
  /** The chosen offer first, then same-size offers of its provider to fall back to; null creates nothing. */
  create: Offer[] | null;
}

/** What creating `offer` commits against the monthly cap before the next decision: an hour, or DRAIN_BEFORE_MS of seconds. */
const commitment = (billing: Offer['billing'], hourlyUsd: number) => (billing === 'hour' ? hourlyUsd : (hourlyUsd * DRAIN_BEFORE_MS) / HOUR_MS);

/** The monthly cap is soft: a busy server drained at the cap keeps its running job, which can outlive the billed hour (up to ~3810 s,
 *  worker-routes.ts PRESIGN_S), so spend can pass it by at most about 2 hours of the live fleet. Stopping paid users' runs mid-way
 *  to hold it exactly is worse than that bounded overshoot.
 *
 *  Placement: queued jobs go first to cores already running, which cost nothing more (a Hetzner hour is paid; an EC2 worker is
 *  billed anyway until it drains). What does not fit orders ONE server per tick: the offer that serves the oldest unplaced job
 *  cheapest (fleet.ts cheapest), among those that fit its provider's limit and the cap. */
export function decide(fleet: Fleet, limits: Pick<FleetConfig, 'capUsd' | 'hetzner' | 'ec2'>): Plan {
  const now = fleet.now.getTime();
  const plan: Plan = { remove: [], forget: [], drain: [], create: null };
  for (const [provider, ids] of Object.entries(fleet.servers) as [ProviderName, string[] | null][]) {
    const known = new Set(fleet.workers.filter((w) => w.provider === provider).map((w) => w.providerId));
    for (const id of ids ?? []) if (!known.has(id)) plan.remove.push({ provider, id, reason: 'orphan' });
  }
  const fits = (cores: number) => fleet.queued.some((j) => j.threads <= cores);
  // Keeping a server spends money too: the cap is checked against spend plus every renewal planned so far.
  let projected = fleet.spend;
  const kept: FleetWorker[] = [];
  const free: { cores: number }[] = [];
  for (const w of fleet.workers) {
    const listed = fleet.servers[w.provider];
    // No provider id: its create call failed or never finished (tick() fills it in the same run). A failed listing proves nothing.
    if (w.providerId === null || (listed && !listed.includes(w.providerId) && now - w.createdAt.getTime() > LISTING_GRACE_MS)) {
      plan.forget.push(w.id);
      continue;
    }
    const lost = w.lastSeenAt ? now - w.lastSeenAt.getTime() > HEARTBEAT_LOSS_MS : now - w.createdAt.getTime() > BOOT_GRACE_MS;
    // A server holding a leased job is only ever removed once its heartbeat is lost.
    if (lost || (w.status === 'draining' && w.busy === 0)) {
      plan.remove.push({ provider: w.provider, id: w.providerId, reason: lost ? 'heartbeat lost' : 'idle' });
      plan.forget.push(w.id);
      continue;
    }
    kept.push(w);
    if (w.status === 'draining') continue;
    if (BILLING[w.provider] === 'hour') {
      const renewsIn = HOUR_MS - ((now - w.createdAt.getTime()) % HOUR_MS);
      if (w.status === 'ready' && renewsIn <= DRAIN_BEFORE_MS) {
        if ((w.busy === 0 && !fits(w.cores)) || projected + w.hourlyUsd > limits.capUsd) {
          plan.drain.push(w.id);
          continue;
        }
        projected += w.hourlyUsd;
      }
    } else {
      const idle = w.status === 'ready' && w.busy === 0 && now - w.idleSince.getTime() >= EC2_IDLE_S * 1000 && !fits(w.cores);
      const ahead = commitment('second', w.hourlyUsd);
      if (idle || projected + ahead > limits.capUsd) {
        plan.drain.push(w.id);
        continue;
      }
      projected += ahead;
    }
    free.push({ cores: Math.max(0, w.cores - w.busy) });
  }
  // A job wider than every offer and worker can never be claimed; ordering servers for it would only idle them.
  const widest = Math.max(0, ...fleet.offers.map((o) => o.cores), ...kept.map((w) => w.cores));
  const unplaced = fleet.queued.filter((job) => {
    if (job.threads > widest) return false;
    const slot = free.find((f) => f.cores >= job.threads);
    if (!slot) return true;
    slot.cores -= job.threads;
    return false;
  });
  if (!unplaced.length) return plan;
  const [first] = unplaced;
  const affordable = fleet.offers.filter((o) => roomFor(limits, kept, o) && projected + commitment(o.billing, o.maxHourlyUsd) <= limits.capUsd);
  // ponytail: at most one new server per tick (15 s); a burst scales over a few ticks, which also bounds a runaway.
  const best = cheapest(affordable, first.threads, first.runS, unplaced.length);
  if (best) plan.create = [best, ...affordable.filter((o) => o !== best && o.provider === best.provider && o.cores === best.cores)];
  return plan;
}

/** Worker bootstrap (DESIGN.md P1): the snapshot ships frostsim-worker.service disabled; cloud-init enables it once the env file exists. */
export function userData(coordinator: string, token: string): string {
  return [
    '#cloud-config',
    'write_files:',
    '  - path: /etc/frostsim/worker.env',
    "    permissions: '0600'",
    '    owner: root:root',
    '    content: |',
    `      FROSTSIM_COORDINATOR=${coordinator}`,
    `      FROSTSIM_WORKER_TOKEN=${token}`,
    'runcmd:',
    '  - [ systemctl, enable, --now, frostsim-worker.service ]',
    '',
  ].join('\n');
}

async function loadFleet(app: AppCtx, fc: FleetConfig, provs: Provider[]): Promise<Fleet> {
  const now = app.now();
  const listings = await Promise.all(provs.map(async (p) => {
    const [ids, offers] = await Promise.allSettled([p.list(), p.offers(now)]);
    if (ids.status === 'rejected') app.log(`compute: listing ${p.name} servers failed (${errorSummary(ids.reason)})`);
    if (offers.status === 'rejected') app.log(`compute: reading ${p.name} prices failed (${errorSummary(offers.reason)})`);
    else rememberOffers(p.name, offers.value);
    return { name: p.name, ids: ids.status === 'fulfilled' ? ids.value : null, offers: offers.status === 'fulfilled' ? offers.value : [] };
  }));
  const [rows, queued, spent, model] = await Promise.all([
    app.sql`select w.id, w.provider, w.provider_id, w.cores, w.status, coalesce(${hourlyUsdSql(app.sql, fc.usdPerEur)}, 0)::float8 as hourly_usd,
        w.created_at, w.last_seen_at,
        coalesce((select sum(j.threads) from compute_jobs j where j.worker_id = w.id and j.status = 'running'), 0)::int as busy,
        greatest(w.created_at, (select max(j.finished_at) from compute_jobs j where j.worker_id = w.id)) as idle_since
      from workers w where w.deleted_at is null`,
    app.sql`select distinct on (coalesce('g:' || guild_id, 'u:' || user_id::text)) threads, created_at, ${liteColumns(app.sql)}
        from compute_jobs j where j.status = 'queued' and not exists (select 1 from compute_jobs r where r.status = 'running'
          and coalesce('g:' || r.guild_id, 'u:' || r.user_id::text) = coalesce('g:' || j.guild_id, 'u:' || j.user_id::text))
        order by coalesce('g:' || guild_id, 'u:' || user_id::text), created_at`,
    spendRows(app.sql, now, fc.usdPerEur),
    cloudModel(app),
  ]);
  return {
    now,
    servers: Object.fromEntries(listings.map((l) => [l.name, l.ids])),
    queued: queued.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((j) => ({ threads: j.threads, runS: expectedRunS(model, liteWork(j), j.threads) ?? DEFAULT_RUN_S })),
    spend: monthSpend(spent, now),
    offers: listings.flatMap((l) => l.offers),
    workers: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      providerId: r.provider_id,
      cores: r.cores ?? 0,
      status: r.status,
      hourlyUsd: r.hourly_usd,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      busy: r.busy,
      idleSince: r.idle_since,
    })),
  };
}

/** The token's hash is stored before the server exists, so a server can never run with a token the coordinator does not know.
 *  Hetzner rows also get hcloud_id and hourly_eur, which a rolled-back release still reads. */
async function createWorker(app: AppCtx, fc: FleetConfig, provider: Provider, offers: Offer[]): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const [first] = offers;
  const [row] = await app.sql`insert into workers (provider, server_type, token_hash, cores, status, hourly_usd, created_at)
    values (${provider.name}, ${first.size}, ${sha256Hex(token)}, ${first.cores}, 'booting', ${first.maxHourlyUsd}, ${app.now()}) returning id`;
  let made: { id: string; offer: Offer };
  try {
    made = await provider.create(offers, { name: `frostsim-worker-${row.id}`, userData: userData(app.config.publicOrigin, token) });
  } catch (err) {
    // If the provider did create it, the next reconcile deletes it as an orphan; this row's token dies with the row.
    await app.sql`update workers set status = 'deleted', deleted_at = ${app.now()} where id = ${row.id}`;
    throw err;
  }
  const { id, offer } = made;
  const hetzner = provider.name === 'hetzner';
  await app.sql`update workers set provider_id = ${id}, server_type = ${offer.size}, hourly_usd = ${offer.maxHourlyUsd},
      hcloud_id = ${hetzner ? Number(id) : null}, hourly_eur = ${hetzner && fc.usdPerEur ? offer.maxHourlyUsd / fc.usdPerEur : null}
    where id = ${row.id}`;
  app.log(`compute: created worker ${row.id} (${provider.name} ${offer.size}${offer.zone ? ` in ${offer.zone}` : ''} ${id}, at most $${offer.maxHourlyUsd.toFixed(4)}/h)`);
}

export async function tick(app: AppCtx): Promise<void> {
  const fc = fleetConfig(app.config);
  if (!fc) return;
  const provs = providers(fc, app.fetch);
  const byName = new Map(provs.map((p) => [p.name, p]));
  const fleet = await loadFleet(app, fc, provs);
  const plan = decide(fleet, fc);
  for (const { provider, id, reason } of plan.remove) {
    try {
      await byName.get(provider)!.remove(id);
      app.log(`compute: deleted ${provider} server ${id} (${reason})`);
    } catch (err) {
      // Its row is still forgotten below; the server then comes back as an orphan and is retried next tick.
      app.log(`compute: deleting ${provider} server ${id} failed (${errorSummary(err)})`);
    }
  }
  for (const id of plan.forget) await forgetWorker(app, id);
  if (plan.drain.length) {
    await app.sql`update workers set status = 'draining' where id in ${app.sql(plan.drain)} and deleted_at is null and status = 'ready'`;
  }
  if (plan.create) await createWorker(app, fc, byName.get(plan.create[0].provider)!, plan.create);
}

export const tasks: Task[] = [
  // FEATURE_ENV.compute covers only R2; tick() returns at once unless a provider and the monthly cap are configured.
  { name: 'compute-autoscaler', feature: 'compute', everyMs: 15_000, run: tick },
];
