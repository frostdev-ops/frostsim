#!/usr/bin/env node
// Emit public/engine/manifest.json: identity and capability record of built engine (PLAN P00.7, P02.1).
// Every field read from actual build (checkout, CMake cache, binary); nothing hand-retyped; maxThreads from -sPTHREAD_POOL_SIZE (D11).
// Usage: node scripts/engine-manifest.mjs [--build-dir build/wasm] [--engine-dir public/engine] [--no-compression]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const buildDir = resolve(root, arg('--build-dir', 'build/wasm'));
// Which tree compiler read and which patches were in it; fallback built from staged copy with patches; reference checkout never modified.
const sourceTreeArg = arg('--source-tree', null);
const patchFiles = argv.reduce((acc, a, i) => (a === '--patch' ? [...acc, argv[i + 1]] : acc), []);
const engineDir = resolve(root, arg('--engine-dir', 'public/engine'));
const measureCompression = !argv.includes('--no-compression');

const read = (p) => readFileSync(p, 'utf8');
const define = (text, name) => {
  const m = text.match(new RegExp(`^#define\\s+${name}\\s+(.+)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^"|"$/g, '').replace(/^\(|\)$/g, '');
};

// --- upstream identity -------------------------------------------------------------------
const lock = JSON.parse(read(join(root, 'engine.lock.json')));
// Identity from reference checkout only; patched copy would let a patch rewrite provenance.
const simcDir = resolve(root, lock.upstream.path);
const sourceTree = sourceTreeArg ?? lock.upstream.path;

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', simcDir, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const checkoutCommit = git('rev-parse', 'HEAD');
const config = read(join(simcDir, 'engine/config.hpp'));
const simcVersion = `${define(config, 'SC_MAJOR_VERSION')}-${define(config, 'SC_MINOR_VERSION')}`;
const dataVersion = read(join(simcDir, 'engine/dbc/generated/client_data_version.inc'));
const wow = {
  clientDataVersion: define(dataVersion, 'CLIENT_DATA_WOW_VERSION'),
  hotfixDate: define(dataVersion, 'CLIENT_DATA_HOTFIX_DATE'),
  hotfixBuild: Number(define(dataVersion, 'CLIENT_DATA_HOTFIX_BUILD')),
  hotfixHash: define(dataVersion, 'CLIENT_DATA_HOTFIX_HASH'),
};

// Lock is release contract; checkout is what got compiled; report disagreements in manifest, never ship silent mismatches.
const mismatches = [];
if (checkoutCommit && checkoutCommit !== lock.upstream.commit) {
  mismatches.push(`upstream commit: lock ${lock.upstream.commit}, checkout ${checkoutCommit}`);
}
for (const [key, field] of [
  ['simcVersion', simcVersion],
  ['clientDataWowVersion', wow.clientDataVersion],
  ['clientDataHotfixDate', wow.hotfixDate],
  ['clientDataHotfixHash', wow.hotfixHash],
]) {
  if (lock.expected?.[key] && lock.expected[key] !== field) {
    mismatches.push(`${key}: lock ${lock.expected[key]}, checkout ${field}`);
  }
}

// --- build identity ----------------------------------------------------------------------
const cachePath = join(buildDir, 'CMakeCache.txt');
if (!existsSync(cachePath)) {
  console.error(`engine-manifest: no CMake cache at ${cachePath}. Build first: npm run engine:build`);
  process.exit(1);
}
const cmakeCache = read(cachePath);
const cacheVar = (name) => {
  const m = cmakeCache.match(new RegExp(`^${name}:[A-Z]+=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
};
const cxxFlags = cacheVar('CMAKE_CXX_FLAGS') ?? '';
const linkFlags = cacheVar('CMAKE_EXE_LINKER_FLAGS') ?? '';
const flags = `${cxxFlags} ${linkFlags}`;
const linkOpt = (name) => {
  const m = flags.match(new RegExp(`-s${name}=([^\\s]+)`));
  return m ? m[1] : null;
};

// --- artifact truth ------------------------------------------------------------------------
// CMake cache records last *configured* state (not necessarily how linked); glue is the truth for capabilities; cache cross-checked.
const gluePath = join(engineDir, 'simc.js');
if (!existsSync(gluePath)) {
  console.error(`engine-manifest: ${gluePath} missing. Run npm run engine:install after a build.`);
  process.exit(1);
}
const glue = read(gluePath);
const glueNumber = (re) => {
  const m = glue.match(re);
  return m ? Number(m[1]) : null;
};

const threading = /var pthreadPoolSize\s*=/.test(glue);
const poolSize = threading ? glueNumber(/var pthreadPoolSize\s*=\s*(\d+)/) : 0;
if (threading && !Number.isFinite(poolSize)) {
  console.error('engine-manifest: threaded artifact whose glue has no readable pthreadPoolSize.');
  process.exit(1);
}

// All app loader dependencies read from artifact, not assumed.
const artifactFlags = {
  pthreadPoolSize: poolSize,
  initialMemory: glueNumber(/INITIAL_MEMORY\s*=\s*(\d+)/),
  es6Module: /\bexport default\b/.test(glue),
  exportName: glue.match(/\b(createSimc)\b/)?.[1] ?? null,
};

// Disagreement = artifact not from this build tree with these flags = not reproducible = release blocker.
const buildTreeMismatches = [];
const configuredPool = Number(linkOpt('PTHREAD_POOL_SIZE'));
if (threading && Number.isFinite(configuredPool) && configuredPool !== poolSize) {
  buildTreeMismatches.push(`pthread pool: build tree configured ${configuredPool}, artifact has ${poolSize}`);
}
if (artifactFlags.es6Module !== flags.includes('-sEXPORT_ES6=1')) {
  buildTreeMismatches.push(
    `module format: build tree configured ${flags.includes('-sEXPORT_ES6=1') ? 'ES6' : 'classic'}, artifact is ${artifactFlags.es6Module ? 'ES6' : 'classic'}`,
  );
}
if (cacheVar('SC_NO_THREADING') === 'ON' && threading) {
  buildTreeMismatches.push('build tree configured SC_NO_THREADING=ON but the artifact is threaded');
}

const version = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    return null;
  }
};

// --- artifact files ----------------------------------------------------------------------
const sha256 = (path) => {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
};

const compressedSize = async (path, stream) => {
  let bytes = 0;
  const counter = new Writable({
    write(chunk, _e, cb) { bytes += chunk.length; cb(); },
  });
  await pipeline(createReadStream(path), stream, counter);
  return bytes;
};

const manifestPath = join(engineDir, 'manifest.json');
const previous = existsSync(manifestPath) ? JSON.parse(read(manifestPath)) : null;

const files = {};
for (const name of ['simc.js', 'simc.wasm']) {
  const path = join(engineDir, name);
  if (!existsSync(path)) {
    console.error(`engine-manifest: ${path} missing. Run npm run engine:install after a build.`);
    process.exit(1);
  }
  const hash = sha256(path);
  const entry = { bytes: statSync(path).size, sha256: hash };
  const prior = previous?.files?.[name];
  if (prior?.sha256 === hash && prior.gzipBytes && prior.brotliBytes) {
    entry.gzipBytes = prior.gzipBytes;
    entry.brotliBytes = prior.brotliBytes;
  } else if (measureCompression) {
    entry.gzipBytes = await compressedSize(path, createGzip({ level: 9 }));
    entry.brotliBytes = await compressedSize(
      path,
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: entry.bytes,
        },
      }),
    );
  }
  files[name] = entry;
}

// Patches are build identity and GPL corresponding source; hash here so manifest names exact diff, not filename.
const patches = patchFiles.map((file) => {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    console.error(`engine-manifest: patch ${file} does not exist.`);
    process.exit(1);
  }
  return { file: relative(root, path), sha256: sha256(path), bytes: statSync(path).size };
});

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  artifact: threading ? 'threaded' : 'fallback',
  engine: {
    simcVersion,
    upstreamCommit: checkoutCommit ?? lock.upstream.commit,
    upstreamRemote: lock.upstream.remote,
    upstreamBranch: lock.upstream.branch,
    license: lock.upstream.license,
  },
  wow: { ...wow, ptr: !flags.includes('-DSC_USE_PTR=0') },
  capabilities: {
    threads: threading,
    // Hard ceiling on threads=N: main() blocks in callMain, no pthread beyond pool starts, simc deadlocks (D11).
    pthreadPoolSize: poolSize,
    maxThreads: poolSize,
    // Upstream compiles profilesets out with SC_NO_THREADING; fallback runs candidates as sequential independent jobs (P02.7).
    profilesets: threading,
    networking: cacheVar('SC_NO_NETWORKING') !== 'ON',
    reportVersions: [2],
    requiresSharedArrayBuffer: threading,
  },
  build: {
    type: cacheVar('CMAKE_BUILD_TYPE'),
    // Tree compiler read; for patched variant this is staged copy of engine.upstreamCommit, not reference checkout.
    sourceTree: relative(root, resolve(root, sourceTree)) || sourceTree,
    patches,
    cxxFlags,
    linkFlags,
    artifactFlags,
    toolchain: {
      emcc: version('emcc', ['--version'])?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null,
      cmake: version('cmake', ['--version'])?.replace('cmake version ', '') ?? null,
      ninja: version('ninja', ['--version']),
      node: process.version.replace(/^v/, ''),
      platform: `${process.platform}-${process.arch}`,
    },
    lockedToolchain: lock.toolchain,
  },
  files,
  lockMismatches: mismatches,
  buildTreeMismatches,
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`engine-manifest: wrote ${manifestPath}`);
console.log(`  artifact   ${manifest.artifact}, pool ${poolSize}, profilesets ${manifest.capabilities.profilesets}`);
console.log(`  engine     simc ${simcVersion} @ ${manifest.engine.upstreamCommit.slice(0, 7)}, WoW ${wow.clientDataVersion}`);
for (const [name, f] of Object.entries(files)) {
  const comp = f.brotliBytes ? `, ${mb(f.gzipBytes)} MB gzip, ${mb(f.brotliBytes)} MB brotli` : '';
  console.log(`  ${name.padEnd(10)} ${mb(f.bytes)} MB raw${comp}  sha256 ${f.sha256.slice(0, 12)}`);
}
if (buildTreeMismatches.length) {
  console.error('engine-manifest: BUILD TREE MISMATCH — the artifact was not produced by this build tree:');
  for (const m of buildTreeMismatches) console.error(`  ${m}`);
}
if (mismatches.length) {
  console.error('engine-manifest: LOCK MISMATCH — the built artifact is not what engine.lock.json names:');
  for (const m of mismatches) console.error(`  ${m}`);
}
if (mismatches.length || buildTreeMismatches.length) process.exit(2);
