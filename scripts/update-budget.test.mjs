import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const config = () => { const dir = mkdtempSync(join(tmpdir(), 'frostsim-budget-')); dirs.push(dir); return {
  file: join(dir, 'ledger.json'), runId: 'run-a', monthlyUsdCap: 3, runUsdCap: 2, initialize: true,
}; };

describe('O4 durable updater budget', () => {
  it('rejects a corrupt active reservation instead of treating missing lifecycle fields as an available budget', async () => {
    const { UpdaterBudget } = await import('./update-operations.mjs');
    const options = config();
    writeFileSync(options.file, JSON.stringify({ schemaVersion: 1, entries: [{ state: 'active', reservedUsd: 0.01 }] }));
    expect(() => new UpdaterBudget(options).reserveAi({ maximumUsd: 0.01, callUsdCap: 0.05 })).toThrow(/invalid/i);
  });
  it('fails closed without approved budgets and reserves billable minimums before a paid operation', async () => {
    const { UpdaterBudget } = await import('./update-operations.mjs');
    expect(() => new UpdaterBudget({ file: config().file })).toThrow(/budget/i);
    const options = config(), ledger = new UpdaterBudget(options);
    const id = ledger.reserveBuilder({ provider: 'test', hourlyUsd: 0.6, minimumMs: 3600000, billingUnitMs: 3600000, timeoutMs: 1000, cleanupMs: 1000 });
    expect(JSON.parse(readFileSync(options.file, 'utf8')).entries[0]).toEqual(expect.objectContaining({ id, reservedUsd: 0.6, state: 'reserved' }));
    // Reloading (a restart or second service) retains outstanding charges.
    const next = new UpdaterBudget({ ...options, runId: 'run-b', monthlyUsdCap: 0.7 });
    expect(() => next.reserveBuilder({ provider: 'test', hourlyUsd: 0.6, minimumMs: 3600000, billingUnitMs: 3600000, timeoutMs: 1000, cleanupMs: 1000 })).toThrow(/monthly/i);
  });
  it('keeps unknown launch and failed deletion charged, blocking new spend across month rollover', async () => {
    const { UpdaterBudget } = await import('./update-operations.mjs');
    const options = config(); let now = Date.parse('2026-10-31T23:59:00Z');
    const ledger = new UpdaterBudget({ ...options, now: () => now });
    const id = ledger.reserveBuilder({ provider: 'test', hourlyUsd: 0.6, minimumMs: 3600000, billingUnitMs: 3600000, timeoutMs: 1000, cleanupMs: 1000 });
    ledger.launching(id); ledger.launched(id, 'server-1'); ledger.cleanupFailed(id);
    now += 86400000;
    const next = new UpdaterBudget({ ...options, runId: 'run-b', now: () => now });
    expect(() => next.reserveAi({ maximumUsd: 0.01, callUsdCap: 0.05 })).toThrow(/unresolved/i);
    expect(() => ledger.confirmDeleted(id, { confirmed: false })).toThrow(/confirm/i);
    ledger.confirmDeleted(id, { confirmed: true });
    expect(JSON.parse(readFileSync(options.file, 'utf8')).entries[0].chargedUsd).toBeGreaterThan(0.6);
    expect(() => next.reserveAi({ maximumUsd: 0.01, callUsdCap: 0.05 })).toThrow(/monthly/i);
  });
  it('enforces per-call/run limits, holds unknown AI charges and settles only known finite cost', async () => {
    const { UpdaterBudget } = await import('./update-operations.mjs');
    const options = config(), ledger = new UpdaterBudget(options);
    expect(() => ledger.reserveAi({ maximumUsd: 0.06, callUsdCap: 0.05 })).toThrow(/call/i);
    const id = ledger.reserveAi({ maximumUsd: 0.05, callUsdCap: 0.05 });
    ledger.settleAi(id, null);
    expect(JSON.parse(readFileSync(options.file, 'utf8')).entries[0]).toEqual(expect.objectContaining({ state: 'reserved', reservedUsd: 0.05 }));
    ledger.settleAi(id, 0.01);
    const strict = new UpdaterBudget({ ...options, runUsdCap: 0.02 });
    expect(() => strict.reserveAi({ maximumUsd: 0.05, callUsdCap: 0.05 })).toThrow(/run/i);
  });
});
