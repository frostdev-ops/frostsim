#!/usr/bin/env node
// Measure engine threading/profileset/numerical behavior (P02.3-5,10); JSON + markdown output.
// Via engine-smoke.sh (same objects, pool size as browser). NOT measuring worker lifecycle/heap.
// Deterministic check: fixed seed => same DPS at every thread count; spread = merge bug.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const PROFILE = arg('--profile', 'vendor/simc/profiles/MID2/MID2_Mage_Frost.simc');
const ITERATIONS = Number(arg('--iterations', '250'));
const SEED = arg('--seed', '4242');
const SUITE = arg('--suite', 'all');
const OUT = resolve(root, arg('--out', 'bench/engine-bench.md'));
const THREADS = (arg('--threads', '1,2,4,8,16')).split(',').map(Number);

const fromJson = argv.includes('--from-json');
const manifest = JSON.parse(readFileSync(join(root, 'public/engine/manifest.json'), 'utf8'));
const POOL = manifest.capabilities.pthreadPoolSize;

const work = join(tmpdir(), `frostsim-bench-${process.pid}`);
mkdirSync(work, { recursive: true });

// Peak RSS: time -l (macOS) or -v (Linux), or null. Not essential.
const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
const peakRssFrom = (stderr) => {
  const mac = stderr.match(/(\d+)\s+maximum resident set size/);
  if (mac) return Number(mac[1]);
  const linux = stderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
  return linux ? Number(linux[1]) * 1024 : null;
};

let runIndex = 0;
const run = (label, options) => {
  const jsonPath = join(work, `run-${runIndex++}.json`);
  const args = [...timeArgs, join(root, 'scripts/engine-smoke.sh'), join(root, PROFILE),
    ...options, `json=${jsonPath},version=2`];
  const started = Date.now();
  const proc = spawnSync('/usr/bin/time', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60 * 1000,
  });
  const wallMs = Date.now() - started;
  const stderr = proc.stderr ?? '';
  if (proc.status !== 0 || proc.signal) {
    const why = proc.signal === 'SIGTERM' ? 'TIMED OUT (15 min) — treat as a hang' : `exit ${proc.status}`;
    const tail = stderr.split('\n').filter((l) => l.length < 300).slice(-3).join(' | ');
    console.error(`  ${label}: FAILED — ${why}${tail ? ` — ${tail}` : ''}`);
    return { label, options, failed: true, why, wallMs, peakRssBytes: peakRssFrom(stderr) };
  }

  const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const sim = report.sim;
  const player = sim.players[0];
  const dps = player.collected_data.dps;
  const result = {
    label,
    options,
    wallMs,
    peakRssBytes: peakRssFrom(stderr),
    dps: dps.mean,
    dpsMeanStdDev: dps.mean_std_dev,
    // `sim.options.iterations` is what the engine settled on after dividing across threads;
    // `collected_data.dps.count` is how many samples actually landed. They differ, and only
    // the second one is "actual iterations" for reporting purposes.
    requestedIterations: sim.options.iterations,
    collectedIterations: dps.count,
    elapsedSeconds: sim.statistics?.elapsed_time_seconds ?? null,
    initSeconds: sim.statistics?.init_time_seconds ?? null,
    mergeSeconds: sim.statistics?.merge_time_seconds ?? null,
    analyzeSeconds: sim.statistics?.analyze_time_seconds ?? null,
    wowVersion: sim.options?.dbc?.Live?.wow_version ?? null,
    profilesets: Object.fromEntries(
      (sim.profilesets?.results ?? []).map((p) => [p.name, p.mean]),
    ),
  };
  rmSync(jsonPath, { force: true });
  console.log(`  ${label}: ${Math.round(result.dps).toLocaleString()} dps, ${result.collectedIterations} iters, ${(wallMs / 1000).toFixed(1)}s`);
  return result;
};

const suites = fromJson
  ? JSON.parse(readFileSync(OUT.replace(/\.md$/, '.json'), 'utf8')).suites
  : {};

// P02.3: Thread sweep (deterministic=1 for comparable numbers).
if (!fromJson && (SUITE === 'all' || SUITE === 'threads')) {
  console.log(`thread sweep (${ITERATIONS} iterations, deterministic, seed ${SEED}, pool ${POOL}):`);
  suites.threads = THREADS.map((t) =>
    run(`threads=${t}`, [`iterations=${ITERATIONS}`, `threads=${t}`, 'deterministic=1', `seed=${SEED}`]),
  );
}

// P02.4: Profileset stress (nested workers in pool). Push at pool ceiling for deadlock test.
if (!fromJson && (SUITE === 'all' || SUITE === 'profilesets')) {
  // Cheap, legal, diverse work: vary target count per profile.
  const variants = (n) =>
    Array.from({ length: n }, (_, i) => `profileset."p${i}"=desired_targets=${(i % 4) + 1}`);
  console.log(`\nprofileset stress (pool ${POOL}):`);
  suites.profilesets = [];
  for (const [count, threads, workThreads] of [
    [4, 4, 1], [8, 8, 1], [16, 16, 1], [16, 8, 2], [32, 16, 1],
  ]) {
    suites.profilesets.push(
      run(`${count} profilesets, threads=${threads}, work_threads=${workThreads}`, [
        `iterations=${Math.min(ITERATIONS, 100)}`, `threads=${threads}`,
        `profileset_work_threads=${workThreads}`, 'deterministic=1', `seed=${SEED}`,
        ...variants(count),
      ]),
    );
  }
}

// Numerical verdict.
const sweep = (suites.threads ?? []).filter((r) => !r.failed);
const dpsValues = sweep.map((r) => r.dps);
const spread = dpsValues.length
  ? (Math.max(...dpsValues) - Math.min(...dpsValues)) / (dpsValues.reduce((a, b) => a + b, 0) / dpsValues.length)
  : null;

const num = (v, digits = 0) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: digits }));
const mb = (v) => (v == null ? '—' : `${(v / 1024 / 1024).toFixed(0)} MB`);

let md = `<!-- Generated by scripts/engine-bench.mjs. Do not hand-edit. -->\n`;
md += `# Engine measurements\n\n`;
md += `Generated ${new Date().toISOString()} on ${process.platform}-${process.arch}.\n\n`;
md += `Artifact: ${manifest.artifact}, simc ${manifest.engine.simcVersion} @ ${manifest.engine.upstreamCommit.slice(0, 7)}, `;
md += `WoW ${manifest.wow.clientDataVersion}, pthread pool ${POOL}.\n`;
md += `Profile: \`${PROFILE}\`. Fixed iterations, \`deterministic=1\`, \`seed=${SEED}\`.\n\n`;
md += `Measured through the node relink of the same engine objects (\`scripts/engine-smoke.sh\`), `;
md += `not in a browser. Engine numbers, thread scaling and profileset behavior transfer; `;
md += `worker lifecycle, heap growth and pthread cleanup do not and are not claimed here.\n\n`;

if (suites.threads) {
  const base = sweep[0];
  md += `## Thread sweep (P02.3)\n\n`;
  md += `| threads | DPS | collected iterations | engine elapsed | init | merge | speedup vs 1 | process wall | peak RSS |\n`;
  md += `| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const r of suites.threads) {
    if (r.failed) { md += `| ${r.options[1].split('=')[1]} | **${r.why}** | | | | | | | |\n`; continue; }
    // Speedup from engine elapsed time, not process wall (60 MB wasm compile hides scaling).
    const speedup = base && !base.failed && r.elapsedSeconds
      ? (base.elapsedSeconds / r.elapsedSeconds).toFixed(2) : '—';
    md += `| ${r.options[1].split('=')[1]} | ${num(r.dps)} | ${r.collectedIterations} | `;
    md += `${num(r.elapsedSeconds, 2)}s | ${num(r.initSeconds, 2)}s | ${num(r.mergeSeconds, 3)}s | ${speedup}× | `;
    md += `${(r.wallMs / 1000).toFixed(2)}s | ${mb(r.peakRssBytes)} |\n`;
  }
  const lo = sweep.reduce((a, b) => (a.dps < b.dps ? a : b));
  const hi = sweep.reduce((a, b) => (a.dps > b.dps ? a : b));
  const combinedSe = Math.hypot(lo.dpsMeanStdDev ?? 0, hi.dpsMeanStdDev ?? 0);
  const sigma = combinedSe ? (hi.dps - lo.dps) / combinedSe : null;

  const startup = sweep.map((r) => r.wallMs / 1000 - (r.elapsedSeconds ?? 0)).sort((a, b) => a - b);
  const startupMedian = startup[Math.floor(startup.length / 2)];
  const fastest = sweep.reduce((a, b) => ((a.elapsedSeconds ?? 1e9) < (b.elapsedSeconds ?? 1e9) ? a : b));
  md += `\n**Process startup costs ~${startupMedian.toFixed(0)}s regardless of workload**, against\n`;
  md += `${num(fastest.elapsedSeconds, 2)}s of engine time in the fastest row (${fastest.label}) — a ratio of\n`;
  md += `${(startupMedian / (fastest.elapsedSeconds || 1)).toFixed(0)}:1 at this size. That is node compiling a 60 MB wasm module from scratch on every\n`;
  md += `invocation plus node startup, not anything the sim does. A browser streams compilation and can\n`;
  md += `cache the compiled module, so the number does NOT carry over — it is recorded to explain why\n`;
  md += `the process-wall column shows no scaling, and because it is the reason P02.6's compiled-module\n`;
  md += `caching is worth more than any thread tuning until the workload is large.\n`;

  md += `\n**Sample count is \`iterations - threads\`.** Every thread discards its own first\n`;
  md += `iteration: \`sim.cpp\` — "First iterations of each thread are considered statistically\n`;
  md += `insignificant and not collected", \`current_iterations - threads\`. Measured exactly:\n`;
  md += sweep.map((r) => `${r.options[1].split('=')[1]} threads -> ${r.collectedIterations}`).join(', ');
  md += ` samples from ${ITERATIONS} requested. So a high thread count on a small run throws away a\n`;
  md += `large fraction of the work, and at \`iterations <= threads\` there is nothing left to report.\n`;
  md += `The honest "actual iterations" is the collected count, not \`sim.options.iterations\`.\n`;

  md += `\n**Numerical spread across thread counts:** `;
  if (spread === null) {
    md += 'not measured.\n';
  } else {
    md += `${(spread * 100).toFixed(3)}% of mean `;
    md += `(${num(lo.dps)} at ${lo.label} to ${num(hi.dps)} at ${hi.label}), `;
    md += sigma === null
      ? 'standard error unavailable.\n'
      : `which is ${sigma.toFixed(1)}x the combined standard error of those two runs (±${num(lo.dpsMeanStdDev)} and ±${num(hi.dpsMeanStdDev)}).\n`;
    md += `\n\`deterministic=1\` does **not** make results identical across thread counts, and expecting\n`;
    md += `it to would be wrong: the thread count changes how many samples survive, so the runs are\n`;
    md += `comparing different sample sets, not the same computation split differently. Compare these\n`;
    md += `statistically against the standard error; do not assert equality and do not widen a\n`;
    md += `tolerance until an equality check passes.\n`;
  }
  md += `\n`;
}

if (suites.profilesets) {
  md += `## Profileset stress (P02.4)\n\n`;
  md += `Profilesets run inside the same preallocated pool as the iteration workers. `;
  md += `\`profileset_work_threads=W\` with \`threads=T\` asks for W concurrent profiles each using T/W threads.\n\n`;
  md += `| configuration | result | wall | peak RSS |\n| --- | --- | --- | --- |\n`;
  for (const r of suites.profilesets) {
    const profileCount = Object.keys(r.profilesets ?? {}).length;
    const outcome = r.failed
      ? '**FAILED / did not complete**'
      : `${profileCount} profileset results, base ${num(r.dps)} dps`;
    md += `| ${r.label} | ${outcome} | ${(r.wallMs / 1000).toFixed(2)}s | ${mb(r.peakRssBytes)} |\n`;
  }
  md += `\nA configuration that hangs rather than failing is the deadlock D11 describes: `;
  md += `\`main()\` blocks inside \`callMain\`, so no pthread beyond the preallocated pool can start `;
  md += `and simc waits forever to join it. Any row that did not complete is a configuration the UI must not be able to request.\n\n`;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md);
writeFileSync(OUT.replace(/\.md$/, '.json'), `${JSON.stringify({ manifest: { artifact: manifest.artifact, engine: manifest.engine, wow: manifest.wow, pool: POOL }, profile: PROFILE, iterations: ITERATIONS, seed: SEED, suites }, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`\nengine-bench: wrote ${OUT}`);
