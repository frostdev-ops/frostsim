// Surface guard for the opt-in accounts and cloud compute work (CLAUDE.md D14, D15; PLAN P15): what existed stays as it was.
// node scripts/check-surface.mjs [--dist <flag-off build>] [--base <merge-base build>] [--allow-entry-growth]. Exits 1 on any violation.
// --allow-entry-growth reports entry growth past the limit as a note: for a deliberate change to the core app, which CI passes
// only on a pull request labelled entry-growth-ok. Every other check still fails.
// Build both trees the same way, without the gitignored public/legal/ (it sets VITE_SITE_LEGAL and adds ~0.8 KB to the entry set).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// sha256 at e384736; functions/api, api-server.mjs and the api unit since the Armory lookup and character search. deploy/ is excluded from git (.git/info/exclude), so `git diff` cannot guard it and a hash must.
// A deliberate change to one of these files updates its hash here in the same change.
export const BASELINE = {
  'server/api-server.mjs': '3e35efb0ebe292fc18e327626c1df2c95c5f72c5026ea9651d24d0073d7e7c43',
  'functions/api/[[path]].ts': '4b4c4f6d944b77bb45e79420bcc6f8d833bde72bd5b6ab326e750f2f2d944504',
  'functions/api/_lib/battlenet.test.ts': '4420ceaff4c7011c0d47dfae2463bb727087676b447b2d6bf805025e31e0ec02',
  'functions/api/_lib/character-index.test.ts': 'f2f419e82b91701a3155da621d2b54537f9a1d9c9eef147af745b459af482980',
  'functions/api/_lib/character-index.ts': '73d10b58a3c5120f6abc9752ecbb13dd9717c19971bfa6e5595dee94980dcde3',
  'functions/api/_lib/security.ts': '9c8960a2b4284a09c577decf7fad6607a2ec5907ef95e3f50e6ce84e6da17f18',
  'functions/api/_lib/upstream.ts': '030338512cdc5cbe04fa1623a0eebc946b1d01ea7de1b1217f61ae2078d4e96f',
  'deploy/systemd/frostsim-api.service': 'cc8e21197aefe829be407090611f0916e64c9edafaa7ff0f4f8b8ed53802eb01',
  'public/sw.js': '64bee8ed0583d0031d1ad148372ccdeea61aa416dd6b2c4c7610427546578acd',
  // Hashed with the account-server block stripped: that block is the only change the vhost may gain.
  'deploy/nginx/sim.frostdev.io.conf': 'e71dd1f842602bf5bf22475d2ddf948bb588dea5d6fe2a8af491a20edfb6d1ab',
};
const GUARDED_DIR = 'functions/api';
const VHOST = 'deploy/nginx/sim.frostdev.io.conf';
/** PLAN P15: flag off, the entry set may grow by at most 0.5 KB of gzip -9. Shrinking is always fine. */
export const ENTRY_GROWTH_LIMIT = 512;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const filesUnder = (dir) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()) : [];

const ACCOUNT_BLOCK = /^ *# BEGIN account-server[^\n]*\n([\s\S]*?)^ *# END account-server[^\n]*\n\n/m;

/** Removes the one `# BEGIN account-server` ... `# END account-server` block and the blank line after it. */
export function stripAccountBlock(text) {
  return text.replace(ACCOUNT_BLOCK, '');
}

/** The block must be one top-level `location ^~ /api/v1/ { ... }`: nginx searches nested locations only inside it, so
 *  nothing in the block can reach another path. True when there is no block. */
export function accountBlockConfined(text) {
  const block = text.match(ACCOUNT_BLOCK)?.[1];
  if (block === undefined) return true;
  // Braces inside quotes or comments are not nginx syntax. A quoted string is consumed first, so a # inside one stays.
  const code = block.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g, (m) => (m[0] === '#' ? '' : '""')).trim();
  if (!/^location\s+\^~\s+\/api\/v1\/\s*\{/.test(code)) return false;
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i === code.length - 1;
  }
  return false;
}

// Reviewed editorial policy is confined to the marked guide location. The full vhost
// (minus its opt-in account block) is still hash-protected above, including this block.
const GUIDE_CSP = "default-src 'self'; script-src 'nonce-$request_id' 'strict-dynamic' 'self'; worker-src 'none'; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; frame-src https:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
export function guideAdsPolicy(text) {
  const markers = text.match(/^ *# (?:BEGIN|END) guide-ads\b[^\n]*$/gm) ?? [];
  if (!markers.length) return { ok: true, app: text };
  const blocks = [...text.matchAll(/^ *# BEGIN guide-ads\n([\s\S]*?)^ *# END guide-ads\n/gm)];
  if (markers.length !== 2 || blocks.length !== 1) return { ok: false, app: text };
  const block = blocks[0][1];
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g;
  const uncommented = block.replace(tokens, m => m[0] === '#' ? '' : m).trim();
  const code = uncommented.replace(tokens, '""');
  const locations = /^location\s+\^~\s+\/guides\/\s*\{([^{}]*)\}\s*location\s*=\s*\/ads\.txt\s*\{([^{}]*)\}$/.exec(code);
  const rawLocations = /^location\s+\^~\s+\/guides\/\s*\{([^{}]*)\}\s*location\s*=\s*\/ads\.txt\s*\{([^{}]*)\}$/.exec(uncommented);
  const csps = [...(rawLocations?.[1] ?? '').matchAll(/add_header\s+content-security-policy\s+(["'])(.*?)\1/gi)].map(m => m[2]);
  const ok = !!locations && !!rawLocations && csps.length === 1 && csps[0] === GUIDE_CSP
    && !/content-security-policy/i.test(rawLocations[2])
    && !/cross-origin-opener-policy|cross-origin-embedder-policy/i.test(code)
    && /proxy_pass\s+http:\/\/127\.0\.0\.1:3012\/api\/v1\/ads\.txt\s*;/.test(locations[2]);
  return { ok, app: ok ? text.replace(blocks[0][0], '') : text };
}

/** gzip -9 bytes of what dist/index.html loads up front: the entry script, modulepreloads and stylesheets. */
export function entryBytes(dist) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const tags = /<script\b[^>]*\bsrc="\/([^"]+)"|<link\b[^>]*\brel="(?:modulepreload|stylesheet)"[^>]*\bhref="\/([^"]+)"/g;
  const files = [...html.matchAll(tags)].map((m) => m[1] ?? m[2]);
  if (!files.length) throw new Error(`${dist}/index.html references no entry script`);
  return { files, gzip: files.reduce((sum, f) => sum + gzipSync(readFileSync(join(dist, f)), { level: 9 }).length, 0) };
}

export function checkSurface({ root, dist, base, allowEntryGrowth = false }) {
  const failures = [];
  const notes = [];
  // deploy/ lives only in the maintainer's checkout; CI has none, so those checks run locally only.
  const hasDeploy = existsSync(join(root, 'deploy'));

  const guarded = new Set([...Object.keys(BASELINE), ...filesUnder(join(root, GUARDED_DIR)).map((f) => `${GUARDED_DIR}/${f}`)]);
  let hashed = 0;
  for (const path of [...guarded].sort()) {
    const file = join(root, path);
    if (path.startsWith('deploy/') && !hasDeploy) notes.push(`skipped ${path}: no deploy/ in this checkout`);
    else if (!(path in BASELINE)) failures.push(`${path}: new file in guarded ${GUARDED_DIR}/`);
    else if (!existsSync(file)) failures.push(`${path}: missing`);
    else {
      const bytes = readFileSync(file);
      const actual = sha256(path === VHOST ? stripAccountBlock(bytes.toString('utf8')) : bytes);
      if (actual === BASELINE[path]) hashed++;
      else failures.push(`${path}: sha256 ${actual}, baseline ${BASELINE[path]}`);
    }
  }
  notes.push(`${hashed} guarded files match the baseline`);

  if (hasDeploy && existsSync(join(root, VHOST))) {
    const vhost = readFileSync(join(root, VHOST), 'utf8');
    if (!accountBlockConfined(vhost)) failures.push(`${VHOST}: the account-server block must be exactly one location ^~ /api/v1/ { ... }`);
    const guides = guideAdsPolicy(vhost);
    if (!guides.ok) failures.push(`${VHOST}: guide-ads markers, routes or editorial CSP differ from the reviewed confined policy`);
    const expected = readFileSync(join(root, 'public/_headers'), 'utf8').match(/^\s*Content-Security-Policy: (.*)$/m)?.[1];
    // Header names are case-insensitive, and nginx takes either quote.
    const served = [...guides.app.matchAll(/add_header\s+content-security-policy\s+(["'])(.*?)\1/gi)].map((m) => m[2]);
    if (!expected || served.length !== 1 || served[0] !== expected) {
      failures.push(`${VHOST}: expected exactly one CSP equal to public/_headers', found ${served.length}${served.length === 1 ? ' that differs' : ''}`);
    } else notes.push('vhost CSP equals public/_headers');
  }

  const assets = join(dist, 'assets');
  if (!existsSync(assets)) failures.push(`${assets}: missing; run a flag-off npm run build first`);
  else {
    for (const f of readdirSync(assets)) {
      if (/account/i.test(f)) failures.push(`dist/assets/${f}: account chunk in a flag-off build`);
      const text = readFileSync(join(assets, f), 'latin1');
      // Quoted, because the catalog carries https://raider.io/api/v1/... as data.
      if (/["'`]\/api\/v1/.test(text)) failures.push(`dist/assets/${f}: quoted "/api/v1 literal in a flag-off build`);
      // Chunks are named after their module (src/lib/account/api.ts ships as api-*.js); the marker key exists only in
      // flag-gated code.
      if (/["'`]frostsim\.account["'`]/.test(text)) failures.push(`dist/assets/${f}: quoted "frostsim.account" marker key in a flag-off build`);
    }
    notes.push(`${assets}: checked for account chunks, quoted "/api/v1 literals and the frostsim.account marker key`);
  }

  if (base) {
    const now = entryBytes(dist);
    const was = entryBytes(base);
    const growth = now.gzip - was.gzip;
    const line = `entry set gzip -9: ${now.gzip} B over ${now.files.length} files, base ${was.gzip} B, growth ${growth} B (limit ${ENTRY_GROWTH_LIMIT})`;
    if (growth > ENTRY_GROWTH_LIMIT && !allowEntryGrowth) failures.push(line);
    else notes.push(growth > ENTRY_GROWTH_LIMIT ? `${line}, allowed by --allow-entry-growth` : line);
  }
  return { failures, notes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const { failures, notes } = checkSurface({
      root, dist: resolve(arg('--dist') ?? join(root, 'dist')), base: arg('--base') && resolve(arg('--base')),
      allowEntryGrowth: process.argv.includes('--allow-entry-growth'),
    });
    for (const note of notes) console.log(`  ${note}`);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.log(failures.length ? `surface check failed: ${failures.length} problem(s)` : 'surface check passed');
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    process.exitCode = 1;
  }
}
