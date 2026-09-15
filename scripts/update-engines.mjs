#!/usr/bin/env node
// Daily release discovery and isolated engine builds; index replaced LAST.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'https://api.github.com/repos/simulationcraft/simc';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const run = (cwd, command, args, extra = {}) => execFileSync(command, args, {
  cwd, stdio: 'inherit', env: { ...process.env, CMAKE_BUILD_PARALLEL_LEVEL: process.env.CMAKE_BUILD_PARALLEL_LEVEL || '1' }, ...extra,
});

export function releaseChannel(release) {
  const name = `${release.tag_name} ${release.name ?? ''}`.toLowerCase();
  if (/(?:^|[^a-z])nightly(?:[^a-z]|$)/.test(name)) return 'nightly';
  if (/(?:^|[^a-z])alpha(?:\d|[^a-z]|$)/.test(name)) return 'alpha';
  if (/(?:^|[^a-z])beta(?:\d|[^a-z]|$)/.test(name)) return 'beta';
  if (release.prerelease || /(?:^|[^a-z])rc(?:\d|[^a-z]|$)/.test(name)) return 'prerelease';
  return 'stable';
}

async function github(path) {
  const response = await fetch(`${api}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'frostsim-engine-updater' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}

async function pages(path) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await github(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub list');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error('GitHub pagination exceeded 2,000 entries; refusing a partial release list');
}

export async function discover() {
  const [releases, tags, ci] = await Promise.all([pages('/releases'), pages('/tags'),
    github('/actions/workflows/main.yml/runs?branch=midnight&event=push&status=success&per_page=20')]);
  const latest = new Map();
  for (const release of releases.filter(r => !r.draft).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))) {
    const channel = releaseChannel(release);
    if (!latest.has(channel)) latest.set(channel, { channel, ref: release.tag_name });
  }
  // SimC publishes release-* tags instead of GitHub Releases historically.
  const tagged = tags.filter(t => /^release-\d+-\d+$/.test(t.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
  if (!latest.has('stable') && tagged.length) latest.set('stable', { channel: 'stable', ref: tagged[0].name });
  for (const tag of tags.sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))) {
    const channel = releaseChannel({ tag_name: tag.name });
    if (channel !== 'stable' && !latest.has(channel)) latest.set(channel, { channel, ref: tag.name });
  }
  const tested = ci.workflow_runs?.find(run => run.status === 'completed' && run.conclusion === 'success'
    && run.event === 'push' && run.head_branch === 'midnight' && run.path === '.github/workflows/main.yml'
    && run.repository?.full_name === 'simulationcraft/simc' && run.head_repository?.full_name === 'simulationcraft/simc'
    && /^[a-f0-9]{40}$/.test(run.head_sha));
  if (!tested) throw new Error('No successful upstream midnight CI source was available');
  // Frostsim's nightly source build, not simc-publish binaries.
  latest.set('nightly', { channel: 'nightly', ref: tested.head_sha, ciUrl: tested.html_url });
  return [...latest.values()];
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
  for (const file of catalog.files) assert.equal(sha256(readFileSync(join(pack, 'catalog', file.path))), file.sha256);
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

async function build(candidate, commit, config, output, id) {
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
    // Checks read static routes and version list; no prebuilt engine copied.
    for (const file of ['routes', 'engine-versions.json', 'sw.js']) cpSync(join(root, 'public', file), join(work, 'public', file), { recursive: true });
    run(work, 'git', ['init', '-q']);
    const lock = json(join(work, 'engine.lock.json'));
    lock.upstream.commit = commit;
    lock.upstream.branch = candidate.ref;
    lock.upstream.commitDate = candidate.date;
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
    assert.equal(actorBody(readFileSync(actors, 'utf8')), previousActors, 'Actor option contract changed; update the application first');
    const weekly = join(work, 'src/lib/simc/generated/weekly-defaults.json');
    const previousWeekly = json(weekly);
    run(work, 'node', ['scripts/generate-weekly-defaults.mjs']);
    const generatedWeekly = json(weekly);
    assert.deepEqual(generatedWeekly.rules, previousWeekly.rules, 'Guided consumable defaults changed; update the application first');
    assert.deepEqual(generatedWeekly.weekly, previousWeekly.weekly);
    run(work, 'bash', ['scripts/build-engine.sh']);
    run(work, 'bash', ['scripts/build-engine.sh', '--fallback']);
    const dataEnv = process.env.FROSTSIM_DATA_ENV_FILE;
    if (!dataEnv || !existsSync(dataEnv)) throw new Error('FROSTSIM_DATA_ENV_FILE must name the protected Blizzard data credential file');
    run(work, 'node', [`--env-file=${resolve(dataEnv)}`, 'scripts/catalog/build-catalogs.mjs', '--out', join(work, 'public/engine/catalog')]);
    const talentCache = join(process.env.FROSTSIM_TALENT_CACHE || join(root, 'build'), `talent-layout-${lock.expected.clientDataWowVersion}`);
    run(work, 'node', [`--env-file=${resolve(dataEnv)}`, 'scripts/generate-talent-layout.mjs',
      '--catalog', join(work, 'public/engine/catalog'), '--out', join(work, 'public/engine/talent-layout'), '--cache', talentCache]);
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
    for (const file of walk(pack)) if (/\.(wasm|js|json)$/.test(file)) writeFileSync(`${file}.gz`, gzipSync(readFileSync(file)));
    const target = join(output, 'engine/versions', id);
    const staging = `${target}.staging`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(pack, staging, { recursive: true });
    renameSync(staging, target);
    return lock.expected.simcVersion;
  } finally { if (!process.env.FROSTSIM_BUILD_WORKSPACE) rmSync(work, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    assert.equal(releaseChannel({ tag_name: '1210-01', prerelease: false }), 'stable');
    assert.equal(releaseChannel({ tag_name: 'v1210-beta2', prerelease: false }), 'beta');
    assert.equal(releaseChannel({ tag_name: 'v1210-alpha.1', prerelease: true }), 'alpha');
    assert.equal(releaseChannel({ tag_name: 'nightly-20260915', prerelease: false }), 'nightly');
    assert.equal(releaseChannel({ tag_name: 'v1210-rc1', prerelease: false }), 'prerelease');
    assert.equal(releaseChannel({ tag_name: '1210-01', prerelease: true }), 'prerelease');
    console.log('Engine release classification checks passed');
    return;
  }
  const output = resolve(args[args.indexOf('--output') + 1] || 'public');
  if (!args.includes('--output') && !args.includes('--discover')) throw new Error('Pass --output <persistent public directory> or --discover');
  const lock = json(join(root, 'engine.lock.json'));
  const refIndex = args.indexOf('--ref');
  const candidates = refIndex === -1 ? await discover() : [{ channel: 'nightly', ref: args[refIndex + 1] }];
  if (refIndex !== -1 && !/^[a-f0-9]{40}$/.test(args[refIndex + 1] ?? '')) throw new Error('--ref requires a full immutable source commit');
  const indexPath = join(output, 'engine-versions.json');
  const index = existsSync(indexPath) ? json(indexPath) : json(join(root, 'public/engine-versions.json'));
  // Artifact identity includes adapter and recipe, not just upstream SHA.
  const recipe = sha256(Buffer.concat([...walk(join(root, 'patches')), ...walk(join(root, 'scripts')), ...walk(join(root, 'src/lib/simc')),
    join(root, 'public/engine/sim-worker.js'), join(root, 'engine.lock.json')]
    .sort().map(file => readFileSync(file)))).slice(0, 12);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const taggedVersion = /^release-(\d+)-/.exec(candidate.ref)?.[1];
      if (taggedVersion && taggedVersion !== lock.expected.simcVersion.split('-')[0]) {
        console.log(`Skipped ${candidate.ref}: different game version from ${lock.expected.simcVersion}`);
        continue;
      }
      const revision = await github(`/commits/${encodeURIComponent(candidate.ref)}`);
      const commit = revision.sha;
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid upstream commit');
      const config = await sourceText(commit, 'engine/config.hpp');
      if (candidate.channel === 'nightly' && /^#define\s+SC_BETA\s+1\b/m.test(config)) candidate.channel = 'beta';
      // App sends game-version-specific options; expansion change needs app update.
      if (define(config, 'SC_MAJOR_VERSION') !== lock.expected.simcVersion.split('-')[0]) {
        console.log(`Skipped ${candidate.ref}: different game version from ${lock.expected.simcVersion}`);
        continue;
      }
      candidate.date = revision.commit.committer.date;
      console.log(`${candidate.channel}: ${candidate.ref} @ ${commit}`);
      if (args.includes('--discover')) continue;
      const id = `${candidate.channel}-${commit.slice(0, 12)}-${recipe}`;
      if (index.versions.some(v => v.id === id)) continue;
      mkdirSync(join(output, 'engine/versions'), { recursive: true });
      const pack = join(output, 'engine/versions', id);
      let version;
      if (existsSync(pack)) { verifyPack(pack, commit); version = json(join(pack, 'manifest.json')).engine.simcVersion; }
      else version = await build(candidate, commit, config, output, id);
      index.versions.push({ id, label: `${version} · ${candidate.channel} · ${candidate.date.slice(0, 10)} · ${commit.slice(0, 7)}`,
        channel: candidate.channel, baseUrl: `/engine/versions/${id}/`, upstreamCommit: commit, publishedAt: candidate.date, ciUrl: candidate.ciUrl });
      if (existsSync(indexPath)) cpSync(indexPath, `${indexPath}.previous`);
      writeJson(`${indexPath}.tmp`, index);
      renameSync(`${indexPath}.tmp`, indexPath);
      console.log(`Published ${id}`);
    } catch (err) { failures.push(`${candidate.ref}: ${err.message}`); }
  }
  if (!args.includes('--discover')) {
    const eligible = [...index.versions].reverse().filter(v => v.channel === 'stable' || v.channel === 'nightly')
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    const preferred = eligible.find(v => v.channel === 'stable') ?? eligible[0];
    if (preferred && index.defaultId !== preferred.id) {
      index.defaultId = preferred.id;
      if (existsSync(indexPath)) cpSync(indexPath, `${indexPath}.previous`);
      writeJson(`${indexPath}.tmp`, index);
      renameSync(`${indexPath}.tmp`, indexPath);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`Daily engine check complete; automatic engine: ${index.defaultId}; previous versions retained.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
