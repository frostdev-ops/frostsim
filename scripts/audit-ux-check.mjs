// Focused real-browser regressions for audit U1/U2/U3/F1. No provider or simulation calls.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const output = resolve(arg('--output', 'build/audit-ux/after'));
const dist = arg('--dist', 'dist');
const accounts = process.argv.includes('--accounts');
const port = arg('--port', '4197');
const origin = `http://127.0.0.1:${port}`;
mkdirSync(output, { recursive: true });
let hostedFixture;
if (accounts) {
  // Reuse the frozen sanitized report already verified by the codec tests.
  const { build } = await import('esbuild');
  const codec = await build({ entryPoints: [resolve('src/lib/store/report-share.ts')], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { decodeReport, DICTIONARY } = await import(`data:text/javascript;base64,${Buffer.from(codec.outputFiles[0].contents).toString('base64')}`);
  const shared = await decodeReport(readFileSync('tests/fixtures/shared-report-v1.txt', 'utf8').trim(), JSON.parse(readFileSync(`public/share/${DICTIONARY}.json`, 'utf8')));
  hostedFixture = gzipSync(JSON.stringify({ format: 'frostsim', version: 1, kind: 'report', exportedAt: 0, payload: { shared, rawReport: null } }));
}
const server = spawn(process.execPath, ['scripts/serve-pages.mjs', '--dist', dist, '--port', port], { stdio: 'ignore' });
let browser;
const report = { scope: 'Chromium production CSP, bundled sample, no provider calls; no physical-device or assistive-technology claim', accounts, checks: [], views: [], pageErrors: [] };
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
    await context.route('**/api/**', route => {
      const url = new URL(route.request().url());
      requests.push(url.href);
      // Local fixtures only: exercise the signed-out account UI without an OAuth or provider call.
      if (accounts && url.pathname === '/api/v1/auth/providers') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: [{ id: 'battlenet', label: 'Battle.net' }] }) });
      if (accounts && url.pathname === '/api/v1/me') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized', message: 'Sign in to continue.' }) });
      if (accounts && url.pathname === '/api/v1/shares/BBBBBBBBBBBBBBBBBBBBBB/blob') return route.fulfill({ status: 200, contentType: 'application/gzip', body: hostedFixture });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: 'Local audit fixture: service unavailable.' }) });
    });
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
      if (accounts) check('accounts: anonymous startup does not request account API', !requests.some(url => new URL(url).pathname.startsWith('/api/v1/')));
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
      // Start the menu flow at the top, independently of full-page capture/resize scroll anchoring.
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      check('mobile: Settings remains accessible in menu', await page.getByRole('button', { name: 'Settings', exact: true }).isVisible());
      check('mobile: menu controls at least44px', await page.getByRole('button', { name: 'Settings', exact: true }).evaluate(e => e.getBoundingClientRect().height >= 44));
      if (accounts) {
        const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
        check('accounts: mobile Sign in remains accessible in menu', await signIn.isVisible());
        check('accounts: mobile Sign in target at least44px', await signIn.evaluate(e => e.getBoundingClientRect().height >= 44), await signIn.evaluate(e => e.getBoundingClientRect().height));
        await signIn.click();
        await page.getByRole('button', { name: 'Continue with Battle.net', exact: true }).waitFor();
        check('accounts: mobile sign-in dialog fits viewport', await page.getByRole('dialog').evaluate(e => { const rect = e.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }));
        await page.keyboard.press('Escape');
      }
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
      await page.getByRole('heading', { name: 'Help and status', exact: true }).waitFor();
      const helpCopy = await page.locator('main').innerText();
      check('help: local execution scope is explicit', helpCopy.includes('Browser simulations run locally.'));
      check('help: optional cloud instructions follow build feature', accounts === helpCopy.includes('AI explanations are opt-in.'));
      if (accounts) {
        check('accounts: Help explains each opt-in data flow', ['Cloud runs are opt-in.', 'Account sync sends saved characters to your account.', 'AI explanations are opt-in.', 'Hosted report'].every(text => helpCopy.includes(text)));
        check('accounts: footer identifies optional cloud execution', (await page.locator('footer').innerText()).includes('Cloud runs are opt-in.'));
        await page.goto(`${origin}/#/plans`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { level: 1, name: /Sim on our servers/ }).waitFor();
        await page.getByRole('link', { name: 'See plans', exact: true }).click();
        check('accounts: See plans preserves plans route', await page.evaluate(() => location.hash === '#/plans'));
        check('accounts: plans render without import error', await page.getByRole('heading', { name: 'This screen could not be displayed', exact: true }).count() === 0);
        await page.setViewportSize({ width: 320, height: 960 });
        check('accounts: plans fit narrow viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `${output}/plans-320-light.png`, fullPage: true });
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.goto(`${origin}/#/discord`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Server settings', exact: true }).waitFor();
        check('accounts: Discord settings route renders signed-out path', await page.getByRole('button', { name: 'Sign in', exact: true }).count() > 0);
        for (const route of ['r/invalid', 's/invalid', 's/AAAAAAAAAAAAAAAAAAAAAA']) {
          await page.goto(`${origin}/#/${route}`, { waitUntil: 'networkidle' });
          await page.getByRole('heading', { name: 'Could not open shared report', exact: true }).waitFor();
          check(`accounts: ${route} reaches shared-report error state`, await page.getByRole('heading', { name: 'This screen could not be displayed', exact: true }).count() === 0);
        }
        check('accounts: valid hosted-share route requests API fixture', requests.some(url => /\/api\/v1\/.*AAAAAAAAAAAAAAAAAAAAAA/.test(url)));
        await page.goto(`${origin}/#/s/BBBBBBBBBBBBBBBBBBBBBB`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Quick Sim', exact: true }).waitFor();
        check('accounts: hosted-share alias renders frozen sanitized report', await page.getByRole('heading', { name: 'Testchar', exact: true }).count() > 0);
        await page.screenshot({ path: `${output}/hosted-report-1440-light.png`, fullPage: true });
        await page.goto(`${origin}/#/help`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Help and status', exact: true }).waitFor();
      }
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
