#!/usr/bin/env node
// Separate disposable local PostgreSQL/Redis services; reuse existing cloud integration tests unchanged.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const ref = arg('--account-ref', 'origin/cloud');
mkdirSync(join(root, 'build'), { recursive: true });
const work = mkdtempSync(join(root, 'build/staging-local-'));
const source = join(work, 'source');
mkdirSync(source);
const archive = execFileSync('git', ['archive', ref], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
const password = randomBytes(32).toString('hex');
const passwordFile = join(work, 'password');
const redisConfig = join(work, 'redis.conf');
writeFileSync(passwordFile, password, { mode: 0o600 });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' };
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const pgPort = await freePort(), redisPort = await freePort();
const record = { schemaVersion: 1, sourceRef: ref,
  sourceCommit: execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim(),
  origin: 'https://sim.test (existing integration fixture; no hosted TLS origin)',
  postgres: { host: '127.0.0.1', port: pgPort, independentCluster: true },
  redis: { host: '127.0.0.1', port: redisPort, independentInstance: true },
  providers: 'Existing tests fake OAuth/Stripe/R2 at fetch; no real provider callback, purchase, billing or object-storage claim.',
  checks: [], failures: [] };
let pgProcess, redisProcess, sql, redis;
try {
  execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: source, env, stdio: 'pipe' });
  const requireSource = createRequire(join(source, 'package.json'));
  const { default: postgres } = await import(requireSource.resolve('postgres'));
  const { default: Redis } = await import(requireSource.resolve('ioredis'));
  execFileSync('initdb', ['-D', join(work, 'pg'), '-U', 'frostsim_staging', '--auth=scram-sha-256', `--pwfile=${passwordFile}`, '--no-locale'], { env, stdio: 'pipe' });
  pgProcess = spawn('postgres', ['-D', join(work, 'pg'), '-h', '127.0.0.1', '-p', String(pgPort), '-k', work], { env, stdio: 'ignore' });
  writeFileSync(redisConfig, `bind 127.0.0.1\nport ${redisPort}\nprotected-mode yes\nsave ""\nappendonly no\nrequirepass ${password}\n`, { mode: 0o600 });
  redisProcess = spawn('redis-server', [redisConfig], { env, stdio: 'ignore' });
  const pgUrl = `postgres://frostsim_staging:${password}@127.0.0.1:${pgPort}/postgres`;
  const redisUrl = `redis://:${password}@127.0.0.1:${redisPort}/0`;
  sql = postgres(pgUrl, { connect_timeout: 1 });
  redis = new Redis(redisUrl, { lazyConnect: true, retryStrategy: () => null });
  redis.on('error', () => {});
  const deadline = Date.now() + 15000;
  while (true) {
    try { await sql`select 1`; break; } catch {
      assert.ok(Date.now() < deadline, 'isolated PostgreSQL did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await redis.connect();
  assert.equal(await redis.ping(), 'PONG');
  record.checks.push({ name: 'independent-postgres-and-redis', status: 'passed' });
  const testOutput = join(work, 'integration-tests.json');
  await new Promise((resolve, reject) => {
    const tests = spawn(process.execPath, [join(source, 'node_modules/vitest/vitest.mjs'), 'run',
      'server/account/integration.test.ts', 'server/account/accounts.integration.test.ts',
      'server/account/billing.test.ts', 'server/account/entitlements.test.ts',
      '--exclude', 'build/**', '--exclude', 'public/**', '--reporter=json', `--outputFile=${testOutput}`], {
      cwd: source, env: { ...env, FROSTSIM_TEST_PG: pgUrl, FROSTSIM_TEST_REDIS: redisUrl }, stdio: 'ignore',
    });
    tests.on('error', reject);
    tests.on('exit', code => code === 0 ? resolve() : reject(Error(`Existing integration tests exited ${code}; inspect ${testOutput}`)));
  });
  const tests = JSON.parse(readFileSync(testOutput, 'utf8'));
  record.tests = { total: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests, pending: tests.numPendingTests };
  record.suites = tests.testResults.map(suite => ({ name: suite.name.replace(source + '/', ''), status: suite.status,
    tests: suite.assertionResults.length, boundary: (suite.name.endsWith('/integration.test.ts') || suite.name.includes('.integration.test.')) ? 'real disposable PostgreSQL/Redis; fake providers' : 'retained pure/mocked billing tests; no provider acceptance' }));
  assert.ok(record.tests.total > 0 && record.tests.failed === 0 && record.tests.pending === 0, 'real-service integration tests must run, not skip');
  record.checks.push({ name: 'existing-account-session-callback-billing-integration', status: 'passed', ...record.tests });
} catch (error) { record.failures.push({ error: String(error) }); }
finally {
  redis?.disconnect();
  await sql?.end({ timeout: 3 });
  for (const child of [pgProcess, redisProcess]) if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (existsSync(passwordFile)) unlinkSync(passwordFile);
  if (existsSync(redisConfig)) unlinkSync(redisConfig);
  record.passed = !record.failures.length;
  writeFileSync(join(work, 'staging-check.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`Local staging ${record.passed ? 'passed' : 'failed'}: ${join(work, 'staging-check.json')}`);
}
assert.equal(record.passed, true, JSON.stringify(record.failures));
