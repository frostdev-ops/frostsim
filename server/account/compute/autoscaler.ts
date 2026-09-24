// Worker autoscaler (CLAUDE.md D14; DESIGN.md C8, P1, R1): a 15 s tick that reconciles Hetzner servers
// labelled frostsim=worker with the workers table, retires lost and idle ones, and creates a server when claimable demand exceeds
// free cores and both caps allow. decide() is pure; tick() loads the state, applies the plan and logs every server it touches.

import { randomBytes } from 'node:crypto';
import type { AppCtx, Task } from '../app';
import { errorSummary } from '../http';
import { sha256Hex } from '../signed';
import { forgetWorker } from './queue';
import { HOUR_MS, fleetLimits, hcloud, monthSpend, serverPrice, spendRows, type FleetLimits, type Hcloud, type Price } from './hetzner';

/** A worker calls in at least every 25 s (claim long poll) or every second (progress); silence this long means it is gone. */
export const HEARTBEAT_LOSS_MS = 3 * 60_000;
/** A new server has this long to boot and make its first call. */
export const BOOT_GRACE_MS = 10 * 60_000;
/** Idle workers are drained inside this window before their next billed hour starts (Hetzner bills per started hour). */
export const DRAIN_BEFORE_MS = 5 * 60_000;
/** A server missing from a listing right after it was created is not treated as gone yet. */
const LISTING_GRACE_MS = 60_000;

export interface FleetWorker {
  id: string;
  hcloudId: number | null;
  cores: number;
  status: string;
  hourlyEur: number;
  createdAt: Date;
  lastSeenAt: Date | null;
  /** Threads of the jobs it is running. */
  busy: number;
}

export interface Fleet {
  now: Date;
  /** Rows not yet deleted. */
  workers: FleetWorker[];
  /** hcloud ids of every server labelled frostsim=worker. */
  servers: number[];
  /** Threads of claimable queued jobs: the oldest per scope, for scopes with nothing running, that fit the configured server type. */
  demand: number;
  /** EUR billed this month so far (monthSpend). */
  spend: number;
  price: Price;
}

export interface Plan {
  remove: { hcloudId: number; reason: 'orphan' | 'heartbeat lost' | 'idle' }[];
  /** Rows to mark deleted, releasing their jobs. */
  forget: string[];
  drain: string[];
  create: boolean;
}

/** WORKER_MONTHLY_EUR_CAP is soft: a busy server drained at the cap keeps its running job, which can outlive the billed hour (up to
 *  ~3810 s, worker-routes.ts PRESIGN_S), so spend can pass the cap by at most 2 hours x WORKER_MAX x hourly price. Stopping paid
 *  users' runs mid-way to hold it exactly is worse than that bounded overshoot. */
export function decide(fleet: Fleet, limits: Pick<FleetLimits, 'max' | 'capEur'>): Plan {
  const now = fleet.now.getTime();
  const known = new Set(fleet.workers.map((w) => w.hcloudId));
  const listed = new Set(fleet.servers);
  const plan: Plan = {
    remove: fleet.servers.filter((id) => !known.has(id)).map((hcloudId) => ({ hcloudId, reason: 'orphan' as const })),
    forget: [],
    drain: [],
    create: false,
  };
  // Renewing a server for another hour spends money too: the cap is checked against spend plus every renewal planned so far.
  let projected = fleet.spend;
  let free = 0;
  let kept = 0;
  for (const w of fleet.workers) {
    // No hcloud id: its create call failed or never finished (tick() fills it in the same run).
    if (w.hcloudId === null || (!listed.has(w.hcloudId) && now - w.createdAt.getTime() > LISTING_GRACE_MS)) {
      plan.forget.push(w.id);
      continue;
    }
    const lost = w.lastSeenAt ? now - w.lastSeenAt.getTime() > HEARTBEAT_LOSS_MS : now - w.createdAt.getTime() > BOOT_GRACE_MS;
    // A server holding a leased job is only ever removed once its heartbeat is lost.
    if (lost || (w.status === 'draining' && w.busy === 0)) {
      plan.remove.push({ hcloudId: w.hcloudId, reason: lost ? 'heartbeat lost' : 'idle' });
      plan.forget.push(w.id);
      continue;
    }
    kept++;
    if (w.status === 'draining') continue;
    const renewsIn = HOUR_MS - ((now - w.createdAt.getTime()) % HOUR_MS);
    if (w.status === 'ready' && renewsIn <= DRAIN_BEFORE_MS) {
      if ((w.busy === 0 && fleet.demand === 0) || projected + w.hourlyEur > limits.capEur) {
        plan.drain.push(w.id);
        continue;
      }
      projected += w.hourlyEur;
    }
    free += Math.max(0, w.cores - w.busy);
  }
  // ponytail: at most one new server per tick (15 s); a burst scales over a few ticks, which also bounds a runaway.
  plan.create = fleet.demand > free && kept < limits.max && projected + fleet.price.hourlyEur <= limits.capEur;
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

async function loadFleet(app: AppCtx, api: Hcloud, limits: FleetLimits): Promise<Fleet> {
  const now = app.now();
  const [servers, rows, queued, spent, price] = await Promise.all([
    api.workerServers(),
    app.sql`select w.id, w.hcloud_id::float8 as hcloud_id, w.cores, w.status, coalesce(w.hourly_eur, 0)::float8 as hourly_eur,
        w.created_at, w.last_seen_at,
        coalesce((select sum(j.threads) from compute_jobs j where j.worker_id = w.id and j.status = 'running'), 0)::int as busy
      from workers w where w.deleted_at is null`,
    app.sql`select distinct on (coalesce('g:' || guild_id, 'u:' || user_id::text)) threads
        from compute_jobs j where j.status = 'queued' and not exists (select 1 from compute_jobs r where r.status = 'running'
          and coalesce('g:' || r.guild_id, 'u:' || r.user_id::text) = coalesce('g:' || j.guild_id, 'u:' || j.user_id::text))
        order by coalesce('g:' || guild_id, 'u:' || user_id::text), created_at`,
    spendRows(app.sql, now),
    serverPrice(api, limits, now),
  ]);
  return {
    now,
    servers,
    // A job wider than the server type can never be claimed; counting it would renew idle servers for nothing.
    demand: queued.reduce((sum, { threads }) => (threads <= price.cores ? sum + threads : sum), 0),
    spend: monthSpend(spent, now),
    price,
    workers: rows.map((r) => ({
      id: r.id,
      hcloudId: r.hcloud_id,
      cores: r.cores ?? 0,
      status: r.status,
      hourlyEur: r.hourly_eur,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      busy: r.busy,
    })),
  };
}

/** The token's hash is stored before the server exists, so a server can never run with a token the coordinator does not know. */
async function createWorker(app: AppCtx, api: Hcloud, limits: FleetLimits, price: Price): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await app.sql`insert into workers (server_type, token_hash, cores, status, hourly_eur, created_at)
    values (${limits.serverType}, ${sha256Hex(token)}, ${price.cores}, 'booting', ${price.hourlyEur}, ${app.now()}) returning id`;
  let hcloudId: number;
  try {
    hcloudId = await api.createServer({
      name: `frostsim-worker-${row.id}`,
      serverType: limits.serverType,
      location: limits.location,
      image: limits.snapshot,
      userData: userData(app.config.publicOrigin, token),
    });
  } catch (err) {
    // If Hetzner did create it, the next reconcile deletes it as an orphan; this row's token dies with the row.
    await app.sql`update workers set status = 'deleted', deleted_at = ${app.now()} where id = ${row.id}`;
    throw err;
  }
  await app.sql`update workers set hcloud_id = ${hcloudId} where id = ${row.id}`;
  app.log(`compute: created worker ${row.id} (hcloud ${hcloudId})`);
}

export async function tick(app: AppCtx): Promise<void> {
  const limits = fleetLimits(app.config);
  if (!limits) return;
  const api = hcloud(limits.token, app.fetch);
  const fleet = await loadFleet(app, api, limits);
  const plan = decide(fleet, limits);
  for (const { hcloudId, reason } of plan.remove) {
    try {
      await api.deleteServer(hcloudId);
      app.log(`compute: deleted hcloud server ${hcloudId} (${reason})`);
    } catch (err) {
      // Its row is still forgotten below; the server then comes back as an orphan and is retried next tick.
      app.log(`compute: deleting hcloud server ${hcloudId} failed (${errorSummary(err)})`);
    }
  }
  for (const id of plan.forget) await forgetWorker(app, id);
  if (plan.drain.length) {
    await app.sql`update workers set status = 'draining' where id in ${app.sql(plan.drain)} and deleted_at is null and status = 'ready'`;
  }
  if (plan.create) await createWorker(app, api, limits, fleet.price);
}

export const tasks: Task[] = [
  // FEATURE_ENV.compute covers only R2; tick() returns at once unless HCLOUD_* and both caps are set.
  { name: 'compute-autoscaler', feature: 'compute', everyMs: 15_000, run: tick },
];
