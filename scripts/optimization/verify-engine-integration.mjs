#!/usr/bin/env node
// End-to-end optimizer check against the real engine; node relink used as the worker.
// Does NOT prove: browser worker, pthread cleanup, wall-clock. Proves: engine accepts output, optimizer reads back.
// Usage: npx vite-node scripts/optimization/verify-engine-integration.mjs [--iterations N]
// vite-node required (TS imports); plain node fails on Catalog's constructor(private readonly x).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = join(ROOT, 'build/wasm/simc-node.cjs'); // Built engine (node relink)
const PROFILE = join(ROOT, 'vendor/simc/profiles/MID2/MID2_Mage_Frost.simc');

const args = process.argv.slice(2);
const iterations = Number(args[args.indexOf('--iterations') + 1]) || 200;

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

if (!existsSync(ENGINE)) {
  process.stderr.write(
    `skipped: no engine at ${ENGINE}\n` +
    'Build it first (see docs/simc-notes.md "Verifying a build"), then rerun.\n',
  );
  process.exit(0);
}

const catalogRoot = join(ROOT, 'public/catalogs');
const catalogDir = existsSync(catalogRoot)
  ? readdirSync(catalogRoot).map((d) => join(catalogRoot, d)).find((d) => existsSync(join(d, 'manifest.json')))
  : null;
if (!catalogDir) {
  process.stderr.write('skipped: no catalog. Run `npm run catalog:build` first.\n');
  process.exit(0);
}

const { Catalog } = await import('../../src/lib/catalog/catalog.ts');
const { generate, collect } = await import('../../src/lib/optimization/candidates.ts');
const { runStagedSearch, memoryCache } = await import('../../src/lib/optimization/runner.ts');

const j = (f) => JSON.parse(readFileSync(join(catalogDir, f), 'utf8'));
const catalog = new Catalog({
  manifest: j('manifest.json'), items: j('items.json'), bonus: j('item-bonus.json'),
  scaling: j('scaling.json'), enchants: j('enchants.json'), gems: j('gems.json'),
  sets: j('sets.json'), embellishments: j('embellishments.json'), consumables: j('consumables.json'),
});

// --- baseline profile ------------------------------------------------------

const profileText = readFileSync(PROFILE, 'utf8');

// Parse one gear line from profile into ItemInstance.
function gearInstance(slot) {
  const line = profileText.split('\n').find((l) => l.startsWith(`${slot}=`));
  if (!line) throw new Error(`profile has no ${slot} line`);
  const inst = { instanceId: `base-${slot}`, source: 'equipped', slot, itemId: 0, bonusIds: [] };
  for (const part of line.slice(slot.length + 1).split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'id') inst.itemId = Number(value);
    else if (key === 'bonus_id') inst.bonusIds = value.split(/[/:]/).map(Number);
    else if (key === 'gem_id') inst.gemIds = value.split(/[/:]/).map(Number);
    else if (key === 'enchant_id') inst.enchantId = Number(value);
    else if (key === 'crafted_stats') inst.craftedStats = value.split('/').map(Number);
    else if (key === 'redirected_base_stats') inst.redirectedBaseStats = Number(value);
    else if (key === 'content_tuning') inst.contentTuning = Number(value);
    else if (key === 'ilevel') inst.itemLevel = Number(value);
  }
  return inst;
}

const SLOTS = ['head', 'neck', 'back', 'chest', 'hands', 'waist', 'legs', 'feet',
  'finger1', 'finger2', 'trinket1', 'trinket2', 'main_hand', 'off_hand'];
const baselineGear = new Map();
for (const slot of SLOTS) {
  try { baselineGear.set(slot, gearInstance(slot)); } catch { /* slot absent in this profile */ }
}

const character = {
  classId: 8, // mage
  raceMaskBit: null,
  armorSubclass: 1, // cloth
  canDualWield: false,
  canTitansGrip: false,
};

// Item level variants of two equipped items. Deterministic, legal, large DPS move => tests plumbing, not RNG.

const ring = baselineGear.get('finger1');
const trinket = baselineGear.get('trinket1');
const ringResolved = catalog.resolve(ring, 90);
const trinketResolved = catalog.resolve(trinket, 90);
if (!ringResolved || !trinketResolved) fail('catalog could not resolve the baseline ring or trinket');

process.stdout.write(
  `baseline ${ringResolved.name} ilvl ${ringResolved.itemLevel}, ` +
  `${trinketResolved.name} ilvl ${trinketResolved.itemLevel}\n`,
);

const dimensions = [
  {
    key: 'slot:finger1', kind: 'gear', slot: 'finger1',
    options: [280, 320, 360].map((ilvl) => ({
      key: `r${ilvl}`, label: `ring @${ilvl}`,
      item: { ...ring, instanceId: `ring-${ilvl}`, itemLevel: ilvl },
    })),
  },
  {
    key: 'slot:trinket1', kind: 'gear', slot: 'trinket1',
    options: [300, 360].map((ilvl) => ({
      key: `t${ilvl}`, label: `trinket @${ilvl}`,
      item: { ...trinket, instanceId: `trinket-${ilvl}`, itemLevel: ilvl },
    })),
  },
];

const { candidates, report: genReport } = collect(
  generate(dimensions, { workCap: 50, character, catalog, baselineGear, playerLevel: 90 }),
  50,
);
process.stdout.write(
  `generated ${candidates.length} candidates: ${genReport.upperBound} variants (upper bound) plus the baseline\n`,
);
if (candidates.length !== 7) fail(`expected 7 candidates (baseline + 3x2), got ${candidates.length}`);

// Engine port; node relink stands in for execution track's engineIdentity(manifest).
const work = mkdtempSync(join(tmpdir(), 'frostsim-opt-'));
let jobIndex = 0;
const ENGINE_IDENTITY = `node-relink|${catalog.manifest.engine.simcVersion}|${catalog.manifest.engine.clientDataVersion}`;
// One RunBatch call = one engine invocation (same as browser).
const runBatch = async (request) => {
  const jobDir = join(work, `job${++jobIndex}`);
  const profilePath = join(jobDir, 'sim.simc');
  const reportPath = join(jobDir, 'out.json');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(jobDir, { recursive: true });

  // Same composition as execution track: base profile + profileset."<id>"+=<line> per candidate.
  const lines = [request.profile];
  for (const set of request.profilesets) {
    for (const line of set.lines) lines.push(`profileset."${set.id}"+=${line}`);
  }
  writeFileSync(profilePath, `${lines.join('\n')}\n`);

  const accuracy = request.accuracy.mode === 'iterations'
    ? [`iterations=${request.accuracy.iterations}`, 'target_error=0']
    : [`target_error=${request.accuracy.targetError}`, `iterations=${request.accuracy.maxIterations}`];

  execFileSync('node', [ENGINE, profilePath, ...accuracy, 'threads=4', `json=${reportPath},version=2`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

  const raw = JSON.parse(readFileSync(reportPath, 'utf8'));
  const sim = raw.sim;
  const player = sim.players?.[0];
  const confidence = sim.options?.confidence ?? null;
  return {
    results: (sim.profilesets?.results ?? []).map((p) => ({
      id: p.name,
      mean: p.mean,
      margin: p.mean_error ?? null,
      iterations: p.iterations,
    })),
    baseline: player
      ? {
          mean: player.collected_data.dps.mean,
          margin: player.collected_data.dps.mean_std_dev != null && sim.options?.confidence_estimator != null
            ? player.collected_data.dps.mean_std_dev * sim.options.confidence_estimator
            : null,
          iterations: player.collected_data.dps.count,
        }
      : null,
    confidence,
    targetReached: null,
    engineIdentity: ENGINE_IDENTITY,
  };
};

// Run the search.
const plan = {
  version: 1,
  retentionFactor: 1,
  minIterations: 50,
  stages: [
    { label: 'Survey', accuracy: { mode: 'iterations', iterations: iterations }, maxSurvivors: 4, batchSize: 10 },
    { label: 'Finalists', accuracy: { mode: 'iterations', iterations: iterations * 4 }, maxSurvivors: 4, batchSize: 10 },
  ],
};

const started = Date.now();
const result = await runStagedSearch(candidates, {
  profile: profileText,
  plan,
  catalogId: catalog.catalogId,
  engineIdentity: ENGINE_IDENTITY,
  runBatch,
  cache: memoryCache(),
  onProgress: (p) => process.stdout.write(
    `  ${p.stageLabel} batch ${p.batchIndex + 1}/${p.batchCount}, ${p.candidatesRemaining} candidates\n`,
  ),
});

process.stdout.write(`\nfinished in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
process.stdout.write(`stages run: ${result.stagesRun.map((s) => `${s.label} (${s.candidates})`).join(', ')}\n\n`);

const width = Math.max(...result.candidates.map((s) => s.candidate.provenance.label.length));
for (const state of result.candidates) {
  const m = state.measurement;
  process.stdout.write(
    `${state.candidate.provenance.label.padEnd(width)}  ${state.status.padEnd(11)}` +
    `${m ? `${m.mean.toFixed(0).padStart(8)} +/- ${(m.margin ?? 0).toFixed(0).padStart(5)} (${m.iterations} it)` : ''}` +
    `${state.note ? `  ${state.note}` : ''}\n`,
  );
}
if (result.unresolvedTie.length) {
  process.stdout.write(`\nunresolved tie: ${result.unresolvedTie.join(', ')}\n`);
}
for (const w of result.warnings) process.stdout.write(`warning: ${w}\n`);

// Assertions on search results.
const measured = result.candidates.filter((s) => s.status === 'measured' && s.measurement);
const eliminated = result.candidates.filter((s) => s.status === 'eliminated');

if (result.incomplete) fail(`search did not finish: ${result.incomplete.message}`);
if (measured.length + eliminated.length !== candidates.length) {
  fail(`every candidate should be measured or eliminated; got ${measured.length} + ${eliminated.length} of ${candidates.length}`);
}
if (measured.some((s) => !Number.isFinite(s.measurement.mean) || s.measurement.mean <= 0)) {
  fail('a measured candidate has a non-positive mean; the engine rejected its lines');
}
if (measured.some((s) => s.measurement.margin === null)) {
  fail('a measured candidate has no confidence margin; mean_error was not read');
}
if (result.stagesRun.length !== 2) fail(`expected 2 stages to run, got ${result.stagesRun.length}`);
if (result.stagesRun[1].candidates >= result.stagesRun[0].candidates) {
  fail('the second stage did not narrow the field');
}

// Item level monotonic in DPS (pure upgrade); ranking must match. Catches silent mislabel or id drift.
const ringLevelOf = (state) => {
  const item = state.candidate.delta.gear?.get('finger1');
  return item?.itemLevel ?? null;
};
const trinketLevelOf = (state) => {
  const item = state.candidate.delta.gear?.get('trinket1');
  return item?.itemLevel ?? null;
};
const best = result.candidates.find((s) => s.candidate.id !== 'baseline' && s.measurement);
if (best && (ringLevelOf(best) !== 360 || trinketLevelOf(best) !== 360)) {
  process.stdout.write(
    `\nnote: the top candidate is not the highest item level pair ` +
    `(ring ${ringLevelOf(best)}, trinket ${trinketLevelOf(best)}). ` +
    'At this iteration count that can be sampling noise; rerun with --iterations 2000 to check.\n',
  );
}

const baselineState = result.candidates.find((s) => s.candidate.id === 'baseline');
if (!baselineState?.measurement) fail('the baseline was not measured');

// DISTINCTNESS CONTROL: numbers not all SAME (hides best). Candidates 40 ilvls apart can't genuinely tie.
const means = measured.map((s) => s.measurement.mean);
const distinct = new Set(means.map((m) => m.toFixed(6)));
if (means.length > 1 && distinct.size === 1) {
  fail(
    `all ${means.length} measured candidates returned the same mean (${means[0].toFixed(2)}). ` +
    'Candidates differing by 40 item levels cannot genuinely tie, so their gear did not reach ' +
    'the actor — check option scope and line placement before believing any ranking.',
  );
} else if (means.length > 1 && distinct.size < means.length) {
  process.stdout.write(
    `\nnote: ${means.length - distinct.size} of ${means.length} candidates share a mean with another. ` +
    'Possible at low iteration counts; suspicious if it persists at higher precision.\n',
  );
}

if (process.exitCode) process.stderr.write('\nsome checks failed\n');
else process.stdout.write('\nall checks passed\n');
