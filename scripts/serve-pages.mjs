#!/usr/bin/env node
// Serves the built app the way a static host does; exercises engine, CSP and cross-origin isolation together.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_API_URL, isAccountApi, proxyAccountApi } from './account-proxy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const port = Number(arg('--port', '4180'));
const distDir = resolve(root, arg('--dist', 'dist'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// _headers format: path rules then indented headers; later rules override.
function parseHeaders(file) {
  if (!existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw) && raw.trim().startsWith('/')) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (current && colon > 0) {
      current.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }
  return rules;
}

const headerRules = parseHeaders(join(distDir, '_headers'));

function matches(pattern, pathname) {
  // /* matches any suffix including nested paths like Pages does.
  const rx = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return rx.test(pathname);
}

function headersFor(pathname) {
  const out = new Map();
  for (const rule of headerRules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) out.set(name, value);
  }
  return out;
}

// Env values read into process, handed to handler, never logged; startup shows names only.
function readDevVars() {
  const out = {};
  for (const file of ['.dev.vars', '.env']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

const env = { ...process.env, ...readDevVars() };

// --- functions -------------------------------------------------------------------------------
let handler = null;
async function loadHandler() {
  if (handler) return handler;
  const src = join(root, 'functions/api/[[path]].ts');
  if (!existsSync(src)) return null;
  // Esbuild (already Vite dependency) erases types; no other transformation.
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [src], bundle: true, format: 'esm', platform: 'neutral',
    target: 'es2022', write: false, logLevel: 'silent',
  });
  const url = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`;
  const mod = await import(url);
  handler = mod.onRequest ?? mod.default;
  return handler;
}

// Server implementation.
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  const send = (status, body, extra = {}) => {
    const applied = headersFor(pathname);
    for (const [k, v] of Object.entries(extra)) applied.set(k, v);
    res.writeHead(status, Object.fromEntries(applied));
    res.end(body);
  };

  // Account server first, like nginx's `^~ /api/v1/`; everything else under /api/ is the Battle.net handler as before.
  if (isAccountApi(req.url)) return proxyAccountApi(req, res, Object.fromEntries(headersFor(pathname)));

  if (pathname.startsWith('/api/')) {
    const fn = await loadHandler();
    if (!fn) return send(503, 'No functions/api handler');
    try {
      const request = new Request(url.toString(), {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      });
      const response = await fn({
        request, env, params: { path: pathname.slice('/api/'.length).split('/') },
        data: {}, waitUntil: () => {}, next: async () => new Response('', { status: 404 }),
      });
      const applied = headersFor(pathname);
      response.headers.forEach((v, k) => applied.set(k, v));
      res.writeHead(response.status, Object.fromEntries(applied));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      // Handler errors reported, not left hanging.
      send(500, `handler threw: ${err.message}`);
    }
    return;
  }

  // Static with SPA fallback to index.html for unknown paths.
  const unsafe = normalize(join(distDir, pathname));
  if (!unsafe.startsWith(distDir)) return send(403, 'forbidden');
  let file = unsafe;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const index = join(file, 'index.html');
    file = existsSync(index) ? index : join(distDir, 'index.html');
  }
  if (!existsSync(file)) return send(404, 'not found');

  const body = readFileSync(file);
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : body.length - 1;
    return send(206, body.subarray(start, end + 1), {
      'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${body.length}`,
    });
  }
  send(200, body, { 'Content-Type': type });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`pages-like server on http://localhost:${port}  (dist: ${distDir.replace(root + '/', '')})`);
  console.log(`  header rules: ${headerRules.map((r) => r.pattern).join(', ') || '(none — is _headers in dist?)'}`);
  console.log(`  api handler:  ${existsSync(join(root, 'functions/api/[[path]].ts')) ? 'functions/api/[[path]].ts' : '(absent)'}`);
  console.log(`  /api/v1/*:    proxied to ${ACCOUNT_API_URL}`);
  const names = Object.keys(readDevVars());
  console.log(`  env from .dev.vars: ${names.length ? names.join(', ') : '(none)'} — names only, values never printed`);
  console.log('  NOT workerd: Node fetch primitives, no bindings. wrangler pages dev remains the pre-release check.');
});

