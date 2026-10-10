#!/usr/bin/env node
// Actual Chromium + production CSP/COOP/COEP. Test helper and registry never enter dist/ or releases.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { engineCompat } from './engine-compat.mjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const channels = arg('--channels', 'live,ptr').split(',');
assert.ok(channels.length && channels.every(c => ['live', 'ptr'].includes(c)), '--channels requires live,ptr');
const variants = arg('--variants', 'threaded,fallback').split(',');
assert.ok(variants.length && variants.every(v => ['threaded', 'fallback'].includes(v)), '--variants requires threaded,fallback');
const sourceDist = resolve(arg('--dist', join(root, 'dist')));
const engineRoot = resolve(arg('--engine-root', join(root, 'public/engine')));
const catalogRoot = resolve(arg('--catalog-root', join(root, 'public/catalogs')));
const output = resolve(arg('--output', join(root, 'build/browser-results.json')));
const prepareOnly = process.argv.includes('--prepare-only');
mkdirSync(join(root, 'build'), { recursive: true });
mkdirSync(resolve(output, '..'), { recursive: true });
const work = mkdtempSync(join(root, 'build/browser-'));
const dist = join(work, 'app');
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceDist, catalogRoot, appIndexSha256: null,
  engineCompat: engineCompat(root), suites: [], failures: [], scope: 'real production Chromium integration; deterministic sequential/direct numerical controls; no native/WASM ensemble or physical-device claim' };
let server;
let browser;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const waitForWorkerExit = async session => {
  const deadline = Date.now() + 5000;
  let workers;
  do {
    workers = (await session.send('Target.getTargets')).targetInfos.filter(t => t.type === 'worker');
    if (!workers.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return workers;
};
try {
  assert.ok(existsSync(join(sourceDist, 'index.html')), 'build production frontend first');
  report.appIndexSha256 = hash(readFileSync(join(sourceDist, 'index.html')));
  cpSync(sourceDist, dist, { recursive: true, mode: constants.COPYFILE_FICLONE });
  mkdirSync(join(dist, '__ci__'), { recursive: true });
  await build({ entryPoints: [join(root, 'scripts/browser-suite.mjs')], bundle: true, format: 'esm', platform: 'browser',
    outfile: join(dist, '__ci__/suite.mjs'), define: { __ENGINE_COMPAT__: JSON.stringify(report.engineCompat), 'import.meta.env.DEV': 'false' } });
  await build({ entryPoints: [join(root, 'src/lib/simc/report-worker.ts')], bundle: true, format: 'esm', platform: 'browser', outfile: join(dist, '__ci__/report-worker.mjs') });
  writeFileSync(join(dist, '__ci__/index.html'), '<!doctype html><html><head><title>Frostsim CI engine harness</title></head><body><main>Production-policy engine validation</main></body></html>');
  writeFileSync(join(dist, '__ci__/observer-child.js'), "setInterval(()=>{},1000); postMessage('child-ready');");
  writeFileSync(join(dist, '__ci__/observer-parent.js'), "const child=new Worker('/__ci__/observer-child.js'); child.onmessage=()=>postMessage('parent-ready'); onmessage=()=>{ child.terminate(); self.close(); };");
  const registry = { schemaVersion: 3, packs: [], status: null, statusByChannel: { live: null, ptr: null } };
  const catalogs = {};
  for (const channel of channels) {
    const engineDir = channel === 'ptr' ? join(engineRoot, 'ptr') : engineRoot;
    const manifest = JSON.parse(readFileSync(join(engineDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.engineChannel ?? 'live', channel, 'engine channel mismatch');
    const id = `ci-${channel}-${manifest.engine.upstreamCommit.slice(0, 12)}-${report.engineCompat}`;
    const target = join(dist, 'engine/versions', id);
    mkdirSync(target, { recursive: true });
    cpSync(join(root, 'public/engine/sim-worker.js'), join(target, 'sim-worker.js'));
    for (const variant of variants) {
      const from = variant === 'fallback' ? join(engineDir, 'fallback') : engineDir;
      const to = variant === 'fallback' ? join(target, 'fallback') : target;
      mkdirSync(to, { recursive: true });
      const m = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
      assert.equal(m.artifact, variant);
      assert.equal(m.engineChannel ?? 'live', channel);
      assert.equal(m.engine.upstreamCommit, manifest.engine.upstreamCommit);
      assert.equal(m.wow.clientDataVersion, manifest.wow.clientDataVersion);
      assert.deepEqual(m.lockMismatches ?? [], [], 'engine lock mismatch');
      assert.deepEqual(m.buildTreeMismatches ?? [], [], 'engine build tree mismatch');
      for (const name of ['simc.js', 'simc.wasm']) {
        const bytes = readFileSync(join(from, name));
        assert.equal(hash(bytes), m.files[name].sha256, `${channel}/${variant}/${name}: artifact hash mismatch`);
        assert.equal(bytes.length, m.files[name].bytes);
        cpSync(join(from, name), join(to, name), { mode: constants.COPYFILE_FICLONE });
      }
      cpSync(join(from, 'manifest.json'), join(to, 'manifest.json'));
    }
    registry.packs.push({ id, engineChannel: channel, baseUrl: `/engine/versions/${id}/`, compat: report.engineCompat,
      upstreamCommit: manifest.engine.upstreamCommit, clientDataVersion: manifest.wow.clientDataVersion,
      publishedAt: report.startedAt, commitDate: report.startedAt });
    const matchingCatalogs = readdirSync(catalogRoot).filter(name => {
      const file = join(catalogRoot, name, 'manifest.json');
      if (!existsSync(file)) return false;
      const c = JSON.parse(readFileSync(file, 'utf8'));
      return (c.engineChannel ?? c.engine.engineChannel ?? 'live') === channel &&
        c.engine.upstreamCommit === manifest.engine.upstreamCommit && c.engine.clientDataVersion === manifest.wow.clientDataVersion && c.engine.hotfixHash === manifest.wow.hotfixHash;
    }).sort((a, b) => Number(b.startsWith(`${channel}-`)) - Number(a.startsWith(`${channel}-`)) || a.localeCompare(b));
    const rejectedCatalogs = [];
    let catalogValidation;
    for (const name of matchingCatalogs) {
      try {
        catalogValidation = execFileSync(process.execPath, [join(root, 'scripts/catalog/validate-catalogs.mjs'),
          join(catalogRoot, name), '--engine', join(engineDir, 'manifest.json')], { cwd: root, encoding: 'utf8' });
        catalogs[channel] = name;
        break;
      } catch (error) {
        rejectedCatalogs.push({ name, error: String(error) });
      }
    }
    report.catalogValidation ??= {};
    report.catalogValidation[channel] = { selected: catalogs[channel] ?? null,
      manifestSha256: catalogs[channel] ? hash(readFileSync(join(catalogRoot, catalogs[channel], 'manifest.json'))) : null,
      validation: catalogValidation ?? null, rejected: rejectedCatalogs };
    assert.ok(catalogs[channel], `${channel}: no fully validated matching catalog; generate it from the frozen source. ${JSON.stringify(rejectedCatalogs)}`);
    cpSync(join(catalogRoot, catalogs[channel]), join(target, 'catalog'), { recursive: true, mode: constants.COPYFILE_FICLONE });
    const layout = existsSync(join(engineDir, 'talent-layout')) ? join(engineDir, 'talent-layout') : join(root, 'public/talent-layout');
    for (let classId = 1; classId <= 13; classId++) {
      const data = JSON.parse(readFileSync(join(layout, `class-${classId}.json`), 'utf8'));
      assert.equal(data.schemaVersion, 1);
      assert.equal(data.classId, classId);
      assert.equal(data.engineChannel ?? 'live', channel, `${channel}: talent layout channel mismatch`);
      assert.equal(data.engineCommit, manifest.engine.upstreamCommit);
      assert.equal(data.build, manifest.wow.clientDataVersion);
      assert.ok(Number.isFinite(Date.parse(data.expiresAt)) && data.nodes && data.descriptions && Array.isArray(data.edges) && data.budgetSources, 'invalid talent presentation metadata');
    }
    cpSync(layout, join(target, 'talent-layout'), { recursive: true, mode: constants.COPYFILE_FICLONE });
    const presentationPath = existsSync(join(engineDir, 'presentation.json')) ? join(engineDir, 'presentation.json') : join(root, 'public/presentation.json');
    const presentation = JSON.parse(readFileSync(presentationPath, 'utf8'));
    assert.equal(presentation.engineChannel ?? 'live', channel);
    assert.equal(presentation.engineCommit, manifest.engine.upstreamCommit);
    if (presentation.build !== undefined) assert.equal(presentation.build, manifest.wow.clientDataVersion);
    assert.ok(presentation.names && Array.isArray(presentation.augmentation) && Array.isArray(presentation.weapon), 'invalid presentation choices');
    cpSync(presentationPath, join(target, 'presentation.json'));
    // Guided UI and the numerical helper must resolve the same immutable pack catalog.
    catalogs[channel] = `/engine/versions/${id}/catalog`;
  }
  writeFileSync(join(dist, 'engine-channels.json'), JSON.stringify(registry));
  report.fixturePath = dist;
  report.browserChecksRun = !prepareOnly;
  if (!prepareOnly) {
  const port = Number(arg('--port', '4189'));
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, 'scripts/serve-pages.mjs'), '--dist', dist, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', bytes => { serverLog += bytes; });
  server.stderr.on('data', bytes => { serverLog += bytes; });
  const deadline = Date.now() + 20000;
  while (true) {
    if (server.exitCode !== null) throw new Error(`production server exited: ${serverLog}`);
    try { const r = await fetch(origin); if (r.ok) break; } catch { /* server startup */ }
    assert.ok(Date.now() < deadline, 'production server startup timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  report.chromium = browser.version();
  report.workerObservation = { mode: 'public Playwright Chromium controller and CDP target snapshots',
    positiveControl: 'live tagged parent and child discovered after jobs, then shutdown to zero',
    diagnosticRawObserver: 'preserved in ignored lifecycle-cdp snapshots; did not resolve strict all-worker failure' };
  const profile = readFileSync(join(root, 'tests/fixtures/addon-export-demonology.simc'), 'utf8');
  report.fixtureSha256 = hash(profile);
  report.helperSha256 = hash(readFileSync(join(dist, '__ci__/suite.mjs')));
  for (const channel of channels) for (const variant of variants) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const externalRequests = [];
    page.on('request', request => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    page.setDefaultTimeout(180000);
    const startObserverControl = () => page.evaluate(() => new Promise(resolve => {
      globalThis.__observerParent = new Worker('/__ci__/observer-parent.js');
      globalThis.__observerParent.onmessage = () => resolve(true);
    }));
    let suite;
    try {
      const response = await page.goto(`${origin}/?engine=${channel}`);
      assert.equal(response.headers()['cross-origin-opener-policy'], 'same-origin');
      assert.equal(response.headers()['cross-origin-embedder-policy'], 'require-corp');
      assert.equal(response.headers()['content-security-policy'], readFileSync(join(dist, '_headers'), 'utf8').match(/^\s*Content-Security-Policy: (.+)$/m)[1]);
      await page.waitForSelector('main');
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      await page.goto(`${origin}/__ci__/index.html?engine=${channel}`);
      await startObserverControl();
      suite = await page.evaluate(async input => (await import('/__ci__/suite.mjs')).runSuite(input),
        { channel, variant, profile, catalogBase: catalogs[channel] });
      report.suites.push(suite);
      if (variant === 'fallback') {
        const input = { channel, profile, catalogBase: catalogs[channel] };
        const prepared = await page.evaluate(async input => (await import('/__ci__/suite.mjs')).prepareResume(input), input);
        await page.reload();
        await startObserverControl();
        const resumed = await page.evaluate(async input => (await import('/__ci__/suite.mjs')).resumeSearch(input), input);
        suite.cases.push({ name: 'checkpoint-real-reload-resume', status: 'passed', ...prepared, ...resumed });
        const denied = await page.evaluate(async () => (await import('/__ci__/suite.mjs')).storageDenial());
        suite.cases.push({ name: 'checkpoint-quota-denial', status: 'passed', ...denied, boundary: 'real IndexedDB adapter refusal; no UI toast acceptance claim' });
        const hostileRequests = [];
        page.on('request', request => { if (request.url().includes('/hostile-')) hostileRequests.push(request.url()); });
        await page.evaluate(async () => (await import('/__ci__/suite.mjs')).mountHostileReport());
        const frame = page.frameLocator('iframe[title="Hostile policy control"]');
        await frame.getByRole('heading', { name: 'Hostile fixture' }).waitFor();
        await frame.getByRole('button', { name: 'Submit' }).click();
        await frame.getByRole('link', { name: 'Navigate' }).click();
        await page.waitForTimeout(100);
        assert.deepEqual(hostileRequests, []);
        assert.equal(await page.evaluate(() => globalThis.__reportExecuted), undefined);
        assert.equal(new URL(page.url()).pathname, '/__ci__/index.html');
        suite.cases.push({ name: 'hostile-report-browser-policy', status: 'passed', scriptExecuted: false, networkRequests: 0,
          boundary: 'actual browser sandbox and source withPolicy contract; ReportFrame UI rendering audited separately' });
      }
      const workerSession = await browser.newBrowserCDPSession();
      let controlTargets;
      const controlDeadline = Date.now() + 5000;
      do {
        const targets = await workerSession.send('Target.getTargets');
        controlTargets = targets.targetInfos.filter(t => t.type === 'worker' && t.url.includes('/__ci__/observer-'));
        if (controlTargets.length === 2) break;
        await page.waitForTimeout(100);
      } while (Date.now() < controlDeadline);
      assert.equal(controlTargets.length, 2, 'observer must discover both existing live control workers');
      const parentTarget = controlTargets.find(t => t.url.endsWith('/observer-parent.js'));
      const childTarget = controlTargets.find(t => t.url.endsWith('/observer-child.js'));
      assert.ok(parentTarget && childTarget, 'observer control URLs must identify actual parent and child');
      assert.equal(childTarget.parentId, parentTarget.targetId, 'observer control must prove nested worker topology');
      await page.evaluate(() => globalThis.__observerParent.postMessage('stop'));
      const controlCloseDeadline = Date.now() + 5000;
      let closedControls;
      do {
        const targets = await workerSession.send('Target.getTargets');
        closedControls = targets.targetInfos.filter(t => t.type === 'worker' && t.url.includes('/__ci__/observer-'));
        if (!closedControls.length) break;
        await page.waitForTimeout(100);
      } while (Date.now() < controlCloseDeadline);
      suite.workerObserverControl = { discovered: controlTargets, afterShutdown: closedControls };
      assert.equal(closedControls.length, 0, 'nested observer control workers did not terminate');
      suite.cases.push({ name: 'nested-worker-observer-positive-control', status: 'passed', discovered: 2, afterShutdown: 0 });
      const terminalWorkers = await waitForWorkerExit(workerSession);
      const runningEngineTargets = terminalWorkers.filter(t => t.url.includes('/engine/versions/ci-'));
      suite.workerTargetsAfterSuite = runningEngineTargets;
      suite.allWorkerTargetsAfterSuite = terminalWorkers;
      suite.playwrightWorkersAfterSuite = page.workers().map(worker => worker.url());
      assert.equal(runningEngineTargets.length, 0, 'engine child targets remain after terminal jobs');
      assert.equal(terminalWorkers.length, 0, 'worker targets, including unidentified or orphaned workers, remain after terminal jobs');
      suite.cases.push({ name: 'terminal-engine-worker-teardown', status: 'passed', engineWorkerTargets: 0 });
      await workerSession.detach();
      await page.reload();
      await page.evaluate(async id => (await import('/__ci__/suite.mjs')).checkPersisted(id), `ci-${channel}-${variant}`);
      suite.cases.push({ name: 'persistence-after-reload', status: 'passed' });
      if (suite.cases.find(c => c.name === 'cancel-and-retry')?.requiresReload) {
        const cdp = await browser.newBrowserCDPSession();
        const reloadWorkers = await waitForWorkerExit(cdp);
        const engineWorkers = reloadWorkers.filter(t => t.url.includes('/engine/versions/ci-'));
        suite.workerTargetsAfterReload = engineWorkers;
        suite.allWorkerTargetsAfterReload = reloadWorkers;
        assert.equal(engineWorkers.length, 0, 'engine child targets remain after explicit page reload');
        assert.equal(reloadWorkers.length, 0, 'worker targets remain after explicit page reload');
        const retry = await page.evaluate(async input => (await import('/__ci__/suite.mjs')).retryAfterReload(input), { channel, variant, profile });
        const retryWorkers = await waitForWorkerExit(cdp);
        suite.workerTargetsAfterFreshRetry = retryWorkers.filter(t => t.url.includes('/engine/versions/ci-'));
        suite.allWorkerTargetsAfterFreshRetry = retryWorkers;
        assert.equal(suite.workerTargetsAfterFreshRetry.length, 0, 'engine child targets remain after fresh retry');
        assert.equal(retryWorkers.length, 0, 'worker targets remain after fresh retry');
        suite.cases.push({ name: 'explicit-reload-and-fresh-retry', status: 'passed', engineWorkerTargetsAfterReload: engineWorkers.length, ...retry });
        await cdp.detach();
      }
      assert.deepEqual(externalRequests, [], 'browser pipeline issued a third-party request');
      assert.deepEqual(errors, [], 'uncaught browser errors');
      assert.equal(suite.cases.filter(c => c.status !== 'passed').length, 0, `${channel}/${variant}: failed browser cases`);
    } catch (error) { report.failures.push({ channel, variant, error: String(error), pageErrors: errors }); }
    finally {
      await page.close();
      if (suite) {
        const session = await browser.newBrowserCDPSession();
        const targets = await session.send('Target.getTargets');
        suite.workerTargetsAfterPageClose = targets.targetInfos.filter(t => t.type === 'worker' && t.url.includes('/engine/versions/ci-'));
        suite.allWorkerTargetsAfterPageClose = targets.targetInfos.filter(t => t.type === 'worker');
        await session.detach();
      }
      await context.close();
    }
  }
  }
} catch (error) { report.failures.push({ error: String(error) }); }
finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
  report.finishedAt = new Date().toISOString();
  report.passed = prepareOnly ? null : report.failures.length === 0;
  report.fixturePrepared = report.failures.length === 0 && !!report.fixturePath;
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(prepareOnly ? `fixture ${report.fixturePrepared ? 'prepared' : 'failed'}; browser checks not run: ${report.fixturePath}\n${output}` : `browser checks ${report.passed ? 'passed' : 'failed'}: ${output}`);
}
assert.equal(prepareOnly ? report.fixturePrepared : report.passed, true, JSON.stringify(report.failures));
