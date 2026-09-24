// Worker agent tests (CLAUDE.md D14, DESIGN.md P1): a fake coordinator over node:http and a fake simc script stand in for the network and systemd.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, zstdCompressSync } from 'node:zlib';
import { JOB_DIR, backoff, mapArgs, parseEnv, pushLines, readReport, sandboxArgv, serve, summarize, takeBatch } from './agent.mjs';

const ARGS = ['/profile.simc', 'fight_style=Patchwerk', 'max_time=300', 'iterations=1000', 'threads=2', 'progressbar_type=1', 'json=/out.json,version=2'];

describe('mapArgs', () => {
  it('maps the profile and report paths into the job dir and keeps every other arg', () => {
    expect(mapArgs(ARGS, '/job')).toEqual(['/job/profile.simc', ...ARGS.slice(1, -1), 'json=/job/out.json,version=2']);
  });
  it('refuses bare tokens, file options, variables, a bare profileset value and a missing or repeated report', () => {
    const refused = [
      'extra.simc', '-', '=x', '$(x)', 'input=a.simc', 'html=/out.html', 'save=me.simc', 'save_actions=a', 'reforge_plot_output_file=x',
      'json2=x', 'profileset."a"+=save=x', 'profileset."a"+=/etc/passwd', 'profileset.a=', '$(v)=input=b', 'enemy=a\nb', 'output=x',
      // simc expands $(var) after this check: these become html=/tmp/x.html and output=/etc/x.
      '$(e)=', '$(m)=ml', 'ht$(m)=$(e)/tmp/x.html', 'out$(n)=$(e)/etc/x',
    ];
    for (const arg of refused) expect(() => mapArgs([...ARGS, arg], '/job'), arg).toThrow(/Refused/);
    expect(() => mapArgs(ARGS.slice(1), '/job')).toThrow(/first/);
    expect(() => mapArgs(ARGS.slice(0, -1), '/job')).toThrow(/exactly one/);
    expect(() => mapArgs([...ARGS, 'json=/out.json,version=2'], '/job')).toThrow(/exactly one/);
    expect(() => mapArgs([...ARGS, 42], '/job')).toThrow(/Refused/);
    // A path in a value that names no file is fine: raid events and action lists are written with slashes.
    const kept = ['target_error=0.1', 'enemy="Fluffy Pillow"', 'analyze_error_interval=100', 'raid_events=/adds,count=3,first=30,cooldown=60',
      'raid_events+=/movement,cooldown=30,distance=10', 'actions+=/shadow_bolt', 'profileset."a"+=head=,id=1,bonus_id=1/2', 'override.bloodlust=0'];
    expect(mapArgs([...ARGS, ...kept], '/job')).toEqual(['/job/profile.simc', ...ARGS.slice(1, -1), 'json=/job/out.json,version=2', ...kept]);
  });
});

describe('summarize', () => {
  it('reads mean DPS, the confidence margin and total iterations, and omits what is missing', () => {
    const report = { sim: { options: { iterations: 1003, confidence_estimator: 1.96 }, players: [{ collected_data: { dps: { mean: 1000, mean_std_dev: 10 } } }] } };
    expect(summarize(report)).toEqual({ dps: 1000, dpsError: 19.6, iterations: 1003 });
    expect(JSON.parse(JSON.stringify(summarize({ sim: {} })))).toEqual({});
  });
});

describe('progress batching', () => {
  it('drops the oldest queued lines, strips CR, and takes batches within the line and byte caps', () => {
    const pending = [];
    pushLines(pending, Array.from({ length: 1500 }, (_, i) => `line ${i}\r`), 1000);
    expect(pending).toHaveLength(1000);
    expect(pending[0]).toBe('line 500');
    expect(takeBatch(pending)).toHaveLength(200);
    expect(pending[0]).toBe('line 700');
    const long = [];
    pushLines(long, Array.from({ length: 50 }, () => 'x'.repeat(5000)));
    const batch = takeBatch(long);
    expect(batch[0]).toHaveLength(2000);
    expect(Buffer.byteLength(JSON.stringify({ lines: batch }))).toBeLessThan(64 * 1024);
    expect(long.length).toBe(50 - batch.length);
  });
});

describe('backoff and env', () => {
  it('doubles up to a minute', () => {
    expect([0, 1, 2, 10].map((n) => backoff(n))).toEqual([1000, 2000, 4000, 60_000]);
  });
  it('requires https except on loopback, and a token', () => {
    expect(parseEnv('FROSTSIM_COORDINATOR=https://sim.frostdev.io/\nFROSTSIM_WORKER_TOKEN= abc \n'))
      .toEqual({ coordinator: 'https://sim.frostdev.io', token: 'abc' });
    expect(parseEnv('FROSTSIM_COORDINATOR=http://127.0.0.1:3012\nFROSTSIM_WORKER_TOKEN=t').coordinator).toBe('http://127.0.0.1:3012');
    expect(() => parseEnv('FROSTSIM_COORDINATOR=http://sim.frostdev.io\nFROSTSIM_WORKER_TOKEN=t')).toThrow(/https/);
    expect(() => parseEnv('FROSTSIM_COORDINATOR=https://sim.frostdev.io')).toThrow(/TOKEN/);
  });
});

describe('sandboxArgv', () => {
  it('runs simc in the empty root with the contract properties, sized to the job', () => {
    const argv = sandboxArgv({ unit: 'frostsim-job-j1', binary: '/var/cache/frostsim/engines/abc/simc', hostDir: '/var/lib/frostsim-worker/jobs/j1',
      args: ['/job/profile.simc', 'threads=4'], threads: 4, memoryMax: 8_000_000_000 });
    expect(argv.slice(0, 5)).toEqual(['--quiet', '--wait', '--collect', '--pipe', '--unit=frostsim-job-j1']);
    const props = argv.filter((_, i) => argv[i - 1] === '-p');
    for (const prop of ['DynamicUser=yes', 'PrivateNetwork=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes',
      'NoNewPrivileges=yes', 'MemoryMax=8000000000', 'RuntimeMaxSec=1800', 'CPUQuota=400%', 'RootDirectory=/var/lib/frostsim-worker/root',
      'BindPaths=/var/lib/frostsim-worker/jobs/j1:/job', 'ReadWritePaths=+/job', 'WorkingDirectory=/job',
      'SystemCallFilter=@system-service', 'RestrictAddressFamilies=none', 'RestrictNamespaces=yes', 'ProtectProc=invisible', 'ProcSubset=pid',
      'PrivateIPC=yes', 'MemoryDenyWriteExecute=yes', 'CapabilityBoundingSet=', 'TasksMax=512', 'LimitFSIZE=1G', 'LimitCORE=0']) expect(props).toContain(prop);
    expect(argv.slice(-3)).toEqual(['/var/cache/frostsim/engines/abc/simc', '/job/profile.simc', 'threads=4']);
  });
});

describe('readReport', () => {
  it('reads a regular file and refuses a symlink, a FIFO (without blocking) and a file over the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frostsim-report-'));
    try {
      writeFileSync(join(dir, 'ok.json'), '{"sim":{}}');
      expect((await readReport(join(dir, 'ok.json'))).toString()).toBe('{"sim":{}}');
      writeFileSync(join(dir, 'host-secret'), 'SECRET');
      symlinkSync(join(dir, 'host-secret'), join(dir, 'link.json'));
      await expect(readReport(join(dir, 'link.json'))).rejects.toThrow(/no readable report/);
      execFileSync('mkfifo', [join(dir, 'fifo.json')]);
      await expect(readReport(join(dir, 'fifo.json'))).rejects.toThrow(/not a regular file/);
      writeFileSync(join(dir, 'big.json'), '');
      truncateSync(join(dir, 'big.json'), 256 * 2 ** 20 + 1);
      await expect(readReport(join(dir, 'big.json'))).rejects.toThrow(/over 256 MiB/);
      await expect(readReport(join(dir, 'missing.json'))).rejects.toThrow(/no readable report/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Stands in for simc: reads its profile for a MODE, prints progress to stdout and notices to stderr, writes the report.
const FAKE_SIMC = `#!/usr/bin/env node
const fs = require('node:fs');
const [profile, ...rest] = process.argv.slice(2);
const out = rest.find((a) => a.startsWith('json=')).slice(5).split(',')[0];
const text = fs.readFileSync(profile, 'utf8');
const pidFile = /PIDFILE=(\\S+)/.exec(text);
if (pidFile) fs.writeFileSync(pidFile[1], String(process.pid));
const link = /LINK=(\\S+)/.exec(text);
if (link) { fs.symlinkSync(link[1], out); process.exit(0); }
if (text.includes('MODE=fail')) { process.stderr.write('Error: boom\\n'); process.exit(3); }
if (text.includes('MODE=noisy')) for (let i = 0; i < 300; i++) process.stderr.write(i + ':' + 'x'.repeat(600) + '\\n');
if (text.includes('MODE=hang')) setInterval(() => console.log('progress\\t1'), 10);
else {
  console.log('Generating baseline...');
  process.stderr.write('Warning: fake notice\\n');
  setTimeout(() => {
    fs.writeFileSync(out, JSON.stringify({ sim: { options: { iterations: 1000, confidence_estimator: 1.96 },
      players: [{ collected_data: { dps: { mean: 1234.5, mean_std_dev: 10 } } }] } }));
    console.log('done');
  }, text.includes('MODE=slow') ? 300 : 0);
}
`;

// Nothing below polls a clock: the fake coordinator wakes waiters on every request, and each test waits for the event it needs.
// The only bound is this timeout. Measured 2026-09-24 on a 15-core Mac, slowest test: 0.40 s alone, 0.41 s in a full `npm test`,
// 0.55 s with 8 full suites at once, 0.46 s with 30 busy-loop processes. 30 s leaves node start-up for the fake simc 50x headroom.
const SERVE_TIMEOUT_MS = 30_000;

describe('serve against a fake coordinator', { timeout: SERVE_TIMEOUT_MS }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'frostsim-agent-'));
  const engineZst = zstdCompressSync(Buffer.from(FAKE_SIMC));
  const engineSha = createHash('sha256').update(engineZst).digest('hex');
  const record = { claims: [], progress: [], complete: new Map(), fail: new Map(), results: new Map(), engineGets: 0, unauthorized: 0, puts: new Map() };
  const logs = [];
  const holdPut = new Set();
  const queue = [];
  const cancel = new Set();
  let server, base;

  const waiters = new Set(), claimWaiters = new Set();
  const wakeAll = (set) => { for (const wake of set) wake(); set.clear(); };
  const changed = () => wakeAll(waiters);
  async function until(check) { while (!check()) await new Promise((wake) => waiters.add(wake)); }
  /** Queues claim answers and wakes a claim long poll waiting for one. */
  const push = (...items) => { queue.push(...items); wakeAll(claimWaiters); };
  /** The agent logs `done` only after the coordinator answered complete, so stopping it then aborts nothing in flight. */
  const logged = (id, what) => logs.some((line) => line.startsWith(`job ${id}: ${what}`));

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(value === undefined ? undefined : JSON.stringify(value));
        changed();
      };
      if (req.url === '/engine') { record.engineGets++; res.writeHead(200); return res.end(engineZst); }
      const put = /^\/result\/(.+)$/.exec(req.url);
      if (put) {
        const start = Date.now(), seen = record.progress.length;
        // Answers only once a beat for this job arrives mid-upload: the lease must outlive a slow PUT.
        if (holdPut.has(put[1])) await until(() => record.progress.slice(seen).some((p) => p.id === put[1]));
        record.puts.set(put[1], { start, end: Date.now() });
        record.results.set(put[1], { type: req.headers['content-type'], body });
        return send(200, {});
      }
      if (req.headers.authorization !== 'Bearer test-token') { record.unauthorized++; return send(401, {}); }
      const json = body.length ? JSON.parse(body) : null;
      if (req.url === '/api/v1/worker/claim') {
        record.claims.push(json);
        // A long poll, like the coordinator's: held until a job is queued or the agent hangs up.
        if (!queue.length) await new Promise((wake) => { claimWaiters.add(wake); res.once('close', wake); });
        const next = queue.shift();
        if (next === undefined) return send(204);
        return typeof next === 'number' ? send(next, {}) : send(200, next);
      }
      const [, id, action] = /^\/api\/v1\/worker\/jobs\/([^/]+)\/(\w+)$/.exec(req.url) ?? [];
      if (action === 'progress') { record.progress.push({ id, lines: json.lines, at: Date.now() }); return send(200, { cancel: cancel.has(id) }); }
      if (action === 'complete' || action === 'fail') { record[action].set(id, json); return send(200, {}); }
      send(404, {});
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(tmp, { recursive: true, force: true });
  });

  const job = (jobId, profile, overrides = {}) => ({ jobId, threads: 2, profile, args: ARGS, leaseSeconds: 60,
    engine: { url: `${base}/engine`, sha256: engineSha }, resultPut: { url: `${base}/result/${jobId}` }, ...overrides });

  // Emulates the systemd bind mount: /job inside the sandbox is the host job dir.
  const sandbox = ({ binary, hostDir, args }) => {
    const child = spawn(binary, args.map((arg) => arg.replaceAll(`${JOB_DIR}/`, `${hostDir}/`)), { stdio: ['ignore', 'pipe', 'pipe'] });
    return { child, kill: () => child.kill('SIGKILL') };
  };

  async function withAgent(fn) {
    const controller = new AbortController();
    const jobsDir = join(tmp, 'jobs');
    const done = serve({ coordinator: base, token: 'test-token', cores: 4, jobsDir, enginesDir: join(tmp, 'engines'), sandbox,
      memoryMax: () => 1, progressMs: 20, backoffMs: 5, idleMs: 5, log: (line) => { logs.push(line); changed(); }, signal: controller.signal });
    try { await fn(); } finally { controller.abort(); await done; }
    expect(existsSync(jobsDir) ? readdirSync(jobsDir) : []).toEqual([]);
  }

  it('backs off a failing claim, runs two jobs side by side, uploads gzip results and completes with the notices', async () => {
    push(503, job('ok-1', 'MODE=slow\n'), job('ok-2', 'MODE=slow\n'));
    await withAgent(() => until(() => logged('ok-1', 'done') && logged('ok-2', 'done')));
    expect(record.claims.slice(0, 3).map((c) => c.freeCores)).toEqual([4, 4, 2]);
    expect(record.claims[0].agentVersion).toBe('1');
    for (const id of ['ok-1', 'ok-2']) {
      const result = record.results.get(id);
      expect(result.type).toBe('application/gzip');
      expect(summarize(JSON.parse(gunzipSync(result.body)))).toEqual({ dps: 1234.5, dpsError: 19.6, iterations: 1000 });
      const { wallSeconds, summary, notices } = record.complete.get(id);
      expect(wallSeconds).toBeGreaterThan(0.2);
      expect(summary).toEqual({ dps: 1234.5, dpsError: 19.6, iterations: 1000 });
      expect(notices).toEqual(['Warning: fake notice']);
      expect(record.progress.filter((p) => p.id === id).flatMap((p) => p.lines)).toEqual(expect.arrayContaining(['Generating baseline...', 'done']));
    }
    // One download serves both jobs, through the in-flight map or the cache.
    expect(record.engineGets).toBe(1);
    expect(existsSync(join(tmp, 'engines', engineSha, 'simc'))).toBe(true);
    expect(record.unauthorized).toBe(0);
  });

  it('forwards only the last 200 stderr lines, each cut to 500 characters', async () => {
    push(job('noisy-1', 'MODE=noisy\n'));
    await withAgent(() => until(() => logged('noisy-1', 'done')));
    const { notices } = record.complete.get('noisy-1');
    expect(notices).toHaveLength(200);
    expect(notices[0]).toBe(`101:${'x'.repeat(496)}`);
    expect(notices.at(-2)).toMatch(/^299:x{496}$/);
    expect(notices.at(-1)).toBe('Warning: fake notice');
  });

  it('kills simc on a cancel and reports neither complete nor fail', async () => {
    const pidFile = join(tmp, 'hang.pid');
    push(job('hang-1', `MODE=hang\nPIDFILE=${pidFile}\n`));
    await withAgent(async () => {
      await until(() => record.progress.some((p) => p.id === 'hang-1' && p.lines.includes('progress\t1')));
      cancel.add('hang-1');
      await until(() => logs.includes('job hang-1: cancelled'));
    });
    expect(record.complete.has('hang-1') || record.fail.has('hang-1')).toBe(false);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('still reports a job that was running when the agent was told to stop', async () => {
    push(job('stop-1', 'MODE=slow\n'));
    await withAgent(() => until(() => record.progress.some((p) => p.id === 'stop-1')));
    expect(record.complete.has('stop-1')).toBe(true);
    expect(record.fail.has('stop-1')).toBe(false);
  });

  it('keeps the lease through a slow result upload, and completes after it', async () => {
    holdPut.add('upload-1');
    push(job('upload-1', 'MODE=ok\n'));
    await withAgent(() => until(() => logged('upload-1', 'done')));
    const { start, end } = record.puts.get('upload-1');
    expect(record.progress.some((p) => p.id === 'upload-1' && p.at >= start && p.at <= end)).toBe(true);
  });

  it('fails a job whose report is a symlink out of the job dir, without uploading the target', async () => {
    const secret = join(tmp, 'host-secret.json');
    writeFileSync(secret, '{"hostOnly":"SECRET"}');
    push(job('link-1', `LINK=${secret}\n`));
    await withAgent(() => until(() => record.fail.has('link-1')));
    expect(record.fail.get('link-1')).toEqual({ error: 'simc left no readable report', notices: [] });
    expect(record.results.has('link-1')).toBe(false);
  });

  it('fails with the stderr tail when simc exits non-zero, and forwards it as notices', async () => {
    push(job('fail-1', 'MODE=fail\n'));
    await withAgent(() => until(() => record.fail.has('fail-1')));
    expect(record.fail.get('fail-1')).toEqual({ error: 'simc exited with status 3: Error: boom', notices: ['Error: boom'] });
    expect(record.results.has('fail-1')).toBe(false);
  });

  it('refuses an engine whose sha256 does not match, and args that could escape the job dir, without running simc', async () => {
    const gets = record.engineGets;
    push(job('sha-1', 'MODE=ok\n', { engine: { url: `${base}/engine`, sha256: 'f'.repeat(64) } }),
      job('args-1', 'MODE=ok\n', { args: [...ARGS, 'input=/etc/passwd'] }));
    await withAgent(() => until(() => record.fail.has('sha-1') && record.fail.has('args-1')));
    expect(record.fail.get('sha-1').error).toMatch(/sha256 mismatch/);
    expect(existsSync(join(tmp, 'engines', 'f'.repeat(64)))).toBe(false);
    expect(record.fail.get('args-1').error).toMatch(/^Refused arg: input=/);
    expect(record.engineGets).toBe(gets + 1);
    expect(record.progress.filter((p) => ['sha-1', 'args-1'].includes(p.id)).flatMap((p) => p.lines)).toEqual([]);
  });
});
