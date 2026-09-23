#!/usr/bin/env node
// Engine publisher: newest green upstream `midnight` commit -> validated pack -> index, replaced LAST.
// One channel. Clients run the newest pack whose `compat` equals their own (scripts/engine-compat.mjs).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
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

export async function discover() {
  const ci = await github('/actions/workflows/main.yml/runs?branch=midnight&event=push&status=success&per_page=20');
  const tested = pickGreenRun(ci.workflow_runs);
  if (!tested) throw new Error('No successful upstream midnight CI run was available');
  return { ref: tested.head_sha, ciUrl: tested.html_url };
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
    for (const file of ['scripts', 'patches', 'src', 'tests', 'functions', 'package.json', 'package-lock.json',
      'engine.lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts',
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
    run(work, 'bash', ['scripts/build-engine.sh']);
    run(work, 'bash', ['scripts/build-engine.sh', '--fallback']);
    const dataEnv = process.env.FROSTSIM_DATA_ENV_FILE;
    if (!dataEnv || !existsSync(dataEnv)) throw new Error('FROSTSIM_DATA_ENV_FILE must name the protected Blizzard data credential file');
    run(work, 'node', [`--env-file=${resolve(dataEnv)}`, 'scripts/catalog/build-catalogs.mjs', '--out', join(work, 'public/engine/catalog')]);
    const talentCache = join(process.env.FROSTSIM_TALENT_CACHE || join(root, 'build'), `talent-layout-${lock.expected.clientDataWowVersion}`);
    run(work, 'node', [`--env-file=${resolve(dataEnv)}`, 'scripts/generate-talent-layout.mjs',
      '--catalog', join(work, 'public/engine/catalog'), '--out', join(work, 'public/engine/talent-layout'), '--cache', talentCache]);
    seasonData(work, lock, process.env.FROSTSIM_TALENT_CACHE || join(root, 'build'));
    // Spell names/icons and consumable labels belong to this engine's spell data, so they ship in the pack.
    run(work, 'node', ['scripts/generate-presentation.mjs']);
    cpSync(join(work, 'public/presentation.json'), join(work, 'public/engine/presentation.json'));
    for (const variant of ['', '--fallback']) {
      const report = join(work, variant ? 'fallback-report.json' : 'threaded-report.json');
      run(work, 'bash', ['scripts/engine-smoke.sh', ...(variant ? [variant] : []),
        'vendor/simc/profiles/MID2/MID2_Mage_Frost.simc', 'iterations=50', `threads=${variant ? 1 : 4}`, `json=${report},version=2`]);
      const dps = json(report).sim.players[0].collected_data.dps;
      assert(dps.mean > 0 && dps.count > 0, 'Engine smoke produced no DPS samples');
    }
    run(work, 'npx', ['vitest', 'run', 'src/lib/simc'], { env: { ...process.env, FROSTSIM_ENGINE: '1' } });
    run(work, 'npm', ['run', 'check']);
    const pack = join(work, 'public/engine');
    const source = join(pack, 'source');
    mkdirSync(source, { recursive: true });
    run(work, 'git', ['-C', 'vendor/simc', 'archive', '--format=tar.gz', `--output=${join(source, 'simc.tar.gz')}`, commit]);
    for (const file of ['engine.lock.json', 'patches', 'scripts', 'package.json', 'package-lock.json']) cpSync(join(work, file), join(source, file), { recursive: true });
    cpSync(join(work, 'vendor/simc/LICENSE'), join(source, 'LICENSE'));
    verifyPack(pack, commit);
    writeJson(join(pack, 'validation.json'), { checkedAt: new Date().toISOString(), commit,
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

async function notify(previous, status) {
  const token = githubToken();
  if (!token) { console.log('Alerts disabled: no GitHub token file (FROSTSIM_GITHUB_ENV_FILE)'); return; }
  const [open] = await alertApi(token, `/issues?labels=${ALERT_LABEL}&state=open&per_page=1`);
  const action = issueAction(open, previous, status);
  if (action === 'open') {
    const issue = await alertApi(token, '/issues', { method: 'POST', body: JSON.stringify({
      title: `Engine updater ${status.state}: ${status.reason}`.slice(0, 200), labels: [ALERT_LABEL], body: describe(status) }) });
    status.issueUrl = issue.html_url;
  } else if (action === 'comment') {
    await alertApi(token, `/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: describe(status) }) });
    status.issueUrl = open.html_url;
  } else if (action === 'close') {
    await alertApi(token, `/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Recovered.\n\n${describe(status)}` }) });
    await alertApi(token, `/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  } else if (open && status.state !== 'current') status.issueUrl = open.html_url;
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
    const candidate = ref ? { ref } : await discover();
    const revision = await github(`/commits/${candidate.ref}`);
    const commit = revision.sha;
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid upstream commit');
    candidate.date = revision.commit.committer.date;
    console.log(`midnight @ ${commit} (${candidate.date}), compat ${compat}`);
    // Never move backwards: not past the app's own pin, not past what is already published.
    const floor = [lock.upstream.commitDate, ...index.packs.filter(p => p.compat === compat).map(p => p.commitDate)]
      .filter(Boolean).map(Date.parse).reduce((a, b) => Math.max(a, b), 0);
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
  if (status.state === 'failed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.stack ?? err.message); process.exitCode = 1; });
}
