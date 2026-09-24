// Compute worker protocol under /api/v1/worker (CLAUDE.md D14; DESIGN.md C8, P1): bearer-token workers claim jobs by long
// poll, report progress, completion and failure. Nothing sent to a worker identifies the user.

import { setTimeout as sleep } from 'node:timers/promises';
import type { RequestCtx, Route, Task } from '../app';
import { HttpError, bearer, json } from '../http';
import { rateLimit } from '../ratelimit';
import { sha256Hex } from '../signed';
import { LEASE_S, claimJob, completeJob, failJob, progressJob, resultKey, unclaimJob, type Summary } from './queue';
import { engineKey, nativeEngine } from './native';

const JOB = '(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
/** nginx's proxy_read_timeout on /api/ is 30 s. */
const CLAIM_POLL_MS = 25_000;
const CLAIM_STEP_MS = 1000;
const MAX_LINES = 200;
/** Presigned URL lifetime, both signed at claim. The agent's last result PUT can start after the engine download (5 attempts of up to
 *  300 s plus backoff, ~1515 s), simc (RuntimeMaxSec=1800) and 4 failed uploads (120 s each plus backoff, ~495 s): ~3810 s, all in
 *  cloud/worker/agent.mjs. R2's own ceiling is 7 days. */
const PRESIGN_S = 4200;
/** Notices (DESIGN.md P1): the agent sends simc's last 200 stderr lines of at most 500 characters. Up to 6 JSON bytes per character. */
const MAX_NOTICES = 200;
const NOTICE_CHARS = 500;
const FINISH_MAX_BODY = 1 << 20;
/** autoscaler.ts createWorker: randomBytes(32) as base64url. */
const WORKER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Per IP, before the database. A worker makes about one call a second per running job plus its claim poll; 32 one-thread jobs
 *  stay under this, and a flood of bogus bearers cannot hold the 5-connection pool. */
const AUTH_PER_MINUTE = 3000;

/** Set on SIGTERM so a claim loop stops claiming during the account server's 5 s drain, when its response could be cut off. */
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });

const noContent = () => new Response(null, { status: 204 });
const invalid = (message: string) => new HttpError(400, 'invalid', message);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** `auth: 'worker'`. Every authenticated call is the worker's heartbeat, including progress while a job keeps its claim poll idle. */
export async function resolveWorker(ctx: RequestCtx): Promise<string | null> {
  const token = bearer(ctx.request);
  if (!token || !WORKER_TOKEN.test(token)) return null;
  if (!(await rateLimit(ctx, 'worker-auth', ctx.ip, AUTH_PER_MINUTE, 60))) return null;
  const [row] = await ctx.sql`update workers set last_seen_at = ${ctx.now()},
      status = case when status = 'booting' then 'ready' else status end
    where token_hash = ${sha256Hex(token)} and deleted_at is null returning id`;
  return row?.id ?? null;
}

async function claim(ctx: RequestCtx): Promise<Response> {
  const body = record(await ctx.json());
  const freeCores = body.freeCores;
  if (!Number.isInteger(freeCores) || (freeCores as number) < 1 || (freeCores as number) > 1024) throw invalid('freeCores must be a whole number from 1.');
  if (typeof body.agentVersion !== 'string' || body.agentVersion.length > 64) throw invalid('agentVersion must be a short string.');
  const until = Date.now() + CLAIM_POLL_MS;
  const { signal } = ctx.request;
  // Never claim once the worker has hung up: nobody would receive the job and it would sit out its lease.
  while (!signal.aborted && !stopping) {
    const job = await claimJob(ctx, ctx.workerId!, freeCores as number);
    if (job === 'draining') break;
    if (job) {
      let engine, engineUrl, resultUrl;
      try {
        engine = await nativeEngine(ctx, job.packId);
        if (engine) {
          [engineUrl, resultUrl] = await Promise.all([
            ctx.r2.presign(ctx.config.env.R2_ENGINES_BUCKET!, engineKey(job.packId), 'GET', PRESIGN_S),
            ctx.r2.presign(ctx.config.env.R2_DATA_BUCKET!, resultKey(job.id), 'PUT', PRESIGN_S),
          ]);
        }
      } catch (err) {
        // The claim is committed but this worker will never hear of it: give the job back rather than spend one of its attempts.
        await unclaimJob(ctx, ctx.workerId!, job.id);
        throw err;
      }
      if (!engine) {
        await failJob(ctx, ctx.workerId!, job.id, 'This engine version has no cloud build.');
        continue;
      }
      return json({
        jobId: job.id,
        threads: job.threads,
        profile: job.profile,
        args: job.args,
        engine: { url: engineUrl, sha256: engine.sha256 },
        resultPut: { url: resultUrl },
        leaseSeconds: LEASE_S,
      });
    }
    if (Date.now() + CLAIM_STEP_MS >= until) break;
    try {
      await sleep(CLAIM_STEP_MS, undefined, { signal });
    } catch {
      break;
    }
  }
  return noContent();
}

async function progress(ctx: RequestCtx): Promise<Response> {
  const { lines } = record(await ctx.json());
  if (!Array.isArray(lines) || lines.length > MAX_LINES || !lines.every((l) => typeof l === 'string')) {
    throw invalid(`lines must be an array of at most ${MAX_LINES} strings.`);
  }
  const state = await progressJob(ctx, ctx.workerId!, ctx.params.id, lines);
  if (state === 'lost') throw new HttpError(409, 'conflict', 'This worker no longer holds the job.');
  return json({ cancel: state === 'cancel' });
}

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/** Optional in DESIGN.md P1 (older agents send none). Bounded here too: the coordinator never trusts the agent's own bound. */
function notices(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((l) => typeof l === 'string')) throw invalid('notices must be an array of strings.');
  return value.slice(-MAX_NOTICES).map((l: string) => l.slice(0, NOTICE_CHARS));
}

async function complete(ctx: RequestCtx): Promise<Response> {
  const body = record(await ctx.json());
  if (!finite(body.wallSeconds) || (body.wallSeconds as number) < 0) throw invalid('wallSeconds must be a number of seconds.');
  const raw = record(body.summary);
  const summary: Summary = {};
  for (const key of ['dps', 'dpsError', 'iterations'] as const) {
    if (raw[key] === undefined) continue;
    if (!finite(raw[key])) throw invalid(`summary.${key} must be a number.`);
    summary[key] = raw[key] as number;
  }
  const state = await completeJob(ctx, ctx.workerId!, ctx.params.id, body.wallSeconds as number, summary, notices(body.notices));
  if (state === 'lost') throw new HttpError(409, 'conflict', 'This worker no longer holds the job.');
  if (state === 'missing') throw new HttpError(409, 'conflict', 'No result was uploaded; the job has failed.');
  return noContent();
}

async function fail(ctx: RequestCtx): Promise<Response> {
  const body = record(await ctx.json());
  const { error } = body;
  if (typeof error !== 'string' || error.length > 2000) throw invalid('error must be a string of at most 2000 characters.');
  const held = await failJob(ctx, ctx.workerId!, ctx.params.id, error, notices(body.notices));
  if (!held) throw new HttpError(409, 'conflict', 'This worker no longer holds the job.');
  return noContent();
}

export const routes: Route[] = [
  { method: 'POST', path: /^\/api\/v1\/worker\/claim$/, feature: 'compute', auth: 'worker', handler: claim },
  { method: 'POST', path: new RegExp(`^/api/v1/worker/jobs/${JOB}/progress$`), feature: 'compute', auth: 'worker', handler: progress },
  { method: 'POST', path: new RegExp(`^/api/v1/worker/jobs/${JOB}/complete$`), feature: 'compute', auth: 'worker', maxBody: FINISH_MAX_BODY,
    handler: complete },
  { method: 'POST', path: new RegExp(`^/api/v1/worker/jobs/${JOB}/fail$`), feature: 'compute', auth: 'worker', maxBody: FINISH_MAX_BODY,
    handler: fail },
];
export const tasks: Task[] = [];
