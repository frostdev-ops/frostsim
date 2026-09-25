// Battle.net game-data proxy. Holds the credential and answers /api/*; static bytes are served by the web server, not this process.
// NO SIMULATION HERE: no engine, no wasm, and no route that could start one.
// Credentials come from the process environment, never from argv, logs or the webroot. Startup prints NAMES ONLY.
// Binds to loopback; the fronting web server is the only caller.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { characterIndex, onRequest } from '../functions/api/[[path]].ts';

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

// The shared character search index survives restarts as one JSON file (the unit's StateDirectory). Unset: memory only.
const INDEX_PATH = process.env.CHARACTER_INDEX_PATH;
if (INDEX_PATH) {
  try {
    characterIndex.load(JSON.parse(readFileSync(INDEX_PATH, 'utf8')));
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error(`api: character index not loaded (${err?.name ?? 'Error'})`);
  }
}

/** Writes the index when it changed: temp file, then rename, so a crash mid-write keeps the last good file. */
function saveIndex() {
  if (!INDEX_PATH || !characterIndex.dirty) return;
  try {
    writeFileSync(`${INDEX_PATH}.tmp`, JSON.stringify(characterIndex));
    renameSync(`${INDEX_PATH}.tmp`, INDEX_PATH);
    characterIndex.dirty = false;
  } catch (err) {
    console.error(`api: character index not saved (${err?.code ?? err?.name ?? 'Error'})`);
  }
}
setInterval(saveIndex, 5 * 60_000).unref();

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
  console.log(`  character index: ${INDEX_PATH ? `${characterIndex.size} entries, saved to ${INDEX_PATH}` : 'memory only'}`);
  console.log(`  credentials present: ${present.join(', ') || '(none)'} — names only, values never printed`);
  if (missing.length) {
    console.log(`  WARNING: ${missing.join(' and ')} missing — /api/wow/health will report unconfigured`);
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    saveIndex();
    server.close(() => process.exit(0));
    // Don't let hung upstream keep unit alive through restart.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
