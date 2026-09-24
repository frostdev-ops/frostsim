// Signed tokens (CLAUDE.md D15, DESIGN.md C7): round trip, tamper, wrong secret or purpose, expiry.

import { describe, expect, it } from 'vitest';
import { safeEqual, sha256Hex, sign, verify } from './signed';

const SECRET = 'k'.repeat(32);
const NOW = 1_700_000_000_000;

describe('sign / verify', () => {
  it('round-trips the payload with an exp in seconds', () => {
    const token = sign(SECRET, 'oauth', { state: 's1', returnTo: '#/' }, 600, NOW);
    expect(verify(SECRET, 'oauth', token, NOW + 599_000)).toEqual({ state: 's1', returnTo: '#/', exp: NOW / 1000 + 600 });
  });

  it('refuses expiry, tampering, another secret and another purpose', () => {
    const token = sign(SECRET, 'oauth', { state: 's1' }, 600, NOW);
    expect(verify(SECRET, 'oauth', token, NOW + 600_000)).toBeNull();
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ state: 's2', exp: NOW / 1000 + 600 })).toString('base64url');
    expect(verify(SECRET, 'oauth', `${forged}.${mac}`, NOW)).toBeNull();
    expect(verify(SECRET, 'oauth', `${body}.${mac.slice(1)}`, NOW)).toBeNull();
    expect(verify('x'.repeat(32), 'oauth', token, NOW)).toBeNull();
    expect(verify(SECRET, 'guild-checkout', token, NOW)).toBeNull();
    expect(verify(SECRET, 'oauth', 'garbage', NOW)).toBeNull();
  });
});

describe('helpers', () => {
  it('compares in constant time and hashes to hex', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
