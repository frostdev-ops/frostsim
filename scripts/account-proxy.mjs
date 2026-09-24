// Local-harness pass-through of /api/v1/* to the account server (CLAUDE.md D15), like nginx's `location ^~ /api/v1/`.
// Used by vite.config.ts (dev) and scripts/serve-pages.mjs; the Battle.net /api handler never sees these paths.

import { request as httpRequest } from 'node:http';

export const ACCOUNT_API_URL = process.env.ACCOUNT_API_URL || 'http://127.0.0.1:3012';

/** nginx matches `^~ /api/v1/`; a bare `/api/v1` still falls to the Battle.net handler there, so here too. */
export function isAccountApi(url) {
  return typeof url === 'string' && url.startsWith('/api/v1/');
}

/** Streams one request to the account server; 503 JSON when nothing listens there. */
export function proxyAccountApi(req, res, extraHeaders = {}, target = ACCOUNT_API_URL) {
  // Lower-cased so an upstream header replaces a harness one instead of being sent twice.
  const base = Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  // Concatenate, not new URL(path, target): a `//host/x` path must not switch hosts.
  const upstream = httpRequest(target + req.url, { method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, { ...base, ...up.headers });
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(503, { ...base, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'unconfigured', message: `No account server at ${target}. Start one with npm run account:serve.` }));
  });
  req.pipe(upstream);
}
