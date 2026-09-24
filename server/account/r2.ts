// Cloudflare R2 over its S3 API, signed with aws4fetch (CLAUDE.md D14, D15; DESIGN.md C4). Never exposed to the browser: content is
// proxied through our origin; compute workers get presigned URLs whose lifetime the caller sets (worker-routes PRESIGN_S). The bucket is chosen per call.

import { AwsClient } from 'aws4fetch';
import type { Config } from './config';
import { HttpError } from './http';

export interface R2 {
  put(bucket: string, key: string, body: BodyInit, headers?: HeadersInit): Promise<void>;
  /** The object as a streaming Response, or null when it does not exist. Copy what you need; do not forward R2's headers. */
  get(bucket: string, key: string): Promise<Response | null>;
  /** Object headers (content-length, x-amz-meta-*), or null when it does not exist. */
  head(bucket: string, key: string): Promise<Headers | null>;
  delete(bucket: string, key: string): Promise<void>;
  presign(bucket: string, key: string, method: 'GET' | 'PUT', expiresS: number): Promise<string>;
}

/** Longest wait for R2's answer (a PUT's upload included). The body of a GET may stream for longer, to a slow client. */
const ANSWER_TIMEOUT_MS = 30_000;

/** Without the three R2 credentials every call throws 503 unconfigured, so the process still starts. Only the two configured buckets
 *  are reachable, and a key with an empty, `.` or `..` segment is refused with 400. */
export function createR2(config: Config, fetchFn: typeof fetch): R2 {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = config.env;
  const buckets = new Set([config.env.R2_ENGINES_BUCKET, config.env.R2_DATA_BUCKET]);
  // R2_ENDPOINT: a jurisdiction endpoint (<account>.eu.r2.cloudflarestorage.com) or an S3-compatible local store. Path-style either way.
  const endpoint = (config.env.R2_ENDPOINT ?? `https://${account}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  // retries 0: aws4fetch's own retry loop would bypass the injected fetch; we sign and send ourselves.
  const aws = account && accessKeyId && secretAccessKey
    ? new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 })
    : null;

  function client(): AwsClient {
    if (!aws) throw new HttpError(503, 'unconfigured', 'Storage is not configured on this server.');
    return aws;
  }
  const url = (bucket: string, key: string) => {
    const segments = key.split('/');
    // encodeURIComponent keeps `.` and `..`, and URL parsing then climbs out of the key's prefix or the bucket.
    if (!buckets.has(bucket) || segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new HttpError(400, 'invalid', 'Invalid storage key.');
    }
    return `${endpoint}/${encodeURIComponent(bucket)}/${segments.map(encodeURIComponent).join('/')}`;
  };
  const send = async (method: string, bucket: string, key: string, init: RequestInit = {}) => {
    const aws = client();
    const answer = new AbortController();
    const timer = setTimeout(() => answer.abort(), ANSWER_TIMEOUT_MS);
    try {
      return await fetchFn(await aws.sign(url(bucket, key), { ...init, method, signal: answer.signal }));
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async put(bucket, key, body, headers) {
      const res = await send('PUT', bucket, key, { body, headers });
      await expectOk(res, 'PUT');
      await res.body?.cancel();
    },
    async get(bucket, key) {
      const res = await send('GET', bucket, key);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      await expectOk(res, 'GET');
      return res;
    },
    async head(bucket, key) {
      const res = await send('HEAD', bucket, key);
      if (res.status === 404) return null;
      await expectOk(res, 'HEAD');
      return res.headers;
    },
    async delete(bucket, key) {
      const res = await send('DELETE', bucket, key);
      if (res.status !== 404) await expectOk(res, 'DELETE');
      await res.body?.cancel();
    },
    async presign(bucket, key, method, expiresS) {
      const aws = client();
      const target = new URL(url(bucket, key));
      target.searchParams.set('X-Amz-Expires', String(expiresS));
      return (await aws.sign(target.toString(), { method, aws: { signQuery: true } })).url;
    },
  };
}

/** Status only: R2 error bodies echo request details and are never read. */
async function expectOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  await res.body?.cancel();
  throw new Error(`R2 ${what} failed with status ${res.status}`);
}
