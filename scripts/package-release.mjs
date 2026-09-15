#!/usr/bin/env node
// Assemble release locally, write immutable record (P14.6,P14.12,P14.16); no publish/upload/credential/network; produces inspect/hash-able directory.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, statSync, readdirSync,
} from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const wantSource = argv.includes('--source-archive');
const skipChecks = argv.includes('--skip-checks');

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const lock = JSON.parse(readFileSync(join(root, 'engine.lock.json'), 'utf8'));

// --- application identity ---
// Repo may have no commits (authorization needed), so no SHA; say so, don't invent version.
const headSha = sh('git', ['rev-parse', 'HEAD']).status === 0
  ? sh('git', ['rev-parse', 'HEAD']).stdout.trim()
  : null;
const dirty = sh('git', ['status', '--porcelain']).stdout.trim().length > 0;

// Identify source state without commit: hash file list + content hashes; reproducible, distinguishes working trees.
const trackedFiles = sh('git', ['ls-files', '--cached', '--others', '--exclude-standard'])
  .stdout.split('\n').filter(Boolean).sort();
const treeHash = createHash('sha256');
for (const f of trackedFiles) {
  const p = join(root, f);
  if (existsSync(p) && statSync(p).isFile()) treeHash.update(`${f}\0${sha256(p)}\0`);
}
const appTreeHash = treeHash.digest('hex');
const releaseId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${appTreeHash.slice(0, 8)}`;
const out = join(root, 'release', releaseId);

// --- checks ---
const runCheck = (name, cmd, args) => {
  if (skipChecks) return { name, status: 'not run', command: `${cmd} ${args.join(' ')}` };
  const r = sh(cmd, args);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');
  return {
    name,
    status: r.status === 0 ? 'passed' : 'FAILED',
    command: `${cmd} ${args.join(' ')}`,
    output,
  };
};

console.log(skipChecks ? 'release: skipping checks (recorded as not run)' : 'release: running checks...');
const checks = [
  runCheck('unit', 'npm', ['test']),
  runCheck('types', 'npm', ['run', 'check']),
  runCheck('build', 'npm', ['run', 'build']),
];
for (const c of checks) console.log(`  ${c.name}: ${c.status}`);

// --- artifacts ---
mkdirSync(out, { recursive: true });

const hashTree = (dir) => {
  const files = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else files[relative(dir, p)] = { bytes: statSync(p).size, sha256: sha256(p) };
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
};

// Pages: 25 MiB limit; engine ~60 MB packaged under engine/ from asset host (P14.1,P14.2); worker shim+manifest in app (emscripten derives paths, D10).
const ENGINE_BINARY = /^engine\/(fallback\/)?simc\.(js|wasm)$/;
const PAGES_ASSET_LIMIT = 25 * 1024 * 1024;

const dist = join(root, 'dist');
let app = { status: 'missing', note: 'no dist/ — run npm run build' };
if (existsSync(dist)) {
  cpSync(dist, join(out, 'app'), {
    recursive: true,
    filter: (src) => !ENGINE_BINARY.test(relative(dist, src).split('\\').join('/')),
  });
  const files = hashTree(join(out, 'app'));
  const oversized = Object.entries(files)
    .filter(([, f]) => f.bytes > PAGES_ASSET_LIMIT)
    .map(([name, f]) => ({ name, bytes: f.bytes }));
  app = {
    status: 'packaged',
    note: 'engine binaries excluded — they exceed the 25 MiB per-asset limit and are packaged under engine/',
    oversizedForPages: oversized,
    files,
  };
  console.log(`release: packaged ${Object.keys(files).length} application files (engine binaries excluded)`);
  if (oversized.length) {
    console.log(`release: ${oversized.length} app asset(s) over the 25 MiB Pages limit:`);
    for (const f of oversized) console.log(`  ${f.name}  ${(f.bytes / 1024 / 1024).toFixed(1)} MB`);
  }
}

const engines = {};
for (const [variant, dir] of [['threaded', 'public/engine'], ['fallback', 'public/engine/fallback']]) {
  const manifestPath = join(root, dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    engines[variant] = { status: 'missing', note: `no manifest at ${dir}` };
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const missing = Object.keys(manifest.files).filter((f) => !existsSync(join(root, dir, f)));
  // Binaries gitignored; release assembles on machines with manifest but no artifact; record identity, copy what exists.
  if (missing.length === 0) {
    mkdirSync(join(out, 'engine', variant), { recursive: true });
    for (const f of Object.keys(manifest.files)) {
      cpSync(join(root, dir, f), join(out, 'engine', variant, f));
    }
    cpSync(manifestPath, join(out, 'engine', variant, 'manifest.json'));
    // Rehash from copy: record proves these bytes are these bytes.
    const verified = Object.fromEntries(Object.keys(manifest.files).map((f) => {
      const actual = sha256(join(out, 'engine', variant, f));
      return [f, { ...manifest.files[f], verifiedSha256: actual, matches: actual === manifest.files[f].sha256 }];
    }));
    engines[variant] = { status: 'packaged', manifest, files: verified };
  } else {
    engines[variant] = { status: 'manifest only', manifest, missingFiles: missing };
  }
  console.log(`release: engine ${variant}: ${engines[variant].status}`);
}

// --- catalogs (owned by catalog track; packaged if present) ---
const catalogDir = join(root, 'public/catalogs');
const catalogs = existsSync(catalogDir)
  ? (() => {
      cpSync(catalogDir, join(out, 'app/catalogs'), { recursive: true });
      return { status: 'packaged', files: hashTree(join(out, 'app/catalogs')) };
    })()
  : { status: 'absent', note: 'no public/catalogs/ yet' };

// --- what the app talks to (P14.11) ---
// No profile/talent/item/APL/report leaves device; shipped bundle has no external origin (same-origin/relative only); list inert origins explicitly.
const INERT_ORIGINS = {
  'http://www.w3.org': { reason: 'XML/SVG namespace URIs — identifiers, never requested', allowIn: /.*/ },
  'https://www.w3.org': { reason: 'XML/SVG namespace URIs — identifiers, never requested', allowIn: /.*/ },
  'https://svelte.dev': { reason: 'framework error-message links in the Svelte runtime', allowIn: /\.js$/ },
  // Provenance only/where it belongs; github.com in script/catalog = real dependency, not label.
  'https://github.com': {
    reason: 'upstream source provenance in the engine manifest — a label, not a fetch target',
    allowIn: /(^|\/)manifest\.json$/,
  },
};

const scanOrigins = (() => {
  const found = new Map();
  const textFile = /\.(js|mjs|css|html|json|map)$/;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!textFile.test(entry.name)) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)\\]+/g)) {
        let origin;
        try { origin = new URL(m[0]).origin; } catch { continue; }
        // localhost is dev tooling artifact, not shipped destination.
        if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)) continue;
        const where = found.get(origin) ?? new Set();
        where.add(relative(out, p));
        found.set(origin, where);
      }
    }
  };
  walk(join(out, 'app'));
  return [...found].map(([origin, files]) => [origin, [...files]]);
})();

const isInert = ([origin, files]) => {
  const rule = INERT_ORIGINS[origin];
  return rule ? files.every((f) => rule.allowIn.test(f)) : false;
};
const externalOrigins = {
  unexpected: Object.fromEntries(scanOrigins.filter((e) => !isInert(e))),
  inert: Object.fromEntries(scanOrigins.filter(isInert)
    .map(([o, files]) => [o, { reason: INERT_ORIGINS[o].reason, files }])),
  enforcement: "CSP connect-src 'self' in public/_headers is what actually prevents a request; this scan only shows what is written in the bundle",
};
const unexpectedCount = Object.keys(externalOrigins.unexpected).length;
if (unexpectedCount) {
  console.log(`release: ${unexpectedCount} UNEXPECTED external origin(s) in the bundle:`);
  for (const [origin, files] of Object.entries(externalOrigins.unexpected)) console.log(`  ${origin}  (${files.join(', ')})`);
} else {
  console.log(`release: no unexpected external origin in the bundle (${Object.keys(externalOrigins.inert).length} known-inert)`);
}

// --- credentials (P14.11) ---
// Shipped secret is hard failure not warning; proxy keeps secret in hosting config, tokens server-side; scans packaged assets only.
const SECRET_PATTERNS = [
  [/\bBLIZZARD_CLIENT_SECRET\b\s*[:=]\s*['"`]?[A-Za-z0-9._-]{8,}/i, 'a value assigned to BLIZZARD_CLIENT_SECRET'],
  [/client_secret\s*[:=]\s*['"`][^'"`]{8,}/i, 'a client_secret literal'],
  [/\bBearer\s+[A-Za-z0-9._-]{24,}/, 'a bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bVITE_[A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD)\b/, 'a VITE_ variable named like a secret (those are inlined into the client bundle)'],
];
// Secrets file never packaged; checked by name across tree (copied .env leaks even if pattern-mismatched).
const SECRET_FILENAMES = /^(\.dev\.vars(\..*)?|\.env(\..*)?)$/;
// Exact-value scan: regex describes secret shape, bundler destroys it, value survives; read here, search packaged bytes literally.
const knownSecretValues = (() => {
  const values = [];
  for (const file of ['.dev.vars', '.env', '.env.local', '.dev.vars.local']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      // Short/low-entropy values false-positive; real credentials are long; don't scan "changeme" or "".
      if (value.length < 12) continue;
      values.push({ name, value, source: file });
    }
  }
  return values;
})();

const leakedSecrets = [];
(function scanForSecretFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { scanForSecretFiles(p); continue; }
    if (SECRET_FILENAMES.test(entry.name) && entry.name !== '.env.example') {
      leakedSecrets.push({ file: relative(out, p), found: 'a secrets file was packaged' });
    }
  }
})(out);
(function scanForSecrets(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { scanForSecrets(p); continue; }

    // Exact-value matching on every file as raw bytes (images, binaries); credentials survive minification destroying patterns.
    const bytes = readFileSync(p);
    for (const secret of knownSecretValues) {
      if (bytes.includes(secret.value) || bytes.toString('base64').includes(Buffer.from(secret.value).toString('base64'))) {
        leakedSecrets.push({
          file: relative(out, p),
          found: `the exact value of ${secret.name} (from ${secret.source})`,
        });
      }
    }

    // Shape matching stays for credentials this machine doesn't hold (committed by others or CI-only).
    if (!/\.(js|mjs|cjs|css|html|json|map|txt|md|ts)$/.test(entry.name)) continue;
    const text = bytes.toString('utf8');
    for (const [re, what] of SECRET_PATTERNS) {
      if (re.test(text)) leakedSecrets.push({ file: relative(out, p), found: what });
    }
  }
})(out);
if (leakedSecrets.length) {
  // Filename and classification only; scanner that prints secrets writes them to build logs.
  console.error('release: CREDENTIAL LEAK in packaged assets:');
  for (const l of leakedSecrets) console.error(`  ${l.file}: ${l.found}`);
} else {
  console.log('release: no credential pattern in the packaged application');
}

// --- corresponding source (GPL, P14.12) ---
// simc GPL-3.0-only; shipping compiled engine obliges exact source distribution including patches/scripts.
const sourceCommand = `git -C ${lock.upstream.path} archive --format=tar.gz --prefix=simc-${lock.upstream.commit.slice(0, 12)}/ ${lock.upstream.commit}`;
let source = {
  status: 'not generated',
  obligation: 'GPL-3.0-only: the exact engine source, patches and build scripts must be distributed with any published binary',
  command: sourceCommand,
  upstream: lock.upstream,
};
if (wantSource) {
  mkdirSync(join(out, 'source'), { recursive: true });
  const archive = join(out, 'source', `simc-${lock.upstream.commit.slice(0, 12)}.tar.gz`);
  console.log('release: generating corresponding source archive (this takes a minute)...');
  const r = sh('git', ['-C', lock.upstream.path, 'archive', '--format=tar.gz',
    `--prefix=simc-${lock.upstream.commit.slice(0, 12)}/`, '-o', archive, lock.upstream.commit]);
  if (r.status === 0 && existsSync(archive)) {
    source = {
      status: 'generated',
      file: relative(out, archive),
      bytes: statSync(archive).size,
      sha256: sha256(archive),
      command: sourceCommand,
      upstream: lock.upstream,
    };
    console.log(`  ${(source.bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${source.sha256.slice(0, 12)}`);
  } else {
    source = { ...source, status: 'FAILED', error: (r.stderr ?? '').trim().slice(0, 400) };
  }
}

// Patches, build scripts, server functions travel with source always; patches/scripts are GPL corresponding source; functions/ is proxy part of release.
mkdirSync(join(out, 'source'), { recursive: true });
const SOURCE_TREES = ['patches', 'scripts', 'functions'];
// Never copy secrets file or local build artefact into source tree.
const excludeFromSource = (src) => {
  const name = src.split('/').pop() ?? '';
  return /^(\.dev\.vars(\..*)?|\.env(\..*)?|node_modules|\.DS_Store)$/.test(name) && name !== '.env.example';
};
for (const dir of SOURCE_TREES) {
  if (!existsSync(join(root, dir))) continue;
  cpSync(join(root, dir), join(out, 'source', dir), { recursive: true, filter: (src) => !excludeFromSource(src) });
}
cpSync(join(root, 'engine.lock.json'), join(out, 'source', 'engine.lock.json'));
// Lockfile and manifest make clean install reproducible; source drop without them can't rebuild.
for (const f of ['package.json', 'package-lock.json', '.nvmrc']) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(out, 'source', f));
}
const licenseFile = join(root, lock.upstream.licenseFile ?? '');
const license = existsSync(licenseFile)
  ? (cpSync(licenseFile, join(out, 'source', 'LICENSE-simc')), { status: 'included', sha256: sha256(licenseFile) })
  : { status: 'MISSING', note: `no license file at ${lock.upstream.licenseFile} — the upstream checkout may be absent` };

// --- record ---
const record = {
  schemaVersion: 1,
  releaseId,
  generatedAt: new Date().toISOString(),
  publishing: 'none — this script assembles locally and uploads nothing',
  application: {
    gitCommit: headSha,
    gitDirty: dirty,
    treeHash: appTreeHash,
    note: headSha ? undefined : 'repository has no commits; identity is the working-tree hash',
    ...app,
  },
  engines,
  catalogs,
  externalOrigins,
  leakedSecrets,
  source: { ...source, license, patches: hashTree(join(out, 'source/patches')) },
  toolchain: lock.toolchain,
  checks,
  unverified: [
    'Production headers, CORS, MIME and compression have not been observed from a real host (P14.3-P14.5).',
    'No browser integration or device matrix run is included in this record (P14.15).',
    'Rollback has not been rehearsed (P14.19).',
  ],
};

writeFileSync(join(out, 'release.json'), `${JSON.stringify(record, null, 2)}\n`);

const failed = checks.filter((c) => c.status === 'FAILED');
if (leakedSecrets.length) {
  console.error('  A packaged asset contains a credential pattern — this is not a releasable build.');
}
console.log(`\nrelease: ${relative(root, out)}/release.json`);
console.log(`  application ${record.application.status}, engines ${Object.entries(engines).map(([k, v]) => `${k}=${v.status}`).join(' ')}`);
console.log(`  source ${source.status}, license ${license.status}`);
if (failed.length) {
  console.error(`  CHECKS FAILED: ${failed.map((c) => c.name).join(', ')} — this is not a releasable build`);
}
if (failed.length || leakedSecrets.length) process.exit(1);
