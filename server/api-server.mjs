// Battle.net game-data proxy. Holds the credential and answers /api/*; static bytes are served by the web server, not this process.
// NO SIMULATION HERE: no engine, no wasm, and no route that could start one.
// Credentials come from the process environment, never from argv, logs or the webroot. Startup prints NAMES ONLY.
// Binds to loopback; the fronting web server is the only caller.

import { createServer } from 'node:http';
import { onRequest } from '../functions/api/[[path]].ts';

const PORT = Number(process.env.FROSTSIM_API_PORT || 3011);
const HOST = process.env.FROSTSIM_API_HOST || '127.0.0.1';

/** Variables the handler reads; nothing else forwarded. */
const ENV_KEYS = [
  'BLIZZARD_CLIENT_ID',
  'BLIZZARD_CLIENT_SECRET',
  'BLIZZARD_REGION',
  'BLIZZARD_CACHE_SECONDS',
  'BLIZZARD_ITEM_ID_ALLOWLIST',
];

const env = {};
for (const key of ENV_KEYS) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

/** node:http request -> WHATWG Request; origin is a placeholder, so a spoofed Host header cannot affect URL parsing. */
function toRequest(req) {
  const url = new URL(req.url, 'http://frostsim.invalid');
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return new Request(url, { method: req.method, headers });
}

async function writeResponse(res, response) {
  const headers = {};
  for (const [name, value] of response.headers) headers[name] = value;
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer((req, res) => {
  // GET/HEAD only (handler's rule, answers 405); no body reading (no endpoint takes one).
  (async () => {
    try {
      const response = await onRequest({
        request: toRequest(req),
        env,
        params: {},
        data: {},
      });
      await writeResponse(res, response);
    } catch (err) {
      // Never surface upstream message (may carry URL with token); handler redacts, this is last resort for escaped throw.
      console.error(`api: unhandled error (${err?.name ?? 'Error'})`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: 'Request failed.' }));
    }
  })();
});

server.listen(PORT, HOST, () => {
  const present = ENV_KEYS.filter((k) => env[k] !== undefined);
  const missing = ['BLIZZARD_CLIENT_ID', 'BLIZZARD_CLIENT_SECRET'].filter((k) => env[k] === undefined);
  console.log(`frostsim api on http://${HOST}:${PORT}`);
  console.log(`  credentials present: ${present.join(', ') || '(none)'} — names only, values never printed`);
  if (missing.length) {
    console.log(`  WARNING: ${missing.join(' and ')} missing — /api/wow/health will report unconfigured`);
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Don't let hung upstream keep unit alive through restart.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
