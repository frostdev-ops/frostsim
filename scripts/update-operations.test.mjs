import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as updater from './update-engines.mjs';
import { nativeRetentionReport } from './native-retention.mjs';

const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'frostsim-ops-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('O2 daily backup retention command', () => {
  it('expires only top-level dated daily dumps and preserves manual/nested backups', () => {
    const command = readFileSync(new URL('./deploy-vps.sh', import.meta.url), 'utf8').match(/^ExecStartPost=(\/usr\/bin\/find .+)$/m)[1];
    const dir = temp(); mkdirSync(join(dir, 'manual'));
    for (const name of ['frostsim-20260901.dump', 'frostsim-manual.dump', 'frostsim-20261018.dump', 'manual/frostsim-20260901.dump']) {
      const file = join(dir, name); writeFileSync(file, 'archive');
      if (!name.includes('20261018')) utimesSync(file, new Date(0), new Date(0));
    }
    execFileSync('/bin/sh', ['-c', command.replace('/var/backups/frostsim', dir)]);
    expect(existsSync(join(dir, 'frostsim-20260901.dump'))).toBe(false);
    expect(existsSync(join(dir, 'frostsim-20261018.dump'))).toBe(true);
    expect(existsSync(join(dir, 'frostsim-manual.dump'))).toBe(true);
    expect(existsSync(join(dir, 'manual/frostsim-20260901.dump'))).toBe(true);
  });
});

describe('O3 alert delivery health', () => {
  it('rejects missing configuration and records unhealthy delivery on the persisted status object', async () => {
    vi.stubEnv('FROSTSIM_GITHUB_ENV_FILE', join(temp(), 'absent.env'));
    const status = { state: 'failed', reason: 'smoke failed' };
    await expect(updater.notify(null, status)).rejects.toThrow(/alert.*config/i);
    expect(status.alertHealth).toEqual(expect.objectContaining({ state: 'unconfigured', delivered: false }));
  });
  it('records failed HTTP delivery and successful delivery independently of engine state', async () => {
    const file = join(temp(), 'github.env'); writeFileSync(file, 'GITHUB_TOKEN=test-token\n');
    vi.stubEnv('FROSTSIM_GITHUB_ENV_FILE', file);
    const status = { state: 'failed', reason: 'smoke failed' };
    await expect(updater.notify(null, status, 'engine-updater', async () => { throw new Error('HTTP 403'); })).rejects.toThrow('403');
    expect(status.alertHealth.state).toBe('failed');
    const calls = [];
    await updater.notify(null, status, 'engine-updater', async (_token, path) => { calls.push(path); return path.startsWith('/issues?') ? [] : { html_url: 'https://example.test/issue' }; });
    expect(calls).toHaveLength(2);
    expect(status.alertHealth).toEqual(expect.objectContaining({ state: 'healthy', delivered: true }));
  });
});

describe('O5 structured builder failure', () => {
  it('captures a real local smoke failure ahead of a cache cleanup line', () => {
    let failure;
    try { updater.runBuildPhase('threaded-smoke', temp(), '/bin/sh', ['-c', 'echo "Error: missing talent 136814" >&2; echo "ccache saved: 8G"; exit 1']); }
    catch (error) { failure = error; }
    expect(failure.message).toBe('Engine threaded-smoke failed: Error: missing talent 136814');
    expect(failure.detail.phase).toBe('threaded-smoke');
  });
  it('preserves failing phase and useful error while excluding cache-trap noise and signed URLs', () => {
    const failure = updater.buildFailureDetail('Builder exited with 1:\nFROSTSIM_PHASE=threaded-smoke\nError: missing talent 136814\nhttps://bucket.test/object?X-Amz-Signature=secret\nHits: 100\nccache saved: 8G\n');
    expect(failure.phase).toBe('threaded-smoke');
    expect(failure.reason).toContain('missing talent 136814');
    expect(failure.reason).not.toContain('ccache');
    expect(failure.logTail).not.toContain('secret');
  });
});

describe('O6 native retention reconciliation', () => {
  it('reads current and rollback indexes, and refuses stale or live-changing purge snapshots', async () => {
    const output = temp(), now = Date.parse('2026-10-18T12:00:00Z');
    writeFileSync(join(output, 'engine-channels.json'), JSON.stringify({ schemaVersion: 3, packs: [{ id: 'current' }] }));
    writeFileSync(join(output, 'engine-channels.json.previous'), JSON.stringify({ schemaVersion: 3, packs: [{ id: 'rollback' }] }));
    const inventory = { complete: true, jobsPaused: true, activeReferencesKnown: true, checkedAt: new Date(now).toISOString(),
      graceMs: 30 * 86400000, activePackIds: ['active'], objects: ['current', 'rollback', 'active', 'old'].map(id => ({
        key: `engines/${id}/simc-linux-x64.zst`, lastModified: new Date(0).toISOString(),
      })) };
    const remove = vi.fn();
    expect((await nativeRetentionReport(output, inventory, { now, deleteObject: remove })).candidates).toEqual(['engines/old/simc-linux-x64.zst']);
    expect(remove).not.toHaveBeenCalled();
    await expect(nativeRetentionReport(output, { ...inventory, jobsPaused: false }, { now, purge: true, deleteObject: remove })).rejects.toThrow(/paused/i);
    await expect(nativeRetentionReport(output, inventory, { now: now + 60001, purge: true, deleteObject: remove })).rejects.toThrow(/fresh/i);
    await expect(nativeRetentionReport(output, { ...inventory, complete: false }, { now, purge: true, deleteObject: remove })).rejects.toThrow(/complete/i);
  });
  it('protects retained, rollback, active and recent objects and defaults to dry-run', async () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    const objects = ['kept', 'rollback', 'active', 'old', 'recent'].flatMap(id => ['', '.sha256'].map(suffix => ({
      key: `engines/${id}/simc-linux-x64.zst${suffix}`, lastModified: new Date(now - (id === 'recent' ? 1 : 90) * 86400_000).toISOString(),
    })));
    objects.push({ key: 'ccache/engine.tar.zst', lastModified: new Date(0).toISOString() });
    const deleted = [];
    const options = { objects, inventoryComplete: true, retainedIds: ['kept'], rollbackIds: ['rollback'], activePackIds: ['active'], activeReferencesKnown: true,
      now, graceMs: 30 * 86400_000, deleteObject: async key => deleted.push(key) };
    const dry = await updater.reconcileNativeRetention(options);
    expect(dry.candidates).toEqual(['engines/old/simc-linux-x64.zst', 'engines/old/simc-linux-x64.zst.sha256']);
    expect(deleted).toEqual([]);
    await expect(updater.reconcileNativeRetention({ ...options, purge: true, activeReferencesKnown: false })).rejects.toThrow(/active/i);
    const result = await updater.reconcileNativeRetention({ ...options, purge: true });
    expect(deleted).toEqual(dry.candidates); expect(result.deleted).toEqual(dry.candidates);
  });
  it('refuses purge with unknown age or absent grace and reports a failed deletion without success', async () => {
    const options = { objects: [{ key: 'engines/old/simc-linux-x64.zst' }], inventoryComplete: true, retainedIds: [], rollbackIds: [], activePackIds: [], activeReferencesKnown: true, purge: true };
    await expect(updater.reconcileNativeRetention(options)).rejects.toThrow(/grace/i);
    expect((await updater.reconcileNativeRetention({ ...options, graceMs: 1000, purge: false })).candidates).toEqual([]);
    await expect(updater.reconcileNativeRetention({ ...options, graceMs: 1000, objects: [{ ...options.objects[0], lastModified: new Date(0).toISOString() }],
      deleteObject: async () => { throw new Error('R2 refused'); } })).rejects.toThrow('R2 refused');
  });
});
