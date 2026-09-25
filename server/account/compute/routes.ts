// Client compute job routes under /api/v1/compute (CLAUDE.md D14; DESIGN.md C8, P6), plus every compute background task.
// A refusal is the browser's cue to run the job locally instead (402, 409, 429, 503).

import type { RequestCtx, Route, Task } from '../app';
import { HttpError, json } from '../http';
import { rateLimit } from '../ratelimit';
import type { SimRequest } from '../../../src/lib/simc/assemble';
import { cancelJob, capacityView, enqueueJob, jobView, resultKey, tasks as queueTasks } from './queue';
import { tasks as autoscalerTasks } from './autoscaler';

/** One bucket for every source that submits on a user's behalf (web, Discord). */
export const submitAllowed = (ctx: Parameters<typeof rateLimit>[0], userId: string) => rateLimit(ctx, 'compute-submit', userId, 30, 60);

const JOB = '(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
/** nginx's client_max_body_size for /api/ is 1m. A Top Gear batch with many profilesets is the largest request. */
const MAX_REQUEST_BYTES = 1 << 20;

const notFound = () => new HttpError(404, 'not-found', 'No such job.');

async function submit(ctx: RequestCtx): Promise<Response> {
  const userId = ctx.session!.userId;
  if (!(await submitAllowed(ctx, userId))) throw new HttpError(429, 'rate-limited', 'Too many cloud runs; wait a minute.');
  const body = await ctx.json<{ packId?: unknown; request?: unknown }>();
  const result = await enqueueJob(ctx, {
    userId,
    guildId: null,
    source: 'web',
    packId: body?.packId as string,
    request: body?.request as SimRequest,
  });
  if (!result.ok) throw new HttpError(result.status, result.code, result.message);
  return json({ id: result.id });
}

/** Polled about once a second. `?after=<next>` returns only lines written since the previous poll. */
async function status(ctx: RequestCtx): Promise<Response> {
  const after = Number(ctx.url.searchParams.get('after') ?? 0);
  const view = await jobView(ctx, ctx.params.id, Number.isSafeInteger(after) && after > 0 ? after : 0);
  if (!view || view.userId !== ctx.session!.userId) throw notFound();
  const { status, position, lines, next, error, summary, notices, effective } = view;
  return json({ status, position, lines, next, error, summary, notices, effective });
}

/** The gzip bytes, proxied from R2 and never rendered by the browser. */
async function result(ctx: RequestCtx): Promise<Response> {
  const [row] = await ctx.sql`select 1 from compute_jobs where id = ${ctx.params.id} and user_id = ${ctx.session!.userId} and status = 'done'`;
  if (!row) throw notFound();
  const obj = await ctx.r2.get(ctx.config.env.R2_DATA_BUCKET!, resultKey(ctx.params.id));
  if (!obj) throw new HttpError(404, 'not-found', 'This result has expired.');
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/gzip',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'attachment',
    },
  });
}

/** Where a new job would start and about when (queue.ts capacityView). Asked once per hybrid run, before it splits. */
async function capacity(ctx: RequestCtx): Promise<Response> {
  const userId = ctx.session!.userId;
  if (!(await rateLimit(ctx, 'compute-capacity', userId, 60, 60))) throw new HttpError(429, 'rate-limited', 'Too many capacity checks; wait a minute.');
  return json(await capacityView(ctx, userId));
}

/** Idempotent: 204 when cancelled now or already finished, 404 when it is not the caller's. */
async function cancel(ctx: RequestCtx): Promise<Response> {
  const userId = ctx.session!.userId;
  if (!(await cancelJob(ctx, ctx.params.id, { userId }))) {
    const [row] = await ctx.sql`select 1 from compute_jobs where id = ${ctx.params.id} and user_id = ${userId}`;
    if (!row) throw notFound();
  }
  return new Response(null, { status: 204 });
}

export const routes: Route[] = [
  { method: 'GET', path: /^\/api\/v1\/compute\/capacity$/, feature: 'compute', auth: 'session', handler: capacity },
  { method: 'POST', path: /^\/api\/v1\/compute\/jobs$/, feature: 'compute', auth: 'session', maxBody: MAX_REQUEST_BYTES, handler: submit },
  { method: 'GET', path: new RegExp(`^/api/v1/compute/jobs/${JOB}$`), feature: 'compute', auth: 'session', handler: status },
  { method: 'GET', path: new RegExp(`^/api/v1/compute/jobs/${JOB}/result$`), feature: 'compute', auth: 'session', handler: result },
  { method: 'DELETE', path: new RegExp(`^/api/v1/compute/jobs/${JOB}$`), feature: 'compute', auth: 'session', handler: cancel },
];

export const tasks: Task[] = [...queueTasks, ...autoscalerTasks];
