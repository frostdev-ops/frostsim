// The compute queue and usage ledger (CLAUDE.md D14; DESIGN.md C8, P1, P3): enqueue with every refusal in one place so web,
// Discord and Loothing jobs obey identical rules; claim with FOR UPDATE SKIP LOCKED; 60 s leases; metering at completion.
// Every timestamp comes from app.now(), so usage periods, leases and metering share one clock.

import type postgres from 'postgres';
import type { AppCtx, Task } from '../app';
import type { Db } from '../db';
import { HttpError } from '../http';
import { loadEntitlements } from '../entitlements';
import { usedCoreSeconds } from '../usage';
import { tryRedis } from '../redis';
import { configured } from '../config';
import { assembleRun, validateRequest, type AssembledRun, type SimRequest } from '../../../src/lib/simc/assemble';
import { PACK_ID, nativeEngine, nativeInputProblem } from './native';
import { cachedPrice, fleetLimits, monthSpend, spendRows } from './hetzner';

export const LEASE_S = 60;
const MAX_ATTEMPTS = 2;
const QUEUED_PER_SCOPE = 3;
/** A job nobody could claim this long fails, so a cap or an outage never fills a user's queue slots for good. */
const QUEUE_TIMEOUT_MS = 15 * 60_000;
const LOG_LINES = 500;
const LOG_TTL_S = 3600;
const RETENTION_MS = 7 * 86_400_000;
/** Sanity bound on a worker's result upload: presigned PUTs bind no size. */
const RESULT_MAX_BYTES = 256 << 20;
/** resultBytes buffers the object in this process (512M MemoryMax) for a server-side caller; the browser's route streams instead. */
const RESULT_READ_MAX_BYTES = 32 << 20;
/** The agent's RuntimeMaxSec for simc (cloud/worker/agent.mjs): the most a cancelled or failed run is metered for. */
const RUN_MAX_S = 1800;
const NO_ALLOWANCE = 'The cloud allowance for this period is used up.';
const NOT_ENTITLED = 'No Frostsim Cloud plan covers this run.';
const RESTARTED = 'Frostsim Cloud: the server running this job stopped; restarting it on another server.';
/** Advisory-lock class for per-scope locks (two-int keyspace, apart from migrate.ts's bigint lock). */
export const SCOPE_LOCK = 0x636d7075;

type App = Pick<AppCtx, 'config' | 'sql' | 'redis' | 'r2' | 'log' | 'now'>;
export type Source = 'web' | 'discord' | 'loothing' | 'patch';
export type Refusal = { ok: false; status: 400 | 402 | 403 | 409 | 429 | 503; code: string; message: string };

export const resultKey = (id: string) => `results/${id}.json.gz`;
const logKey = (id: string) => `job:${id}:log`;
const seqKey = (id: string) => `job:${id}:seq`;
/** Limits apply per guild pool for guild jobs, else per user. The same expression is spelled in SQL below. */
const scopeOf = (userId: string | null, guildId: string | null) => (guildId ? `g:${guildId}` : `u:${userId}`);

const refuse = (status: Refusal['status'], code: string, message: string): Refusal => ({ ok: false, status, code, message });

/** Request problems the cloud refuses before assembly. Expert Mode and HTML reports stay browser-only (DESIGN.md C8). */
export function cloudRequestProblem(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'The request must be an object.';
  const req = request as SimRequest;
  if (req.mode !== undefined && req.mode !== 'guided') return 'Expert Mode runs stay in the browser.';
  if (req.slots !== undefined) return 'Expert Mode slots stay in the browser.';
  if (req.htmlReport) return 'HTML reports are only produced in the browser.';
  return null;
}

/** The run a worker would get for this request at `threads`, or why the server refuses it (400). Pure, so the refusal corpus test
 *  (cloud/worker/refusal-corpus.test.mjs) checks exactly what enqueue checks before a worker's agent sees the arguments. */
export function cloudRun(request: SimRequest, threads: number): { run: AssembledRun } | { problem: string } {
  const cloudReq: SimRequest = { ...request, settings: { ...request.settings, threads } };
  const issues = validateRequest(cloudReq, threads);
  if (issues.length) return { problem: issues.map((i) => `${i.field}: ${i.message}`).join('; ').slice(0, 1000) };
  const run = assembleRun(cloudReq, threads);
  const unsafe = nativeInputProblem(run, request.extraOptions);
  return unsafe ? { problem: unsafe } : { run };
}

/** DESIGN.md P3. Threads are the entitlement's (capped by the server type), never the request's (C8). */
export async function enqueueJob(
  app: App,
  job: {
    userId: string | null; guildId: string | null; source: Source; packId: string; request: SimRequest;
    /** The slot the request was built from, for history and integration views. */
    characterId?: string | null;
    /** A caller's key for this job; a second insert with it (source, user) fails with 23505, which the caller maps to the first job. */
    idempotencyKey?: string | null;
  },
): Promise<{ ok: true; id: string } | Refusal> {
  const { userId, guildId, source, packId, request } = job;
  if (!app.config.features.has('compute')) return refuse(503, 'compute-disabled', 'Frostsim Cloud is switched off; runs stay in the browser.');
  if (!configured(app.config, 'compute')) return refuse(503, 'unconfigured', 'Frostsim Cloud is not configured on this server.');
  if (!userId && !guildId) return refuse(400, 'invalid', 'A job needs a user or a guild.');
  if (typeof packId !== 'string' || !PACK_ID.test(packId)) return refuse(400, 'invalid', 'packId is not an engine pack id.');
  const problem = cloudRequestProblem(request);
  if (problem) return refuse(400, 'invalid', problem);
  // Every source, not only web sessions (which getSession already ends): a Discord or Loothing job names the user directly.
  if (userId) {
    const [user] = await app.sql`select suspended_at, role from users where id = ${userId}`;
    if (user?.suspended_at) return refuse(403, 'suspended', 'This account is suspended.');
    if (app.config.adminOnly && user?.role !== 'admin') return refuse(403, 'forbidden', 'This server is open to admins only.');
  }

  const now = app.now();
  const ent = await loadEntitlements(app.sql, guildId ? { guildId } : { userId: userId! }, now);
  const pool = guildId ? ent.guilds[0] : ent;
  if (!pool || pool.maxThreads < 1) return refuse(402, 'not-entitled', NOT_ENTITLED);
  const used = await usedCoreSeconds(app.sql, guildId ? { guildId } : { userId: userId! }, pool.periodStart, pool.periodEnd);
  if (used >= pool.coreSeconds) return refuse(402, 'no-allowance', NO_ALLOWANCE);

  const prepared = cloudRun(request, jobThreads(app, pool.maxThreads));
  if ('problem' in prepared) return refuse(400, 'invalid', prepared.problem);
  const { run } = prepared;

  if (!(await nativeEngine(app, packId))) return refuse(409, 'no-native-engine', 'This engine version has no cloud build yet.');
  const capacity = await capacityProblem(app, run.threads);
  if (capacity) return refuse(503, 'capacity', capacity);

  const scope = scopeOf(userId, guildId);
  const id = await app.sql.begin(async (tx) => {
    // Serialises enqueues of one scope, so two concurrent requests cannot both see 2 queued and make it 4.
    await tx`select pg_advisory_xact_lock(${SCOPE_LOCK}::int, hashtext(${scope}::text))`;
    const [{ queued }] = await tx`select count(*)::int as queued from compute_jobs
      where status = 'queued' and ${guildId ? tx`guild_id = ${guildId}` : tx`user_id = ${userId} and guild_id is null`}`;
    if (queued >= QUEUED_PER_SCOPE) return null;
    const [row] = await tx`insert into compute_jobs (user_id, guild_id, source, pack_id, threads, request, payload, status, created_at,
        character_id, idempotency_key)
      values (${userId}, ${guildId}, ${source}, ${packId}, ${run.threads}, ${tx.json(request as unknown as postgres.JSONValue)},
        ${tx.json({ profile: run.profile, args: run.args })}, 'queued', ${now}, ${job.characterId ?? null}, ${job.idempotencyKey ?? null})
      returning id`;
    return row.id as string;
  });
  if (!id) return refuse(429, 'too-many-jobs', `At most ${QUEUED_PER_SCOPE} cloud runs can wait at once.`);
  return { ok: true, id };
}

/** The plan's width, capped by the configured server type (DESIGN.md A7): a Hetzner project's dedicated-core limit can rule out the
 *  32-core type, and a job wider than its servers could never be claimed. Cold (no cached price), the plan's width. */
function jobThreads(app: App, maxThreads: number): number {
  const limits = fleetLimits(app.config);
  const serverCores = limits ? cachedPrice(limits)?.cores : undefined;
  return serverCores ? Math.min(maxThreads, serverCores) : maxThreads;
}

/** Seconds from a worker's creation to its first claim before any worker has made one. */
const DEFAULT_BOOT_S = 60;
/** Expected wait for the autoscaler's next 15 s tick to order a server. */
const HALF_TICK_S = 8;

export interface CapacityWorker { status: string; cores: number; busy: number; ageS: number }
/** Where a new job would start: 'warm' on a free worker now, 'booting' on a server already starting, 'cold' on a server the
 *  autoscaler would order, 'queued' behind other runs (or the caller's own), 'none' when the cloud would refuse it (503/402).
 *  `waitS`: seconds until a worker claims it, when the server can tell. */
export interface Capacity { state: 'warm' | 'booting' | 'cold' | 'queued' | 'none'; waitS?: number; threads: number }

/** capacityView's decision, pure. `aheadThreads`: queued jobs a worker could claim before this one. */
export function capacityState(o: {
  threads: number; ownRunning: boolean; workers: CapacityWorker[]; aheadThreads: number; canCreate: boolean; bootS: number;
}): Omit<Capacity, 'threads'> {
  // One running job per scope: the caller's next one waits for it, however many servers are free.
  if (o.ownRunning) return { state: 'queued' };
  const fits = (free: number) => Math.floor(Math.max(0, free) / o.threads);
  let ahead = Math.ceil(o.aheadThreads / o.threads);
  const ready = o.workers.filter((w) => w.status === 'ready').reduce((n, w) => n + fits(w.cores - w.busy), 0);
  if (ready > ahead) return { state: 'warm', waitS: 0 };
  ahead -= ready;
  for (const w of o.workers.filter((w) => w.status === 'booting').sort((a, b) => b.ageS - a.ageS)) {
    if (fits(w.cores) > ahead) return { state: 'booting', waitS: Math.round(Math.max(0, o.bootS - w.ageS)) };
    ahead -= fits(w.cores);
  }
  // ponytail: a cold job with others ahead waits for servers the autoscaler orders one per tick; that wait is not estimated.
  if (o.canCreate && ahead === 0) return { state: 'cold', waitS: Math.round(o.bootS + HALF_TICK_S) };
  return { state: 'queued' };
}

/** Where a job of the user's own plan would start now (GET /api/v1/compute/capacity), so a hybrid run can size its split first. */
export async function capacityView(app: App, userId: string): Promise<Capacity> {
  const now = app.now();
  const ent = await loadEntitlements(app.sql, { userId }, now);
  if (ent.maxThreads < 1) return { state: 'none', threads: 0 };
  const threads = jobThreads(app, ent.maxThreads);
  if (await capacityProblem(app, threads)) return { state: 'none', threads };
  const [workers, [{ own }], [{ ahead }], [{ boot }], [{ total }]] = await Promise.all([
    app.sql`select status, cores, extract(epoch from (${now}::timestamptz - created_at))::float8 as age,
        coalesce((select sum(j.threads) from compute_jobs j where j.worker_id = w.id and j.status = 'running'), 0)::int as busy
      from workers w where deleted_at is null and status in ('ready', 'booting') and cores >= ${threads}`,
    app.sql`select exists (select 1 from compute_jobs where status = 'running' and user_id = ${userId} and guild_id is null) as own`,
    app.sql`select coalesce(sum(threads), 0)::int as ahead from compute_jobs j where j.status = 'queued' and not exists (
        select 1 from compute_jobs r where r.status = 'running'
          and coalesce('g:' || r.guild_id, 'u:' || r.user_id::text) = coalesce('g:' || j.guild_id, 'u:' || j.user_id::text))`,
    // Real cold starts: the autoscaler creates a worker for queued demand, so its first claim marks when it could take work.
    app.sql`select percentile_cont(0.5) within group (order by s)::float8 as boot from (
        select extract(epoch from (min(j.claimed_at) - w.created_at)) as s from workers w join compute_jobs j on j.worker_id = w.id
        where j.claimed_at is not null group by w.id, w.created_at order by w.created_at desc limit 20) recent`,
    app.sql`select count(*)::int as total from workers where deleted_at is null`,
  ]);
  const limits = fleetLimits(app.config);
  return {
    threads,
    ...capacityState({
      threads,
      ownRunning: own,
      workers: workers.map((w) => ({ status: w.status, cores: w.cores ?? 0, busy: w.busy, ageS: w.age })),
      aheadThreads: ahead,
      canCreate: !!limits && total < limits.max,
      bootS: boot ?? DEFAULT_BOOT_S,
    }),
  };
}

/** Null when a job of `threads` can be served: a live worker exists, or the autoscaler may still create one (DESIGN.md C8: 503 otherwise). */
export async function capacityProblem(app: App, threads: number): Promise<string | null> {
  const [{ live, total }] = await app.sql`select
      count(*) filter (where status <> 'draining' and cores >= ${threads})::int as live, count(*)::int as total
    from workers where deleted_at is null`;
  if (live > 0) return null;
  const limits = fleetLimits(app.config);
  if (!limits) return 'Frostsim Cloud has no workers available.';
  if (total >= limits.max) return 'Every cloud worker is busy.';
  // A job wider than the configured server type could never be claimed. The autoscaler keeps the price warm; cold, it is let through.
  const price = cachedPrice(limits);
  if (price && threads > price.cores) return 'Frostsim Cloud servers are too small for this run.';
  const now = app.now();
  if (monthSpend(await spendRows(app.sql, now), now) >= limits.capEur) return 'The cloud spending limit for this month is reached.';
  return null;
}

export interface JobView {
  id: string;
  userId: string | null;
  guildId: string | null;
  source: Source;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  /** 1-based place in the queue while queued. */
  position?: number;
  /** Progress lines after the `after` cursor (all retained lines for 0). */
  lines: string[];
  /** Cursor for the next call: the number of lines ever written. */
  next: number;
  error?: string;
  summary?: Summary;
  /** Once done, while the payload is retained: simc's stderr lines from the worker (warnings the browser engine would have logged). */
  notices?: string[];
  /** Once done, while the payload is retained: what the worker actually ran, which the browser's own assembly can differ from. */
  effective?: { threads: number; args: string[]; profile: string };
  createdAt: Date;
  finishedAt?: Date;
}

/** DESIGN.md P3, plus an optional line cursor. One primary-key query and one Redis round trip: polled about once a second. */
export async function jobView(app: App, id: string, after = 0): Promise<JobView | null> {
  // The payload (up to the 1 MiB request, assembled) is read only for a done job, whose client stops polling.
  const [row] = await app.sql`select id, user_id, guild_id, source, status, error, summary, threads, created_at, finished_at,
      case when status = 'done' then payload end as payload,
      case when status = 'queued' then (select count(*)::int from compute_jobs q where q.status = 'queued' and q.created_at <= j.created_at) end as position
    from compute_jobs j where id = ${id}`;
  if (!row) return null;
  const log = await tryRedis(app.redis, app.log, async (r) => {
    const replies = await r.multi().lrange(logKey(id), 0, -1).get(seqKey(id)).exec();
    const lines = (replies?.[0]?.[1] as string[] | undefined) ?? [];
    const next = Number(replies?.[1]?.[1]) || lines.length;
    const first = next - lines.length;
    return { lines: lines.slice(Math.max(0, after - first)), next };
  }, { lines: [] as string[], next: after });
  const summary = (row.summary ?? {}) as Summary;
  const done = row.status === 'done';
  return {
    id: row.id,
    userId: row.user_id,
    guildId: row.guild_id,
    source: row.source,
    status: row.status,
    ...(row.position != null ? { position: row.position } : {}),
    lines: log.lines,
    next: log.next,
    ...(row.error ? { error: row.error } : {}),
    ...(Object.keys(summary).length ? { summary } : {}),
    ...(done ? { notices: row.payload?.notices ?? [] } : {}),
    ...(done && row.payload ? { effective: { threads: row.threads, args: row.payload.args, profile: row.payload.profile } } : {}),
    createdAt: row.created_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

/** DESIGN.md P3: the result's gzip bytes, only once the job is done. Null when unfinished or expired from R2 (1-day lifecycle). Throws 413
 *  too-large above RESULT_READ_MAX_BYTES (the worker's presigned PUT can replace the object with anything until it expires). Callers
 *  inflate with their own maxOutputLength. */
export async function resultBytes(app: App, id: string): Promise<Uint8Array | null> {
  const [row] = await app.sql`select 1 from compute_jobs where id = ${id} and status = 'done'`;
  if (!row) return null;
  const obj = await app.r2.get(app.config.env.R2_DATA_BUCKET!, resultKey(id));
  if (!obj) return null;
  if (!(Number(obj.headers.get('content-length')) <= RESULT_READ_MAX_BYTES)) {
    await obj.body?.cancel();
    throw new HttpError(413, 'too-large', `The result is larger than ${RESULT_READ_MAX_BYTES} bytes.`);
  }
  return new Uint8Array(await obj.arrayBuffer());
}

/** wall_seconds and core_seconds for a run stopped at `now`: threads x claim-to-now, at most RUN_MAX_S. 0 for a job never claimed. */
const meterToNow = (app: App, now: Date) => {
  const wall = app.sql`least(greatest(coalesce(extract(epoch from ${now}::timestamptz - claimed_at), 0), 0), ${RUN_MAX_S})`;
  return app.sql`wall_seconds = ${wall}, core_seconds = threads * ${wall}`;
};

/** DESIGN.md P3. True when this call cancelled a queued or running job owned by `by`. A running job's worker learns it at its next progress.
 *  A running job is metered up to the cancel: the worker used those cores whether or not a result follows. */
export async function cancelJob(app: App, id: string, by: { userId: string } | { guildId: string }): Promise<boolean> {
  const owner = 'userId' in by ? app.sql`user_id = ${by.userId}` : app.sql`guild_id = ${by.guildId}`;
  const now = app.now();
  const rows = await app.sql`update compute_jobs set status = 'cancelled', finished_at = ${now}, lease_until = null, ${meterToNow(app, now)}
    where id = ${id} and status in ('queued', 'running') and ${owner} returning id`;
  return rows.length > 0;
}

// ---- Worker side (DESIGN.md P1) ----

export interface Claimed { id: string; threads: number; packId: string; profile: string; args: string[] }

/** One claim attempt: the oldest queued job that fits `freeCores` and whose scope has nothing running. 'draining' tells the caller
 *  to stop polling. SKIP LOCKED keeps concurrent workers off each other's rows; the scope lock keeps one running job per scope.
 *  The allowance is checked again here, so jobs queued before the scope's previous run was metered cannot run past it. */
export async function claimJob(app: App, workerId: string, freeCores: number): Promise<Claimed | 'draining' | null> {
  const now = app.now();
  let retried = false;
  const claimed = await app.sql.begin(async (tx) => {
    const [worker] = await tx`select status from workers where id = ${workerId} and deleted_at is null`;
    if (!worker || worker.status === 'draining') return 'draining';
    const candidates = await tx`select j.id, j.threads, j.pack_id, j.payload, j.user_id, j.guild_id,
        coalesce('g:' || j.guild_id, 'u:' || j.user_id::text) as scope
      from compute_jobs j
      where j.status = 'queued' and j.threads <= ${freeCores} and not exists (select 1 from compute_jobs r where r.status = 'running'
        and coalesce('g:' || r.guild_id, 'u:' || r.user_id::text) = coalesce('g:' || j.guild_id, 'u:' || j.user_id::text))
      order by j.created_at
      limit 5
      for update of j skip locked`;
    for (const job of candidates) {
      // Another transaction may be claiming a sibling of this scope right now; its running row is invisible until it commits.
      const [{ locked }] = await tx`select pg_try_advisory_xact_lock(${SCOPE_LOCK}::int, hashtext(${job.scope}::text)) as locked`;
      if (!locked) continue;
      const busy = await tx`select 1 from compute_jobs where status = 'running'
        and coalesce('g:' || guild_id, 'u:' || user_id::text) = ${job.scope} limit 1`;
      if (busy.length) continue;
      const who = job.guild_id ? { guildId: job.guild_id as string } : { userId: job.user_id as string };
      const ent = await loadEntitlements(tx, who, now);
      const pool = job.guild_id ? ent.guilds[0] : ent;
      const refusal = !pool || pool.maxThreads < 1 ? NOT_ENTITLED
        : (await usedCoreSeconds(tx, who, pool.periodStart, pool.periodEnd)) >= pool.coreSeconds ? NO_ALLOWANCE : null;
      if (refusal) {
        await tx`update compute_jobs set status = 'failed', error = ${refusal}, finished_at = ${now} where id = ${job.id}`;
        continue;
      }
      const [{ attempts }] = await tx`update compute_jobs set status = 'running', worker_id = ${workerId}, claimed_at = ${now},
        lease_until = ${new Date(now.getTime() + LEASE_S * 1000)}, attempts = attempts + 1 where id = ${job.id} returning attempts`;
      retried = attempts > 1;
      return { id: job.id, threads: job.threads, packId: job.pack_id, profile: job.payload.profile, args: job.payload.args };
    }
    return null;
  });
  // The log and cursor carry on from the lost attempt, so the browser sees why progress starts over.
  if (retried && claimed && typeof claimed === 'object') await appendLog(app, claimed.id, [RESTARTED]);
  return claimed;
}

/** Undoes a claim the worker never received (the claim route failed after committing it): back to the queue, attempt refunded. */
export async function unclaimJob(app: App, workerId: string, id: string): Promise<void> {
  await app.sql`update compute_jobs set status = 'queued', worker_id = null, claimed_at = null, attempts = attempts - 1
    where id = ${id} and worker_id = ${workerId} and status = 'running'`;
}

async function appendLog(app: App, id: string, lines: string[]): Promise<void> {
  await tryRedis(app.redis, app.log, async (r) => {
    // One MULTI: the list never exists without its TTL, and the cursor counts every line ever written.
    const replies = await r.multi()
      .rpush(logKey(id), ...lines).ltrim(logKey(id), -LOG_LINES, -1).expire(logKey(id), LOG_TTL_S)
      .incrby(seqKey(id), lines.length).expire(seqKey(id), LOG_TTL_S)
      .exec();
    const failed = replies?.find(([err]) => err)?.[0];
    if (failed) throw failed;
  }, undefined);
}

/** Extends the lease and records lines. 'cancel' when the owner cancelled it; 'lost' when this worker no longer holds it. */
export async function progressJob(app: App, workerId: string, id: string, lines: string[]): Promise<'ok' | 'cancel' | 'lost'> {
  const now = app.now();
  const held = await app.sql`update compute_jobs set lease_until = ${new Date(now.getTime() + LEASE_S * 1000)}
    where id = ${id} and worker_id = ${workerId} and status = 'running' returning id`;
  if (!held.length) {
    const [row] = await app.sql`select 1 from compute_jobs where id = ${id} and worker_id = ${workerId} and status = 'cancelled'`;
    return row ? 'cancel' : 'lost';
  }
  if (lines.length) await appendLog(app, id, lines);
  return 'ok';
}

export interface Summary { dps?: number; dpsError?: number; iterations?: number }

/** Worker-sent simc stderr lines join the payload (what the worker ran), not the summary: the payload goes with the 7-day retention,
 *  and the account export reports only its size, while the summary is kept in the ledger for good and exported whole. */
const noticesJson = (app: App, notices: readonly string[]) => app.sql.json({ notices: [...notices] });

/** Marks done and meters the job's CPU seconds, capped at threads x min(worker wall, coordinator claim->complete) (DESIGN.md C8):
 *  on shared vCPUs a busy neighbour lengthens the wall time, not the CPU time. Without cpuSeconds (older agents), the cap itself.
 *  'missing' fails the job: no result object. */
export async function completeJob(
  app: App, workerId: string, id: string, wallSeconds: number, summary: Summary, notices: readonly string[] = [], cpuSeconds?: number,
): Promise<'ok' | 'lost' | 'missing'> {
  const [job] = await app.sql`select threads, claimed_at from compute_jobs where id = ${id} and worker_id = ${workerId} and status = 'running'`;
  if (!job) return 'lost';
  const head = await app.r2.head(app.config.env.R2_DATA_BUCKET!, resultKey(id));
  const size = Number(head?.get('content-length'));
  const now = app.now();
  if (!head || !(size > 0) || size > RESULT_MAX_BYTES) {
    await app.sql`update compute_jobs set status = 'failed', error = 'The cloud worker did not upload a result.', finished_at = ${now},
      lease_until = null, payload = payload || ${noticesJson(app, notices)}
      where id = ${id} and worker_id = ${workerId} and status = 'running'`;
    return 'missing';
  }
  const wall = Math.max(0, Math.min(wallSeconds, (now.getTime() - job.claimed_at.getTime()) / 1000));
  const allocated = job.threads * wall;
  const core = cpuSeconds === undefined ? allocated : Math.min(Math.max(0, cpuSeconds), allocated);
  const done = await app.sql`update compute_jobs set status = 'done', finished_at = ${now}, lease_until = null,
      wall_seconds = ${wall}, core_seconds = ${core}, summary = ${app.sql.json(summary as postgres.JSONValue)},
      payload = payload || ${noticesJson(app, notices)}
    where id = ${id} and worker_id = ${workerId} and status = 'running' returning id`;
  return done.length ? 'ok' : 'lost';
}

/** A worker-reported failure is final (simc refused the input, crashed or hit RuntimeMaxSec). Metered claim-to-now, capped at
 *  RUN_MAX_S: the cores were used, and an unmetered failure would be a free way to run for 30 minutes. */
export async function failJob(app: App, workerId: string, id: string, error: string, notices: readonly string[] = []): Promise<boolean> {
  const now = app.now();
  const rows = await app.sql`update compute_jobs set status = 'failed', error = ${error.slice(0, 2000)}, finished_at = ${now},
    lease_until = null, payload = payload || ${noticesJson(app, notices)}, ${meterToNow(app, now)}
    where id = ${id} and worker_id = ${workerId} and status = 'running' returning id`;
  return rows.length > 0;
}

/** Running jobs matching `where` go back to the queue while attempts remain, else fail. Unmetered: the loss was ours.
 *  lease_until is left as it was: on a requeued job it marks when it last ran, which the queue timeout reads. */
export async function releaseJobs(db: Db, where: postgres.PendingQuery<postgres.Row[]>, now: Date): Promise<number> {
  const rows = await db`update compute_jobs set
      status = case when attempts < ${MAX_ATTEMPTS} then 'queued' else 'failed' end,
      worker_id = case when attempts < ${MAX_ATTEMPTS} then null else worker_id end,
      claimed_at = case when attempts < ${MAX_ATTEMPTS} then null else claimed_at end,
      finished_at = case when attempts < ${MAX_ATTEMPTS} then null else ${now}::timestamptz end,
      error = case when attempts < ${MAX_ATTEMPTS} then null else 'The cloud worker stopped responding.' end
    where status = 'running' and ${where} returning id`;
  return rows.length;
}

/** Expired leases, then queued jobs nobody could claim in time. A job waiting behind its own scope's running job is not stuck, so
 *  the timeout starts only once its scope has had nothing running or finishing, and the job itself has not run, for the window. */
export async function expireJobs(app: App): Promise<void> {
  const now = app.now();
  await releaseJobs(app.sql, app.sql`lease_until < ${now}`, now);
  const cutoff = new Date(now.getTime() - QUEUE_TIMEOUT_MS);
  await app.sql`update compute_jobs j set status = 'failed', finished_at = ${now}, error = 'No cloud worker became available in time.'
    where j.status = 'queued' and j.created_at < ${cutoff} and (j.lease_until is null or j.lease_until < ${cutoff})
      and not exists (select 1 from compute_jobs r
        where coalesce('g:' || r.guild_id, 'u:' || r.user_id::text) = coalesce('g:' || j.guild_id, 'u:' || j.user_id::text)
          and (r.status = 'running' or r.finished_at > ${cutoff}))`;
}

/** Retire a worker row and release whatever it held. */
export async function forgetWorker(app: App, workerId: string): Promise<void> {
  const now = app.now();
  await app.sql.begin(async (tx) => {
    await tx`update workers set status = 'deleted', deleted_at = ${now} where id = ${workerId} and deleted_at is null`;
    await releaseJobs(tx, tx`worker_id = ${workerId}`, now);
  });
}

export const tasks: Task[] = [
  { name: 'compute-leases', feature: 'compute', everyMs: 10_000, run: expireJobs },
  {
    name: 'compute-retention',
    feature: 'compute',
    everyMs: 3600_000,
    // The request, assembled profile and engine notices are kept 7 days for support, then only the ledger columns remain.
    run: async (app) => {
      await app.sql`update compute_jobs set request = null, payload = null
        where created_at < ${new Date(app.now().getTime() - RETENTION_MS)} and (request is not null or payload is not null)`;
    },
  },
];
