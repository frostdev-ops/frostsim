#!/usr/bin/env node
// CI and release validation use the same schema/reference checks as browser loading.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { brotliCompressSync, constants } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const directory = argv[0];
if (!directory || directory.startsWith('--')) throw Error('Usage: node scripts/catalog/validate-catalogs.mjs <catalog-directory> [--engine <manifest-path>]');
const bundled = await build({ entryPoints: [join(root, 'src/lib/catalog/validation.ts')], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent' });
const { manifestProblems, payloadProblems, talentTreeProblems, lootProblems } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const json = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const manifest = json('manifest.json');
const problems = manifestProblems(manifest);
if (problems.length) throw Error(problems.join('\n'));
for (const file of manifest.files) {
  const bytes = readFileSync(join(directory, file.path));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) problems.push(`${file.path}: size/hash mismatch`);
  if (brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).length !== file.brotliBytes) problems.push(`${file.path}: Brotli size mismatch`);
  if (file.path.startsWith('talents/')) problems.push(...talentTreeProblems(JSON.parse(bytes.toString())).map(problem => `${file.path}: ${problem}`));
}
const payloads = { manifest, items: json('items.json'), bonus: json('item-bonus.json'), scaling: json('scaling.json'),
  enchants: json('enchants.json'), gems: json('gems.json'), sets: json('sets.json'),
  embellishments: json('embellishments.json'), consumables: json('consumables.json'), rules: json('rules.json') };
problems.push(...payloadProblems(payloads));
if (manifest.loot) {
  const loot = json(manifest.loot.path);
  problems.push(...lootProblems(loot));
  if (loot.expiresAt !== manifest.loot.expiresAt || loot.sources.length !== manifest.loot.sources) problems.push('Loot metadata disagrees with manifest.');
  const known = new Set(payloads.items.id);
  const unknown = new Set(loot.sources.flatMap(source => source.itemIds).filter(id => !known.has(id)));
  if (unknown.size) console.warn(`Unresolved loot item IDs (${unknown.size}): ${[...unknown].join(', ')}. Recommendations remain unavailable for these items.`);
}
const engineIndex = argv.indexOf('--engine');
if (engineIndex >= 0) {
  const engine = JSON.parse(readFileSync(argv[engineIndex + 1], 'utf8'));
  if ((engine.engineChannel ?? 'live') !== (manifest.engineChannel ?? 'live')
    || engine.engine.upstreamCommit !== manifest.engine.upstreamCommit
    || engine.wow.clientDataVersion !== manifest.engine.clientDataVersion
    || engine.wow.hotfixHash !== manifest.engine.hotfixHash) problems.push('Catalog identity disagrees with selected engine manifest.');
}
if (problems.length) throw Error(problems.join('\n'));
console.log(`Catalog ${manifest.catalogId}: ${manifest.files.length} hashed files and schema/reference checks passed.`);
