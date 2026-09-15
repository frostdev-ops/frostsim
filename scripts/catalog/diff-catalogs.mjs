#!/usr/bin/env node
// Diff two catalogs; flag changes needing review (P05.12). Coverage regression and file removal always flagged.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_THRESHOLD = 5; // percent

function readManifest(dir) {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`no manifest.json in ${dir}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Two most recently generated catalogs under public/catalogs.
function latestTwo(root = 'public/catalogs') {
  if (!existsSync(root)) throw new Error(`${root} does not exist`);
  const dirs = readdirSync(root)
    .map((name) => join(root, name))
    .filter((d) => existsSync(join(d, 'manifest.json')))
    .sort((a, b) => statSync(join(b, 'manifest.json')).mtimeMs - statSync(join(a, 'manifest.json')).mtimeMs);
  if (dirs.length < 2) throw new Error(`need two catalogs under ${root}, found ${dirs.length}`);
  return [dirs[1], dirs[0]];
}

export function diffManifests(before, after, thresholdPercent = DEFAULT_THRESHOLD) {
  const notes = [];
  const review = [];

  if (before.catalogId === after.catalogId) {
    notes.push(`Both catalogs are ${after.catalogId}: same engine data and same upstream commit.`);
  } else {
    notes.push(`catalogId ${before.catalogId} -> ${after.catalogId}`);
  }
  for (const key of ['clientDataVersion', 'simcWowVersion', 'hotfixBuild', 'hotfixHash', 'upstreamCommit']) {
    const a = before.engine?.[key];
    const b = after.engine?.[key];
    if (a !== b) notes.push(`engine.${key}: ${a} -> ${b}`);
  }

  // --- counts --------------------------------------------------------------
  const counts = [];
  const keys = [...new Set([...Object.keys(before.counts ?? {}), ...Object.keys(after.counts ?? {})])].sort();
  for (const key of keys) {
    const a = before.counts?.[key];
    const b = after.counts?.[key];
    if (a === b) continue;
    const percent = typeof a === 'number' && a !== 0 && typeof b === 'number'
      ? ((b - a) / a) * 100
      : null;
    const entry = { key, before: a ?? null, after: b ?? null, percent };
    counts.push(entry);
    if (a === undefined) {
      notes.push(`count ${key}: new, ${b}`);
    } else if (b === undefined) {
      review.push(`count ${key} disappeared (was ${a})`);
    } else if (percent !== null && Math.abs(percent) >= thresholdPercent) {
      review.push(`count ${key} moved ${percent.toFixed(1)}% (${a} -> ${b})`);
    }
  }

  // --- files ---------------------------------------------------------------
  const beforeFiles = new Map((before.files ?? []).map((f) => [f.path, f]));
  const afterFiles = new Map((after.files ?? []).map((f) => [f.path, f]));
  const added = [...afterFiles.keys()].filter((p) => !beforeFiles.has(p));
  const removed = [...beforeFiles.keys()].filter((p) => !afterFiles.has(p));
  const changed = [...afterFiles.keys()].filter(
    (p) => beforeFiles.has(p) && beforeFiles.get(p).sha256 !== afterFiles.get(p).sha256,
  );
  const unchanged = [...afterFiles.keys()].filter(
    (p) => beforeFiles.has(p) && beforeFiles.get(p).sha256 === afterFiles.get(p).sha256,
  );

  for (const p of added) notes.push(`file added: ${p}`);
  // Removed file = runtime 404 for consumers that ask for it.
  for (const p of removed) review.push(`file removed: ${p}`);

  // --- coverage ------------------------------------------------------------
  const rank = { verified: 2, partial: 1, unavailable: 0 };
  const beforeCoverage = new Map((before.coverage ?? []).map((c) => [c.field, c]));
  const coverage = [];
  for (const c of after.coverage ?? []) {
    const old = beforeCoverage.get(c.field);
    if (!old) { notes.push(`coverage field added: ${c.field} (${c.status})`); continue; }
    if (old.status === c.status) continue;
    coverage.push({ field: c.field, before: old.status, after: c.status });
    if (rank[c.status] < rank[old.status]) {
      review.push(`coverage REGRESSED: ${c.field} ${old.status} -> ${c.status}`);
    } else {
      notes.push(`coverage improved: ${c.field} ${old.status} -> ${c.status}`);
    }
  }
  for (const field of beforeCoverage.keys()) {
    if (!(after.coverage ?? []).some((c) => c.field === field)) {
      review.push(`coverage field removed: ${field}`);
    }
  }

  // --- loot ----------------------------------------------------------------
  const lootBefore = before.loot ?? null;
  const lootAfter = after.loot ?? null;
  if (lootBefore && !lootAfter) review.push('loot data was present and is now absent');
  else if (!lootBefore && lootAfter) notes.push(`loot data added: ${lootAfter.sources} sources`);
  else if (lootBefore && lootAfter && lootBefore.sources !== lootAfter.sources) {
    const percent = lootBefore.sources ? ((lootAfter.sources - lootBefore.sources) / lootBefore.sources) * 100 : null;
    const line = `loot sources ${lootBefore.sources} -> ${lootAfter.sources}`;
    if (percent !== null && Math.abs(percent) >= thresholdPercent) review.push(`${line} (${percent.toFixed(1)}%)`);
    else notes.push(line);
  }

  return {
    needsReview: review.length > 0,
    review,
    notes,
    counts,
    coverage,
    files: { added, removed, changed, unchanged: unchanged.length },
    thresholdPercent,
  };
}

function main(argv) {
  const thresholdIdx = argv.indexOf('--threshold');
  const threshold = thresholdIdx >= 0 ? Number(argv[thresholdIdx + 1]) : DEFAULT_THRESHOLD;
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--threshold');

  const [oldDir, newDir] = argv.includes('--latest')
    ? latestTwo()
    : positional.slice(0, 2).map((p) => resolve(p));

  if (!oldDir || !newDir) {
    console.error('usage: diff-catalogs.mjs <old-dir> <new-dir> [--threshold 5]  |  --latest');
    return 2;
  }

  const result = diffManifests(readManifest(oldDir), readManifest(newDir), threshold);

  console.log(`catalog diff  ${oldDir}  ->  ${newDir}`);
  console.log(`threshold ${result.thresholdPercent}% on counts\n`);

  if (result.notes.length) {
    console.log('changes:');
    for (const n of result.notes) console.log(`  ${n}`);
    console.log();
  }

  console.log(
    `files: ${result.files.added.length} added, ${result.files.removed.length} removed, ` +
    `${result.files.changed.length} changed, ${result.files.unchanged} identical`,
  );
  for (const p of result.files.changed) console.log(`  changed: ${p}`);
  console.log();

  if (!result.needsReview) {
    console.log('Nothing needs review.');
    return 0;
  }
  console.log('NEEDS REVIEW:');
  for (const r of result.review) console.log(`  ${r}`);
  console.log('\nCheck these before shipping the new catalog. A count that moved a long way');
  console.log('usually means an upstream table changed shape, not that the game did.');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`catalog diff failed: ${err.message}`);
    process.exitCode = 2;
  }
}
