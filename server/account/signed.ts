// HMAC-SHA256 signed, expiring tokens (CLAUDE.md D15, DESIGN.md C7): the OAuth state cookie and guild checkout links.
// A purpose string is bound into the MAC so a token minted for one use can never be replayed as another.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** `<base64url JSON>.<base64url MAC>`; the payload gains `exp` (epoch seconds). Readable by anyone holding it, so never put a secret in it. */
export function sign(secret: string, purpose: string, payload: object, ttlS: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlS })).toString('base64url');
  return `${body}.${mac(secret, purpose, body)}`;
}

/** The payload, or null when the MAC, the purpose or the expiry does not hold. */
export function verify<T extends object>(secret: string, purpose: string, token: string, now = Date.now()): (T & { exp: number }) | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(secret, purpose, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' && payload.exp * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

function mac(secret: string, purpose: string, body: string): string {
  return createHmac('sha256', secret).update(`${purpose}\n${body}`).digest('base64url');
}

/** Constant-time string comparison; unequal lengths fail without comparing. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
