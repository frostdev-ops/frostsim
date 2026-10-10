#!/usr/bin/env node
// Equivalent clean builds: shared locked dependencies, no private legal files or local binaries.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { entryBytes, ENTRY_GROWTH_LIMIT } from './check-surface.mjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const base = arg('--base', 'origin/main');
const candidate = arg('--candidate', 'origin/cloud');
mkdirSync(join(root, 'build'), { recursive: true });
const output = mkdtempSync(join(root, 'build/surface-'));
const builds = [];
for (const [label, ref] of [['base', base], ['candidate', candidate]]) {
  const tree = join(output, label);
  mkdirSync(tree);
  const archive = execFileSync('git', ['archive', ref], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', tree], { input: archive });
  symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'), 'dir');
  execFileSync('npm', ['run', 'build'], {
    cwd: tree, stdio: 'inherit', env: { ...process.env, VITE_FEATURE_ACCOUNTS: '0' },
  });
  builds.push({ ref, commit: execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim(),
    dist: join(tree, 'dist'), ...entryBytes(join(tree, 'dist')) });
}
const growth = builds[1].gzip - builds[0].gzip;
const evidence = { builds, growth, limit: ENTRY_GROWTH_LIMIT, passed: growth <= ENTRY_GROWTH_LIMIT };
writeFileSync(join(output, 'surface.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
assert.ok(evidence.passed, `flag-off entry grew ${growth} B; limit ${ENTRY_GROWTH_LIMIT} B`);
