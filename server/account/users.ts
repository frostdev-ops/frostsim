// The signed-in user's own account (CLAUDE.md D15; DESIGN.md C7, P6): profile, identities, export, Loothing grant, and
// account deletion, which admin.ts shares.
//
// Deletion order. Every step is idempotent, so a retry resumes wherever a failure stopped:
//   1. Lock, in one transaction: suspended_at set, an `account.delete-started` audit row written (the pending marker), shares revoked.
//      Then every session is destroyed. From here the account can neither sign in nor serve a share, whatever fails next.
//   2. The Stripe customer is deleted (Stripe cancels its subscriptions). Before the row: the row holds the only pointer to it.
//   3. The R2 objects go: shares/<id>.json.gz and results/<jobId>.json.gz. Before the row: its shares and jobs are the only index.
//   4. The user's finished guild jobs are detached (user_id and the character data nulled) so they keep counting against the guild
//      pool, then the users row is deleted (everything else cascades) with an `account.deleted` audit row, in one transaction that first locks
//      the row and re-reads the customer and the object keys: a checkout, share or job that passed auth before step 1 may have added
//      one since, and then the row stays for the retry.
// Stripe or R2 unconfigured while there is something to delete there is a failure too: skipping would drop the only pointer.
// A failure after step 1 leaves a locked account carrying its marker: the hourly `account-delete-retry` task finishes it, admin DELETE
// can too, and admin cannot unsuspend it. A failure in step 1 changes nothing.

import type { AppCtx, RequestCtx, Route, Task } from './app';
import { audit } from './audit';
import type { Db } from './db';
import { HttpError, errorSummary, json } from './http';
import { HIDDEN_CHAR } from './providers/index';
import { rateLimit } from './ratelimit';
import { clearSessionCookie, createSession, destroyUserSessions, forgetCachedSessions } from './session';
import { StripeError, stripe } from './stripe';

const MAX_NAME = 64;
const R2_DELETE_BATCH = 8;

/** GET /api/v1/me shape (DESIGN.md P6), or null when the user is gone. */
export async function meView(db: Db, userId: string) {
  const [user] = await db`select id, display_name, role, created_at from users where id = ${userId}`;
  if (!user) return null;
  const identities = await db`select provider, display_name, created_at from identities where user_id = ${userId} order by created_at`;
  const grants = await db`select integration from integration_grants where user_id = ${userId} order by integration`;
  return {
    user: { id: user.id as string, displayName: user.display_name as string, role: user.role as string, createdAt: user.created_at as Date },
    identities: identities.map((i) => ({ provider: i.provider as string, displayName: i.display_name as string | null, createdAt: i.created_at as Date })),
    integrations: grants.map((g) => g.integration as string),
  };
}

/** Everything stored about the user except secrets. Left out: sessions.id_hash (the lookup key of a live cookie), and the bodies of
 *  compute_jobs.request/payload (up to 1 MiB each, kept 7 days for support, then nulled by compute): their sizes stand in, so one
 *  export cannot hold hundreds of MB in memory. Not in Postgres, so not here: share blobs and job results in R2 (fetched through their
 *  own routes), job progress lines in Redis (expire within an hour).
 *  ponytail: built in memory; stream rows with a cursor if a job ledger reaches ~100k rows. */
export async function exportAccount(db: Db, userId: string) {
  const [user] = await db`select id, display_name, role, suspended_at, stripe_customer_id, comp_core_seconds::float8 as comp_core_seconds,
    comp_max_threads, created_at from users where id = ${userId}`;
  if (!user) return null;
  return {
    exportedAt: new Date(),
    user,
    identities: await db`select provider, subject, display_name, created_at from identities where user_id = ${userId} order by created_at`,
    sessions: await db`select created_at, expires_at, last_seen_at from sessions where user_id = ${userId} order by created_at`,
    subscriptions: await db`select stripe_subscription_id, status, current_period_start, current_period_end, items, guild_id,
      stripe_updated::float8 as stripe_updated, updated_at from subscriptions where user_id = ${userId} order by updated_at`,
    computeJobs: await db`select id, guild_id, source, pack_id, threads, octet_length(request::text) as request_bytes,
      octet_length(payload::text) as payload_bytes, status, worker_id, attempts, lease_until,
      created_at, claimed_at, finished_at, wall_seconds, core_seconds, summary, error from compute_jobs where user_id = ${userId}
      order by created_at`,
    cloudCharacters: await db`select id, label, raw, bytes, created_at, updated_at from cloud_characters where user_id = ${userId}
      order by created_at`,
    characterSnapshots: await db`select s.character_id, s.created_at, s.item_level, s.gear from character_snapshots s
      join cloud_characters c on c.id = s.character_id where c.user_id = ${userId} order by s.created_at`,
    characterSims: await db`select s.character_id, s.created_at, s.source, s.dps, s.dps_error, s.fight_style, s.targets, s.game_build,
      s.report_id, s.job_id from character_sims s join cloud_characters c on c.id = s.character_id where c.user_id = ${userId}
      order by s.created_at`,
    shares: await db`select id, title, bytes, created_at, expires_at, revoked_at from shares where user_id = ${userId} order by created_at`,
    integrationGrants: await db`select integration, created_at from integration_grants where user_id = ${userId} order by integration`,
    auditLog: await db`select at, actor, action, detail from audit_log where user_id = ${userId} order by at, id`,
  };
}

/** Whether a deletion was started and has not finished (see the header). */
export async function deletionPending(db: Db, userId: string): Promise<boolean> {
  const [row] = await db`select 1 from audit_log where user_id = ${userId} and action = 'account.delete-started' limit 1`;
  return Boolean(row);
}

/** R2 keys of everything the user's rows point at. */
async function objectKeys(db: Db, userId: string): Promise<string[]> {
  return [
    ...(await db`select id from shares where user_id = ${userId}`).map((r) => `shares/${r.id}.json.gz`),
    ...(await db`select id from compute_jobs where user_id = ${userId}`).map((r) => `results/${r.id}.json.gz`),
  ];
}

/** Deletes the account in the order the header documents. `actor` is `user:<id>`, `admin:<id>` or `system`. 'pending' means the lock
 *  held but a later step failed; it is logged and retried hourly. */
export async function deleteAccount(app: AppCtx, userId: string, actor: string): Promise<'deleted' | 'pending' | 'not-found'> {
  const locked = await app.sql.begin(async (tx) => {
    const [user] = await tx`update users set suspended_at = coalesce(suspended_at, ${app.now()}) where id = ${userId}
      returning stripe_customer_id`;
    if (!user) return null;
    if (!(await deletionPending(tx, userId))) await audit(tx, { userId, actor, action: 'account.delete-started' });
    await tx`update shares set revoked_at = coalesce(revoked_at, ${app.now()}) where user_id = ${userId}`;
    return { customer: user.stripe_customer_id as string | null };
  });
  if (!locked) return 'not-found';

  try {
    // Rows go first, so a failed cache DEL leaves at most a 300 s cached copy of a locked account; not worth stopping for.
    await destroyUserSessions(app, userId).catch((err) => app.log(`account: session cache not cleared (${errorSummary(err)})`));

    // Without STRIPE_SECRET_KEY or the R2 keys these throw 503 unconfigured, which keeps the account pending (header).
    if (locked.customer) {
      try {
        await stripe(app, 'DELETE', `/customers/${encodeURIComponent(locked.customer)}`);
      } catch (err) {
        // Already deleted by an earlier attempt.
        if (!(err instanceof StripeError && err.status === 404)) throw err;
      }
    }

    const keys = await objectKeys(app.sql, userId);
    // ponytail: 8 single-key DELETEs at a time; switch to S3 DeleteObjects (1000 keys per call) if job ledgers reach many thousands.
    for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
      await Promise.all(keys.slice(i, i + R2_DELETE_BATCH).map((key) => app.r2.delete(app.config.env.R2_DATA_BUCKET!, key)));
    }

    await app.sql.begin(async (tx) => {
      const [user] = await tx`select stripe_customer_id from users where id = ${userId} for update`;
      if (!user) return;
      const done = new Set(keys);
      if (user.stripe_customer_id !== locked.customer || (await objectKeys(tx, userId)).some((key) => !done.has(key))) {
        throw new Error('a customer, share or job was added during deletion');
      }
      // Metered guild jobs are the guild's usage ledger: cascading them would refill the pool on every delete and re-signup. Only
      // 'done' rows carry core_seconds. A still-running one cascades and its completion is dropped as 'lost' (one job, unmetered).
      await tx`update compute_jobs set user_id = null, request = null, payload = null, summary = null
        where user_id = ${userId} and guild_id is not null and status = 'done'`;
      await tx`delete from users where id = ${userId}`;
      // user_id null: the row it would point at is gone. The id stays in the detail so the log still says who.
      await audit(tx, { userId: null, actor, action: 'account.deleted',
        detail: { userId, stripe: locked.customer ? 'deleted' : 'none', r2: keys.length ? 'deleted' : 'none', r2Objects: keys.length } });
    });
    return 'deleted';
  } catch (err) {
    app.log(`account: deleting ${userId} stopped (${errorSummary(err)}); the hourly retry resumes it`);
    return 'pending';
  }
}

function displayName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > MAX_NAME || HIDDEN_CHAR.test(name)) {
    throw new HttpError(400, 'invalid', `displayName must be 1 to ${MAX_NAME} characters without control or invisible formatting characters.`);
  }
  return name;
}

async function me(ctx: RequestCtx): Promise<Response> {
  const view = await meView(ctx.sql, ctx.session!.userId);
  if (!view) throw new HttpError(401, 'signed-out', 'Sign in first.');
  return json(view);
}

const grant = (on: boolean) => async (ctx: RequestCtx): Promise<Response> => {
  const userId = ctx.session!.userId;
  const changed = on
    ? await ctx.sql`insert into integration_grants (user_id, integration) values (${userId}, 'loothing') on conflict do nothing returning 1`
    : await ctx.sql`delete from integration_grants where user_id = ${userId} and integration = 'loothing' returning 1`;
  if (changed.length) await audit(ctx.sql, { userId, actor: `user:${userId}`, action: on ? 'integration.grant' : 'integration.revoke', detail: { integration: 'loothing' } });
  return new Response(null, { status: 204 });
};

export const routes: Route[] = [
  { method: 'GET', path: /^\/api\/v1\/me$/, feature: 'accounts', auth: 'session', handler: me },
  {
    method: 'PATCH', path: /^\/api\/v1\/me$/, feature: 'accounts', auth: 'session',
    handler: async (ctx) => {
      const name = displayName((await ctx.json<{ displayName?: unknown } | null>())?.displayName);
      const userId = ctx.session!.userId;
      await ctx.sql`update users set display_name = ${name} where id = ${userId}`;
      // Row first, cache second (session.ts). A failed DEL only shows the old name for up to 5 minutes.
      await forgetCachedSessions(ctx, userId).catch((err) => ctx.log(`account: session cache not cleared (${errorSummary(err)})`));
      return me(ctx);
    },
  },
  {
    method: 'DELETE', path: /^\/api\/v1\/me$/, feature: 'accounts', auth: 'session',
    handler: async (ctx) => {
      const userId = ctx.session!.userId;
      const outcome = await deleteAccount(ctx, userId, `user:${userId}`);
      const headers = { 'set-cookie': clearSessionCookie() };
      return outcome === 'pending' ? json({ pending: true }, 202, headers) : new Response(null, { status: 204, headers });
    },
  },
  {
    method: 'GET', path: /^\/api\/v1\/me\/export$/, feature: 'accounts', auth: 'session',
    handler: async (ctx) => {
      // Each export reads every row about the user: a few an hour is plenty, and it bounds concurrent ones.
      if (!(await rateLimit(ctx, 'export', ctx.session!.userId, 5, 3600))) throw new HttpError(429, 'rate-limited', 'Too many exports; try again later.');
      const data = await exportAccount(ctx.sql, ctx.session!.userId);
      if (!data) throw new HttpError(401, 'signed-out', 'Sign in first.');
      return json(data, 200, { 'content-disposition': 'attachment; filename="frostsim-account.json"' });
    },
  },
  {
    method: 'DELETE', path: /^\/api\/v1\/me\/identities\/(?<provider>[a-z0-9-]{1,32})$/, feature: 'accounts', auth: 'session',
    handler: async (ctx) => {
      const userId = ctx.session!.userId;
      const provider = ctx.params.provider;
      const outcome = await ctx.sql.begin(async (tx) => {
        // Serialises this user's unlinks and links (oauth.ts takes the same lock): two unlinks could otherwise each see another
        // identity and remove both.
        await tx`select 1 from users where id = ${userId} for update`;
        const [counts] = await tx`select count(*) filter (where provider = ${provider})::int as mine,
          count(*) filter (where provider <> ${provider})::int as others from identities where user_id = ${userId}`;
        if (!counts?.mine) return 'not-found';
        if (!counts.others) return 'last';
        await tx`delete from identities where user_id = ${userId} and provider = ${provider}`;
        await audit(tx, { userId, actor: `user:${userId}`, action: 'identity.unlink', detail: { provider } });
        return 'unlinked';
      });
      if (outcome === 'not-found') throw new HttpError(404, 'not-found', 'No linked account from that provider.');
      if (outcome === 'last') throw new HttpError(409, 'conflict', 'This is your only sign-in method; link another before removing it.');
      // A removed sign-in method takes every session with it (one may have come through it); this browser gets a fresh one. The rows
      // are gone before the cache DEL can fail, and a cached copy then lasts at most 300 s: not worth signing this browser out for.
      await destroyUserSessions(ctx, userId).catch((err) => ctx.log(`account: session cache not cleared (${errorSummary(err)})`));
      const { cookie } = await createSession(ctx, userId);
      return new Response(null, { status: 204, headers: { 'set-cookie': cookie } });
    },
  },
  { method: 'PUT', path: /^\/api\/v1\/me\/integrations\/loothing$/, feature: 'accounts', auth: 'session', handler: grant(true) },
  { method: 'DELETE', path: /^\/api\/v1\/me\/integrations\/loothing$/, feature: 'accounts', auth: 'session', handler: grant(false) },
];

export const tasks: Task[] = [{
  name: 'account-delete-retry',
  feature: 'accounts',
  everyMs: 3600_000,
  run: async (ctx) => {
    const rows = await ctx.sql`select u.id from users u where u.suspended_at is not null
      and exists (select 1 from audit_log a where a.user_id = u.id and a.action = 'account.delete-started')`;
    // deleteAccount logs its own failures and never throws past the lock, so one stuck account cannot starve the rest.
    for (const row of rows) await deleteAccount(ctx, row.id as string, 'system');
  },
}];
