// OAuth sign-in, account linking and logout (CLAUDE.md D15; DESIGN.md C7, P4, P6). The callback is the one GET that changes
// state: its authority is the signed 10-minute __Host-fs_oauth cookie, whose state must equal the one the provider echoes back.
// Every callback outcome is a redirect to /?account=<code>#<returnTo> (P4); provider bodies are never echoed or logged. Each state is
// consumed once (Redis, fail open), so a replayed callback cannot spend our client's provider rate limit on token calls.

import { createHash, randomBytes } from 'node:crypto';
import type { RequestCtx, Route, Task } from './app';
import { audit } from './audit';
import type { Db } from './db';
import { HttpError, errorSummary, json, readCookie, setCookie } from './http';
import { PROVIDERS, type ProviderUser } from './providers/index';
import { rateLimit } from './ratelimit';
import { tryRedis } from './redis';
import { clearSessionCookie, createSession, destroySession, forgetCachedSessions, getSession } from './session';
import { safeEqual, sha256Hex, sign, verify } from './signed';

export const OAUTH_COOKIE = '__Host-fs_oauth';
const OAUTH_TTL_S = 600;
const PURPOSE = 'oauth';
const RETURN_TO = /^#\/[A-Za-z0-9/_.-]{0,200}$/;
// Per client IP; generous for a household behind one address, tight enough to stop cookie/state minting floods.
const START_LIMIT = 30;
const START_WINDOW_S = 600;
// Fetch Metadata values allowed to start a flow: our own pages and user-typed URLs. A cross-site page must not start one in this
// browser (a forced link, or a switch into another account). Browsers without Fetch Metadata send no header and are let through.
const START_SITES = new Set(['same-origin', 'none']);

interface OAuthState {
  state: string;
  verifier: string;
  provider: string;
  mode: 'login' | 'link';
  returnTo: string;
  linkUserId?: string;
}

interface Identity extends ProviderUser {
  provider: string;
}

interface UserRow {
  id: string;
  role: 'user' | 'admin';
  suspended_at: Date | null;
}

/** The only return paths we redirect to: an in-app hash route. Anything else (//host, https:, backslashes, encoded slashes) is #/. */
export function safeReturn(value: string | null | undefined): string {
  return value && RETURN_TO.test(value) ? value : '#/';
}

const redirectUri = (ctx: RequestCtx, provider: string) => `${ctx.config.publicOrigin}/api/v1/auth/${provider}/callback`;
const secret = (ctx: RequestCtx) => ctx.config.env.SESSION_SECRET ?? '';

/** Sign-in landing (DESIGN.md P4). Always clears the OAuth cookie: it is single use whatever the outcome. */
function landing(ctx: RequestCtx, code: string, returnTo = '#/', sessionCookie?: string): Response {
  const headers = new Headers({ location: `${ctx.config.publicOrigin}/?account=${code}${returnTo}` });
  headers.append('set-cookie', setCookie(OAUTH_COOKIE, '', 0));
  if (sessionCookie) headers.append('set-cookie', sessionCookie);
  return new Response(null, { status: 302, headers });
}

async function start(ctx: RequestCtx): Promise<Response> {
  const provider = PROVIDERS.get(ctx.params.provider);
  if (!provider) throw new HttpError(404, 'not-found', 'Unknown sign-in provider.');
  if (!provider.configured(ctx.config)) throw new HttpError(503, 'unconfigured', `${provider.label} sign-in is not configured on this server.`);
  const mode = ctx.url.searchParams.get('mode') ?? 'login';
  if (mode !== 'login' && mode !== 'link') throw new HttpError(400, 'invalid', 'mode must be login or link.');
  const site = ctx.request.headers.get('sec-fetch-site');
  if (site && !START_SITES.has(site)) throw new HttpError(403, 'forbidden', 'Start sign-in from this site.');
  if (!(await rateLimit(ctx, 'oauth-start', ctx.ip, START_LIMIT, START_WINDOW_S))) {
    throw new HttpError(429, 'rate-limited', 'Too many sign-in attempts. Try again in a few minutes.');
  }

  const saved: OAuthState = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'),
    provider: provider.id, mode, returnTo: safeReturn(ctx.url.searchParams.get('return')) };
  if (mode === 'link') {
    const session = await getSession(ctx, ctx.request);
    if (!session) throw new HttpError(401, 'signed-out', 'Sign in before linking another account.');
    saved.linkUserId = session.userId;
  }
  const location = provider.authorizeUrl(ctx.config, {
    state: saved.state,
    codeChallenge: createHash('sha256').update(saved.verifier).digest('base64url'),
    redirectUri: redirectUri(ctx, provider.id),
  });
  const cookie = setCookie(OAUTH_COOKIE, sign(secret(ctx), PURPOSE, saved, OAUTH_TTL_S, ctx.now().getTime()), OAUTH_TTL_S);
  return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie } });
}

async function callback(ctx: RequestCtx): Promise<Response> {
  const query = ctx.url.searchParams;
  const token = readCookie(ctx.request, OAUTH_COOKIE);
  const saved = token ? verify<OAuthState>(secret(ctx), PURPOSE, token, ctx.now().getTime()) : null;
  // Missing, expired, tampered, for another provider, or a state that is not ours: a forged or replayed callback.
  if (!saved || saved.provider !== ctx.params.provider || !safeEqual(query.get('state') ?? '', saved.state)) {
    return landing(ctx, 'error-state');
  }
  // Single use: the cookie outlives this request in an attacker's own jar. The key lives as long as any cookie carrying this state.
  const fresh = await tryRedis(ctx.redis, ctx.log,
    async (r) => (await r.set(`oauth:${sha256Hex(saved.state)}`, '1', 'EX', OAUTH_TTL_S, 'NX')) === 'OK', true);
  if (!fresh) return landing(ctx, 'error-state');
  const returnTo = safeReturn(saved.returnTo);
  const providerError = query.get('error');
  if (providerError) return landing(ctx, providerError === 'access_denied' ? 'error-denied' : 'error-provider', returnTo);

  const provider = PROVIDERS.get(saved.provider);
  const code = query.get('code');
  if (!provider?.configured(ctx.config) || !code) return landing(ctx, 'error-provider', returnTo);
  try {
    const who = await provider.exchange(ctx.config, { code, codeVerifier: saved.verifier, redirectUri: redirectUri(ctx, provider.id) }, ctx.fetch);
    const identity: Identity = { provider: provider.id, ...who };
    if (saved.mode === 'link') return landing(ctx, await link(ctx, saved.linkUserId, identity), returnTo);
    const outcome = await login(ctx, identity);
    return typeof outcome === 'string' ? landing(ctx, outcome, returnTo) : landing(ctx, 'signed-in', returnTo, outcome.cookie);
  } catch (err) {
    // The provider or our own storage: a top-level navigation still gets its DESIGN.md P4 landing, never a JSON 500.
    ctx.log(`account: ${provider.id} sign-in failed (${errorSummary(err)})`);
    return landing(ctx, 'error-provider', returnTo);
  }
}

async function findOwner(db: Db, id: Identity): Promise<UserRow | null> {
  const [row] = await db`select u.id, u.role, u.suspended_at from identities i join users u on u.id = i.user_id
    where i.provider = ${id.provider} and i.subject = ${id.subject}`;
  return (row as UserRow | undefined) ?? null;
}

/** Login mode: an existing identity signs its user in; a new one creates user + identity. Returns a DESIGN.md P4 error code or the cookie. */
async function login(ctx: RequestCtx, id: Identity): Promise<string | { cookie: string }> {
  const admin = ctx.config.adminIdentities.has(`${id.provider}:${id.subject}`);
  let user = await findOwner(ctx.sql, id);
  if (!user) {
    // Staging refuses strangers before they leave a row behind.
    if (ctx.config.adminOnly && !admin) return 'error-admin-only';
    user = await createUser(ctx, id, admin);
  }
  if (user.suspended_at) return 'error-suspended';
  if (admin && user.role !== 'admin') {
    await ctx.sql`update users set role = 'admin' where id = ${user.id}`;
    await audit(ctx.sql, { userId: user.id, actor: 'system', action: 'user.promote', detail: { identity: `${id.provider}:${id.subject}` } });
    await forgetCachedSessions(ctx, user.id).catch((err) => ctx.log(`account: session cache not cleared (${errorSummary(err)})`));
    user = { ...user, role: 'admin' };
  }
  if (ctx.config.adminOnly && user.role !== 'admin') return 'error-admin-only';
  // BattleTags and Discord names change; keep the shown name current.
  await ctx.sql`update identities set display_name = ${id.displayName}
    where provider = ${id.provider} and subject = ${id.subject} and display_name is distinct from ${id.displayName}`;
  return { cookie: (await createSession(ctx, user.id)).cookie };
}

async function createUser(ctx: RequestCtx, id: Identity, admin: boolean): Promise<UserRow> {
  try {
    return await ctx.sql.begin(async (tx) => {
      const [user] = await tx`insert into users (display_name, role) values (${id.displayName}, ${admin ? 'admin' : 'user'})
        returning id, role, suspended_at`;
      await tx`insert into identities (provider, subject, user_id, display_name)
        values (${id.provider}, ${id.subject}, ${user.id}, ${id.displayName})`;
      await audit(tx, { userId: user.id, actor: `user:${user.id}`, action: 'user.create', detail: { provider: id.provider, admin } });
      return user as UserRow;
    }) as UserRow;
  } catch (err) {
    // Two first sign-ins of one identity raced (unique violation): the other one created the user; use it.
    const winner = (err as { code?: string }).code === '23505' ? await findOwner(ctx.sql, id) : null;
    if (!winner) throw err;
    return winner;
  }
}

/** Link mode: needs the user the flow started for AND that user's live session. Never merges: an identity bound elsewhere is refused. */
async function link(ctx: RequestCtx, linkUserId: string | undefined, id: Identity): Promise<string> {
  const session = await getSession(ctx, ctx.request);
  if (!linkUserId || session?.userId !== linkUserId) return 'error-signed-out';
  return await ctx.sql.begin(async (tx) => {
    // Serialises this user's links and unlinks (users.ts takes the same lock): two concurrent links from one provider would
    // otherwise both pass the check below.
    await tx`select 1 from users where id = ${linkUserId} for update`;
    const owner = await findOwner(tx, id);
    if (owner) return owner.id === linkUserId ? 'linked' : 'error-identity-in-use';
    // One identity per provider: unlinking is by provider, and two would make that ambiguous.
    const [other] = await tx`select 1 from identities where user_id = ${linkUserId} and provider = ${id.provider}`;
    if (other) return 'error-already-linked';
    const [row] = await tx`insert into identities (provider, subject, user_id, display_name)
      values (${id.provider}, ${id.subject}, ${linkUserId}, ${id.displayName}) on conflict do nothing returning user_id`;
    if (!row) return (await findOwner(tx, id))?.id === linkUserId ? 'linked' : 'error-identity-in-use';
    await audit(tx, { userId: linkUserId, actor: `user:${linkUserId}`, action: 'identity.link', detail: { provider: id.provider } });
    return 'linked';
  }) as string;
}

export const routes: Route[] = [
  {
    method: 'GET', path: /^\/api\/v1\/auth\/providers$/, feature: 'accounts', auth: 'public',
    handler: (ctx) => json({ providers: [...PROVIDERS.values()].filter((p) => p.configured(ctx.config)).map((p) => ({ id: p.id, label: p.label })) }),
  },
  { method: 'GET', path: /^\/api\/v1\/auth\/(?<provider>[a-z0-9-]{1,32})\/start$/, feature: 'accounts', auth: 'public', handler: start },
  { method: 'GET', path: /^\/api\/v1\/auth\/(?<provider>[a-z0-9-]{1,32})\/callback$/, feature: 'accounts', auth: 'public', handler: callback },
  {
    method: 'POST', path: /^\/api\/v1\/auth\/logout$/, feature: 'accounts', auth: 'session',
    handler: async (ctx) => {
      // The row is gone before the cache DEL can fail; either way this browser forgets the cookie.
      await destroySession(ctx, ctx.session!.idHash).catch((err) => ctx.log(`account: logout incomplete (${errorSummary(err)})`));
      return new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie() } });
    },
  },
];

export const tasks: Task[] = [];
