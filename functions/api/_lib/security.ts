// Server-side safety rails for Battle.net proxy: redaction, SSRF prevention, rate limiting, TTL enforcement.

import { MAX_RETENTION_SECONDS } from '../../../src/lib/battlenet/contract';

export interface Env {
  /** OAuth client id. Hosting secret. Never a VITE_ variable. */
  BLIZZARD_CLIENT_ID?: string;
  /** OAuth client secret. Hosting secret. Never logged, never returned. */
  BLIZZARD_CLIENT_SECRET?: string;
  BLIZZARD_REGION?: string;
  /** Seconds to cache upstream responses. Clamped to the retention limit. */
  BLIZZARD_CACHE_SECONDS?: string;
  /** Optional comma-separated allowlist of item ids. Empty means "any valid id". */
  BLIZZARD_ITEM_ID_ALLOWLIST?: string;
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export function credentialsFrom(env: Env): Credentials | null {
  const clientId = env.BLIZZARD_CLIENT_ID?.trim();
  const clientSecret = env.BLIZZARD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Cache lifetime for this deployment, never above Blizzard's retention limit. */
export function cacheSeconds(env: Env): number {
  const raw = Number(env.BLIZZARD_CACHE_SECONDS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60;
  return Math.min(requested, MAX_RETENTION_SECONDS);
}

/**
 * Optional per-deployment item id allowlist. Null means "any id that passes the
 * numeric validation", which is the normal case — the catalog already bounds what
 * the app asks for, and an explicit list exists for a deployment that wants to
 * narrow it further.
 */
export function itemIdAllowlist(env: Env): Set<number> | null {
  const raw = env.BLIZZARD_ITEM_ID_ALLOWLIST?.trim();
  if (!raw) return null;
  const ids = new Set<number>();
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids.size > 0 ? ids : null;
}

// --- Redaction ---------------------------------------------------------------

/** Redact secrets from all messages (upstream echoes, stack traces may carry them). */
export function redact(text: unknown, credentials: Credentials | null): string {
  let out = typeof text === 'string' ? text : String(text);
  if (credentials) {
    for (const secret of [credentials.clientSecret, credentials.clientId]) {
      if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
    }
  }
  // Bearer tokens and basic-auth blobs, whatever their origin.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
  out = out.replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [redacted]');
  out = out.replace(/(access_token"?\s*[:=]\s*"?)[A-Za-z0-9._~+/-]+/gi, '$1[redacted]');
  return out;
}

/** Safe messages never echo upstream (can contain request ids); fixed string per class of failure. */
export function safeMessage(code: string): string {
  // Generic messages avoid revealing what data the endpoint serves.
  switch (code) {
    case 'not_configured':
      return 'The game data service is not configured for this deployment.';
    case 'not_found':
      return 'Nothing was found for that id.';
    case 'rate_limited':
      return 'Too many game data requests. Try again shortly.';
    case 'upstream_timeout':
      return 'The game data service did not respond in time.';
    case 'upstream_unavailable':
      return 'The game data service is unavailable.';
    case 'invalid_request':
      return 'The request was not valid.';
    default:
      return 'Something went wrong retrieving game data.';
  }
}

// --- Media host allowlist (SSRF) -------------------------------------------------

/** SSRF defense: allowlist hosts the endpoint may fetch from (upstream response may point elsewhere). */
export const ALLOWED_MEDIA_HOSTS = [
  'render.worldofwarcraft.com',
  'render-us.worldofwarcraft.com',
  'render-eu.worldofwarcraft.com',
  'render-kr.worldofwarcraft.com',
  'render-tw.worldofwarcraft.com',
] as const;

export function isAllowedMediaUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.port && url.port !== '443') return false;
  if (url.username || url.password) return false;
  return (ALLOWED_MEDIA_HOSTS as readonly string[]).includes(url.hostname);
}

/** Image types the proxy will pass through. Anything else is refused. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** Icons are small. A ceiling stops a redirect-to-huge-file from becoming our problem. */
export const MAX_IMAGE_BYTES = 512 * 1024;

export function isAllowedImageType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
}

// --- Rate limiting ---------------------------------------------------------------

/** Token bucket for upstream calls. GLOBAL ONLY in single-process deployments; upgrade path for serverless. */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity = 60,
    private readonly refillPerSecond = 8,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Consumes one token. Returns null when allowed, or seconds to wait. */
  take(): number | null {
    const now = this.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return null;
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerSecond));
  }
}

// --- Request deduplication ---------------------------------------------------

/** Collapse concurrent identical requests into one upstream call. */
export class InFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = task().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.pending.size;
  }
}

// --- Bounded TTL cache -------------------------------------------------------

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** LRU cache with hard TTL clamped to Blizzard's retention limit. */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly maxEntries = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    const ttl = Math.min(Math.max(0, ttlSeconds), MAX_RETENTION_SECONDS);
    if (ttl === 0) return;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttl * 1000 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Rejects a promise that has not settled in time, so a hung upstream is bounded. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not respond within ${ms}ms`);
    this.name = 'TimeoutError';
  }
}
