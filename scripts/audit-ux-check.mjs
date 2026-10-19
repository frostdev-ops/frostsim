// Focused real-browser regressions for audit U1/U2/U3/F1. No provider or simulation calls.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const output = resolve(arg('--output', 'build/audit-ux/after'));
const dist = arg('--dist', 'dist');
const port = arg('--port', '4197');
const origin = `http://127.0.0.1:${port}`;
mkdirSync(output, { recursive: true });
const server = spawn(process.execPath, ['scripts/serve-pages.mjs', '--dist', dist, '--port', port], { stdio: 'ignore' });
let browser;
const report = { scope: 'Chromium production CSP, bundled sample, no provider calls; no physical-device or assistive-technology claim', checks: [], views: [], pageErrors: [] };
const check = (name, pass, actual) => report.checks.push({ name, pass: !!pass, actual });
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* startup */ }
    if (attempt > 100) throw new Error('preview startup timed out');
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  report.chromium = browser.version();
  for (const mode of ['reduced', 'forced']) {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference', forcedColors: mode === 'forced' ? 'active' : 'none', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.__webglAttempts = 0;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (kind.includes('webgl')) { window.__webglAttempts++; return null; }
        return original.call(this, kind, ...args);
      };
    });
    const requests = [];
    await context.route('**/api/**', route => { requests.push(route.request().url()); return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); });
    const page = await context.newPage();
    const assets = [];
    const scriptBodies = [];
    page.on('request', r => assets.push(r.url()));
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('response', response => {
      if (response.request().resourceType() === 'script') scriptBodies.push(response.body().then(bytes => ({ url: response.url(), gzip9: gzipSync(bytes, { level: 9 }).length })));
    });
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Try the sample character' }).waitFor();
    await page.waitForTimeout(350);
    check(`${mode}: no decorative WebGL construction`, await page.evaluate(() => window.__webglAttempts === 0), await page.evaluate(() => window.__webglAttempts));
    check(`${mode}: scene chunk not downloaded`, !assets.some(u => /\/scene-[^/]+\.js/.test(u)), assets.filter(u => /\/scene-[^/]+\.js/.test(u)));
    if (mode === 'reduced') {
      report.initialScripts = await Promise.all(scriptBodies);
      report.initialScriptGzip9 = report.initialScripts.reduce((sum, script) => sum + script.gzip9, 0);
      check('startup: secondary tool chunks load on use', !assets.some(url => /\/(?:TopGear|Droptimizer|CrestSim|Compare|Reports|Advanced)-[^/]+\.js/.test(url)));
      for (const [width, theme] of [[320, 'dark'], [320, 'light'], [390, 'dark'], [390, 'light'], [1440, 'dark'], [1440, 'light']]) {
        await page.setViewportSize({ width, height: 960 });
        // Explicit saved theme exercises the same pre-paint preference as Settings.
        await page.evaluate(value => localStorage.setItem('frostsim.theme', value), theme);
        await page.reload({ waitUntil: 'networkidle' });
        await page.screenshot({ path: `${output}/character-${width}-${theme}.png`, fullPage: true });
        const metrics = await page.evaluate(() => ({
          width: innerWidth, pageWidth: document.documentElement.scrollWidth,
          headerHeight: document.querySelector('.topbar').getBoundingClientRect().height,
          controls: [...document.querySelectorAll('.nav-toggle, .gear-btn, button.primary')].filter(e => e.getBoundingClientRect().width).map(e => ({ name: e.getAttribute('aria-label') || e.textContent.trim(), height: e.getBoundingClientRect().height })),
        }));
        report.views.push({ width, theme, ...metrics });
        check(`${width}/${theme}: no page overflow`, metrics.pageWidth <= width, metrics.pageWidth);
        if (width < 500) {
          check(`${width}/${theme}: compact closed header`, metrics.headerHeight <= 100, metrics.headerHeight);
          check(`${width}/${theme}: primary targets at least 44px`, metrics.controls.every(c => c.height >= 44), metrics.controls);
        }
      }
      if (process.argv.includes('--screenshots-only')) { await context.close(); continue; }
      await page.setViewportSize({ width: 320, height: 960 });
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      check('mobile: Settings remains accessible in menu', await page.getByRole('button', { name: 'Settings', exact: true }).isVisible());
      check('mobile: menu controls at least44px', await page.getByRole('button', { name: 'Settings', exact: true }).evaluate(e => e.getBoundingClientRect().height >= 44));
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.getByRole('button', { name: 'Try the sample character' }).click();
      await page.getByRole('heading', { name: 'Testchar', exact: true }).waitFor();
      await page.waitForTimeout(500);
      check('sample: no fake external profile request', !requests.some(u => /raider-profile.*testrealm/i.test(u)), requests.filter(u => /raider-profile/i.test(u)));
      check('sample: no broken Raider.IO destination', await page.locator('.character-banner a[href*="raider.io"]').count() === 0, await page.locator('.character-banner a[href*="raider.io"]').count());
      check('sample: provenance is visible', await page.getByText('Sample character', { exact: true }).count() > 0);
      await page.goto(`${origin}/#/gear`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'Top Gear', exact: true }).waitFor();
      check('Top Gear: visiting downloads the tool chunk', assets.some(url => /\/TopGear-[^/]+\.js/.test(url)));
      await page.screenshot({ path: `${output}/top-gear-1440-light.png`, fullPage: true });
      check('Top Gear: secondary choices are collapsed', await page.locator('details.secondary-choices:not([open])').count() === 3, await page.locator('details.secondary-choices:not([open])').count());
      await page.getByRole('button', { name: 'Options', exact: true }).click();
      check('Top Gear: shortcut reveals collapsed settings', await page.locator('#gear-options').evaluate(e => e.open));
      await page.getByRole('combobox', { name: /^Fight length/ }).selectOption('180');
      await page.locator('#gear-options > summary').click();
      check('Top Gear: closed summary reflects configured choice', (await page.locator('#gear-options > summary').innerText()).includes('180s'));
      await page.getByRole('button', { name: 'Options', exact: true }).click();
      check('Top Gear: reopening preserves settings', await page.getByRole('combobox', { name: /^Fight length/ }).inputValue() === '180');
      await page.goto(`${origin}/#/help`, { waitUntil: 'networkidle' });
      check('help: local execution scope is explicit', (await page.locator('body').innerText()).includes('Browser simulations run locally.'));
      check('help: default build excludes optional cloud instructions', !(await page.locator('body').innerText()).includes('AI explanations are opt-in.'));
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('radiogroup', { name: 'Motion', exact: true }).getByText('Full', { exact: true }).click();
      await page.waitForTimeout(1600);
      const fullAttempts = await page.evaluate(() => window.__webglAttempts);
      check('motion: opting into full motion permits scene construction', fullAttempts > 0, fullAttempts);
      await page.emulateMedia({ forcedColors: 'active' });
      await page.waitForTimeout(150);
      const forcedAttempts = await page.evaluate(() => window.__webglAttempts);
      await page.getByRole('radiogroup', { name: 'Motion', exact: true }).getByText('Reduced', { exact: true }).click();
      await page.getByRole('radiogroup', { name: 'Motion', exact: true }).getByText('Full', { exact: true }).click();
      await page.waitForTimeout(1400);
      check('motion: forced colors overrides full-motion preference changes', await page.evaluate(() => window.__webglAttempts) === forcedAttempts);
      await page.emulateMedia({ forcedColors: 'none' });
      await page.waitForTimeout(1400);
      check('motion: clearing forced colors permits scene again', await page.evaluate(() => window.__webglAttempts) > forcedAttempts);
    }
    await context.close();
  }
  check('runtime: no uncaught page errors', report.pageErrors.length === 0, report.pageErrors);
} catch (error) {
  report.error = String(error.stack || error);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (report.error || report.checks.some(c => !c.pass)) process.exitCode = 1;
