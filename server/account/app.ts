// Account-server router (CLAUDE.md D14, D15; DESIGN.md C2): one ordered regex route table, gated per feature, with CSRF, body caps and auth
// applied before any handler runs. Route modules are separate files exporting `routes` and `tasks`, so a new feature never edits this file.
//
// Auth: a route declares `auth`. `session`/`admin` resolve the session cookie here. `worker` and `loothing` call `resolveWorker`
// (compute/worker-routes.ts) and `resolveLoothing` (integrations.ts), which check the bearer token.
// Signature-verified routes (Stripe webhook, Discord interactions) are `public` and verify ctx.body() themselves.

import { configured, type Config, type Feature, type Log } from './config';
import type { Sql } from './db';
import type { Redis } from './redis';
import type { R2 } from './r2';
import { DEFAULT_MAX_BODY, HttpError, clientIp, error, errorSummary, readBody } from './http';
import { getSession, tasks as sessionTasks, type Session } from './session';
import { health } from './health';
import * as oauth from './oauth';
import * as users from './users';
import * as admin from './admin';
import * as billing from './billing';
import * as compute from './compute/routes';
import * as worker from './compute/worker-routes';
import * as characters from './characters';
import * as shares from './shares';
import * as discord from './discord';
import * as integrations from './integrations';

/** Everything a handler or task may touch. Inject fakes in tests. */
export interface AppCtx {
  config: Config;
  sql: Sql;
  /** Null when REDIS_URL is unset; calls may still fail when it is down. Go through tryRedis. */
  redis: Redis | null;
  r2: R2;
  fetch: typeof fetch;
  now: () => Date;
  log: Log;
}

export interface RequestCtx extends AppCtx {
  request: Request;
  /** Built on PUBLIC_ORIGIN; pathname is still percent-encoded. */
  url: URL;
  /** Named groups of the route's path regex. */
  params: Record<string, string>;
  ip: string;
  /** Set for `session` and `admin` routes. */
  session: Session | null;
  /** Set for `worker` routes. */
  workerId: string | null;
  /** Raw body bytes, capped at the route's maxBody (413 past it). Read once, memoised. */
  body(): Promise<Uint8Array>;
  /** Parsed JSON body (400 when it is not JSON). Validate the shape yourself. */
  json<T = unknown>(): Promise<T>;
}

export type Auth = 'public' | 'session' | 'admin' | 'worker' | 'loothing';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
  method: Method;
  /** Must match the WHOLE pathname, e.g. /^\/api\/v1\/shares\/(?<id>[0-9A-Za-z]+)$/; named groups become ctx.params. */
  path: RegExp;
  feature: Feature;
  auth: Auth;
  /** Bytes; default DEFAULT_MAX_BODY (64 KiB). */
  maxBody?: number;
  /** Body media type a session/admin state change must declare; default application/json. */
  bodyType?: 'application/json' | 'application/gzip';
  handler(ctx: RequestCtx): Promise<Response> | Response;
}

export interface Task {
  name: string;
  /** Runs only while this feature is enabled and configured. */
  feature: Feature;
  everyMs: number;
  run(ctx: AppCtx): Promise<void>;
}

const MODULES = [oauth, users, admin, billing, compute, worker, characters, shares, discord, integrations];
export const ROUTES: readonly Route[] = MODULES.flatMap((m) => m.routes);
export const TASKS: readonly Task[] = [...sessionTasks, ...MODULES.flatMap((m) => m.tasks)];

/** With every feature off there is no database; health still answers. */
export type AppDeps = Omit<AppCtx, 'sql'> & { sql: Sql | null };

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function createApp(deps: AppDeps, routes: readonly Route[] = ROUTES): (request: Request, remote: string) => Promise<Response> {
  const { config } = deps;

  async function dispatch(request: Request, remote: string): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/v1/health') return health(deps);

    let params: Record<string, string> = {};
    const route = routes.find((r) => {
      if (r.method !== request.method) return false;
      // A /g or /y regex would resume from its last match and miss every other request.
      r.path.lastIndex = 0;
      const m = r.path.exec(url.pathname);
      if (!m || m[0] !== url.pathname) return false;
      params = { ...m.groups };
      return true;
    });
    if (!route) return error(404, 'not-found', 'No such endpoint.');

    if (!config.features.has(route.feature)) {
      return route.feature === 'compute'
        ? error(503, 'compute-disabled', 'Frostsim Cloud is switched off; runs stay in the browser.')
        : error(404, 'feature-off', 'This feature is not enabled.');
    }
    if (!deps.sql || !configured(config, route.feature)) return error(503, 'unconfigured', 'This feature is not configured on this server.');

    const refused = csrf(route, request, config.publicOrigin);
    if (refused) return refused;

    const maxBody = route.maxBody ?? DEFAULT_MAX_BODY;
    let body: Promise<Uint8Array> | undefined;
    const ctx: RequestCtx = {
      ...deps,
      sql: deps.sql,
      request,
      url,
      params,
      ip: clientIp(request.headers, remote),
      session: null,
      workerId: null,
      body: () => (body ??= readBody(request, maxBody)),
      json: async <T>() => {
        const text = new TextDecoder().decode(await ctx.body());
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError(400, 'invalid', 'The request body is not valid JSON.');
        }
      },
    };
    // Before auth, so an oversized upload is refused without a database round trip.
    if (Number(request.headers.get('content-length')) > maxBody) await ctx.body();

    const denied = await authorize(route, ctx);
    return denied ?? (await route.handler(ctx));
  }

  return async (request, remote) => {
    let response: Response;
    try {
      response = await dispatch(request, remote);
    } catch (err) {
      if (err instanceof HttpError) response = error(err.status, err.code, err.message);
      else {
        deps.log(`account: ${request.method} ${new URL(request.url).pathname} failed (${errorSummary(err)})`);
        response = error(500, 'internal', 'Request failed.');
      }
    }
    return secure(response);
  };
}

/** State changes by cookie must come from our own page: exact Origin, and a body type a cross-site form cannot send without a preflight. */
function csrf(route: Route, request: Request, origin: string): Response | null {
  if (SAFE_METHODS.has(request.method) || (route.auth !== 'session' && route.auth !== 'admin')) return null;
  if (request.headers.get('origin') !== origin) return error(403, 'bad-origin', 'Cross-site request refused.');
  const expected = route.bodyType ?? 'application/json';
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (request.body && type !== expected) return error(400, 'invalid', `The request body must be ${expected}.`);
  return null;
}

async function authorize(route: Route, ctx: RequestCtx): Promise<Response | null> {
  switch (route.auth) {
    case 'public':
      return null;
    case 'session':
    case 'admin':
      ctx.session = await getSession(ctx, ctx.request);
      if (!ctx.session) return error(401, 'signed-out', 'Sign in first.');
      return route.auth === 'admin' && ctx.session.role !== 'admin' ? error(403, 'forbidden', 'Administrators only.') : null;
    case 'worker':
      ctx.workerId = await worker.resolveWorker(ctx);
      return ctx.workerId ? null : error(401, 'signed-out', 'Worker token refused.');
    case 'loothing':
      return (await integrations.resolveLoothing(ctx)) ? null : error(401, 'signed-out', 'Integration token refused.');
  }
}

/** no-store unless the handler chose a cache policy; nosniff always. nginx adds COOP/COEP/Referrer-Policy. */
function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
