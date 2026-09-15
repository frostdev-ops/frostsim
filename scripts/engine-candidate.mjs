#!/usr/bin/env node
// Report candidate upstream changes before build (PLAN P14.22): diff step of update cycle. Fetches but never changes checkout.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'engine.lock.json'), 'utf8'));
const dir = join(root, lock.upstream.path);
const locked = lock.upstream.commit;

const git = (...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')}: ${(r.stderr ?? '').trim().slice(0, 300)}`);
  return r.stdout.trim();
};

const before = git('rev-parse', 'HEAD');
if (before !== locked) {
  console.error(`engine-candidate: vendor/simc is at ${before}, lock says ${locked}. Run npm run engine:bootstrap first.`);
  process.exit(1);
}

const requested = process.argv[2];
console.log(`fetching ${requested ?? lock.upstream.branch} from ${lock.upstream.remote}...`);
try {
  execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin',
    requested ?? lock.upstream.branch], { stdio: 'inherit' });
} catch {
  console.error('engine-candidate: fetch failed. Is the candidate ref reachable on origin?');
  process.exit(1);
}
const candidate = git('rev-parse', requested ?? 'FETCH_HEAD');

if (candidate === locked) {
  console.log(`\nAlready locked to ${locked.slice(0, 12)}. Nothing to compare.`);
  process.exit(0);
}

const show = (rev, path) => {
  const r = spawnSync('git', ['-C', dir, 'show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};
const define = (text, name) =>
  text?.match(new RegExp(`^#define\\s+${name}\\s+(.+)$`, 'm'))?.[1].trim().replace(/^"|"$/g, '') ?? null;

console.log(`\n${'='.repeat(78)}`);
console.log(`locked    ${locked}`);
console.log(`candidate ${candidate}  (${git('log', '-1', '--format=%ci %s', candidate)})`);
console.log(`${git('rev-list', '--count', `${locked}..${candidate}`)} commits ahead`);
console.log('='.repeat(78));

// --- game data identity -----------------------------------------------------------------------
const DATA = 'engine/dbc/generated/client_data_version.inc';
const oldData = show(locked, DATA);
const newData = show(candidate, DATA);
const dataFields = ['CLIENT_DATA_WOW_VERSION', 'CLIENT_DATA_HOTFIX_DATE', 'CLIENT_DATA_HOTFIX_BUILD', 'CLIENT_DATA_HOTFIX_HASH'];
console.log('\nGame data');
let dataChanged = false;
for (const field of dataFields) {
  const a = define(oldData, field);
  const b = define(newData, field);
  if (a === b) continue;
  dataChanged = true;
  console.log(`  ${field}: ${a} -> ${b}`);
}
if (!dataChanged) console.log('  unchanged — catalogs built against the locked engine stay valid');
else console.log('  CHANGED — catalogs must be regenerated and the catalog key changes with it');

const oldVersion = define(show(locked, 'engine/config.hpp'), 'SC_MAJOR_VERSION');
const newVersion = define(show(candidate, 'engine/config.hpp'), 'SC_MAJOR_VERSION');
console.log(`\nsimc version: ${oldVersion} -> ${newVersion}${oldVersion === newVersion ? ' (unchanged)' : ' CHANGED'}`);

// --- the things we actually send and read -----------------------------------------------------
const changedFiles = git('diff', '--name-only', locked, candidate).split('\n').filter(Boolean);

const buckets = {
  'option parsing (what we send)': ['engine/sim/sim.cpp', 'engine/sim/option.cpp', 'engine/sim/profileset.cpp'],
  'JSON report (what we read)': ['engine/report/json/report_json.cpp', 'engine/report/json/Changelog.md'],
  'threading / build config': ['engine/util/concurrency.cpp', 'CMakeLists.txt', 'engine/CMakeLists.txt', 'engine/config.hpp'],
};
console.log('\nFiles we depend on');
for (const [label, paths] of Object.entries(buckets)) {
  const hits = paths.filter((p) => changedFiles.includes(p));
  console.log(`  ${label}: ${hits.length ? hits.join(', ') : 'unchanged'}`);
}

// Patches are the thing most likely to break silently on an update: a patch that no longer
// applies fails the build, but a patch that still applies to changed code is the dangerous one.
const patchTouched = changedFiles.filter((f) =>
  ['engine/report/charts.cpp', 'engine/report/charts.hpp', 'engine/report/report_text.cpp',
    'engine/report/report_html_sim.cpp', 'engine/sim/profileset.cpp'].includes(f));
console.log(`  files our patches touch: ${patchTouched.length ? `${patchTouched.join(', ')} — REVIEW patches/ before building` : 'unchanged'}`);

// --- profiles ----------------------------------------------------------------------------------
const profiles = (rev) => {
  const r = spawnSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', rev, 'profiles/'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set((r.stdout ?? '').split('\n').filter((p) => p.endsWith('.simc')));
};
const oldProfiles = profiles(locked);
const newProfiles = profiles(candidate);
const added = [...newProfiles].filter((p) => !oldProfiles.has(p));
const removed = [...oldProfiles].filter((p) => !newProfiles.has(p));
console.log(`\nProfiles: ${oldProfiles.size} -> ${newProfiles.size}`);
if (added.length) console.log(`  added (${added.length}): ${added.slice(0, 6).join(', ')}${added.length > 6 ? ', …' : ''}`);
if (removed.length) console.log(`  REMOVED (${removed.length}): ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? ', …' : ''} — anything pinned to these breaks`);
if (!added.length && !removed.length) console.log('  unchanged');

console.log(`\n${changedFiles.length} files changed in total.`);
console.log('\nTo adopt: set upstream.commit and the expected.* fields in engine.lock.json to the');
console.log('candidate, then npm run engine:bootstrap && npm run engine:build. The build refuses');
console.log('to run until the lock and the checkout agree, and the manifest records what changed.');

// Leave the checkout exactly as found.
const after = git('rev-parse', 'HEAD');
if (after !== before) {
  console.error(`\nengine-candidate: WARNING vendor/simc moved from ${before} to ${after}`);
  process.exit(1);
}
