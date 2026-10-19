import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetError, UpdaterBudget } from './update-operations.mjs';
import { runOnBuilder, runRemote } from './update-engines.mjs';

let directory, ledgerFile;
const r2 = { accountId: 'a'.repeat(32), accessKeyId: 'test', secretAccessKey: 'test', bucket: 'test' };
const budgetConfig = { hourlyUsd: 1, minimumMs: 1000, billingUnitMs: 1000, cleanupMs: 1000 };
const entry = () => JSON.parse(readFileSync(ledgerFile, 'utf8')).entries[0];
const options = { name: 'review-job', timeoutMs: 1000, sleep: async () => {}, fetchFn: async (_url, request) =>
  new Response(null, { status: request.method === 'GET' ? 404 : 204 }) };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'frostsim-ops-review-'));
  ledgerFile = join(directory, 'ledger.json');
  writeFileSync(ledgerFile, JSON.stringify({ schemaVersion: 1, entries: [] }));
  writeFileSync(join(directory, 'run.sh'), 'true');
  vi.stubEnv('FROSTSIM_UPDATER_LEDGER', ledgerFile);
  vi.stubEnv('FROSTSIM_UPDATER_MONTHLY_USD_CAP', '1');
  vi.stubEnv('FROSTSIM_UPDATER_RUN_USD_CAP', '1');
});

afterEach(() => { process.exitCode = undefined; vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('independent updater provider lifecycle review', () => {
  it('surfaces uncertain launch as a budget fault even with a single provider', async () => {
    const provider = { name: 'uncertain', budget: budgetConfig, launch: async () => { throw new Error('response lost after request'); } };
    await expect(runRemote({ r2, providers: [provider] }, directory, join(directory, 'out'), options)).rejects.toBeInstanceOf(BudgetError);
    expect(entry().state).toBe('launching');
    const ledger = new UpdaterBudget({ file: ledgerFile, monthlyUsdCap: 1, runUsdCap: 1 });
    expect(() => ledger.reserveAi({ maximumUsd: 0.001, callUsdCap: 0.001 })).toThrow(/unresolved/i);
  });

  it('does not try a fallback provider while the first launch is uncertain', async () => {
    const launch = vi.fn();
    const providers = [
      { name: 'uncertain', budget: budgetConfig, launch: async () => { throw new Error('response lost'); } },
      { name: 'fallback', budget: budgetConfig, launch },
    ];
    await expect(runRemote({ r2, providers }, directory, join(directory, 'out'), options)).rejects.toBeInstanceOf(BudgetError);
    expect(launch).not.toHaveBeenCalled();
    expect(entry().state).toBe('launching');
  });

  it('holds failed cleanup despite a prior build error and never settles an unconfirmed resource', async () => {
    const provider = { name: 'cleanup', budget: budgetConfig, launch: async () => 'server-1', gone: async () => true,
      remove: async () => {}, absent: async () => false };
    await expect(runOnBuilder(provider, r2, directory, join(directory, 'out'), { ...options, now: (() => { let time = 0; return () => time += 10000; })() }))
      .rejects.toBeInstanceOf(BudgetError);
    expect(entry()).toEqual(expect.objectContaining({ state: 'cleanup-failed', resourceId: 'server-1' }));
    expect(entry().chargedUsd).toBeUndefined();
  });

  it('releases a definitive prelaunch refusal without claiming a billable resource', async () => {
    const provider = { name: 'refused', budget: budgetConfig, launch: async () => { throw Object.assign(new Error('quota refused'), { launchRefused: true }); } };
    await expect(runOnBuilder(provider, r2, directory, join(directory, 'out'), options)).rejects.toThrow('quota refused');
    expect(entry()).toEqual(expect.objectContaining({ state: 'settled', chargedUsd: 0 }));
  });

  it('reports unreadable ledger contents as a budget fault before any paid dispatch', async () => {
    writeFileSync(ledgerFile, '{interrupted');
    const launch = vi.fn();
    const provider = { name: 'ledger', budget: budgetConfig, launch };
    await expect(runRemote({ r2, providers: [provider] }, directory, join(directory, 'out'), options)).rejects.toBeInstanceOf(BudgetError);
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not restart the billable timeout after a slow launch response', async () => {
    let time = 0;
    const provider = { name: 'slow-launch', budget: budgetConfig,
      launch: async () => { time += 5000; return 'server-1'; }, remove: async () => {}, absent: async () => true };
    const fetchFn = async (url, request) => request.method === 'GET'
      ? new Response(url.endsWith('/exit') ? '0' : 'fake archive') : new Response(null, { status: 204 });
    await expect(runOnBuilder(provider, r2, directory, join(directory, 'out'), { ...options, now: () => time,
      fetchFn, exec: () => {}, sleep: async () => {} })).rejects.toThrow(/finish|deadline|timeout|allowance|budget/i);
    expect(entry().state).toBe('settled');
  });

  it('begins cleanup at the build deadline without a full extra polling sleep', async () => {
    let time = 0;
    const waits = [];
    const provider = { name: 'poll-deadline', budget: budgetConfig, launch: async () => 'server-1',
      remove: async () => {}, absent: async () => true, gone: async () => false };
    await expect(runOnBuilder(provider, r2, directory, join(directory, 'out'), { ...options, now: () => time,
      sleep: async milliseconds => { waits.push(milliseconds); time += milliseconds; } })).rejects.toThrow(/finish|deadline|timeout/i);
    expect(Math.max(...waits)).toBeLessThanOrEqual(options.timeoutMs);
    expect(time).toBeLessThanOrEqual(options.timeoutMs);
  });
});
