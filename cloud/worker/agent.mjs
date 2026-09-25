#!/usr/bin/env node
// Compute worker agent (CLAUDE.md D14, DESIGN.md C8, P1): claims jobs, runs native simc in a systemd sandbox that sees only /usr, the engine cache and its own job dir, uploads the gzip report. Node 22+, no dependencies.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

export const AGENT_VERSION = '1';
const ENV_FILE = '/etc/frostsim/worker.env';
const JOBS = '/var/lib/frostsim-worker/jobs';
const ENGINES = '/var/cache/frostsim/engines';
// An empty root holding only mount points. A profile line without `=` makes simc open that path, so
// ProtectSystem alone would still let a job read the host's /etc.
const ROOT = '/var/lib/frostsim-worker/root';
/** The job dir as simc sees it inside the sandbox. */
export const JOB_DIR = '/job';

const REPORT_ARG = 'json=/out.json,version=2';
// The coordinator's own bound on a stored result (compute/queue.ts RESULT_MAX_BYTES).
const REPORT_MAX_BYTES = 256 * 2 ** 20;
// Options simc reads or writes files for, matched anywhere: `name=` can sit inside a value (profileset."x"+=save=a). The coordinator
// refuses the same pattern first (server/account/compute/native.ts FILE_OPTION); refusal-corpus.test.mjs keeps the two in step.
const FILE_OPTION = /(^|[^\w.])(input|output|html|xml|json\d*|local_json|save\w*|\w+_file)\s*\+?=/i;

/** True when simc could open a file for this argument. A token without `=` is a file simc parses. `$` is refused because simc
 *  expands $(var) in names and values after this check (option.cpp parse_token): `ht$(m)=$(e)/x` becomes `html=/x`. A profileset
 *  value is parsed as a token of its own. A path in any other option's value names no file, so `raid_events=/adds,...` passes. */
function argProblem(arg) {
  if (typeof arg !== 'string' || !/^[^=]+=/.test(arg) || /[\0\r\n$]/.test(arg) || FILE_OPTION.test(arg)) return true;
  const eq = arg.indexOf('=');
  const name = arg.slice(0, eq).toLowerCase();
  return name.startsWith('profileset') && name.includes('.') && argProblem(arg.slice(eq + 1));
}

/** buildArgs output -> simc argv inside the sandbox. Throws on anything that could make simc open a file other than the two it maps. */
export function mapArgs(args, dir) {
  if (!Array.isArray(args) || args[0] !== '/profile.simc') throw new Error('Refused args: the first must be /profile.simc');
  if (args.filter((arg) => arg === REPORT_ARG).length !== 1) throw new Error(`Refused args: exactly one ${REPORT_ARG} is required`);
  return args.map((arg, i) => {
    if (i === 0) return `${dir}/profile.simc`;
    if (arg === REPORT_ARG) return `json=${dir}/out.json,version=2`;
    if (argProblem(arg)) throw new Error(`Refused arg: ${String(arg).slice(0, 100)}`);
    return arg;
  });
}

/** DESIGN.md P1 complete summary from a simc version=2 report. dpsError is the confidence margin, as in src/lib/simc/report.ts. */
export function summarize(report) {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const sim = report?.sim;
  const dps = sim?.players?.[0]?.collected_data?.dps;
  const stdDev = num(dps?.mean_std_dev), estimator = num(sim?.options?.confidence_estimator);
  return {
    dps: num(dps?.mean),
    dpsError: stdDev !== undefined && estimator !== undefined ? stdDev * estimator : undefined,
    iterations: num(sim?.options?.iterations),
  };
}

/** Queues output lines, dropping the oldest past `max`: progress is about now, and a failure shows at the end of stderr. */
export function pushLines(pending, lines, max = 1000, width = 2000) {
  for (const line of lines) {
    const text = line.replace(/\r$/, '');
    if (text) pending.push(text.slice(0, width));
  }
  if (pending.length > max) pending.splice(0, pending.length - max);
}

/** Takes one DESIGN.md P1 progress batch (<= 200 lines, well under the 64 KiB body cap) off the front of the queue. */
export function takeBatch(pending, maxLines = 200, maxBytes = 60_000) {
  let count = 0, bytes = 0;
  while (count < pending.length && count < maxLines) {
    const size = Buffer.byteLength(JSON.stringify(pending[count])) + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    count++;
  }
  return pending.splice(0, count);
}

export const backoff = (attempt, baseMs = 1000) => Math.min(60_000, baseMs * 2 ** attempt);

/** worker.env -> coordinator and token. Plain http only to loopback, so the token never crosses a network in clear. */
export function parseEnv(text) {
  const env = Object.fromEntries([...text.matchAll(/^\s*([A-Z_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
  const url = new URL(env.FROSTSIM_COORDINATOR ?? '');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('FROSTSIM_COORDINATOR must be https');
  if (!env.FROSTSIM_WORKER_TOKEN) throw new Error('FROSTSIM_WORKER_TOKEN is missing');
  return { coordinator: url.origin, token: env.FROSTSIM_WORKER_TOKEN };
}

/** systemd-run argv for one simc run. The engine cache is bound at its host path, so `binary` is valid on both sides. */
export function sandboxArgv({ unit, binary, hostDir, args, threads, memoryMax }) {
  const props = [
    'DynamicUser=yes', 'PrivateNetwork=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'NoNewPrivileges=yes',
    `MemoryMax=${memoryMax}`, 'RuntimeMaxSec=1800', `CPUQuota=${threads * 100}%`,
    `RootDirectory=${ROOT}`, 'MountAPIVFS=yes', 'PrivateDevices=yes',
    'BindReadOnlyPaths=/usr', 'BindReadOnlyPaths=/etc/ld.so.cache', `BindReadOnlyPaths=${ENGINES}`,
    `BindPaths=${hostDir}:${JOB_DIR}`, `ReadWritePaths=+${JOB_DIR}`, `WorkingDirectory=${JOB_DIR}`,
    // A compromised simc gets the kernel surface a CPU-bound program needs and no view of other tenants' processes. AF_UNIX only,
    // not `none`: systemd 255 (Ubuntu 24.04) refuses `none` on a transient unit, and PrivateNetwork already leaves no route out.
    'SystemCallFilter=@system-service', 'SystemCallErrorNumber=EPERM', 'SystemCallArchitectures=native', 'RestrictNamespaces=yes',
    'RestrictAddressFamilies=AF_UNIX', 'ProtectProc=invisible', 'ProcSubset=pid', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes', 'ProtectControlGroups=yes', 'ProtectClock=yes', 'PrivateIPC=yes', 'LockPersonality=yes',
    'MemoryDenyWriteExecute=yes', 'CapabilityBoundingSet=', 'TasksMax=512', 'LimitCORE=0',
    // ponytail: bounds each file, not the file count; /job and the private /tmp are host disk. A tmpfs job dir charged to MemoryMax
    // (PrivateTmp=disconnected, systemd 257+) closes it if a disk-filling job ever matters on these short-lived workers.
    'LimitFSIZE=1G',
  ];
  // Not --quiet: after the unit exits, systemd-run --wait prints its summary, including the CPU time a job is billed by.
  return ['--wait', '--collect', '--pipe', `--unit=${unit}`, '-p', 'CPUAccounting=yes', ...props.flatMap((prop) => ['-p', prop]), binary, ...args];
}

function systemdSandbox(spec) {
  const child = spawn('systemd-run', sandboxArgv(spec), { stdio: ['ignore', 'pipe', 'pipe'] });
  // Killing systemd-run would leave the unit running; stop the unit and let systemd-run return.
  const kill = () => execFile('systemctl', ['kill', '--signal=SIGKILL', `${spec.unit}.service`], (err) => { if (err) child.kill('SIGKILL'); });
  return { child, kill };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** systemd-run's own stderr lines around the job (unit name, then the --wait summary); not simc's, so never forwarded as notices. */
const SYSTEMD_LINE = /^(Running as unit|Finished with result|Main processes terminated|Service runtime|CPU time consumed|Memory( swap)? peak|IP traffic|IO bytes)\b/;
const SPAN_UNITS = { us: 1e-6, ms: 1e-3, s: 1, min: 60, h: 3600, d: 86400 };

/** CPU seconds from systemd-run's summary. The LAST such line: it is printed after the unit exits, so a line simc echoed from
 *  profile text can never come after it. Null when absent (an older systemd), so the coordinator falls back to wall time. */
export function cpuSeconds(lines) {
  const line = lines.findLast((l) => l.startsWith('CPU time consumed:'));
  if (!line) return null;
  let total = 0, parts = 0;
  for (const [, n, unit] of line.slice('CPU time consumed:'.length).matchAll(/(\d+(?:\.\d+)?)(us|ms|min|s|h|d)\b/g)) {
    total += Number(n) * SPAN_UNITS[unit];
    parts++;
  }
  return parts ? total : null;
}

/** simc's stderr only: systemd-run's framing lines are dropped. */
export const simcNotices = (lines) => lines.filter((l) => !SYSTEMD_LINE.test(l));
/** DESIGN.md P1 complete/fail `notices`: simc's stderr (warnings the browser engine would have logged), bounded for the coordinator. */
const NOTICES = 200, NOTICE_CHARS = 500;

/** Feeds a stream's lines to `onLines`; a line over 4 KiB is cut, so output without newlines stays bounded. Returns the flush. */
function readLines(stream, onLines) {
  let rest = '';
  stream.setEncoding('utf8').on('data', (chunk) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    if (rest.length > 4096) { parts.push(rest); rest = ''; }
    onLines(parts);
  });
  return () => onLines([rest]);
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const discard = (res) => res?.body?.cancel().catch(() => {});
const gzip = promisify(zlib.gzip);

/** The sandbox wrote this file, so the root agent never follows a link out of the job dir, blocks on a FIFO or reads past a cap. */
export async function readReport(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new Error('simc left no readable report');
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('simc left a report that is not a regular file');
    if (stat.size > REPORT_MAX_BYTES) throw new Error(`simc left a report over ${REPORT_MAX_BYTES / 2 ** 20} MiB`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Claims and runs jobs until `signal` aborts. Every side effect is injectable so tests run without systemd or a network. */
export async function serve(options) {
  const o = {
    cores: availableParallelism(), jobsDir: JOBS, enginesDir: ENGINES, sandbox: systemdSandbox, fetch: globalThis.fetch,
    memoryMax: (threads) => Math.max(256 * 2 ** 20, Math.floor((totalmem() - 2 ** 30) * threads / availableParallelism())),
    progressMs: 1000, backoffMs: 1000, idleMs: 1000, log: console.log, signal: undefined, ...options,
  };
  const engines = new Map();

  // Only the claim poll listens to the stop signal: after a SIGTERM, running jobs still report progress, complete and fail.
  const call = (path, body, ms = 30_000, signal = undefined) => o.fetch(`${o.coordinator}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
  });

  // Network errors, 5xx and 429 are retried; any other answer is final.
  async function retry(send, attempts = 5) {
    for (let attempt = 0; ; attempt++) {
      let res, error;
      try { res = await send(); } catch (err) { error = err; }
      if (res && res.status < 500 && res.status !== 429) return res;
      if (attempt + 1 >= attempts) { if (res) return res; throw error; }
      await discard(res);
      await sleep(backoff(attempt, o.backoffMs));
    }
  }

  function engine({ url, sha256: expected } = {}) {
    if (typeof url !== 'string' || !/^[0-9a-f]{64}$/.test(expected ?? '')) return Promise.reject(new Error('Invalid engine reference'));
    const file = join(o.enginesDir, expected, 'simc');
    if (existsSync(file)) return Promise.resolve(file);
    if (!engines.has(file)) {
      engines.set(file, (async () => {
        const res = await retry(() => o.fetch(url, { signal: AbortSignal.timeout(300_000) }));
        if (!res.ok) { await discard(res); throw new Error(`Engine download failed with status ${res.status}`); }
        const zst = Buffer.from(await res.arrayBuffer());
        if (sha256(zst) !== expected) throw new Error('Engine sha256 mismatch: refusing to run it');
        await mkdir(join(o.enginesDir, expected), { recursive: true, mode: 0o755 });
        const tmp = `${file}.${process.pid}.tmp`;
        if (zlib.zstdDecompress) await writeFile(tmp, await promisify(zlib.zstdDecompress)(zst));
        else {
          await writeFile(`${tmp}.zst`, zst);
          await promisify(execFile)('zstd', ['-q', '-d', '-f', '-o', tmp, `${tmp}.zst`]);
          await rm(`${tmp}.zst`, { force: true });
        }
        await chmod(tmp, 0o755);
        await rename(tmp, file);
        return file;
      })().finally(() => engines.delete(file)));
    }
    return engines.get(file);
  }

  function runSim(spec, state) {
    return new Promise((done) => {
      const { child, kill } = o.sandbox(spec);
      state.kill = kill;
      if (state.cancelled) kill();
      const endOut = readLines(child.stdout, (lines) => pushLines(state.pending, lines));
      const endErr = readLines(child.stderr, (lines) => pushLines(state.notices, lines, NOTICES, NOTICE_CHARS));
      child.on('error', (err) => { pushLines(state.notices, [err.message], NOTICES, NOTICE_CHARS); done(-1); });
      child.on('close', (code, signal) => { endOut(); endErr(); done(code ?? signal); });
    });
  }

  async function runJob(job, threads) {
    const id = job.jobId, jobPath = `/api/v1/worker/jobs/${id}`;
    const hostDir = join(o.jobsDir, id);
    const state = { done: false, cancelled: false, kill: null, pending: [], notices: [] };
    // Beats run one at a time, so progress lines reach the coordinator in order.
    let beating = Promise.resolve();
    const beat = () => (beating = beating.then(async () => {
      try {
        const res = await call(`${jobPath}/progress`, { lines: takeBatch(state.pending) });
        const body = res.ok ? await res.json().catch(() => null) : (await discard(res), null);
        if (res.status === 409 || body?.cancel === true) { state.cancelled = true; state.kill?.(); }
      } catch { /* a missed beat only shortens the lease */ }
    }));
    // takeBatch always takes at least one line (pushLines caps them), so this ends.
    const flush = async () => { while (state.pending.length) await beat(); };
    // The heartbeat runs from claim until complete or fail is sent: it holds the lease through the engine download and the
    // result upload, keeps the worker's last_seen_at fresh while no claim is possible, and carries cancels.
    const heartbeat = (async () => { while (!state.done) { await sleep(o.progressMs); if (!state.done) await beat(); } })();
    try {
      if (!threads) throw new Error('Invalid thread count');
      if (typeof job.profile !== 'string' || typeof job.resultPut?.url !== 'string') throw new Error('Invalid job');
      const args = mapArgs(job.args, JOB_DIR);
      const binary = await engine(job.engine);
      if (state.cancelled) return;
      await rm(hostDir, { recursive: true, force: true });
      await mkdir(hostDir, { recursive: true });
      await writeFile(join(hostDir, 'profile.simc'), job.profile);
      // The dynamic user is allocated when the unit starts, so it cannot own the dir beforehand.
      await chmod(hostDir, 0o777);
      const started = Date.now();
      const code = await runSim({ unit: `frostsim-job-${id}`, binary, hostDir, args, threads, memoryMax: o.memoryMax(threads) }, state);
      const wallSeconds = (Date.now() - started) / 1000;
      const cpu = cpuSeconds(state.notices);
      state.notices = simcNotices(state.notices);
      if (state.cancelled) { o.log(`job ${id}: cancelled`); return; }
      if (code !== 0) throw new Error(`simc exited with status ${code}${state.notices.length ? `: ${state.notices.join('\n')}` : ''}`);
      const raw = await readReport(join(hostDir, 'out.json'));
      const summary = summarize(JSON.parse(raw.toString('utf8')));
      const body = await gzip(raw);
      const put = await retry(() => o.fetch(job.resultPut.url, {
        method: 'PUT', headers: { 'content-type': 'application/gzip' }, body, signal: AbortSignal.timeout(120_000),
      }));
      await discard(put);
      if (!put.ok) throw new Error(`Result upload failed with status ${put.status}`);
      await flush();
      if (state.cancelled) { o.log(`job ${id}: cancelled during upload`); return; }
      const res = await retry(() => call(`${jobPath}/complete`, { wallSeconds, ...(cpu === null ? {} : { cpuSeconds: cpu }), summary, notices: state.notices }));
      await discard(res);
      o.log(`job ${id}: done in ${wallSeconds.toFixed(1)} s (complete ${res.status})`);
    } catch (err) {
      if (state.cancelled) return;
      const error = String(err?.message ?? err);
      o.log(`job ${id}: failed: ${error.slice(0, 300)}`);
      await flush();
      await retry(() => call(`${jobPath}/fail`, { error: error.length > 2000 ? error.slice(-2000) : error, notices: state.notices }))
        .then(discard, () => {});
    } finally {
      state.done = true;
      await heartbeat;
      await rm(hostDir, { recursive: true, force: true });
    }
  }

  const running = new Set();
  let used = 0, failures = 0;
  while (!o.signal?.aborted) {
    const freeCores = o.cores - used;
    if (freeCores < 1) { await Promise.race(running); continue; }
    let res = null;
    try { res = await call('/api/v1/worker/claim', { freeCores, agentVersion: AGENT_VERSION }, 35_000, o.signal); } catch { /* backoff below */ }
    if (o.signal?.aborted) break;
    if (res?.status === 204) { failures = 0; await sleep(o.idleMs); continue; }
    if (res?.status !== 200) {
      await discard(res);
      o.log(`claim failed (${res ? `status ${res.status}` : 'network error'}); retrying`);
      await sleep(backoff(failures++, o.backoffMs));
      continue;
    }
    failures = 0;
    const job = await res.json().catch(() => null);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(job?.jobId ?? '')) { o.log('claim returned no usable job id'); continue; }
    const threads = Number.isInteger(job.threads) && job.threads >= 1 && job.threads <= o.cores ? job.threads : 0;
    used += threads;
    const task = runJob(job, threads).finally(() => { used -= threads; running.delete(task); });
    running.add(task);
  }
  await Promise.all(running);
}

/** Idempotent host layout: the empty sandbox root, the engine cache, and no job dirs left by a previous agent. */
async function prepare() {
  await rm(JOBS, { recursive: true, force: true });
  await mkdir(JOBS, { recursive: true, mode: 0o700 });
  await mkdir(ENGINES, { recursive: true, mode: 0o755 });
  for (const dir of ['usr', 'etc', 'proc', 'sys', 'dev', 'run', 'tmp', 'var/tmp', JOB_DIR.slice(1), ENGINES.slice(1)]) {
    await mkdir(join(ROOT, dir), { recursive: true, mode: 0o755 });
  }
  await writeFile(join(ROOT, 'etc/ld.so.cache'), '', { flag: 'a' });
  // Ubuntu 24.04 is merged-/usr: these are symlinks on the host too.
  for (const dir of ['bin', 'sbin', 'lib', 'lib64']) await symlink(`usr/${dir}`, join(ROOT, dir)).catch(() => {});
}

/**
 * Run by setup.sh on the snapshot builder with every sandboxArgv property: the real sandbox must start and write its job dir, and
 * must not see the host's /etc or other users' processes, write /usr, or open a socket.
 */
async function selfTest() {
  await prepare();
  const hostDir = join(JOBS, 'self-test');
  await mkdir(hostDir, { recursive: true });
  await chmod(hostDir, 0o777);
  const checks = 'touch ok && ! test -e /etc/hostname && ! test -e /proc/1 && ! touch /usr/x 2>/dev/null'
    + ' && ! (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null';
  const { child } = systemdSandbox({ unit: 'frostsim-job-self-test', binary: '/usr/bin/bash', hostDir,
    args: ['-c', checks], threads: 1, memoryMax: 256 * 2 ** 20 });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const code = await new Promise((done) => child.on('close', done));
  const ok = code === 0 && existsSync(join(hostDir, 'ok'));
  await rm(hostDir, { recursive: true, force: true });
  console.log(ok ? 'Sandbox self-test passed' : `Sandbox self-test failed (exit ${code})`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const env = parseEnv(readFileSync(ENV_FILE, 'utf8'));
  await prepare();
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  console.log(`frostsim worker agent ${AGENT_VERSION}: ${availableParallelism()} cores, coordinator ${env.coordinator}`);
  await serve({ ...env, signal: controller.signal });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err?.message ?? err); process.exitCode = 1; });
}
