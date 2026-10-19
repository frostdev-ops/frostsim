import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dirs = [];
const runner = fileURLToPath(new URL('./run-engine-update.sh', import.meta.url));
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

it.skipIf(!existsSync(runner))('shares one manual-run budget identity across both channels and both native phases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frostsim-runner-')); dirs.push(dir);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const log = join(dir, 'calls');
  const node = join(bin, 'node');
  writeFileSync(node, '#!/bin/bash\nif [ "$1" = scripts/update-engines.mjs ]; then printf "%s|%s\\n" "${FROSTSIM_UPDATER_RUN_ID:-}" "$*" >>"$FROSTSIM_TEST_RUNNER_LOG"; else exec "$FROSTSIM_TEST_NODE" "$@"; fi\n'); chmodSync(node, 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FROSTSIM_TEST_NODE: process.execPath, FROSTSIM_TEST_RUNNER_LOG: log };
  delete env.INVOCATION_ID; delete env.FROSTSIM_UPDATER_RUN_ID;
  execFileSync('bash', [runner, '--output', join(dir, 'output')], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))), env,
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => line.split('|'));
  expect(calls).toHaveLength(4);
  const ids = new Set(calls.map(([id]) => id)); expect(ids.size).toBe(1); expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.map(([, args]) => args.match(/--channel (live|ptr)/)[1])).toEqual(['live', 'ptr', 'live', 'ptr']);
  expect(calls.map(([, args]) => args.includes('--native-only'))).toEqual([false, false, true, true]);
});
