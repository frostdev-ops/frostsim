#!/usr/bin/env node
// Lock/source/recipe/byte checks plus deterministic packaging; never publishes or invokes the updater.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { engineCompat, COMPAT_INPUTS } from './engine-compat.mjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const channel = arg('--channel', 'live');
assert.ok(['live', 'ptr'].includes(channel), '--channel requires live or ptr');
const lock = JSON.parse(readFileSync(join(root, 'engine.lock.json'), 'utf8'));
const upstream = join(root, lock.upstream.path);
assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), lock.upstream.commit);
assert.equal(execFileSync('git', ['-C', upstream, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'upstream must be clean');
const engineRoot = resolve(arg('--engine-root', join(root, 'public/engine')));
const sourceDir = channel === 'ptr' ? join(engineRoot, 'ptr') : engineRoot;
const output = resolve(arg('--out', join(root, `build/engine-package-${channel}`)));
mkdirSync(output, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const packs = [];
for (const repetition of ['first', 'second']) {
  const target = join(output, repetition);
  mkdirSync(join(target, 'source'), { recursive: true });
  for (const variant of ['threaded', 'fallback']) {
    const dir = variant === 'fallback' ? join(sourceDir, 'fallback') : sourceDir;
    const destination = variant === 'fallback' ? join(target, 'fallback') : target;
    mkdirSync(destination, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.artifact, variant);
    assert.equal(manifest.engineChannel ?? 'live', channel);
    assert.equal(manifest.engine.upstreamCommit, lock.upstream.commit);
    assert.equal(manifest.build.toolchain.emcc, lock.toolchain.emsdk.version);
    assert.deepEqual(manifest.lockMismatches ?? [], []);
    assert.deepEqual(manifest.buildTreeMismatches ?? [], []);
    assert.ok(manifest.build.cxxFlags.includes(`-DSC_USE_PTR=${channel === 'ptr' ? 1 : 0}`));
    assert.ok(manifest.build.cxxFlags.includes('-fwasm-exceptions') && manifest.build.linkFlags.includes('-fwasm-exceptions'));
    assert.equal(manifest.capabilities.threads, variant === 'threaded');
    assert.equal(manifest.capabilities.profilesets, variant === 'threaded');
    for (const name of ['simc.js', 'simc.wasm']) {
      const bytes = readFileSync(join(dir, name));
      assert.equal(sha256(bytes), manifest.files[name].sha256, `${variant}/${name}: mismatched hash`);
      assert.equal(bytes.length, manifest.files[name].bytes);
      writeFileSync(join(destination, name), bytes);
      writeFileSync(join(destination, `${name}.gz`), gzipSync(bytes, { level: 9 }));
      writeFileSync(join(destination, `${name}.br`), brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }));
    }
    cpSync(join(dir, 'manifest.json'), join(destination, 'manifest.json'));
  }
  cpSync(join(root, 'public/engine/sim-worker.js'), join(target, 'sim-worker.js'));
  execFileSync('git', ['-C', upstream, 'archive', '--format=tar.gz', `--output=${join(target, 'source/simc.tar.gz')}`, lock.upstream.commit]);
  for (const path of [...COMPAT_INPUTS, 'scripts/bootstrap-engine.mjs', 'scripts/check-engine-package.mjs', 'scripts/engine-compat.mjs', 'engine.lock.json', 'package.json', 'package-lock.json', '.nvmrc']) {
    const to = join(target, 'source', path);
    mkdirSync(resolve(to, '..'), { recursive: true });
    cpSync(join(root, path), to, { recursive: true, filter: file => !file.split('/').at(-1).includes(' ') && !file.split('/').at(-1).startsWith('._') });
  }
  cpSync(join(root, lock.upstream.licenseFile), join(target, 'source/LICENSE-simc'));
  const files = {};
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else { const bytes = readFileSync(path); files[relative(target, path)] = { bytes: bytes.length, sha256: sha256(bytes) }; }
    }
  };
  walk(target);
  packs.push(files);
}
assert.deepEqual(packs[0], packs[1], 'identical inputs did not package reproducibly');
const record = { schemaVersion: 1, channel, upstreamCommit: lock.upstream.commit, compat: engineCompat(root),
  toolchain: lock.toolchain, files: packs[0], packagingReproduced: true,
  compilerRebuildReproduced: false, scope: 'Two deterministic packages of the same hash-verified compiler outputs; independent compiler rebuild is not established.' };
writeFileSync(join(output, 'package-check.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`Engine ${channel}: locked source, both variants, corresponding source and deterministic packaging verified: ${output}`);
