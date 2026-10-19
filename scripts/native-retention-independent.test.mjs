import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeRetentionReport } from './native-retention.mjs';

const directories = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('independent native purge review', () => {
  it.each([undefined, [null], [123]])('requires an explicit valid active-pack list: %j', async activePackIds => {
    const directory = mkdtempSync(join(tmpdir(), 'frostsim-retention-review-'));
    directories.push(directory);
    const now = Date.parse('2026-10-18T12:00:00Z');
    for (const suffix of ['', '.previous']) writeFileSync(join(directory, `engine-channels.json${suffix}`),
      JSON.stringify({ schemaVersion: 3, packs: [{ id: 'retained' }] }));
    const remove = vi.fn();
    const inventory = { complete: true, jobsPaused: true, activeReferencesKnown: true, activePackIds,
      checkedAt: new Date(now).toISOString(), graceMs: 48 * 3600000,
      objects: [{ key: 'engines/possibly-active/simc-linux-x64.zst', lastModified: new Date(0).toISOString() }] };
    await expect(nativeRetentionReport(directory, inventory, { now, purge: true, deleteObject: remove })).rejects.toThrow(/active|list|reference/i);
    expect(remove).not.toHaveBeenCalled();
  });
});
