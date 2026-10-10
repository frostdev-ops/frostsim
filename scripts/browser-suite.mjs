// Bundled only into the temporary CI serving tree by browser-check.mjs.
import { detectEngineCapability, engineIdentity } from '../src/lib/simc/capability.ts';
import { selectedEngine, activeEngineChannel } from '../src/lib/simc/versions.ts';
import { runJob, loadPlayerDetail, engineBusy, engineStopping, lastThreadReap } from '../src/lib/simc/job.ts';
import { runComparison } from '../src/lib/simc/compare.ts';
import { DEFAULT_SETTINGS } from '../src/lib/simc/options.ts';
import { findPreset } from '../src/lib/simc/presets.ts';
import { loadCatalog } from '../src/lib/catalog/load.ts';
import { parseAddonExport } from '../src/lib/import/character.ts';
import { search as topGear } from '../src/lib/optimization/topgear.ts';
import { run as droptimizer } from '../src/lib/optimization/droptimizer.ts';
import { outcomeToProfilesetOutcome } from '../src/lib/optimization/engine-adapter.ts';
import { generate, collect } from '../src/lib/optimization/candidates.ts';
import { runStagedSearch } from '../src/lib/optimization/runner.ts';
import { makePortable, readPortable } from '../src/lib/store/records.ts';
import { reportSnapshot, packReport, decodeReport, sharedEngineChannel } from '../src/lib/store/report-share.ts';
import * as db from '../src/lib/store/db.ts';
import { readSearchCheckpoint, resumeLedger } from '../src/lib/store/search-checkpoint.ts';
import { multiActorParts } from '../src/lib/simc/multi-actor.ts';
import { withPolicy } from '../src/lib/reportDoc.ts';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = async () => {
  const deadline = Date.now() + 20000;
  while (engineBusy() || engineStopping()) {
    check(Date.now() < deadline, 'engine did not release after the preceding job');
    await sleep(100);
  }
};

export async function runSuite({ channel, variant, profile, catalogBase }) {
  check(crossOriginIsolated && isSecureContext, 'production origin is not isolated and secure');
  check(activeEngineChannel === channel, 'tab did not freeze the requested channel');
  const pack = await selectedEngine();
  const capability = await detectEngineCapability({ variant, baseUrl: pack.baseUrl, engineChannel: channel });
  check(capability.ok, capability.detail ?? 'engine capability unavailable');
  check(capability.manifest.files?.['simc.wasm']?.sha256, 'missing frozen wasm hash');
  const deps = { capability, createReportWorker: () => new Worker('/__ci__/report-worker.mjs', { type: 'module' }) };
  const base = { schemaVersion: 1, engineChannel: channel, profile,
    settings: { ...DEFAULT_SETTINGS, threads: variant === 'fallback' ? 1 : 2, maxTime: 60 },
    accuracy: { mode: 'iterations', iterations: 100 }, extraOptions: ['deterministic=1', 'seed=12345'],
    limits: { deadlineMs: 180000, initTimeoutMs: 120000, stallTimeoutMs: 120000 } };
  const evidence = { channel, variant, pack, manifest: capability.manifest, cases: [] };
  const test = async (name, fn) => {
    const started = performance.now();
    try { await idle(); const detail = await fn(); evidence.cases.push({ name, status: 'passed', ms: performance.now() - started, ...detail }); }
    catch (error) { evidence.cases.push({ name, status: 'failed', ms: performance.now() - started, error: String(error) }); }
  };
  let first;
  await test('quick-sim-cold', async () => {
    const handle = runJob({ ...base, htmlReport: true }, undefined, deps);
    first = await handle.result;
    check(first.report.players.length === 1, 'missing quick-sim actor');
    const mean = first.report.players[0].dps.mean;
    check(Number.isFinite(mean) && mean > 0, 'invalid quick-sim DPS');
    check(first.engineIdentity === engineIdentity(capability.manifest), 'unfrozen report identity');
    const raw = first.getRawJson();
    check(raw && raw.size > 0, 'raw JSON report missing');
    const html = first.getHtmlReport();
    check(html && html.size > 0, 'engine HTML export missing');
    return { mean, samples: first.report.actualIterations, engineIdentity: first.engineIdentity, rawBytes: raw.size, htmlBytes: html.size };
  });
  await test('quick-sim-warm', async () => {
    const next = await runJob(base, undefined, deps).result;
    check(next.report.players[0].dps.mean > 0 && next.jobId !== first?.jobId, 'warm run did not use a fresh job');
    return { mean: next.report.players[0].dps.mean, engineIdentity: next.engineIdentity };
  });
  const candidates = [
    { id: 'talent-st', lines: [`talents=${/^# Saved Loadout: ST\n# talents=(.+)$/m.exec(profile)?.[1]}`] },
    { id: 'gear-trinket1', lines: ['trinket1=,id=270164'] },
  ];
  let compared;
  await test('comparisons', async () => {
    compared = await runComparison(base, candidates, undefined, deps).result;
    check(compared.strategy === (variant === 'fallback' ? 'sequential' : 'profilesets'), 'wrong comparison strategy');
    check(compared.candidates.length === 2 && compared.candidates.every(c => c.status === 'complete' && c.mean > 0), 'missing comparison candidate');
    return { strategy: compared.strategy, candidates: compared.candidates };
  });
  if (variant === 'fallback') await test('numerical-sequential-direct-controls', async () => {
    check(compared && first, 'comparison and baseline controls must complete');
    const means = [];
    for (const candidate of candidates) {
      const direct = await runJob({ ...base, extraProfileLines: candidate.lines }, undefined, deps).result;
      const mean = direct.report.players[0].dps.mean;
      check(mean === compared.candidates.find(c => c.id === candidate.id)?.mean, `${candidate.id}: managed comparison differs from deterministic direct execution`);
      check(mean !== first.report.players[0].dps.mean, `${candidate.id}: candidate collapsed to baseline`);
      means.push({ id: candidate.id, mean, samples: direct.report.actualIterations });
    }
    check(means[0].mean !== means[1].mean, 'two distinct candidates produced identical numbers');
    return { controls: means, baseline: first.report.players[0].dps.mean, deterministic: true };
  });
  const runBatch = async request => {
    const requested = request.profilesets.filter(p => p.lines.length);
    const handle = runJob({ ...base, profile: request.profile, accuracy: request.accuracy,
      profilesets: requested.length ? requested : undefined }, undefined, deps);
    const abort = () => handle.cancel();
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = outcomeToProfilesetOutcome(await handle.result);
      result.results.push(...request.profilesets.filter(p => !p.lines.length).map(p => ({ id: p.id, ...result.baseline })));
      return result;
    } finally { request.signal?.removeEventListener('abort', abort); }
  };
  let catalog;
  await test('catalog-identity', async () => {
    const loaded = await loadCatalog({ baseUrl: catalogBase, engine: {
      ...capability.manifest.engine, ...capability.manifest.wow, engineChannel: channel,
    } });
    check(loaded.ok, loaded.message ?? 'catalog unavailable');
    check(!loaded.warnings.length, 'catalog does not match frozen engine');
    catalog = loaded.catalog;
    return { catalogId: catalog.catalogId };
  });
  const character = parseAddonExport(profile);
  const baselineGear = new Map(character.equipped.map(item => [item.slot, item]));
  const constraints = { classId: 9, raceMaskBit: null, armorSubclass: 1, canDualWield: false, canTitansGrip: false };
  const plan = { version: 1, retentionFactor: 1, minIterations: 100, stages: [
    { label: 'browser smoke', accuracy: base.accuracy, maxSurvivors: 4, batchSize: 4 },
  ] };
  const searchOptions = () => ({ catalog, character: constraints, baselineGear, playerLevel: character.level,
    profile, plan, baselineTalents: character.talents, engineIdentity: engineIdentity(capability.manifest), runBatch });
  if (variant === 'fallback') await test('numerical-exhaustive-optimizer-controls', async () => {
    check(catalog, 'matching catalog required');
    const ring = baselineGear.get('finger1'), trinket = baselineGear.get('trinket1');
    check(ring && trinket, 'fixture needs ring and trinket');
    // Reuse verify-engine-integration.mjs's actual 3x2 item-level variants; baseline is the seventh candidate.
    const dimensions = [
      { key: 'slot:finger1', kind: 'gear', slot: 'finger1', options: [280, 320, 360].map(itemLevel => ({
        key: `r${itemLevel}`, label: `ring @${itemLevel}`, item: { ...ring, instanceId: `ring-${itemLevel}`, itemLevel },
      })) },
      { key: 'slot:trinket1', kind: 'gear', slot: 'trinket1', options: [300, 360].map(itemLevel => ({
        key: `t${itemLevel}`, label: `trinket @${itemLevel}`, item: { ...trinket, instanceId: `trinket-${itemLevel}`, itemLevel },
      })) },
    ];
    const { candidates: field } = collect(generate(dimensions, { workCap: 50, character: constraints, catalog, baselineGear, playerLevel: character.level }), 50);
    check(field.length === 7, 'expected baseline plus all six exhaustive candidates');
    const common = { profile, catalogId: catalog.catalogId, engineIdentity: engineIdentity(capability.manifest), runBatch };
    const exhaustive = await runStagedSearch(field, { ...common, plan: { ...plan, stages: [{ ...plan.stages[0], batchSize: 7, maxSurvivors: 7 }] } });
    check(!exhaustive.incomplete && exhaustive.candidates.every(c => c.measurement?.mean > 0), 'exhaustive optimizer left unmeasured candidates');
    const direct = [];
    for (const candidate of field) {
      await idle();
      const outcome = await runJob({ ...base, extraProfileLines: candidate.lines }, undefined, deps).result;
      const mean = outcome.report.players[0].dps.mean;
      check(mean === exhaustive.candidates.find(c => c.candidate.id === candidate.id)?.measurement?.mean, `${candidate.id}: exhaustive optimizer differs from direct script`);
      direct.push({ id: candidate.id, mean, lines: candidate.lines });
    }
    check(new Set(direct.map(c => c.mean)).size > 1, 'gear field collapsed to one baseline number');
    const pruned = await runStagedSearch(field, { ...common, plan: { ...plan, minIterations: 20, stages: [
      { ...plan.stages[0], label: 'Survey', batchSize: 7, maxSurvivors: 4 },
      { ...plan.stages[0], label: 'Finalists', accuracy: { mode: 'iterations', iterations: 400 }, batchSize: 7, maxSurvivors: 4 },
    ] } });
    check(!pruned.incomplete, 'pruned optimizer did not complete');
    check(pruned.candidates.some(c => c.status === 'eliminated'), 'control field did not exercise elimination');
    const finalists = [];
    for (const state of pruned.candidates.filter(c => c.status === 'measured')) {
      await idle();
      const outcome = await runJob({ ...base, accuracy: { mode: 'iterations', iterations: 400 }, extraProfileLines: state.candidate.lines }, undefined, deps).result;
      check(outcome.report.players[0].dps.mean === state.measurement.mean, `${state.candidate.id}: finalist differs from direct script`);
      finalists.push({ id: state.candidate.id, mean: state.measurement.mean });
    }
    return { exhaustive: direct, finalists, eliminated: pruned.candidates.filter(c => c.status === 'eliminated').map(c => c.candidate.id), deterministic: true };
  });
  await test('top-gear', async () => {
    check(catalog, 'matching catalog required');
    const talent = /^# talents=(.+)$/m.exec(profile)?.[1];
    check(talent, 'fixture must include an alternate imported talent loadout');
    const result = await topGear({ slots: {}, loadouts: [character.talents, talent] }, searchOptions()).result;
    check(result.candidates.length >= 2 && result.candidates.every(c => c.measurement?.mean > 0), 'optimizer did not measure alternatives');
    return { candidates: result.candidates.length, engineIdentity: result.engineIdentity };
  });
  await test('droptimizer-explicit-items', async () => {
    check(catalog, 'matching catalog required');
    const item = character.equipped.find(item => item.slot === 'head');
    check(item, 'fixture needs equipped head item');
    const source = { id: 'explicit-fixture', label: 'Explicit imported item', provenance: 'user', items: [{ ...item, instanceId: 'explicit-drop', source: 'hypothetical' }], hypothetical: true };
    const result = await droptimizer([source], searchOptions()).result;
    check(result.rows.length > 0 && result.rows.every(row => row.mean > 0), 'Droptimizer did not measure explicit alternatives');
    check(result.probabilitiesUnavailable, 'explicit item incorrectly claims drop probability');
    return { rows: result.rows.length, engineIdentity: result.engineIdentity };
  });
  await test('stat-weights', async () => {
    const outcome = await runJob({ ...base, extraOptions: [...base.extraOptions, 'calculate_scale_factors=1', 'scale_only=int'] }, undefined, deps).result;
    check(outcome.report.players[0].scaleFactors?.some(s => Number.isFinite(s.value)), 'missing measured stat weights');
    return { factors: outcome.report.players[0].scaleFactors };
  });
  await test('advanced-preset', async () => {
    const preset = findPreset('light-movement');
    check(preset?.supported.ok, 'selected preset is unsupported');
    const outcome = await runJob({ ...base, extraOptions: [...base.extraOptions, ...preset.options], extraProfileLines: preset.profileLines }, undefined, deps).result;
    check(outcome.report.options.fightStyle === 'LightMovement' && outcome.report.players[0].dps.mean > 0, 'preset did not reach engine');
    return { style: outcome.report.options.fightStyle, mean: outcome.report.players[0].dps.mean };
  });
  if (variant === 'fallback') {
    await test('nine-parity-presets', async () => {
      const results = [];
      for (const id of ['patchwerk', 'casting-patchwerk', 'hectic-add-cleave', 'cleave-add', 'light-movement', 'heavy-movement', 'dungeon-slice', 'target-dummy', 'execute-patchwerk']) {
        await idle();
        const preset = findPreset(id);
        const outcome = await runJob({ ...base, settings: { ...base.settings, fightStyle: preset.fightStyle },
          extraOptions: [...base.extraOptions, ...preset.options], extraProfileLines: preset.profileLines }, undefined, deps).result;
        check(outcome.report.options.fightStyle === preset.fightStyle && outcome.report.players[0].dps.mean > 0, `${id}: preset did not produce a real result`);
        results.push({ id, style: outcome.report.options.fightStyle, mean: outcome.report.players[0].dps.mean, profileLines: preset.profileLines ?? [] });
      }
      return { results, parity: 'synthetic health-pinned presets exercise Frostsim construction; no Raidbots numerical equivalence claim' };
    });
    await test('guided-multi-actor', async () => {
      const parts = multiActorParts([{ character }, { character }], []);
      const outcome = await runJob({ ...base, ...parts }, undefined, deps).result;
      check(outcome.report.players.length === 2, 'two guided actors did not receive separate reports');
      check(new Set(outcome.report.players.map(p => p.name)).size === 2, 'duplicate actor names collapsed');
      check(outcome.report.players.every(p => p.dps.mean > 0), 'multi-actor result has missing measurement');
      return { players: outcome.report.players.map(p => ({ name: p.name, mean: p.dps.mean })) };
    });
  }
  await test('exports-and-local-persistence', async () => {
    check(first, 'quick-sim result needed for export');
    const portable = makePortable('report', first.report, { ...capability.manifest.engine, ...capability.manifest.wow, engineChannel: channel });
    check(readPortable(JSON.stringify(portable)).ok, 'portable report failed round trip');
    const raw = first.getRawJson();
    const detail = await loadPlayerDetail(raw, first.report.players[0].name, deps);
    const shared = reportSnapshot(first, detail);
    const words = [];
    const decoded = await decodeReport(await packReport(shared, words), words);
    check(sharedEngineChannel(decoded) === channel && decoded.d === shared.d, 'share lost numerical/channel provenance');
    const stored = await db.put('setups', { id: `ci-${channel}-${variant}`, exported: portable });
    check(stored.ok, 'IndexedDB write failed');
    return { storageId: `ci-${channel}-${variant}`, mean: decoded.d, channel: sharedEngineChannel(decoded) };
  });
  await test('cancel-and-retry', async () => {
    let handle;
    handle = runJob({ ...base, accuracy: { mode: 'iterations', iterations: 1000000 } }, event => {
      if (event.state === 'running') setTimeout(() => handle.cancel('CI cancellation'), 100);
    }, deps);
    let cancelled = false;
    try { await handle.result; } catch (error) { cancelled = error.name === 'AbortError'; }
    check(cancelled, 'running engine cancellation did not reject with AbortError');
    await idle();
    try {
      const retry = await runJob(base, undefined, deps).result;
      check(retry.report.players[0].dps.mean > 0, 'retry after cancellation did not run');
      return { mean: retry.report.players[0].dps.mean, retryInSameTab: true, shutdown: lastThreadReap() };
    } catch (error) {
      if (variant !== 'threaded' || error.code !== 'engine-reload-required') throw error;
      check(lastThreadReap()?.confirmed === false, 'reload gate must describe unknown shutdown');
      return { retryInSameTab: false, requiresReload: true, shutdown: lastThreadReap(),
        limitation: 'Coordinator blocked in wasm pthread join cannot observe cancellation before the bounded shutdown deadline. Explicit reload is required.' };
    }
  });
  return evidence;
}

export async function checkPersisted(id) {
  const result = await db.get('setups', id);
  check(result.ok && readPortable(JSON.stringify(result.value?.exported)).ok, 'saved report did not survive page reload');
  return true;
}

// Deliberately interrupt between real completed batches. The browser runner reloads before resumeSearch.
async function resumeEnvironment({ channel, profile, catalogBase }) {
  const pack = await selectedEngine();
  const capability = await detectEngineCapability({ variant: 'fallback', baseUrl: pack.baseUrl, engineChannel: channel });
  check(capability.ok, capability.detail);
  const loaded = await loadCatalog({ baseUrl: catalogBase, engine: { ...capability.manifest.engine, ...capability.manifest.wow, engineChannel: channel } });
  check(loaded.ok && !loaded.warnings.length, 'resume requires exact catalog identity');
  const request = { schemaVersion: 1, engineChannel: channel, profile,
    settings: { ...DEFAULT_SETTINGS, threads: 1, maxTime: 60 }, accuracy: { mode: 'iterations', iterations: 100 },
    extraOptions: ['deterministic=1', 'seed=12345'] };
  const fields = [['baseline', []], ['talent-st', [`talents=${/^# Saved Loadout: ST\n# talents=(.+)$/m.exec(profile)?.[1]}`]], ['trinket', ['trinket1=,id=270164']]];
  const field = fields.map(([id, lines]) => ({ id, lines, canonical: JSON.stringify(lines), delta: {},
    provenance: { kind: id === 'baseline' ? 'baseline' : 'mixed', items: [], label: id }, cost: { unknownCosts: [] } }));
  const calls = [];
  const runBatch = async batch => {
    await idle(); calls.push(batch.profilesets.map(p => p.id));
    check(batch.profilesets.length <= 1, 'fallback resume control must run one candidate per batch');
    const result = outcomeToProfilesetOutcome(await runJob({ ...request, accuracy: batch.accuracy,
      profilesets: batch.profilesets.length ? batch.profilesets : undefined }, undefined, { capability,
      createReportWorker: () => new Worker('/__ci__/report-worker.mjs', { type: 'module' }) }).result);
    return result;
  };
  const options = { profile, engineIdentity: engineIdentity(capability.manifest), catalogId: loaded.catalog.catalogId,
    requestIdentity: JSON.stringify(request), runBatch, plan: { version: 1, retentionFactor: 1, minIterations: 100,
      stages: [{ label: 'Resume control', accuracy: request.accuracy, batchSize: 1, maxSurvivors: 3 }] } };
  return { request, field, options, calls };
}

export async function prepareResume(input) {
  const env = await resumeEnvironment(input), controller = new AbortController();
  const id = `resume-${input.channel}`;
  const result = await runStagedSearch(env.field, { ...env.options, signal: controller.signal, onCheckpoint: async ledger => {
    const checkpoint = { version: 1, request: env.request, ledger };
    check(readSearchCheckpoint(checkpoint), 'real runner produced an unreadable checkpoint');
    check((await db.put('setups', { id, checkpoint })).ok, 'checkpoint could not persist');
    controller.abort();
  } });
  check(result.incomplete?.reason === 'cancelled' && env.calls.length === 1, 'control did not stop at first completed batch');
  return { id, batches: env.calls, completed: Object.keys((await db.get('setups', id)).value.checkpoint.ledger.completed) };
}

export async function resumeSearch(input) {
  const env = await resumeEnvironment(input), stored = await db.get('setups', `resume-${input.channel}`);
  check(stored.ok && readSearchCheckpoint(stored.value?.checkpoint), 'checkpoint did not survive real reload');
  const ledger = resumeLedger(stored.value.checkpoint);
  const completed = Object.keys(ledger.completed);
  const result = await runStagedSearch(env.field, { ...env.options, ledger });
  check(!result.incomplete && env.calls.length === 1, 'resume repeated a completed batch or left work unfinished');
  check(env.calls.flat().every(id => !completed.includes(id)), 'resume repeated persisted measurement');
  const calls = structuredClone(env.calls);
  const fresh = await runStagedSearch(env.field, env.options);
  const numbers = r => r.candidates.map(c => [c.candidate.id, c.measurement?.mean]);
  check(JSON.stringify(numbers(result)) === JSON.stringify(numbers(fresh)), 'resumed deterministic numbers differ from fresh search');
  check(new Set(numbers(result).map(([, mean]) => mean)).size === env.field.length, 'resume field collapsed to a baseline number');
  const mutated = structuredClone(env.field); mutated[1].lines = ['trinket1=,id=270164'];
  let refused = false; const before = env.calls.length;
  try { await runStagedSearch(mutated, { ...env.options, ledger: resumeLedger(stored.value.checkpoint) }); }
  catch (error) { refused = /different search request/.test(String(error)); }
  check(refused && env.calls.length === before, 'changed simulation lines reused persisted measurements');
  return { completedBeforeReload: completed, resumedBatches: calls, measurements: numbers(result), changedLinesRefused: true };
}

export async function storageDenial() {
  const original = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = function () { throw new DOMException('CI quota denial', 'QuotaExceededError'); };
    const denied = await db.put('setups', { id: 'denied-checkpoint', checkpoint: {} });
    check(!denied.ok && denied.failure.kind === 'quota', 'quota denial was misreported as successful persistence');
    return { failure: denied.failure.kind, persisted: false };
  } finally { IDBObjectStore.prototype.put = original; }
}

export function mountHostileReport() {
  const iframe = document.createElement('iframe');
  iframe.title = 'Hostile policy control'; iframe.setAttribute('sandbox', ''); iframe.referrerPolicy = 'no-referrer';
  iframe.srcdoc = withPolicy('<html><head></head><body><h1>Hostile fixture</h1><script>parent.__reportExecuted=true;fetch("/hostile-script")</script><img src="/hostile-image"><form action="/hostile-submit"><button>Submit</button></form><a href="https://example.invalid/hostile" target="_top">Navigate</a></body></html>');
  document.body.append(iframe);
}

export async function retryAfterReload({ channel, variant, profile }) {
  const pack = await selectedEngine();
  const capability = await detectEngineCapability({ variant, baseUrl: pack.baseUrl, engineChannel: channel });
  check(capability.ok, capability.detail);
  const result = await runJob({ schemaVersion: 1, engineChannel: channel, profile,
    settings: { ...DEFAULT_SETTINGS, threads: variant === 'fallback' ? 1 : 2, maxTime: 60 },
    accuracy: { mode: 'iterations', iterations: 100 } }, undefined, {
    capability, createReportWorker: () => new Worker('/__ci__/report-worker.mjs', { type: 'module' }),
  }).result;
  check(result.report.players[0].dps.mean > 0, 'fresh page could not retry after the safety gate');
  return { mean: result.report.players[0].dps.mean, engineIdentity: result.engineIdentity };
}
