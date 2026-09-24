// Stripe REST over plain fetch (CLAUDE.md D15, DESIGN.md C3): a pinned API version, form encoding, and errors that carry Stripe's
// status/type/code only, never its body.

import type { Config } from './config';
import { HttpError } from './http';

/** stripe-node's ApiVersion on 2026-09-23. Since 2025-03-31.basil the billing period lives on each subscription item, not the subscription. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';
const TIMEOUT_MS = 10_000;

export class StripeError extends Error {
  readonly status: number;
  /** Stripe's error `type` / `code` enums, e.g. invalid_request_error / resource_missing. */
  readonly type: string | null;
  readonly code: string | null;
  constructor(status: number, type: string | null, code: string | null) {
    super(`Stripe answered ${status}${type ? ` ${type}` : ''}${code ? ` (${code})` : ''}`);
    this.name = 'StripeError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

/** `path` starts after /v1, e.g. '/subscriptions/sub_123'. Params go in the query for GET/DELETE and the form body for POST. */
export async function stripe<T = Record<string, unknown>>(
  deps: { config: Config; fetch: typeof fetch },
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<T> {
  const key = deps.config.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, 'unconfigured', 'Billing is not configured on this server.');
  const form = formEncode(params);
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'stripe-version': STRIPE_API_VERSION };
  if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const url = `https://api.stripe.com/v1${path}${method !== 'POST' && form ? `?${form}` : ''}`;
  // A stalled Stripe must not hold a request (or a pooled connection inside sql.begin) for undici's 300 s default.
  const res = await deps.fetch(url, { method, headers, body: method === 'POST' ? form : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as { error?: { type?: unknown; code?: unknown } } | null;
  if (!res.ok) {
    const e = body?.error;
    throw new StripeError(res.status, typeof e?.type === 'string' ? e.type : null, typeof e?.code === 'string' ? e.code : null);
  }
  return body as T;
}

/** Stripe's bracket form encoding: { a: { b: [1] } } -> a[b][0]=1. null sends an empty value (Stripe's "unset"); undefined is skipped. */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    } else out.push(`${encodeURIComponent(key)}=${value === null ? '' : encodeURIComponent(String(value))}`);
  };
  walk(params, '');
  return out.join('&');
}
