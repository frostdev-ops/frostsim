// App <-> engine pack contract key. An app runs only packs whose `compat` equals its own.
// Inputs are exactly what a pack's bytes and formats come from: the worker, the build recipe,
// the catalog/talent/presentation generators and the option surface the app sends. UI-only
// changes leave it alone, so they never force an engine rebuild.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const COMPAT_INPUTS = [
  'public/engine/sim-worker.js',
  'patches',
  'scripts/build-engine.sh',
  'scripts/engine-manifest.mjs',
  'scripts/catalog',
  'scripts/generate-talent-layout.mjs',
  'scripts/generate-presentation.mjs',
  'src/lib/simc/actor-options.generated.ts',
];

// The actor-options header names the upstream commit; the body is the contract. Every input is
// text, and CRLF checkouts (Windows, autocrlf) must hash like the LF archive the updater builds from.
const normalize = (file, bytes) => {
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
  return file.endsWith('actor-options.generated.ts') ? text.replace(/^\/\/ Upstream commit: .*$/m, '') : text;
};

function files(root, path) {
  const full = join(root, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full, { withFileTypes: true })
    // Tests and sync-conflict copies ("x 2.mjs") are not part of the recipe.
    .filter(entry => !entry.name.includes(' ') && !/\.test\.[cm]?[jt]s$/.test(entry.name))
    // Always '/' so a Windows build and the Linux updater agree.
    .flatMap(entry => files(root, `${path}/${entry.name}`));
}

export function engineCompat(root) {
  const hash = createHash('sha256');
  for (const file of COMPAT_INPUTS.flatMap(path => files(root, path)).sort()) {
    hash.update(`${file}\0`);
    hash.update(normalize(file, readFileSync(join(root, file))));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}
