import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as updater from './update-engines.mjs';

const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'frostsim-paid-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it('O4 refuses a paid builder before uploads or launch when updater budget is unconfigured', async () => {
  vi.stubEnv('FROSTSIM_UPDATER_LEDGER', ''); vi.stubEnv('FROSTSIM_UPDATER_MONTHLY_USD_CAP', '');
  const dir = temp(); writeFileSync(join(dir, 'run.sh'), 'true');
  const calls = [];
  const provider = { name: 'Hetzner', launch: async () => { calls.push('launch'); throw new Error('paid request happened'); }, remove: async () => {} };
  await expect(updater.runOnBuilder(provider, { accountId: 'a'.repeat(32), accessKeyId: 'fake', secretAccessKey: 'fake', bucket: 'fake' }, dir, temp(), {
    name: 'engine-test', timeoutMs: 60000, fetchFn: async () => { calls.push('upload'); throw new Error('upload happened'); }, sleep: async () => {},
  })).rejects.toThrow(/budget/i);
  expect(calls).toEqual([]);
});

it('O4 retains a failed-delete reservation and prevents the next builder from being launched', async () => {
  const dir = temp(); writeFileSync(join(dir, 'run.sh'), 'true');
  vi.stubEnv('FROSTSIM_UPDATER_LEDGER', join(dir, 'ledger.json'));
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
  vi.stubEnv('FROSTSIM_UPDATER_MONTHLY_USD_CAP', '10'); vi.stubEnv('FROSTSIM_UPDATER_RUN_USD_CAP', '5');
  const calls = [];
  const provider = { name: 'test', budget: { hourlyUsd: 0.5, minimumMs: 3600000, billingUnitMs: 3600000, cleanupMs: 60000 },
    launch: async () => { calls.push('launch'); return 'server-1'; }, remove: async () => { throw new Error('delete failed'); }, absent: async () => false };
  const options = { name: 'engine-test', timeoutMs: 60000, sleep: async () => {},
    fetchFn: async (_url, init) => new Response(init.method === 'GET' ? '1' : null) };
  await expect(updater.runOnBuilder(provider, { accountId: 'a'.repeat(32), accessKeyId: 'fake', secretAccessKey: 'fake', bucket: 'fake' }, dir, temp(), options)).rejects.toThrow(/delete|cleanup/i);
  expect(JSON.parse(readFileSync(join(dir, 'ledger.json'))).entries[0].state).toBe('cleanup-failed');
  await expect(updater.runOnBuilder(provider, {}, dir, temp(), options)).rejects.toThrow(/unresolved/i);
  expect(calls).toEqual(['launch']);
});

it('O4 blocks updater AI calls lacking an enforceable price contract before sending public diffs', async () => {
  const called = vi.fn();
  await expect(updater.updaterDecision({ key: 'fake', state: 'public upstream diff', questions: {} }, called)).rejects.toThrow(/ceiling|price|budget/i);
  expect(called).not.toHaveBeenCalled();
});

it('O4 reserves a bounded AI chat before the call, supplies unchanged D17 ceilings, retains unknown usage', async () => {
  const file = join(temp(), 'ledger.json'); writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: [] }));
  vi.stubEnv('FROSTSIM_UPDATER_LEDGER', file); vi.stubEnv('FROSTSIM_UPDATER_MONTHLY_USD_CAP', '1');
  vi.stubEnv('FROSTSIM_UPDATER_RUN_USD_CAP', '1'); vi.stubEnv('FROSTSIM_UPDATER_AI_CALL_USD_CAP', '0.05');
  const call = vi.fn(async args => {
    expect(JSON.parse(readFileSync(file, 'utf8')).entries).toHaveLength(1);
    expect(args.maxPrice).toEqual({ prompt: 3, completion: 15 });
    return { cost: null, message: { content: 'result' } };
  });
  await updater.updaterChat({ key: 'fake', maxTokens: 1500, messages: [{ role: 'user', content: 'public upstream subjects' }] }, call);
  expect(JSON.parse(readFileSync(file, 'utf8')).entries[0].state).toBe('reserved');
  vi.stubEnv('FROSTSIM_UPDATER_AI_CALL_USD_CAP', '0.001');
  await expect(updater.updaterChat({ maxTokens: 1500, messages: [] }, call)).rejects.toThrow(/call/i);
  expect(call).toHaveBeenCalledTimes(1);
});

it('O5 actual builder rejection carries the failing phase and meaningful error from before a long cache trailer', async () => {
  const dir = temp(); writeFileSync(join(dir, 'run.sh'), 'true');
  const file = join(temp(), 'ledger.json'); writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: [] }));
  vi.stubEnv('FROSTSIM_UPDATER_LEDGER', file); vi.stubEnv('FROSTSIM_UPDATER_MONTHLY_USD_CAP', '5'); vi.stubEnv('FROSTSIM_UPDATER_RUN_USD_CAP', '5');
  const provider = { name: 'test', budget: { hourlyUsd: 0.5, minimumMs: 3600000, billingUnitMs: 3600000, cleanupMs: 1000 },
    launch: async () => 'server-1', remove: async () => {}, absent: async () => true };
  const log = `FROSTSIM_PHASE=threaded-smoke\nError: missing talent 136814\n${'cache statistics\n'.repeat(50)}ccache saved: 8G`;
  const error = await updater.runOnBuilder(provider, { accountId: 'a'.repeat(32), accessKeyId: 'fake', secretAccessKey: 'fake', bucket: 'fake' }, dir, temp(), {
    name: 'engine-test', timeoutMs: 60000, sleep: async () => {},
    fetchFn: async (url, init) => new Response(init.method === 'GET' ? (url.endsWith('/exit') ? '1' : log) : null),
  }).catch(error => error);
  expect(error.detail).toEqual(expect.objectContaining({ phase: 'threaded-smoke', reason: 'Error: missing talent 136814' }));
  expect(error.message).toContain('missing talent 136814');
  expect(JSON.parse(readFileSync(file, 'utf8')).entries[0]).toEqual(expect.objectContaining({ state: 'settled', chargedUsd: 0.5 }));
});

it('O5 builder scripts mark smoke and compile phases and keep the original diagnostic ahead of cache output', () => {
  const script = updater.engineJobScript({ node: '26.8.2', emsdk: { version: '6.0.9' } });
  expect(script).toContain('FROSTSIM_PHASE=threaded-smoke');
  expect(script).toContain('FROSTSIM_PHASE=fallback-build');
  expect(updater.nativeJobScript()).toContain('FROSTSIM_PHASE=native-build');
});
