// Admin user management under /api/v1/admin (CLAUDE.md D15, DESIGN.md C7): search, view, suspend, role, comped allowance, delete.
// Every change is audit-logged with the acting admin. An admin cannot demote, suspend or delete themselves here, so the last admin
// cannot lock everyone out by accident.

import type { RequestCtx, Route, Task } from './app';
import { audit } from './audit';
import { CATALOG } from './catalog';
import type { Db } from './db';
import { HttpError, json } from './http';
import { destroyUserSessions, forgetCachedSessions } from './session';
import { deleteAccount, deletionPending } from './users';

const USER_ID = '(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_LIMIT = 50;
/** Widest job a worker can take: a comped width above it could never be claimed. */
const MAX_THREADS = Math.max(...Object.values(CATALOG).map((p) => p.maxThreads ?? 0));
const PATCH_FIELDS = new Set(['suspended', 'role', 'compCoreSeconds', 'compMaxThreads']);

interface UserPatch {
  suspended?: boolean;
  role?: 'user' | 'admin';
  compCoreSeconds?: number;
  compMaxThreads?: number | null;
}

async function adminView(db: Db, id: string) {
  const [user] = await db`select id, display_name, role, suspended_at, stripe_customer_id, comp_core_seconds::float8 as comp_core_seconds,
    comp_max_threads, created_at from users where id = ${id}`;
  if (!user) return null;
  const identities = await db`select provider, subject, display_name, created_at from identities where user_id = ${id} order by created_at`;
  const grants = await db`select integration from integration_grants where user_id = ${id} order by integration`;
  return {
    user: {
      id: user.id, displayName: user.display_name, role: user.role, suspendedAt: user.suspended_at, stripeCustomerId: user.stripe_customer_id,
      compCoreSeconds: user.comp_core_seconds, compMaxThreads: user.comp_max_threads, createdAt: user.created_at,
      deletionPending: await deletionPending(db, id),
    },
    identities: identities.map((i) => ({ provider: i.provider, subject: i.subject, displayName: i.display_name, createdAt: i.created_at })),
    integrations: grants.map((g) => g.integration as string),
  };
}

export function parsePatch(body: unknown): UserPatch {
  const bad = (message: string) => new HttpError(400, 'invalid', message);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Expected a JSON object.');
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (!keys.length || keys.some((k) => !PATCH_FIELDS.has(k))) throw bad(`Send one or more of: ${[...PATCH_FIELDS].join(', ')}.`);
  if (b.suspended !== undefined && typeof b.suspended !== 'boolean') throw bad('suspended must be a boolean.');
  if (b.role !== undefined && b.role !== 'user' && b.role !== 'admin') throw bad('role must be user or admin.');
  if (b.compCoreSeconds !== undefined && !(Number.isSafeInteger(b.compCoreSeconds) && (b.compCoreSeconds as number) >= 0)) {
    throw bad('compCoreSeconds must be a whole number of seconds, 0 or more.');
  }
  if (b.compMaxThreads !== undefined && b.compMaxThreads !== null
    && !(Number.isInteger(b.compMaxThreads) && (b.compMaxThreads as number) >= 1 && (b.compMaxThreads as number) <= MAX_THREADS)) {
    throw bad(`compMaxThreads must be null or 1 to ${MAX_THREADS}.`);
  }
  return b as UserPatch;
}

async function patchUser(ctx: RequestCtx): Promise<Response> {
  const id = ctx.params.id;
  const adminId = ctx.session!.userId;
  const patch = parsePatch(await ctx.json());
  if (id === adminId && (patch.role === 'user' || patch.suspended === true)) {
    throw new HttpError(403, 'forbidden', 'You cannot demote or suspend yourself.');
  }
  const found = await ctx.sql.begin(async (tx) => {
    const [user] = await tx`select role, suspended_at from users where id = ${id} for update`;
    if (!user) return false;
    // Unsuspending would bring back an account that is half-deleted; the retry task finishes it instead.
    if (patch.suspended === false && user.suspended_at && (await deletionPending(tx, id))) {
      throw new HttpError(409, 'conflict', 'This account is being deleted.');
    }
    if (patch.suspended !== undefined) {
      await tx`update users set suspended_at = case when ${patch.suspended} then coalesce(suspended_at, ${ctx.now()}) end where id = ${id}`;
    }
    if (patch.role !== undefined) await tx`update users set role = ${patch.role} where id = ${id}`;
    if (patch.compCoreSeconds !== undefined) await tx`update users set comp_core_seconds = ${patch.compCoreSeconds} where id = ${id}`;
    if (patch.compMaxThreads !== undefined) await tx`update users set comp_max_threads = ${patch.compMaxThreads} where id = ${id}`;
    await audit(tx, { userId: id, actor: `admin:${adminId}`, action: 'admin.user.update', detail: { ...patch } });
    return true;
  });
  if (!found) throw new HttpError(404, 'not-found', 'No such user.');
  // Rows first (above), sessions second (session.ts). A Redis failure here reaches the app as a 500 so the admin sees it.
  if (patch.suspended) await destroyUserSessions(ctx, id);
  else if (patch.role !== undefined) await forgetCachedSessions(ctx, id);
  return json(await adminView(ctx.sql, id));
}

export const routes: Route[] = [
  {
    method: 'GET', path: /^\/api\/v1\/admin\/users$/, feature: 'accounts', auth: 'admin',
    handler: async (ctx) => {
      const q = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 100);
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const rows = await ctx.sql`select u.id, u.display_name, u.role, u.suspended_at, u.created_at from users u
        where ${q} = '' or u.id = ${UUID.test(q) ? q.toLowerCase() : null}::uuid or u.display_name ilike ${like}
          or exists (select 1 from identities i where i.user_id = u.id and i.display_name ilike ${like})
        order by u.created_at desc limit ${SEARCH_LIMIT}`;
      return json({
        users: rows.map((u) => ({ id: u.id, displayName: u.display_name, role: u.role, suspended: u.suspended_at !== null, createdAt: u.created_at })),
      });
    },
  },
  {
    method: 'GET', path: new RegExp(`^/api/v1/admin/users/${USER_ID}$`), feature: 'accounts', auth: 'admin',
    handler: async (ctx) => {
      const view = await adminView(ctx.sql, ctx.params.id);
      if (!view) throw new HttpError(404, 'not-found', 'No such user.');
      return json(view);
    },
  },
  { method: 'PATCH', path: new RegExp(`^/api/v1/admin/users/${USER_ID}$`), feature: 'accounts', auth: 'admin', handler: patchUser },
  {
    method: 'DELETE', path: new RegExp(`^/api/v1/admin/users/${USER_ID}$`), feature: 'accounts', auth: 'admin',
    handler: async (ctx) => {
      if (ctx.params.id === ctx.session!.userId) throw new HttpError(403, 'forbidden', 'You cannot delete yourself here; use your own account settings.');
      const outcome = await deleteAccount(ctx, ctx.params.id, `admin:${ctx.session!.userId}`);
      if (outcome === 'not-found') throw new HttpError(404, 'not-found', 'No such user.');
      return outcome === 'pending' ? json({ pending: true }, 202) : new Response(null, { status: 204 });
    },
  },
];

export const tasks: Task[] = [];
