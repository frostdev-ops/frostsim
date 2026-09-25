// HTTP plumbing for the account server (CLAUDE.md D15, DESIGN.md C2): the api-server adapter idea, fixed to read bodies under a cap,
// keep every Set-Cookie and stream responses. Plus the JSON error shape every route answers with.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { Log } from './config';

/** Thrown anywhere under a handler; the app turns it into `{ error: code, message }` with this status. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra response headers, e.g. Retry-After on a 429. */
  readonly headers: HeadersInit;
  constructor(status: number, code: string, message: string, headers: HeadersInit = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers(headers);
  merged.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: merged });
}

/** The one error shape. `message` is ours, never an upstream body (those can carry tokens). */
export function error(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
  return json({ error: code, message }, status, headers);
}

/** Error name and message for a log line, with URLs of any scheme cut out: a presigned URL or a postgres:// / redis:// URL with its
 *  password must never reach the journal. */
export function errorSummary(err: unknown): string {
  const name = (err as Error)?.name ?? 'Error';
  const message = String((err as Error)?.message ?? err).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 300);
  return `${name}: ${message}`;
}

export const DEFAULT_MAX_BODY = 64 * 1024;

/** Whole body, refusing past `max` bytes with 413. The remainder is left unread; node drains it after the response. */
export async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const tooLarge = () => new HttpError(413, 'too-large', `The request body is larger than ${max} bytes.`);
  if (Number(request.headers.get('content-length')) > max) throw tooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) throw tooLarge();
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `__Host-` cookies need Secure, Path=/ and no Domain; every cookie here gets the same flags. Max-Age 0 clears. */
export function setCookie(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeS}`;
}

export function bearer(request: Request): string | null {
  return /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
}

/** The address per-IP limits key on: CF-Connecting-IP, else the first X-Forwarded-For hop, else the socket, whichever first IS an
 *  IP address (any other string would let one client mint unlimited Redis keys). IPv6 is cut to its /64, which one subscriber
 *  usually holds whole. Spoofable while the origin is reachable directly: only unauthenticated limits key on it. */
export function clientIp(headers: Headers, remote: string): string {
  for (const candidate of [headers.get('cf-connecting-ip'), headers.get('x-forwarded-for')?.split(',')[0], remote]) {
    const ip = candidate?.trim() ?? '';
    const version = isIP(ip);
    if (version === 4) return ip;
    if (version === 6) return ipv6Prefix(ip);
  }
  return 'unknown';
}

function ipv6Prefix(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // A dotted IPv4 tail fills two groups.
  const width = right.reduce((n, group) => n + (group.includes('.') ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - width).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

/** node:http -> fetch Request. The origin is PUBLIC_ORIGIN, never the Host header; a body is attached only when the request declares
 *  one. `signal` becomes request.signal. Throws for methods fetch refuses (TRACE, CONNECT). */
export function toRequest(req: IncomingMessage, origin: string, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  // fetch forbids a GET/HEAD body that node accepts: ignore it (node discards it after the response) instead of failing with a 500.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    && (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0);
  // String concatenation, not new URL(path, origin): a `//host/x` path would otherwise switch hosts.
  const url = origin + (req.url?.startsWith('/') ? req.url : '/');
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal };
  if (hasBody) {
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Streams the response; every Set-Cookie survives (a plain header copy keeps only the last). */
export async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(response.status);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res);
}

const FALLBACK_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function nodeHandler(origin: string, handle: (request: Request, remote: string) => Promise<Response>, log: Log) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    // Aborts request.signal when the client hangs up first, so a handler (a worker long poll) stops instead of working for nobody.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    let request: Request;
    try {
      request = toRequest(req, origin, gone.signal);
    } catch {
      // A method fetch refuses. Anyone can send one, so no log line.
      res.writeHead(400, FALLBACK_HEADERS);
      res.end(JSON.stringify({ error: 'invalid', message: 'Request refused.' }));
      return;
    }
    void (async () => {
      try {
        await writeResponse(res, await handle(request, req.socket.remoteAddress ?? ''));
      } catch (err) {
        // The client left: nobody to answer, and not worth a log line.
        if (gone.signal.aborted) return;
        log(`account: response failed (${errorSummary(err)})`);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, FALLBACK_HEADERS);
        res.end(JSON.stringify({ error: 'internal', message: 'Request failed.' }));
      }
    })();
  };
}
