#!/usr/bin/env node
// CLOUD-only real-WASM lifecycle check. HTTP cloud responses are injected; no provider connection or paid compute.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { engineCompat } from './engine-compat.mjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const output = resolve(arg('--output', join(root, 'build/hybrid-browser-results.json')));
const channel = arg('--channel', 'live');
assert.ok(['live', 'ptr'].includes(channel));
const prepareOnly = process.argv.includes('--prepare-only');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), scope: 'actual local threaded WASM and production CSP; injected cloud HTTP responses replay a local raw report; no paid provider or numerical cloud parity claim', cases: [], failures: [] };
let server;
let browser;
mkdirSync(resolve(output, '..'), { recursive: true });

async function zeroWorkers(session) {
  const deadline = Date.now() + 5000;
  let workers;
  do {
    workers = (await session.send('Target.getTargets')).targetInfos.filter(t => t.type === 'worker');
    if (!workers.length) return workers;
    await sleep(100);
  } while (Date.now() < deadline);
  return workers;
}

try {
  let dist = arg('--fixture-root');
  if (!dist) {
    const preparedOutput = output.replace(/\.json$/, '') + '-fixture.json';
    const args = [join(root, 'scripts/browser-check.mjs'), '--prepare-only', '--channels', channel, '--variants', 'threaded', '--output', preparedOutput];
    for (const name of ['--dist', '--engine-root', '--catalog-root']) if (arg(name)) args.push(name, arg(name));
    execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    const prepared = JSON.parse(readFileSync(preparedOutput, 'utf8'));
    assert.equal(prepared.fixturePrepared, true);
    dist = prepared.fixturePath;
  }
  dist = resolve(dist);
  assert.ok(existsSync(join(dist, 'engine-channels.json')), 'fixture must be prepared by browser-check.mjs');
  report.fixturePath = dist;
  const registry = JSON.parse(readFileSync(join(dist, 'engine-channels.json'), 'utf8'));
  const pack = registry.packs.find(p => p.engineChannel === channel);
  assert.ok(pack, `fixture has no ${channel} pack`);
  assert.equal(pack.compat, engineCompat(root), 'fixture compatibility differs from current source');
  mkdirSync(join(dist, '__ci__'), { recursive: true });
  await build({ entryPoints: [join(root, 'scripts/hybrid-browser-suite.mjs')], bundle: true, format: 'esm', platform: 'browser',
    outfile: join(dist, '__ci__/hybrid-suite.mjs'), define: { __ENGINE_COMPAT__: JSON.stringify(pack.compat), 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_FEATURE_ACCOUNTS': 'false' } });
  // Fixture preparation bundles this already; recopy the current wrapper so it cannot use a stale local candidate.
  cpSync(join(root, 'public/engine/sim-worker.js'), join(dist, pack.baseUrl, 'sim-worker.js'));
  if (prepareOnly) {
    report.prepared = true;
    report.browserChecksRun = false;
  } else {
    report.browserChecksRun = true;
    const port = Number(arg('--port', '4192'));
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(root, 'scripts/serve-pages.mjs'), '--dist', dist, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    server.stdout.on('data', b => { serverLog += b; });
    server.stderr.on('data', b => { serverLog += b; });
    const deadline = Date.now() + 20000;
    while (true) {
      if (server.exitCode !== null) throw new Error(`production server exited: ${serverLog}`);
      try { if ((await fetch(origin)).ok) break; } catch { /* startup */ }
      assert.ok(Date.now() < deadline, 'production server startup timed out');
      await sleep(100);
    }
    browser = await chromium.launch({ headless: true, channel: 'chromium' });
    report.chromium = browser.version();
    const session = await browser.newBrowserCDPSession();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    const pageErrors = [];
    const external = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('request', request => { if (new URL(request.url()).origin !== origin) external.push(request.url()); });
    const response = await page.goto(`${origin}/__ci__/index.html?engine=${channel}`);
    assert.equal(response.headers()['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers()['cross-origin-embedder-policy'], 'require-corp');
    assert.equal(response.headers()['content-security-policy'], readFileSync(join(dist, '_headers'), 'utf8').match(/^\s*Content-Security-Policy: (.+)$/m)[1]);
    // Prove CDP sees the real nested worker topology before checking any zero counts.
    await page.evaluate(() => new Promise(resolve => {
      globalThis.control = new Worker('/__ci__/observer-parent.js');
      control.onmessage = () => resolve();
    }));
    const controls = (await session.send('Target.getTargets')).targetInfos.filter(t => t.type === 'worker');
    const parent = controls.find(t => t.url.endsWith('/observer-parent.js'));
    const child = controls.find(t => t.url.endsWith('/observer-child.js'));
    assert.ok(parent && child && child.parentId === parent.targetId, 'worker observer did not establish real parent-child control');
    await page.evaluate(() => control.postMessage('stop'));
    assert.deepEqual(await zeroWorkers(session), [], 'observer controls remained resident');
    report.observerControl = { parent: parent.targetId, child: child.targetId, terminalDedicatedWorkers: 0 };
    const profile = readFileSync(resolve(arg('--profile', join(root, 'tests/fixtures/addon-export-demonology.simc'))), 'utf8');
    report.setup = await page.evaluate(async input => (await import('/__ci__/hybrid-suite.mjs')).setup(input),
      { channel, profile, catalogBase: `${pack.baseUrl}catalog` });
    assert.deepEqual(await zeroWorkers(session), [], 'dedicated workers remain after catalog baseline');
    for (const [name, method, label] of [['local-baseline', 'baseline'], ['cloud-wins-blocked-local', 'cloudWinner'], ['cancel-blocked-local', 'cancel'], ['rerun-after-cancel', 'cloudWinner', 'rerun']]) {
      const started = Date.now();
      console.log(`hybrid browser: ${name}`);
      let timeout;
      const detail = await Promise.race([
        page.evaluate(async ([method, label]) => (await import('/__ci__/hybrid-suite.mjs'))[method](label), [method, label]),
        new Promise((_, reject) => { timeout = setTimeout(async () => {
          try {
            const diagnostic = await page.evaluate(async () => (await import('/__ci__/hybrid-suite.mjs')).diagnostics());
            report.phaseTimeout = { name, diagnostic };
            reject(new Error(`${name}: 60s phase deadline; ${JSON.stringify(diagnostic)}`));
          } catch (error) { reject(error); }
        }, 60000); }),
      ]).finally(() => clearTimeout(timeout));
      const workers = await zeroWorkers(session);
      assert.equal(workers.filter(t => t.url.includes('/engine/versions/')).length, 0, `${name}: engine worker targets remain`);
      assert.deepEqual(workers, [], `${name}: dedicated worker targets remain`);
      report.cases.push({ name, ms: Date.now() - started, engineWorkers: 0, allDedicatedWorkers: 0, ...detail });
      console.log(`hybrid browser: ${name} passed (${Date.now() - started} ms)`);
    }
    try {
      const cpu = async () => (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'renderer').reduce((sum, p) => sum + p.cpuTime, 0);
      const start = await cpu();
      const sampledAt = Date.now();
      await sleep(3000);
      const seconds = (Date.now() - sampledAt) / 1000;
      const coreSeconds = await cpu() - start;
      report.idleCPU = { sampledSeconds: seconds, coreSeconds, averageCores: coreSeconds / seconds, maximumAverageCores: Number(arg('--max-idle-cores', '0.25')) };
      assert.ok(report.idleCPU.averageCores <= report.idleCPU.maximumAverageCores, 'renderer CPU tail exceeds idle threshold');
    } catch (error) {
      if (String(error).includes('CPU tail')) throw error;
      report.idleCPU = { unavailable: String(error) };
    }
    assert.deepEqual(pageErrors, [], 'page errors');
    assert.deepEqual(external, [], 'unexpected external/provider requests');
    report.pageErrors = pageErrors;
    report.externalRequests = external;
    await context.close();
  }
} catch (error) {
  report.failures.push(String(error));
} finally {
  await browser?.close();
  if (server && server.exitCode === null) server.kill('SIGTERM');
  report.finishedAt = new Date().toISOString();
  report.passed = prepareOnly ? null : report.failures.length === 0;
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${prepareOnly ? 'prepared (no browser launched)' : report.passed ? 'passed' : 'failed'}: ${output}`);
}
assert.equal(report.failures.length, 0, JSON.stringify(report.failures));
