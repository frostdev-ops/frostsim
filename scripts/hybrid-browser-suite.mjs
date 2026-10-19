// Test-only browser entry. Bundled into an ignored production-policy fixture, never the application.
import { detectEngineCapability } from '../src/lib/simc/capability.ts';
import { selectedEngine } from '../src/lib/simc/versions.ts';
import { runJob, setRemoteEngine, engineBusy, engineStopping, lastThreadReap } from '../src/lib/simc/job.ts';
import { createHybridEngine } from '../src/lib/simc/hybrid.ts';
import { characterBlocks } from '../src/lib/simc/multi-actor.ts';
import { parseProgressLine } from '../src/lib/simc/progress.ts';
import { DEFAULT_SETTINGS } from '../src/lib/simc/options.ts';
import { loadCatalog } from '../src/lib/catalog/load.ts';

const check = (ok, text) => { if (!ok) throw new Error(text); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = async () => {
  const deadline = performance.now() + 20000;
  while (engineBusy() || engineStopping()) {
    check(performance.now() < deadline, 'controller did not release local ownership');
    await sleep(50);
  }
};
const state = { engines: [], phase: 'setup', logicalNow: 0 };
const NativeWorker = globalThis.Worker;
class ObservedWorker extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    if (!String(url).includes('/engine/versions/')) return;
    this.record = { phase: state.phase, url: String(url), progress: 0, messages: [], cancelled: false, terminated: false };
    state.engines.push(this.record);
    this.addEventListener('message', ({ data }) => {
      this.record.messages.push(data.type);
      if (data.type === 'log' && data.stream === 'out') for (const line of data.lines ?? []) {
        const p = parseProgressLine(line);
        if (p && !p.finished) this.record.progress++;
      }
    });
  }
  postMessage(data, ...rest) {
    if (this.record && typeof data.profile === 'string') this.record.flag = data.cancelFlag && new Int32Array(data.cancelFlag);
    if (this.record && data.type === 'cancel') {
      this.record.cancelled = true;
      this.record.flagAtCancel = this.record.flag ? Atomics.load(this.record.flag, 0) : null;
      this.record.progressAtCancel = this.record.progress;
      this.record.doneBeforeCancel = this.record.messages.includes('done');
    }
    return super.postMessage(data, ...rest);
  }
  terminate() {
    if (this.record) this.record.terminated = true;
    return super.terminate();
  }
}
const records = () => state.engines.filter(e => e.phase === state.phase);
const evidence = () => records().map(({ flag, ...record }) => ({ ...record, finalFlag: flag ? Atomics.load(flag, 0) : null }));

export async function setup({ channel, profile, catalogBase }) {
  check(crossOriginIsolated && isSecureContext, 'fixture lacks production isolation');
  globalThis.Worker = ObservedWorker;
  const pack = await selectedEngine();
  const capability = await detectEngineCapability({ variant: 'threaded', baseUrl: pack.baseUrl, engineChannel: channel });
  check(capability.ok, capability.detail ?? 'threaded capability unavailable');
  const catalog = await loadCatalog({ baseUrl: catalogBase, engine: { ...capability.manifest.engine, ...capability.manifest.wow, engineChannel: channel } });
  check(catalog.ok && !catalog.warnings.length, catalog.message ?? 'matching catalog required');
  state.base = { schemaVersion: 1, engineChannel: channel, profile,
    settings: { ...DEFAULT_SETTINGS, threads: 2, maxTime: 60 }, accuracy: { mode: 'iterations', iterations: 100 },
    extraOptions: ['deterministic=1', 'seed=12345'], limits: { deadlineMs: 180000, initTimeoutMs: 120000, stallTimeoutMs: 120000 } };
  state.deps = { capability, createReportWorker: () => new Worker('/__ci__/report-worker.mjs', { type: 'module' }) };
  return { pack, manifest: capability.manifest, catalogId: catalog.catalog.catalogId };
}

export async function baseline() {
  state.phase = 'baseline';
  setRemoteEngine(null);
  const result = await runJob(state.base, undefined, state.deps).result;
  state.fixture = JSON.parse(await result.getRawJson().text());
  await idle();
  return { fixture: 'raw JSON captured from an actual local WASM baseline; cloud responses replay this report with actor names changed',
    localMean: result.report.players[0].dps.mean, engineIdentity: result.engineIdentity, engines: evidence() };
}

function hybrid(mode) {
  state.logicalNow = 0;
  const jobs = new Map();
  state.cloud = { mode, submittedActors: [], polls: 0, completedPolls: 0 };
  let deletes = 0;
  const fetchCloud = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/capacity')) return Response.json({ state: 'warm', waitS: 0,
      model: { speed: { Patchwerk: { overheadS: 2, secondsPerUnit: 0.001 } }, cv: {} } });
    if (init.method === 'POST') {
      const id = `6f1c1c9e-0d1b-4c43-9a55-${String(jobs.size).padStart(12, '0')}`;
      jobs.set(id, JSON.parse(init.body).request);
      state.cloud.submittedActors.push(characterBlocks(jobs.get(id).profile).map(b => b.name));
      return Response.json({ id });
    }
    if (init.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
    const id = new URL(url, location.origin).pathname.split('/').find(part => jobs.has(part));
    check(id, `unexpected mocked cloud request ${url}`);
    if (url.endsWith('/result')) {
      const raw = structuredClone(state.fixture);
      raw.sim.players = characterBlocks(jobs.get(id).profile).map(({ name }) => ({ ...structuredClone(raw.sim.players[0]), name }));
      const compressed = new Blob([JSON.stringify(raw)]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(compressed);
    }
    // Two real WASM progress messages establish blocked callMain. Logical time changes planning only, never timers or WASM.
    const running = records().some(e => e.progress >= 2 && !e.messages.includes('done') && !e.messages.includes('shutdown'));
    state.cloud.polls++;
    if (mode === 'winner' && running) state.cloud.completedPolls++;
    if (mode === 'winner' && running) state.logicalNow = 20000;
    return Response.json({ status: mode === 'winner' && running ? 'done' : 'running', lines: [], next: 0 });
  };
  const store = { getItem: () => JSON.stringify({ runs: { Patchwerk: [{ units: 30000, threads: 4, wall: 5 }] }, cv2: {} }), setItem() {} };
  setRemoteEngine(createHybridEngine({ fetch: fetchCloud, pollMs: 50, cloudThreads: 12, speedStore: store, now: () => state.logicalNow }));
  const first = characterBlocks(state.base.profile)[0].text;
  const rename = name => first.replace(/^(\s*(?:deathknight|demonhunter|druid|evoker|hunter|mage|monk|paladin|priest|rogue|shaman|warlock|warrior)\s*=).*$/m, `$1"${name}"`);
  const req = { ...state.base, profile: `${rename('HybridLocal')}\n${rename('HybridCloud')}`,
    settings: { ...state.base.settings, threads: 4, maxTime: 300 }, accuracy: { mode: 'iterations', iterations: 1000000 } };
  return { handle: runJob(req, undefined, state.deps), jobs, deleted: () => deletes };
}

export function diagnostics() {
  return { phase: state.phase, logicalNow: state.logicalNow, cloud: state.cloud, engines: evidence(), busy: engineBusy(), stopping: engineStopping() };
}

export async function cloudWinner(label = 'cloud-winner') {
  await idle();
  state.phase = label;
  const run = hybrid('winner');
  const outcome = await run.handle.result;
  await idle();
  const local = records();
  check(run.jobs.size === 2, 'cloud did not race the active local chunk');
  check(local.length === 1, 'expected exactly one actual local coordinator');
  check(local[0].progressAtCancel >= 2 && !local[0].doneBeforeCancel, 'race did not cancel blocked callMain');
  check(local[0].flagAtCancel === 1, 'actual local shared cancellation flag was not signalled');
  check(local[0].messages.includes('shutdown') && lastThreadReap()?.confirmed === true, 'local shutdown was not confirmed');
  check(outcome.report.players.length === 2, 'merged actor records missing');
  setRemoteEngine(null);
  return { submittedActors: [...run.jobs.values()].map(req => characterBlocks(req.profile).map(b => b.name)),
    shutdown: lastThreadReap(), engines: evidence(), numericalCloudParity: 'not tested; injected cloud fixture only' };
}

export async function cancel() {
  await idle();
  state.phase = 'cancel';
  const run = hybrid('hold');
  const rejection = run.handle.result.catch(error => error);
  const deadline = performance.now() + 60000;
  while (!records().some(e => e.progress >= 2)) {
    check(performance.now() < deadline, 'real local progress did not arrive before cancel');
    await sleep(50);
  }
  run.handle.cancel();
  const error = await rejection;
  check(error?.name === 'AbortError', 'cancellation did not reject as AbortError');
  await idle();
  check(lastThreadReap()?.confirmed === true, 'cancel did not confirm actual local shutdown');
  check(records()[0].flagAtCancel === 1, 'global cancel did not signal local chunk flag');
  check(run.deleted() > 0, 'cloud cancellation was not requested');
  setRemoteEngine(null);
  return { shutdown: lastThreadReap(), engines: evidence(), cloudDeleteRequests: run.deleted() };
}
