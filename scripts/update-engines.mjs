#!/usr/bin/env node
// Engine publisher: newest green upstream `midnight` commit -> validated pack -> index, replaced LAST.
// One channel. Clients run the newest pack whose `compat` equals their own (scripts/engine-compat.mjs).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { brotliCompressSync, constants as zlib, gzipSync, zstdCompressSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { engineCompat } from './engine-compat.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'https://api.github.com/repos/simulationcraft/simc';
const ALERT_REPO = 'frostdev-ops/frostsim';
const ALERT_LABEL = 'engine-updater';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const run = (cwd, command, args, extra = {}) => execFileSync(command, args, {
  cwd, stdio: 'inherit', env: { ...process.env, CMAKE_BUILD_PARALLEL_LEVEL: process.env.CMAKE_BUILD_PARALLEL_LEVEL || '1' }, ...extra,
});

/** Upstream changed something only an application update can absorb. Reported as `blocked`. */
export class GateError extends Error {}

async function github(path) {
  const response = await fetch(`${api}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'frostsim-engine-updater' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Newest completed, successful upstream `main.yml` push run on midnight, from the upstream repo itself.
 * Sorted here: the filtered listing API has returned a run from weeks earlier first (2026-09-23).
 */
export function pickGreenRun(runs = []) {
  return [...runs].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).find(run => run.status === 'completed' && run.conclusion === 'success'
    && run.event === 'push' && run.head_branch === 'midnight' && run.path === '.github/workflows/main.yml'
    && run.repository?.full_name === 'simulationcraft/simc' && run.head_repository?.full_name === 'simulationcraft/simc'
    && /^[a-f0-9]{40}$/.test(run.head_sha));
}

/**
 * The listing is intermittently stale (it has served runs from weeks back, 2026-09-23), so a pick
 * older than `floor` is retried before the run concludes there is nothing new.
 */
export async function discover(floor = 0, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const ci = await github('/actions/workflows/main.yml/runs?branch=midnight&event=push&per_page=50');
    const tested = pickGreenRun(ci.workflow_runs);
    if (!tested) throw new Error('No successful upstream midnight CI run was available');
    if (Date.parse(tested.created_at) >= floor || attempt >= attempts) return { ref: tested.head_sha, ciUrl: tested.html_url };
    await new Promise(resolve => setTimeout(resolve, 20_000));
  }
}

function define(text, name) {
  const value = text.match(new RegExp(`^#define\\s+${name}\\s+"([^"]+)"`, 'm'))?.[1];
  if (!value) throw new Error(`Missing upstream ${name}`);
  return value;
}

async function sourceText(commit, file) {
  const response = await fetch(`https://raw.githubusercontent.com/simulationcraft/simc/${commit}/${file}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Upstream ${file}: HTTP ${response.status}`);
  return response.text();
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

/** Index v2. v1 (channels, a bundled entry) is migrated once; its packs keep serving until retention drops them. */
export function readIndex(value) {
  if (value?.schemaVersion === 2) return value;
  const packs = (value?.versions ?? []).filter(v => v.channel !== 'bundled' && v.baseUrl?.startsWith('/engine/versions/'))
    .map(v => ({ id: v.id, baseUrl: v.baseUrl, compat: 'v1', upstreamCommit: v.upstreamCommit, commitDate: v.publishedAt,
      publishedAt: v.publishedAt, ciUrl: v.ciUrl }));
  return { schemaVersion: 2, packs, status: null };
}

const newestFirst = (a, b) => (b.commitDate ?? '').localeCompare(a.commitDate ?? '') || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');

/**
 * Packs to keep: the 6 newest, anything published in the last 48 h (open tabs, offline caches), and the
 * newest pack of every compat seen in the last 30 days (a rolled-back app release still finds one).
 */
export function retainedPacks(packs, now = Date.now()) {
  const sorted = [...packs].sort(newestFirst);
  const age = pack => now - Date.parse(pack.publishedAt ?? 0);
  const keep = new Set(sorted.slice(0, 6).map(p => p.id));
  for (const pack of sorted) if (age(pack) < 48 * 3600_000) keep.add(pack.id);
  const seen = new Set();
  for (const pack of sorted) {
    if (seen.has(pack.compat)) continue;
    seen.add(pack.compat);
    if (age(pack) < 30 * 86400_000) keep.add(pack.id);
  }
  return sorted.filter(p => keep.has(p.id));
}

/** What the single alert issue should do, given the open issue (if any), the last and the new status. */
export function issueAction(openIssue, previous, status) {
  if (status.state === 'current' || status.state === 'building') return openIssue ? 'close' : null;
  if (!openIssue) return 'open';
  return previous?.state === status.state && previous?.reason === status.reason ? null : 'comment';
}

function verifyPack(pack, commit) {
  for (const variant of ['', 'fallback']) {
    const dir = join(pack, variant), manifest = json(join(dir, 'manifest.json'));
    assert.equal(manifest.engine.upstreamCommit, commit);
    assert.equal(manifest.artifact, variant ? 'fallback' : 'threaded');
    assert.deepEqual(manifest.lockMismatches, []);
    assert.deepEqual(manifest.buildTreeMismatches, []);
    assert(manifest.capabilities.reportVersions.includes(2));
    for (const file of ['simc.js', 'simc.wasm']) assert.equal(sha256(readFileSync(join(dir, file))), manifest.files[file].sha256);
  }
  const catalog = json(join(pack, 'catalog/manifest.json'));
  assert.equal(catalog.engine.upstreamCommit, commit);
  const engine = json(join(pack, 'manifest.json'));
  assert.equal(catalog.engine.clientDataVersion, engine.wow.clientDataVersion);
  assert.equal(catalog.engine.hotfixHash, engine.wow.hotfixHash);
  assert(catalog.counts.items > 0 && catalog.counts.traitNodes > 0, 'Catalog contains no usable game data');
  assert(typeof catalog.seasonDataBuild === 'string', 'Catalog is missing its season data attestation');
  for (const file of catalog.files) assert.equal(sha256(readFileSync(join(pack, 'catalog', file.path))), file.sha256);
  assert.equal(json(join(pack, 'presentation.json')).engineCommit, commit);
  for (let classId = 1; classId <= 13; classId++) {
    const layout = json(join(pack, `talent-layout/class-${classId}.json`));
    const tree = json(join(pack, `catalog/talents/class-${classId}.json`));
    assert.equal(layout.engineCommit, commit);
    assert.equal(layout.build, engine.wow.clientDataVersion);
    assert(Date.parse(layout.expiresAt) > Date.now(), 'Talent metadata expired');
    for (const node of tree.nodes.filter(n => n.treeIndex !== 4)) {
      const position = layout.nodes[node.nodeId];
      assert(Number.isFinite(position?.x) && Number.isFinite(position?.y), `Missing talent position ${node.nodeId}`);
    }
    const ids = new Set(tree.nodes.map(n => n.nodeId));
    assert(layout.edges.every(e => ids.has(e.from) && ids.has(e.to)));
    for (const key of ['class', 'spec', 'hero']) assert(layout.budgetSources[key]?.length, `Missing ${key} talent budget`);
  }
}

/** Season data without its provenance stamps: what the app actually uses. */
export function seasonBody(data) {
  const { build: _build, engineCommit: _commit, sources: _sources, ...body } = data;
  return body;
}

/**
 * Upgrade tracks and raid rewards ship in the app, keyed to one game build. For a pack on another build,
 * regenerate both from that build and compare: identical data is stamped into the pack's catalog manifest
 * as `seasonDataBuild` (the app's build it is proven equal to); different data blocks the pack.
 */
function seasonData(work, lock, cacheRoot) {
  const build = lock.expected.clientDataWowVersion;
  const files = ['src/lib/catalog/generated/upgrades.json', 'src/lib/catalog/generated/raid-rewards.json'];
  const shipped = files.map(file => json(join(work, file)));
  const seasonDataBuild = shipped[0].build;
  if (build !== seasonDataBuild) {
    const catalogs = join(work, 'public/catalogs');
    mkdirSync(catalogs, { recursive: true });
    // The generators read the engine-pinned catalog by id; point that id at this pack's catalog.
    run(work, 'ln', ['-sfn', '../engine/catalog', join(catalogs, `${build}-${lock.expected.clientDataHotfixHash.slice(0, 12)}-${lock.upstream.commit.slice(0, 7)}`)]);
    // Both generators cache wago.tools DB2 exports under build/upgrade-data-<build>; keep that across runs.
    mkdirSync(join(cacheRoot, `upgrade-data-${build}`), { recursive: true });
    mkdirSync(join(work, 'build'), { recursive: true });
    run(work, 'ln', ['-sfn', join(cacheRoot, `upgrade-data-${build}`), join(work, 'build', `upgrade-data-${build}`)]);
    run(work, 'node', ['scripts/catalog/generate-upgrades.mjs']);
    run(work, 'node', ['scripts/catalog/generate-raid-rewards.mjs']);
    files.forEach((file, i) => {
      try { assert.deepEqual(seasonBody(json(join(work, file))), seasonBody(shipped[i])); }
      catch { throw new GateError(`Game build ${build} changed ${file.split('/').pop()}; Frostsim needs regenerated season data`); }
    });
  }
  const manifest = join(work, 'public/engine/catalog/manifest.json');
  writeJson(manifest, { ...json(manifest), seasonDataBuild });
}

async function build(candidate, commit, output, id) {
  const work = process.env.FROSTSIM_BUILD_WORKSPACE
    ? resolve(process.env.FROSTSIM_BUILD_WORKSPACE)
    : mkdtempSync(join(process.env.FROSTSIM_BUILD_TMP ?? tmpdir(), 'frostsim-engine-'));
  mkdirSync(work, { recursive: true });
  console.log(`Build workspace: ${work}`);
  try {
    // Explicit source allowlist only; no .env, private exports, binaries, or deploy dirs.
    for (const file of ['scripts', 'patches', 'src', 'tests', 'functions', 'server', 'package.json', 'package-lock.json',
      'engine.lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.server.json', 'vite.config.ts',
      'svelte.config.js', 'index.html', '.nvmrc']) cpSync(join(root, file), join(work, file), { recursive: true });
    mkdirSync(join(work, 'public/engine'), { recursive: true });
    cpSync(join(root, 'public/engine/sim-worker.js'), join(work, 'public/engine/sim-worker.js'));
    // Checks read static routes; no prebuilt engine copied.
    for (const file of ['routes', 'sw.js']) cpSync(join(root, 'public', file), join(work, 'public', file), { recursive: true });
    // cpSync keeps source modes; a read-only directory in the source must never block the build (2026-09-17..23 outage).
    run(work, 'chmod', ['-R', 'u+w', '.']);
    run(work, 'git', ['init', '-q']);
    const lock = json(join(work, 'engine.lock.json'));
    lock.upstream.commit = commit;
    lock.upstream.branch = 'midnight';
    lock.upstream.commitDate = candidate.date;
    const config = await sourceText(commit, 'engine/config.hpp');
    const data = await sourceText(commit, 'engine/dbc/generated/client_data_version.inc');
    lock.expected = {
      simcVersion: `${define(config, 'SC_MAJOR_VERSION')}-${define(config, 'SC_MINOR_VERSION')}`,
      clientDataWowVersion: define(data, 'CLIENT_DATA_WOW_VERSION'),
      clientDataHotfixDate: define(data, 'CLIENT_DATA_HOTFIX_DATE'),
      clientDataHotfixHash: define(data, 'CLIENT_DATA_HOTFIX_HASH'),
    };
    writeJson(join(work, 'engine.lock.json'), lock);
    run(work, 'npm', ['ci', '--ignore-scripts']);
    run(work, 'bash', ['scripts/bootstrap-engine.sh']);
    // Compare behavior, not stamps: every new SHA changes header.
    const actors = join(work, 'src/lib/simc/actor-options.generated.ts');
    const actorBody = text => text.replace(/^\/\/ Upstream commit: .*$/m, '');
    const previousActors = actorBody(readFileSync(actors, 'utf8'));
    run(work, 'node', ['scripts/gen-actor-options.mjs']);
    if (actorBody(readFileSync(actors, 'utf8')) !== previousActors) throw new GateError('Upstream changed the actor option contract (gen-actor-options.mjs); Frostsim needs an update');
    const weekly = join(work, 'src/lib/simc/generated/weekly-defaults.json');
    const previousWeekly = json(weekly);
    run(work, 'node', ['scripts/generate-weekly-defaults.mjs']);
    const generatedWeekly = json(weekly);
    try {
      assert.deepEqual(generatedWeekly.rules, previousWeekly.rules);
      assert.deepEqual(generatedWeekly.weekly, previousWeekly.weekly);
    } catch { throw new GateError('Upstream changed the guided consumable defaults (generate-weekly-defaults.mjs); Frostsim needs an update'); }
    // Spell names/icons and consumable labels belong to this engine's spell data, so they ship in the pack. Generated here, before
    // any builder: the type check imports public/presentation.json, and a builder's wago.tools fetch failed (2026-09-25). Its wago.tools
    // downloads land in the talent layout's persistent cache, so a wago outage blocks only the first build of a client version.
    const talentCache = join(process.env.FROSTSIM_TALENT_CACHE || join(root, 'build'), `talent-layout-${lock.expected.clientDataWowVersion}`);
    mkdirSync(talentCache, { recursive: true });
    mkdirSync(join(work, 'build'), { recursive: true });
    symlinkSync(talentCache, join(work, 'build', `talent-layout-${lock.expected.clientDataWowVersion}`));
    run(work, 'node', ['scripts/generate-presentation.mjs']);
    // The compiles, smokes, tests and type check go to an EC2 builder when ec2.env exists; this host is the fallback.
    const builtOn = await remoteEngineBuild(work, lock.toolchain) ?? 'host';
    const remote = builtOn !== 'host';
    if (!remote) {
      run(work, 'bash', ['scripts/build-engine.sh']);
      run(work, 'bash', ['scripts/build-engine.sh', '--fallback']);
    }
    const dataEnv = process.env.FROSTSIM_DATA_ENV_FILE;
    if (!dataEnv || !existsSync(dataEnv)) throw new Error('FROSTSIM_DATA_ENV_FILE must name the protected Blizzard data credential file');
    run(work, 'node', [`--env-file=${resolve(dataEnv)}`, 'scripts/catalog/build-catalogs.mjs', '--out', join(work, 'public/engine/catalog')]);
    run(work, 'node', [`--env-file=${resolve(dataEnv)}`, 'scripts/generate-talent-layout.mjs',
      '--catalog', join(work, 'public/engine/catalog'), '--out', join(work, 'public/engine/talent-layout'), '--cache', talentCache]);
    seasonData(work, lock, process.env.FROSTSIM_TALENT_CACHE || join(root, 'build'));
    cpSync(join(work, 'public/presentation.json'), join(work, 'public/engine/presentation.json'));
    if (!remote) {
      for (const variant of ['', '--fallback']) {
        const report = join(work, variant ? 'fallback-report.json' : 'threaded-report.json');
        run(work, 'bash', ['scripts/engine-smoke.sh', ...(variant ? [variant] : []),
          'vendor/simc/profiles/MID2/MID2_Mage_Frost.simc', 'iterations=50', `threads=${variant ? 1 : 4}`, `json=${report},version=2`]);
        const dps = json(report).sim.players[0].collected_data.dps;
        assert(dps.mean > 0 && dps.count > 0, 'Engine smoke produced no DPS samples');
      }
      run(work, 'npx', ['vitest', 'run', 'src/lib/simc'], { env: { ...process.env, FROSTSIM_ENGINE: '1' } });
      run(work, 'npm', ['run', 'check']);
    }
    const pack = join(work, 'public/engine');
    const source = join(pack, 'source');
    mkdirSync(source, { recursive: true });
    run(work, 'git', ['-C', 'vendor/simc', 'archive', '--format=tar.gz', `--output=${join(source, 'simc.tar.gz')}`, commit]);
    for (const file of ['engine.lock.json', 'patches', 'scripts', 'package.json', 'package-lock.json']) cpSync(join(work, file), join(source, file), { recursive: true });
    cpSync(join(work, 'vendor/simc/LICENSE'), join(source, 'LICENSE'));
    verifyPack(pack, commit);
    writeJson(join(pack, 'validation.json'), { checkedAt: new Date().toISOString(), commit, builtOn,
      checks: ['both-wasm-builds', 'manifest-and-catalog-hashes', 'both-node-smokes', 'unit-and-real-engine-tests', 'types'],
      browserAcceptance: 'Browser loader acceptance belongs to the application deployment; these are engine checks.' });
    // nginx serves these through gzip_static / brotli_static.
    for (const file of walk(pack)) if (/\.(wasm|js|json)$/.test(file)) {
      const bytes = readFileSync(file);
      writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
      writeFileSync(`${file}.br`, brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length } }));
    }
    const target = join(output, 'engine/versions', id);
    const staging = `${target}.staging`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(pack, staging, { recursive: true });
    renameSync(staging, target);
    return lock.expected;
  } finally { if (!process.env.FROSTSIM_BUILD_WORKSPACE) rmSync(work, { recursive: true, force: true }); }
}

function writeIndex(indexPath, index) {
  if (existsSync(indexPath)) cpSync(indexPath, `${indexPath}.previous`);
  writeJson(`${indexPath}.tmp`, index);
  renameSync(`${indexPath}.tmp`, indexPath);
}

function prune(output, index) {
  const dir = join(output, 'engine/versions');
  if (!existsSync(dir)) return;
  const kept = new Set(index.packs.map(p => p.id));
  for (const entry of readdirSync(dir)) {
    // Staging directories belong to a build in flight; one run at a time is systemd's guarantee.
    if (kept.has(entry) || entry.endsWith('.staging')) continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
    console.log(`Pruned ${entry}`);
  }
}

// The token lives in a file read only here: never in process.env, so no build step inherits it.
function githubToken() {
  const file = process.env.FROSTSIM_GITHUB_ENV_FILE;
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, 'utf8').match(/^GITHUB_TOKEN=(.+)$/m)?.[1].trim() || null;
}

async function alertApi(token, path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${ALERT_REPO}${path}`, { ...init, signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'frostsim-engine-updater',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok) throw new Error(`Alert ${path}: HTTP ${response.status}`);
  return response.json();
}

function describe(status) {
  return [`**State:** ${status.state}`, `**Reason:** ${status.reason ?? '—'}`,
    `**Upstream head:** ${status.upstreamHead ?? 'unknown'}${status.upstreamCiUrl ? ` ([CI](${status.upstreamCiUrl}))` : ''}`,
    `**Checked:** ${status.checkedAt}`, '', 'Logs: `journalctl -u frostsim-engine-update.service` on the VPS.'].join('\n');
}

async function notify(previous, status, label = ALERT_LABEL) {
  const token = githubToken();
  if (!token) { console.log('Alerts disabled: no GitHub token file (FROSTSIM_GITHUB_ENV_FILE)'); return; }
  const [open] = await alertApi(token, `/issues?labels=${label}&state=open&per_page=1`);
  const action = issueAction(open, previous, status);
  if (action === 'open') {
    const issue = await alertApi(token, '/issues', { method: 'POST', body: JSON.stringify({
      title: `Engine updater ${status.state}: ${status.reason}`.slice(0, 200), labels: [label], body: describe(status) }) });
    status.issueUrl = issue.html_url;
  } else if (action === 'comment') {
    await alertApi(token, `/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: describe(status) }) });
    status.issueUrl = open.html_url;
  } else if (action === 'close') {
    await alertApi(token, `/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Recovered.\n\n${describe(status)}` }) });
    await alertApi(token, `/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  } else if (open && status.state !== 'current') status.issueUrl = open.html_url;
}

// Native simc for the compute workers (CLAUDE.md D14): built from each pack's own source archive with
// cmake/ninja/g++ inside this unit's Nice/CPUQuota/MemoryMax (no docker), uploaded to R2, recorded as native.json.
// SigV4 is signed here with node:crypto: the updater source has no node_modules, and the work tree that has
// aws4fetch is gone by the time a pack is published (and never existed for packs published before this).
const NATIVE_ALERT_LABEL = 'engine-updater-native';

/** R2 credentials, read in-process like githubToken(). null when the file is absent: native builds are off. */
export function r2Credentials(file = process.env.FROSTSIM_R2_ENV_FILE || '/opt/frostsim/engine-updater/r2.env') {
  if (!existsSync(file)) return null;
  // Both services bind /opt/frostsim read-only, so a world-readable r2.env hands them the bucket write key.
  if (statSync(file).mode & 0o007) throw new Error(`${file} is readable by other users; chmod 640 (root:frostsim-build)`);
  const text = readFileSync(file, 'utf8');
  const value = name => text.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1].trim();
  const creds = { accountId: value('R2_ACCOUNT_ID'), accessKeyId: value('R2_ACCESS_KEY_ID'), secretAccessKey: value('R2_SECRET_ACCESS_KEY'),
    bucket: value('R2_ENGINES_BUCKET') || 'frostsim-engines' };
  if (!/^[0-9a-f]{32}$/.test(creds.accountId ?? '') || !creds.accessKeyId || !creds.secretAccessKey || !/^[a-z0-9-]{3,63}$/.test(creds.bucket)) {
    throw new Error('r2.env needs R2_ACCOUNT_ID (32 hex), R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
  }
  return creds;
}

const uriEncode = text => encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();

/** AWS Signature V4 Authorization value. Signs host and every header given (x-amz-date required); no query strings. */
export function sigV4({ method, url, headers, payloadHash }, { accessKeyId, secretAccessKey, region, service }) {
  const { host, pathname, search } = new URL(url);
  if (search) throw new Error('sigV4 does not sign query strings');
  const all = Object.fromEntries([['host', host], ...Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])]);
  const names = Object.keys(all).sort();
  const date = all['x-amz-date'], day = date.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const canonical = [method, pathname.split('/').map(s => uriEncode(decodeURIComponent(s))).join('/'), '',
    names.map(n => `${n}:${all[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  let key = `AWS4${secretAccessKey}`;
  for (const part of [day, region, service, 'aws4_request']) key = hmac(key, part);
  const signature = hmac(key, ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n')).toString('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

const amzDate = (date = new Date()) => date.toISOString().replace(/[-:]|\.\d{3}/g, '');
const r2Url = (creds, key) => `https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket}/${key}`;

/** One signed R2 request. GET returns the body, or null for a missing object; PUT and DELETE return nothing. */
async function r2Request(creds, method, key, { body = Buffer.alloc(0), headers = {}, fetchFn = fetch } = {}) {
  const url = r2Url(creds, key);
  const signed = { ...headers, 'x-amz-content-sha256': sha256(body), 'x-amz-date': amzDate() };
  signed.authorization = sigV4({ method, url, headers: signed, payloadHash: signed['x-amz-content-sha256'] }, { ...creds, region: 'auto', service: 's3' });
  const response = await fetchFn(url, { method, headers: signed, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(300_000) });
  if (method === 'GET' && response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`R2 ${method} ${key}: HTTP ${response.status}`); }
  if (method === 'GET') return Buffer.from(await response.arrayBuffer());
  await response.body?.cancel();
  return undefined;
}

async function r2Put(creds, key, body, headers, fetchFn) {
  await r2Request(creds, 'PUT', key, { body, headers, fetchFn });
}

/** A presigned URL (query-string SigV4, host signed, payload unsigned): what a builder with no credentials uses. */
export function presignV4(url, method, { accessKeyId, secretAccessKey, region, service }, expiresS, date = new Date()) {
  const { origin, host, pathname } = new URL(url);
  const stamp = amzDate(date), day = stamp.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const path = pathname.split('/').map(s => uriEncode(decodeURIComponent(s))).join('/');
  const params = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresS), 'X-Amz-SignedHeaders': 'host' };
  const query = Object.keys(params).sort().map(k => `${uriEncode(k)}=${uriEncode(params[k])}`).join('&');
  const canonical = [method, path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  let key = `AWS4${secretAccessKey}`;
  for (const part of [day, region, service, 'aws4_request']) key = hmac(key, part);
  const signature = hmac(key, ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n')).toString('hex');
  return `${origin}${path}?${query}&X-Amz-Signature=${signature}`;
}

// Remote builds: the VPS has 4 cores shared with nginx and the APIs, so a cold engine or native build takes the better part of an
// hour there. Builders come from, in order, EC2 Spot (ec2.env) and Hetzner (hcloud.env); this host is the last resort. Both run
// Ubuntu 24.04, the worker OS, so a native binary links the workers' glibc, and both use the same pull model (below).
const HCLOUD_API = 'https://api.hetzner.cloud/v1';
const BUILDER_LABEL = { frostsim: 'engine-build' };
/** A builder older than this is a leak from a crashed run; each run removes those first. */
const BUILDER_MAX_AGE_MS = 2 * 3600_000;
/** scripts/update-engines.mjs's native flags without the launcher: the builder is fresh, so ccache would only cost time. */
const NATIVE_CMAKE = ['-S', 'vendor/simc', '-B', 'build/native', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_GUI=OFF',
  '-DBUILD_TESTING=OFF', '-DSC_NO_NETWORKING=ON', '-DCMAKE_CXX_FLAGS=-DSC_USE_PTR=0'];

/** Hetzner token for remote builds, read like r2.env. null when the file is absent: no Hetzner builds. */
export function hcloudCredentials(file = process.env.FROSTSIM_HCLOUD_ENV_FILE || '/opt/frostsim/engine-updater/hcloud.env') {
  if (!existsSync(file)) return null;
  // The token can create servers on the project's bill.
  if (statSync(file).mode & 0o007) throw new Error(`${file} is readable by other users; chmod 640 (root:frostsim-build)`);
  const text = readFileSync(file, 'utf8');
  const value = name => text.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1].trim();
  const token = value('HCLOUD_TOKEN');
  if (!token) throw new Error('hcloud.env needs HCLOUD_TOKEN');
  return { token, serverType: value('HCLOUD_BUILD_SERVER_TYPE') || 'cpx62', location: value('HCLOUD_BUILD_LOCATION') || 'nbg1' };
}

/** One Hetzner API call. A missing server (GET or DELETE 404) is null. */
async function hcloudCall(hc, method, path, body, fetchFn) {
  const response = await fetchFn(HCLOUD_API + path, {
    method, headers: { authorization: `Bearer ${hc.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
  });
  if ((method === 'DELETE' || method === 'GET') && response.status === 404) return null;
  if (!response.ok) throw new Error(`hcloud ${method} ${path.split('?')[0]}: HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

/** Deletes Hetzner builders a crashed run left behind; returns their ids. */
export async function sweepBuilders(hc, { fetchFn = fetch, now = Date.now() } = {}) {
  const { servers = [] } = await hcloudCall(hc, 'GET', '/servers?label_selector=frostsim%3Dengine-build', null, fetchFn);
  const stale = servers.filter(s => now - Date.parse(s.created) > BUILDER_MAX_AGE_MS);
  for (const s of stale) await hcloudCall(hc, 'DELETE', `/servers/${s.id}`, null, fetchFn);
  return stale.map(s => s.id);
}

/** Hetzner as a builder provider. A server that shut itself down still bills until it is deleted, which runOnBuilder always does. */
export function hetznerBuilders(hc, fetchFn = fetch) {
  return {
    name: 'Hetzner',
    async launch(userData, name) {
      // Default public networking: the builder needs IPv4 (GitHub and nodejs.org), and R2 did not answer over IPv6 in Phase 0.
      const { server } = await hcloudCall(hc, 'POST', '/servers', { name: `frostsim-${name}`, server_type: hc.serverType, image: 'ubuntu-24.04',
        location: hc.location, labels: BUILDER_LABEL, user_data: userData }, fetchFn);
      console.log(`Builder hcloud ${server.id}: ${hc.serverType} in ${hc.location}`);
      return String(server.id);
    },
    gone: async id => { const data = await hcloudCall(hc, 'GET', `/servers/${id}`, null, fetchFn); return !data?.server || data.server.status === 'off'; },
    remove: async id => { await hcloudCall(hc, 'DELETE', `/servers/${id}`, null, fetchFn); },
    sweep: () => sweepBuilders(hc, { fetchFn }),
  };
}

// The pull model: a builder fetches its job over presigned R2 URLs and pushes its outputs, log and exit code back the same way, so
// it needs no inbound port, no ssh and no credentials of its own, then shuts itself down. EC2 Spot (CLAUDE.md D14's compute
// account): ec2.env holds a key that can only start Spot instances tagged frostsim=engine-build and terminate those.
const EC2_VERSION = '2016-11-15';
const EC2_BUILD_TAG = 'engine-build';
const UBUNTU_AMI = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';
/** Capacity errors worth the next pool; any other error (a quota, a policy) would repeat. */
const EC2_TRY_NEXT = new Set(['InsufficientInstanceCapacity', 'SpotMaxPriceTooLow', 'Unsupported', 'InsufficientFreeAddressesInSubnet']);
const EC2_MAX_POOLS = 8;
/** vCPU of an x86 size (c7a.8xlarge: 32), as server/account/compute/ec2.ts reads it; 0 for anything else. */
const vcpus = type => { const m = /^[a-z]\d+[a-z]*\.(large|xlarge|(\d+)xlarge)$/.exec(type); return !m ? 0 : m[1] === 'large' ? 2 : m[1] === 'xlarge' ? 4 : 4 * Number(m[2]); };
const EC2_POLL_MS = 20_000;
/** A builder whose instance is gone this long without an exit marker was lost (a Spot interruption, a crash). */
const EC2_LOST_MS = 90_000;

/** EC2 build credentials, read like r2.env. null when the file is absent: no EC2 builds. */
export function ec2BuildCredentials(file = process.env.FROSTSIM_EC2_ENV_FILE || '/opt/frostsim/engine-updater/ec2.env') {
  if (!existsSync(file)) return null;
  // The key can start instances on the account's bill.
  if (statSync(file).mode & 0o007) throw new Error(`${file} is readable by other users; chmod 640 (root:frostsim-build)`);
  const text = readFileSync(file, 'utf8');
  const value = name => text.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1].trim();
  const subnets = new Map((value('AWS_SUBNETS') ?? '').split(',').map(p => p.trim().split(':')).filter(p => p.length === 2 && p[0] && p[1]));
  const creds = { region: value('AWS_REGION'), accessKeyId: value('AWS_ACCESS_KEY_ID'), secretAccessKey: value('AWS_SECRET_ACCESS_KEY'),
    securityGroup: value('AWS_SECURITY_GROUP_ID'), subnets,
    // 32 vCPU first: the Spot quota is shared with the compute workers, and a 64-vCPU builder can hold all of it.
    types: (value('AWS_BUILD_INSTANCE_TYPES') ?? 'c7a.8xlarge,c8a.8xlarge,c7a.16xlarge,c8a.16xlarge').split(',').map(t => t.trim()).filter(Boolean) };
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(creds.region ?? '') || !creds.accessKeyId || !creds.secretAccessKey || !creds.securityGroup || !subnets.size) {
    throw new Error('ec2.env needs AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SECURITY_GROUP_ID and AWS_SUBNETS (zone:subnet,...)');
  }
  return creds;
}

/** Text of every flat `<tag>` element, in order. */
export const xmlTags = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map(m => m[1]);

/** One signed AWS JSON or Query call; the error carries the service's own code, never its message (it can echo the request). */
async function awsCall(creds, service, body, headers, fetchFn) {
  const url = `https://${service}.${creds.region}.amazonaws.com/`;
  const signed = { ...headers, 'x-amz-date': amzDate() };
  signed.authorization = sigV4({ method: 'POST', url, headers: signed, payloadHash: sha256(body) }, { ...creds, service });
  const response = await fetchFn(url, { method: 'POST', headers: signed, body, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  if (!response.ok) {
    const code = xmlTags(text, 'Code')[0] ?? (() => { try { return JSON.parse(text).__type?.split('#').pop(); } catch { return undefined; } })();
    const err = new Error(`${service} ${headers['x-amz-target'] ?? body.split('&')[0]}: HTTP ${response.status} (${code ?? 'unknown'})`);
    err.code = code;
    throw err;
  }
  return text;
}

export function ec2Call(creds, action, params, fetchFn = fetch) {
  const body = new URLSearchParams({ Action: action, Version: EC2_VERSION, ...params }).toString();
  return awsCall(creds, 'ec2', body, { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, fetchFn);
}

async function ubuntuAmi(creds, fetchFn) {
  const text = await awsCall(creds, 'ssm', JSON.stringify({ Name: UBUNTU_AMI }),
    { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonSSM.GetParameter' }, fetchFn);
  const ami = JSON.parse(text).Parameter?.Value;
  if (!/^ami-[0-9a-f]+$/.test(ami ?? '')) throw new Error('SSM returned no Ubuntu 24.04 image');
  return ami;
}

/** Pools to try, in the configured type order and, within a type, cheapest zone first. */
export async function buildPools(creds, fetchFn = fetch, now = new Date()) {
  const params = { 'ProductDescription.1': 'Linux/UNIX', StartTime: now.toISOString() };
  creds.types.forEach((t, i) => { params[`InstanceType.${i + 1}`] = t; });
  const xml = await ec2Call(creds, 'DescribeSpotPriceHistory', params, fetchFn);
  const newest = new Map();
  for (const item of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1])) {
    const [type] = xmlTags(item, 'instanceType'), [zone] = xmlTags(item, 'availabilityZone'), [at] = xmlTags(item, 'timestamp');
    const usd = Number(xmlTags(item, 'spotPrice')[0]);
    const key = `${type}@${zone}`;
    if (creds.subnets.has(zone) && usd > 0 && !(newest.get(key)?.at > at)) newest.set(key, { type, zone, usd, at });
  }
  const order = type => creds.types.indexOf(type);
  return [...newest.values()].sort((a, b) => order(a.type) - order(b.type) || a.usd - b.usd).slice(0, EC2_MAX_POOLS);
}

/** A builder that just finished still counts against the Spot quota while it shuts down (1-2 min, measured): a quota refusal is
 *  retried this many times, this far apart, before the next provider is tried. */
const QUOTA_RETRIES = 4;
const QUOTA_RETRY_MS = 45_000;

/** launchOnce, retried while the Spot quota is taken (by a builder still shutting down, or by compute workers). */
async function launchBuilder(creds, userData, name, fetchFn, sleep = ms => new Promise(done => setTimeout(done, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await launchOnce(creds, userData, name, fetchFn); }
    catch (err) {
      if (err.code !== 'MaxSpotInstanceCountExceeded' || attempt >= QUOTA_RETRIES) throw err;
      console.error(`Spot quota taken; retrying in ${QUOTA_RETRY_MS / 1000} s`);
      await sleep(QUOTA_RETRY_MS);
    }
  }
}

/** Starts one tagged, terminate-on-shutdown Spot builder from the first pool with capacity. Returns its instance id. */
async function launchOnce(creds, userData, name, fetchFn) {
  const [ami, pools] = await Promise.all([ubuntuAmi(creds, fetchFn), buildPools(creds, fetchFn)]);
  if (!pools.length) throw new Error('No Spot price for any build instance type in the configured zones');
  let last, ceiling = Infinity;
  for (const pool of pools) {
    // The Spot vCPU quota is shared with the compute workers: after a quota refusal only smaller builders can fit.
    if (vcpus(pool.type) >= ceiling) continue;
    try {
      const xml = await ec2Call(creds, 'RunInstances', {
        ImageId: ami, InstanceType: pool.type, MinCount: '1', MaxCount: '1', SubnetId: creds.subnets.get(pool.zone),
        'SecurityGroupId.1': creds.securityGroup, 'InstanceMarketOptions.MarketType': 'spot',
        'InstanceMarketOptions.SpotOptions.SpotInstanceType': 'one-time', 'InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior': 'terminate',
        InstanceInitiatedShutdownBehavior: 'terminate', 'MetadataOptions.HttpTokens': 'required',
        // Room for Node, emsdk, the simc checkout and two LTO build trees.
        'BlockDeviceMapping.1.DeviceName': '/dev/sda1', 'BlockDeviceMapping.1.Ebs.VolumeSize': '60',
        'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3', 'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
        UserData: Buffer.from(userData).toString('base64'),
        'TagSpecification.1.ResourceType': 'instance', 'TagSpecification.1.Tag.1.Key': 'frostsim', 'TagSpecification.1.Tag.1.Value': EC2_BUILD_TAG,
        'TagSpecification.1.Tag.2.Key': 'Name', 'TagSpecification.1.Tag.2.Value': name,
        'TagSpecification.2.ResourceType': 'volume', 'TagSpecification.2.Tag.1.Key': 'frostsim', 'TagSpecification.2.Tag.1.Value': EC2_BUILD_TAG,
      }, fetchFn);
      const id = xmlTags(xml, 'instanceId')[0];
      if (!id?.startsWith('i-')) throw new Error('RunInstances returned no instance id');
      console.log(`Builder ${id}: ${pool.type} in ${pool.zone} at about $${pool.usd}/h`);
      return id;
    } catch (err) {
      if (err.code === 'MaxSpotInstanceCountExceeded') ceiling = vcpus(pool.type);
      else if (!EC2_TRY_NEXT.has(err.code)) throw err;
      last = err;
    }
  }
  throw last;
}

async function instanceState(creds, id, fetchFn) {
  const xml = await ec2Call(creds, 'DescribeInstances', { 'InstanceId.1': id }, fetchFn);
  return xml.match(/<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/)?.[1] ?? 'unknown';
}

async function terminate(creds, id, fetchFn) {
  try { await ec2Call(creds, 'TerminateInstances', { 'InstanceId.1': id }, fetchFn); }
  catch (err) { if (err.code !== 'InvalidInstanceID.NotFound') throw err; }
}

/** EC2 Spot as a builder provider. */
export function ec2Builders(creds, fetchFn = fetch, sleep = undefined) {
  return {
    name: 'EC2 Spot',
    launch: (userData, name) => launchBuilder(creds, userData, name, fetchFn, sleep),
    gone: async id => ['shutting-down', 'terminated', 'stopped', 'stopping'].includes(await instanceState(creds, id, fetchFn)),
    remove: id => terminate(creds, id, fetchFn),
    sweep: () => sweepEc2Builders(creds, { fetchFn }),
  };
}

/** Terminates EC2 builders a crashed run left behind (older than two hours); returns their ids. */
export async function sweepEc2Builders(creds, { fetchFn = fetch, now = Date.now() } = {}) {
  const xml = await ec2Call(creds, 'DescribeInstances', { 'Filter.1.Name': `tag:frostsim`, 'Filter.1.Value.1': EC2_BUILD_TAG,
    'Filter.2.Name': 'instance-state-name', 'Filter.2.Value.1': 'pending', 'Filter.2.Value.2': 'running' }, fetchFn);
  const stale = xml.split('<instanceId>').slice(1).map(chunk => ({ id: chunk.slice(0, chunk.indexOf('<')), launched: xmlTags(chunk, 'launchTime')[0] }))
    .filter(i => i.id.startsWith('i-') && now - Date.parse(i.launched) > BUILDER_MAX_AGE_MS).map(i => i.id);
  for (const id of new Set(stale)) await terminate(creds, id, fetchFn);
  return [...new Set(stale)];
}

/** What the builder runs from user data: fetch the job, run its run.sh, push out/ (on success), the log and the exit code. */
export function builderUserData(urls) {
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`;
  return ['#!/bin/bash', 'mkdir -p /root/w && cd /root/w', 'code=1',
    `if curl -fsSL --retry 5 -o in.tgz ${q(urls.input)} && tar -xzf in.tgz && rm in.tgz; then bash run.sh >/root/build.log 2>&1; code=$?;`,
    'else echo "The builder could not fetch its job" >/root/build.log; fi',
    `if [ "$code" = 0 ]; then tar -czf /root/out.tgz out && curl -fsS --retry 5 -T /root/out.tgz ${q(urls.output)} >/dev/null || code=97; fi`,
    `curl -fsS --retry 5 -T /root/build.log ${q(urls.log)} >/dev/null`,
    `echo "$code" >/root/exit && curl -fsS --retry 5 -T /root/exit ${q(urls.exit)} >/dev/null`,
    'shutdown -h now', ''].join('\n');
}

/**
 * Runs one job on a builder from `provider` (ec2Builders, hetznerBuilders): `dir` (which must hold run.sh; it writes its results to
 * out/) goes up as a tarball, and out/ comes back extracted into `into`. Throws with the log's tail on failure; the builder and every
 * job object are removed either way.
 */
export async function runOnBuilder(provider, r2, dir, into, { name, timeoutMs, cache, fetchFn = fetch, exec = run, now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const prefix = `builds/${name}`;
  const keys = { input: `${prefix}/in.tgz`, output: `${prefix}/out.tgz`, log: `${prefix}/build.log`, exit: `${prefix}/exit` };
  const expires = Math.ceil(timeoutMs / 1000) + 3600;
  const r2Auth = { ...r2, region: 'auto', service: 's3' };
  const urls = { input: presignV4(r2Url(r2, keys.input), 'GET', r2Auth, expires) };
  for (const key of ['output', 'log', 'exit']) urls[key] = presignV4(r2Url(r2, keys[key]), 'PUT', r2Auth, expires);
  // `cache` names a ccache snapshot kept across builds (ccache/<cache>.tar.zst); the job restores it first and saves it last.
  if (cache) {
    const key = `ccache/${cache}.tar.zst`;
    writeFileSync(join(dir, 'cache.env'), `CACHE_GET='${presignV4(r2Url(r2, key), 'GET', r2Auth, expires)}'\n`
      + `CACHE_PUT='${presignV4(r2Url(r2, key), 'PUT', r2Auth, expires)}'\n`);
  }
  let id = null;
  try {
    const tarball = execFileSync('tar', ['-czf', '-', '-C', dir, '.'], { maxBuffer: 1 << 30 });
    await r2Request(r2, 'PUT', keys.input, { body: tarball, headers: { 'content-type': 'application/gzip' }, fetchFn });
    id = await provider.launch(builderUserData(urls), name);
    const deadline = now() + timeoutMs;
    let goneSince = null;
    for (;;) {
      await sleep(EC2_POLL_MS);
      const exit = await r2Request(r2, 'GET', keys.exit, { fetchFn });
      if (exit !== null) {
        const code = exit.toString().trim();
        if (code !== '0') {
          const log = (await r2Request(r2, 'GET', keys.log, { fetchFn }))?.toString() ?? '';
          throw new Error(`Builder exited with ${code}: ${log.split('\n').slice(-30).join('\n')}`);
        }
        const out = await r2Request(r2, 'GET', keys.output, { fetchFn });
        if (!out) throw new Error('Builder reported success but uploaded no output');
        mkdirSync(into, { recursive: true });
        exec(into, 'tar', ['-xzf', '-'], { input: out, stdio: ['pipe', 'inherit', 'inherit'] });
        return;
      }
      if (now() > deadline) throw new Error(`Builder ${id} did not finish within ${Math.round(timeoutMs / 60_000)} min`);
      if (await provider.gone(id)) {
        goneSince ??= now();
        if (now() - goneSince > EC2_LOST_MS) throw new Error(`Builder ${id} stopped without reporting (a Spot interruption?)`);
      } else goneSince = null;
    }
  } finally {
    if (id) await provider.remove(id).catch(err => console.error(`Builder ${id} NOT removed: ${err.message}`));
    for (const key of Object.values(keys)) await r2Request(r2, 'DELETE', key, { fetchFn }).catch(() => {});
  }
}

/**
 * The builder's shell prelude: fail fast, the pinned Node and emsdk when a job needs them, and ccache restored from R2 when the job
 * carries cache.env (runOnBuilder's `cache`). The builder starts empty every time, so the cache is what makes a rebuild recompile only
 * what changed, as the host's persistent ccache does. `compilerCheck` must be stable across builders: a fresh emsdk install has new
 * mtimes every run, so the engine job keys on its pinned version.
 */
function builderPrelude({ node, emsdk, compilerCheck = 'content' } = {}) {
  return ['set -euo pipefail', 'export DEBIAN_FRONTEND=noninteractive HOME=/root',
    'apt-get update -qq', 'apt-get install -y -qq --no-install-recommends cmake ninja-build g++ git python3 xz-utils ca-certificates curl ccache zstd >/dev/null',
    `export CCACHE_DIR=/root/ccache CCACHE_BASEDIR=/root/w CCACHE_NOHASHDIR=1 CCACHE_MAXSIZE=8G CCACHE_COMPILERCHECK=${compilerCheck}`,
    'if [ -f cache.env ]; then . ./cache.env; fi',
    'if [ -n "${CACHE_GET:-}" ] && curl -fsS --retry 3 "$CACHE_GET" | zstd -dq | tar -xf - -C /root; then echo "ccache restored: $(du -sh /root/ccache | cut -f1)";',
    'else rm -rf /root/ccache; echo "ccache: starting empty"; fi',
    ...(node ? [
      `curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v${node}/node-v${node}-linux-x64.tar.xz`,
      `curl -fsSLo /tmp/SHASUMS256.txt https://nodejs.org/dist/v${node}/SHASUMS256.txt`,
      `echo "$(grep " node-v${node}-linux-x64.tar.xz$" /tmp/SHASUMS256.txt | cut -d' ' -f1)  /tmp/node.tar.xz" | sha256sum -c -`,
      'mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node', 'export PATH=/opt/node/bin:$PATH'] : []),
    ...(emsdk ? [
      `git clone -q --depth 1 --branch ${emsdk} https://github.com/emscripten-core/emsdk.git /opt/emsdk`,
      `/opt/emsdk/emsdk install ${emsdk} >/dev/null && /opt/emsdk/emsdk activate ${emsdk} >/dev/null`,
      'source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1'] : [])];
}

/** The job's last step: the cache goes back to R2 (never fatal; the next build then starts from the previous cache). */
const SAVE_CACHE = ['if [ -n "${CACHE_PUT:-}" ]; then ccache -s | grep -E "Hits|Misses" || true',
  '  if tar -cf - -C /root ccache | zstd -T0 -3 -q >/root/ccache.tar.zst && curl -fsS --retry 3 -T /root/ccache.tar.zst "$CACHE_PUT" >/dev/null',
  '  then echo "ccache saved: $(du -h /root/ccache.tar.zst | cut -f1)"; else echo "ccache not saved"; fi', 'fi'];

/** The engine job: both wasm artifacts, both node smokes, the real-engine and unit tests and the type check, on every core. */
export function engineJobScript(toolchain) {
  const smoke = variant => `bash scripts/engine-smoke.sh ${variant ? '--fallback ' : ''}vendor/simc/profiles/MID2/MID2_Mage_Frost.simc iterations=50 `
    + `threads=${variant ? 1 : 4} json=/root/w/out/${variant ? 'fallback' : 'threaded'}-report.json,version=2`;
  return [...builderPrelude({ node: toolchain.node, emsdk: toolchain.emsdk.version, compilerCheck: `string:emsdk-${toolchain.emsdk.version}` }),
    'cd ws', 'npm ci --ignore-scripts', 'bash scripts/bootstrap-engine.sh', 'export CMAKE_BUILD_PARALLEL_LEVEL=$(nproc)',
    'bash scripts/build-engine.sh', 'bash scripts/build-engine.sh --fallback', 'mkdir -p ../out', smoke(false), smoke(true),
    // The workspace carries public/presentation.json, which the type check imports: the host generates it first.
    'FROSTSIM_ENGINE=1 npx vitest run src/lib/simc', 'npm run check', 'cp -R public/engine ../out/engine',
    'cd ..', ...SAVE_CACHE, ''].join('\n');
}

/** The native job: a Linux simc from a pack's own source archive (the same flags as a local build, without ccache). */
export function nativeJobScript() {
  return [...builderPrelude(), 'mkdir -p vendor/simc out && tar -xzf simc.tar.gz -C vendor/simc',
    `cmake ${NATIVE_CMAKE.join(' ')} -DCMAKE_CXX_COMPILER_LAUNCHER=ccache -DCMAKE_C_COMPILER_LAUNCHER=ccache >/dev/null`,
    'cmake --build build/native', 'cp build/native/simc out/simc', ...SAVE_CACHE, ''].join('\n');
}

/** R2 and the builder providers in fallback order (EC2 Spot, then Hetzner), or null when none is configured: this host builds. */
function builders(fetchFn = fetch) {
  let r2;
  try { r2 = r2Credentials(); } catch (err) { console.error(`Remote builds off: ${err.message}`); return null; }
  if (!r2) return null;
  const providers = [];
  for (const [file, read, make] of [['ec2.env', ec2BuildCredentials, ec2Builders], ['hcloud.env', hcloudCredentials, hetznerBuilders]]) {
    try { const creds = read(); if (creds) providers.push(make(creds, fetchFn)); } catch (err) { console.error(`${file} ignored: ${err.message}`); }
  }
  return providers.length ? { r2, providers } : null;
}

/** Removes leaked builders of every provider; a failing sweep never stops a build. */
async function sweepAll(chain) {
  for (const provider of chain.providers) {
    const swept = await provider.sweep().catch(() => []);
    if (swept.length) console.error(`Removed leaked ${provider.name} builders ${swept.join(', ')}`);
  }
}

/** Runs a job on the first provider that completes it. Returns that provider's name; throws with every failure when none did. */
export async function runRemote(chain, dir, into, opts) {
  const failures = [];
  for (const provider of chain.providers) {
    try {
      await runOnBuilder(provider, chain.r2, dir, into, opts);
      return provider.name;
    } catch (err) {
      failures.push(`${provider.name}: ${err.message}`);
      console.error(`${provider.name} builder failed: ${err.message}`);
    }
  }
  throw new Error(failures.join('; '));
}

/**
 * Builds the engine artifacts of `work` on a remote builder and copies them into its public/engine. Returns the provider that built
 * them, or null (after logging why) when this host must build them itself.
 */
async function remoteEngineBuild(work, toolchain, opts = {}) {
  const chain = builders();
  if (!chain) return null;
  const tmp = process.env.FROSTSIM_BUILD_TMP ?? tmpdir();
  const job = mkdtempSync(join(tmp, 'frostsim-job-')), into = mkdtempSync(join(tmp, 'frostsim-out-'));
  try {
    await sweepAll(chain);
    // The workspace without what the builder fetches or makes itself: the simc checkout, node_modules and build trees.
    cpSync(work, join(job, 'ws'), { recursive: true, filter: src => !/^\/(vendor|node_modules|build)(\/|$)/.test(src.slice(work.length)) });
    writeFileSync(join(job, 'run.sh'), engineJobScript(toolchain));
    const provider = await runRemote(chain, job, into, { name: `engine-${Date.now()}`, timeoutMs: 90 * 60_000, cache: 'engine', ...opts });
    for (const variant of ['threaded', 'fallback']) {
      const dps = json(join(into, `out/${variant}-report.json`)).sim.players[0].collected_data.dps;
      assert(dps.mean > 0 && dps.count > 0, `Remote ${variant} smoke produced no DPS samples`);
    }
    cpSync(join(into, 'out/engine'), join(work, 'public/engine'), { recursive: true });
    return provider;
  } catch (err) {
    console.error(`Remote engine build failed, building here: ${err.message}`);
    return null;
  } finally {
    rmSync(job, { recursive: true, force: true });
    rmSync(into, { recursive: true, force: true });
  }
}

/** Retained packs with a source archive and no native.json yet, in index order (newest first). */
export function nativeTargets(output, packs) {
  return packs.filter(p => {
    const pack = join(output, 'engine/versions', p.id);
    return existsSync(join(pack, 'source/simc.tar.gz')) && !existsSync(join(pack, 'native.json'));
  });
}

/** One pack: build (here, or with `compile` on a remote builder), smoke here, zstd, upload binary then its .sha256 sibling, and
 *  write native.json last. */
export async function buildNative(output, id, creds, { exec = run, fetchFn = fetch, compile } = {}) {
  const pack = join(output, 'engine/versions', id);
  const work = mkdtempSync(join(process.env.FROSTSIM_BUILD_TMP ?? tmpdir(), 'frostsim-native-'));
  try {
    mkdirSync(join(work, 'vendor/simc'), { recursive: true });
    // Extracted here either way: the smoke below reads the pack's own profile.
    exec(work, 'tar', ['-xzf', join(pack, 'source/simc.tar.gz'), '-C', 'vendor/simc']);
    if (compile) await compile(pack, work);
    else {
      // cloud/sim-bench/build-native.sh's flags. The threaded wasm build applies no patches, so neither does this.
      // ccache (installed by install-engine-updater.sh, CCACHE_* set in the unit) turns each pack after the first, and every
      // retry of a failed pack, into a changed-files build, as build-engine.sh does for the wasm.
      exec(work, 'cmake', [...NATIVE_CMAKE, '-DCMAKE_CXX_COMPILER_LAUNCHER=ccache', '-DCMAKE_C_COMPILER_LAUNCHER=ccache']);
      exec(work, 'cmake', ['--build', 'build/native']);
    }
    const binary = join(work, 'build/native/simc');
    exec(work, binary, ['vendor/simc/profiles/MID2/MID2_Mage_Frost.simc', 'iterations=50', 'threads=2', 'json=native-smoke.json,version=2']);
    assert(json(join(work, 'native-smoke.json')).sim.players[0].collected_data.dps.mean > 0, 'Native smoke produced no DPS');
    const zst = zstdCompressSync(readFileSync(binary));
    const native = { key: `engines/${id}/simc-linux-x64.zst`, sha256: sha256(zst), bytes: zst.length, builtAt: new Date().toISOString() };
    await r2Put(creds, native.key, zst, { 'content-type': 'application/zstd', 'x-amz-meta-sha256': native.sha256 }, fetchFn);
    await r2Put(creds, `${native.key}.sha256`, Buffer.from(native.sha256), { 'content-type': 'text/plain' }, fetchFn);
    writeJson(join(pack, 'native.json'), native);
    return native;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/**
 * Sets only `nativeStatus`, on the index as it is on disk now. main() has already written the pack change and rotated
 * `.previous`; writing through writeIndex again would overwrite that rollback copy, and would revert an operator's rollback made
 * while the (hours-long, on the first run) native phase ran.
 */
export function writeNativeStatus(indexPath, status) {
  const index = json(indexPath);
  index.nativeStatus = status;
  writeJson(`${indexPath}.tmp`, index);
  renameSync(`${indexPath}.tmp`, indexPath);
}

/** A remote compile for each pack (EC2 Spot, then Hetzner), or null when no provider is configured: the packs build here. */
async function openBuilder() {
  const chain = builders();
  if (!chain) return null;
  await sweepAll(chain);
  return { close: async () => {}, compile: async (pack, dir) => {
    const tmp = process.env.FROSTSIM_BUILD_TMP ?? tmpdir();
    const job = mkdtempSync(join(tmp, 'frostsim-job-')), into = mkdtempSync(join(tmp, 'frostsim-out-'));
    try {
      cpSync(join(pack, 'source/simc.tar.gz'), join(job, 'simc.tar.gz'));
      writeFileSync(join(job, 'run.sh'), nativeJobScript());
      await runRemote(chain, job, into, { name: `native-${Date.now()}`, timeoutMs: 45 * 60_000, cache: 'native' });
      mkdirSync(join(dir, 'build/native'), { recursive: true });
      cpSync(join(into, 'out/simc'), join(dir, 'build/native/simc'));
      run(dir, 'chmod', ['755', join(dir, 'build/native/simc')]);
    } finally {
      rmSync(job, { recursive: true, force: true });
      rmSync(into, { recursive: true, force: true });
    }
  } };
}

/** Never fails the pack or the run: failures go to their own alert issue and `nativeStatus` in the index. */
async function nativeBuilds(output, index, indexPath) {
  const status = { checkedAt: new Date().toISOString(), state: 'current', reason: null, upstreamHead: index.status?.upstreamHead ?? null };
  try {
    const creds = r2Credentials();
    if (!creds) { console.log('Native builds disabled: no R2 credential file'); return; }
    const failures = [];
    const targets = nativeTargets(output, index.packs);
    const builder = targets.length ? await openBuilder() : null;
    try {
      for (const pack of targets) {
        try {
          let native = null;
          if (builder) {
            try { native = await buildNative(output, pack.id, creds, { compile: builder.compile }); }
            catch (err) { console.error(`Remote build of ${pack.id} failed, building here: ${err.message}`); }
          }
          native ??= await buildNative(output, pack.id, creds);
          console.log(`Native ${pack.id}: ${native.key}`);
        } catch (err) { failures.push(`${pack.id}: ${err.message}`); console.error(err.stack ?? err.message); }
      }
    } finally { await builder?.close(); }
    if (failures.length) Object.assign(status, { state: 'failed', reason: `Native build failed for ${failures.join('; ')}` });
  } catch (err) { Object.assign(status, { state: 'failed', reason: `Native builds: ${err.message}` }); }
  try { await notify(index.nativeStatus ?? null, status, NATIVE_ALERT_LABEL); }
  catch (err) { console.error(`Native alert failed: ${err.message}`); }
  try { writeNativeStatus(indexPath, status); }
  catch (err) { console.error(`Native status not recorded: ${err.message}`); }
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const output = resolve(option('--output') ?? 'public');
  const indexPath = join(output, 'engine-versions.json');
  const index = readIndex(existsSync(indexPath) ? json(indexPath) : null);
  const previous = index.status;

  // OnFailure hook: report a crash only when the run did not get far enough to report itself.
  if (args.includes('--alert-crash')) {
    if (previous && previous.state !== 'current' && Date.now() - Date.parse(previous.checkedAt) < 30 * 60_000) return;
    await notify(previous, { checkedAt: new Date().toISOString(), state: 'failed', upstreamHead: previous?.upstreamHead,
      reason: 'The updater exited before recording a result' });
    return;
  }
  if (!args.includes('--output') && !args.includes('--discover')) throw new Error('Pass --output <persistent public directory> or --discover');

  const compat = engineCompat(root);
  const lock = json(join(root, 'engine.lock.json'));
  const status = { checkedAt: new Date().toISOString(), upstreamHead: null, upstreamDate: null, upstreamCiUrl: null, state: 'current', reason: null, issueUrl: null };

  async function publish(candidate, commit) {
    const config = await sourceText(commit, 'engine/config.hpp');
    if (/^#define\s+SC_BETA\s+1\b/m.test(config)) throw new GateError('Upstream midnight is marked beta (SC_BETA=1)');
    // The app sends game-version-specific options; an expansion change needs an app update.
    const major = define(config, 'SC_MAJOR_VERSION'), supported = lock.expected.simcVersion.split('-')[0];
    if (major !== supported) throw new GateError(`Upstream moved to SimulationCraft ${major}; Frostsim supports ${supported}`);

    const id = `${commit.slice(0, 12)}-${compat}`;
    if (index.packs.some(p => p.id === id)) return;
    mkdirSync(join(output, 'engine/versions'), { recursive: true });
    writeIndex(indexPath, { ...index, status: { ...status, state: 'building' } });
    const pack = join(output, 'engine/versions', id);
    let expected;
    if (existsSync(pack)) {
      verifyPack(pack, commit);
      const manifest = json(join(pack, 'manifest.json'));
      expected = { simcVersion: manifest.engine.simcVersion, clientDataWowVersion: manifest.wow.clientDataVersion };
    } else expected = await build(candidate, commit, output, id);
    index.packs.push({ id, baseUrl: `/engine/versions/${id}/`, compat, upstreamCommit: commit, commitDate: candidate.date,
      publishedAt: new Date().toISOString(), ciUrl: candidate.ciUrl ?? null,
      simcVersion: expected.simcVersion, clientDataVersion: expected.clientDataWowVersion });
    console.log(`Published ${id}`);
  }

  try {
    const ref = option('--ref');
    if (ref !== undefined && !/^[a-f0-9]{40}$/.test(ref)) throw new Error('--ref requires a full immutable source commit');
    // Never move backwards: not past the app's own pin, not past what is already published.
    const floor = [lock.upstream.commitDate, ...index.packs.filter(p => p.compat === compat).map(p => p.commitDate)]
      .filter(Boolean).map(Date.parse).reduce((a, b) => Math.max(a, b), 0);
    const candidate = ref ? { ref } : await discover(floor);
    const revision = await github(`/commits/${candidate.ref}`);
    const commit = revision.sha;
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid upstream commit');
    candidate.date = revision.commit.committer.date;
    console.log(`midnight @ ${commit} (${candidate.date}), compat ${compat}`);
    if (!ref && Date.parse(candidate.date) < floor) {
      console.log(`Upstream listing returned ${commit.slice(0, 7)}, older than what this app already has; nothing to do`);
    } else {
      Object.assign(status, { upstreamHead: commit, upstreamDate: candidate.date, upstreamCiUrl: candidate.ciUrl ?? null });
      if (!args.includes('--discover')) await publish(candidate, commit);
    }
  } catch (err) {
    Object.assign(status, { state: err instanceof GateError ? 'blocked' : 'failed', reason: err.message });
    console.error(err.stack ?? err.message);
  }
  if (args.includes('--discover')) return;

  index.packs = retainedPacks(index.packs);
  try { await notify(previous, status); }
  catch (err) { console.error(`Alert failed: ${err.message}`); process.exitCode = 1; }
  index.status = status;
  writeIndex(indexPath, index);
  prune(output, index);
  console.log(`Engine check ${status.state}; newest for compat ${compat}: ${index.packs.find(p => p.compat === compat)?.id ?? 'none'}`);
  // After the index is live, so a slow native build never delays a pack reaching browsers.
  await nativeBuilds(output, index, indexPath);
  if (status.state === 'failed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.stack ?? err.message); process.exitCode = 1; });
}
