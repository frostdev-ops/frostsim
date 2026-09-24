// R2 and Stripe clients (CLAUDE.md D14, D15; DESIGN.md C3, C4): signed requests through the injected fetch, presigns,
// the pinned Stripe version, form encoding, and errors that never carry an upstream body.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { HttpError } from './http';
import { createR2 } from './r2';
import { STRIPE_API_VERSION, StripeError, formEncode, stripe } from './stripe';

const r2Env = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKID', R2_SECRET_ACCESS_KEY: 'secret' };
const r2Config = loadConfig(r2Env);

describe('r2', () => {
  it('signs every call to the account endpoint with the bucket per call', async () => {
    const seen: Request[] = [];
    const fetchFn = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response(req.method === 'GET' ? 'blob' : null, { status: 200, headers: { 'x-amz-meta-sha256': 'abc' } });
    }) as unknown as typeof fetch;
    const r2 = createR2(r2Config, fetchFn);
    await r2.put('frostsim-data', 'shares/abc.json.gz', new Uint8Array([1, 2]), { 'content-type': 'application/gzip' });
    expect(await (await r2.get('frostsim-data', 'shares/abc.json.gz'))?.text()).toBe('blob');
    expect((await r2.head('frostsim-engines', 'engines/p/simc-linux-x64.zst'))?.get('x-amz-meta-sha256')).toBe('abc');
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      'PUT https://acct.r2.cloudflarestorage.com/frostsim-data/shares/abc.json.gz',
      'GET https://acct.r2.cloudflarestorage.com/frostsim-data/shares/abc.json.gz',
      'HEAD https://acct.r2.cloudflarestorage.com/frostsim-engines/engines/p/simc-linux-x64.zst',
    ]);
    expect(seen[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it('uses R2_ENDPOINT, path-style, for signed calls and presigns alike', async () => {
    const seen: Request[] = [];
    const fetchFn = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const r2 = createR2(loadConfig({ ...r2Env, R2_ENDPOINT: 'http://127.0.0.1:59000/' }), fetchFn);
    await r2.head('frostsim-engines', 'engines/p/simc-linux-x64.zst');
    expect(seen[0].url).toBe('http://127.0.0.1:59000/frostsim-engines/engines/p/simc-linux-x64.zst');
    const url = new URL(await r2.presign('frostsim-data', 'results/j1.json.gz', 'PUT', 900));
    expect(`${url.origin}${url.pathname}`).toBe('http://127.0.0.1:59000/frostsim-data/results/j1.json.gz');
    const eu = createR2(loadConfig({ ...r2Env, R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com' }), fetchFn);
    expect(await eu.presign('frostsim-data', 'k', 'GET', 60)).toMatch(/^https:\/\/acct\.eu\.r2\.cloudflarestorage\.com\/frostsim-data\/k\?/);
  });

  it('answers null for a missing object and throws a status-only error otherwise', async () => {
    const status = (code: number) => (async () => new Response('<Error>secret detail</Error>', { status: code })) as unknown as typeof fetch;
    expect(await createR2(r2Config, status(404)).get('frostsim-data', 'k')).toBeNull();
    expect(await createR2(r2Config, status(404)).head('frostsim-data', 'k')).toBeNull();
    await expect(createR2(r2Config, status(403)).put('frostsim-data', 'k', 'x')).rejects.toThrow(/^R2 PUT failed with status 403$/);
  });

  it('refuses keys that would leave their prefix or bucket, and unknown buckets, before signing', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const r2 = createR2(r2Config, fetchFn);
    for (const key of ['shares/../results/j.json.gz', 'engines/../../frostsim-data/x', 'a/./b', 'a//b', '/a', 'a/', '..']) {
      await expect(r2.get('frostsim-data', key)).rejects.toMatchObject({ status: 400, code: 'invalid' });
      await expect(r2.presign('frostsim-engines', key, 'GET', 900)).rejects.toMatchObject({ status: 400, code: 'invalid' });
    }
    await expect(r2.head('other-bucket', 'k')).rejects.toMatchObject({ status: 400 });
    await expect(r2.delete('..', 'k')).rejects.toMatchObject({ status: 400 });
    expect(fetchFn).not.toHaveBeenCalled();
    // Dots inside a segment are ordinary key characters.
    expect(await r2.presign('frostsim-data', 'shares/a..b.json.gz', 'GET', 900)).toContain('/frostsim-data/shares/a..b.json.gz?');
  });

  it('gives up on an R2 that does not answer within 30 s', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let called = () => {};
    const sent = new Promise<void>((resolve) => (called = resolve));
    const fetchFn = ((req: Request) => new Promise((_, reject) => {
      signal = req.signal;
      req.signal.addEventListener('abort', () => reject(req.signal.reason));
      called();
    })) as unknown as typeof fetch;
    const pending = createR2(r2Config, fetchFn).head('frostsim-engines', 'engines/p/simc-linux-x64.zst');
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await sent;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it('presigns for the given lifetime, without calling fetch', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const url = new URL(await createR2(r2Config, fetchFn).presign('frostsim-data', 'results/j1.json.gz', 'PUT', 900));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('503s every call when credentials are missing', async () => {
    const r2 = createR2(loadConfig({}), vi.fn() as unknown as typeof fetch);
    await expect(r2.get('b', 'k')).rejects.toBeInstanceOf(HttpError);
    await expect(r2.presign('b', 'k', 'GET', 900)).rejects.toMatchObject({ status: 503, code: 'unconfigured' });
  });
});

describe('stripe', () => {
  const deps = (fetchFn: typeof fetch) => ({ config: loadConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }), fetch: fetchFn });

  it('bracket-encodes nested params', () => {
    expect(formEncode({ mode: 'subscription', line_items: [{ price: 'p_1', quantity: 2 }], metadata: { guild_id: 'g 1' }, skip: undefined, clear: null }))
      .toBe('mode=subscription&line_items%5B0%5D%5Bprice%5D=p_1&line_items%5B0%5D%5Bquantity%5D=2&metadata%5Bguild_id%5D=g%201&clear=');
  });

  it('pins the API version and posts a form with an idempotency key', async () => {
    const fetchFn = vi.fn(async () => Response.json({ id: 'cs_1' })) as unknown as typeof fetch;
    expect(await stripe(deps(fetchFn), 'POST', '/checkout/sessions', { mode: 'subscription' }, 'idem-1')).toEqual({ id: 'cs_1' });
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.body).toBe('mode=subscription');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer sk_test_x', 'stripe-version': STRIPE_API_VERSION,
      'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'idem-1',
    });
    // Bounded: a stalled Stripe must not hold the request for undici's 300 s default.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('puts GET params in the query', async () => {
    const fetchFn = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    await stripe(deps(fetchFn), 'GET', '/subscriptions/sub_1', { expand: ['items.data.price'] });
    expect((fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).toBe('https://api.stripe.com/v1/subscriptions/sub_1?expand%5B0%5D=items.data.price');
  });

  it('throws type and code only, never the message Stripe sent', async () => {
    const fetchFn = (async () => Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer: cus_secret' } }, { status: 404 })) as unknown as typeof fetch;
    const err = await stripe(deps(fetchFn), 'GET', '/customers/cus_secret').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err).toMatchObject({ status: 404, type: 'invalid_request_error', code: 'resource_missing' });
    expect(String((err as Error).message)).not.toContain('cus_secret');
  });

  it('503s without a secret key', async () => {
    await expect(stripe({ config: loadConfig({}), fetch }, 'GET', '/x')).rejects.toMatchObject({ status: 503, code: 'unconfigured' });
  });
});
