// Operator-supplied R2 inventory + quiesced queue snapshot; dry-run unless explicitly purged.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileNativeRetention } from './update-operations.mjs';

export async function nativeRetentionReport(output, inventory, { purge = false, now = Date.now(), deleteObject } = {}) {
  const readPacks = filename => {
    if (!existsSync(filename)) throw new Error(`Native retention requires current and rollback indexes: ${filename}`);
    const value = JSON.parse(readFileSync(filename, 'utf8'));
    if (![2, 3].includes(value.schemaVersion) || !Array.isArray(value.packs) || value.packs.some(p => typeof p.id !== 'string')) throw new Error('Invalid native retention pack index');
    return value.packs.map(p => p.id);
  };
  const current = join(output, existsSync(join(output, 'engine-channels.json')) ? 'engine-channels.json' : 'engine-versions.json');
  const retainedIds = readPacks(current), rollbackIds = readPacks(`${current}.previous`);
  const snapshotAge = now - Date.parse(inventory.checkedAt);
  const fresh = Number.isFinite(snapshotAge) && snapshotAge >= 0 && snapshotAge <= 60000;
  if (purge && (!fresh || inventory.jobsPaused !== true)) throw new Error('Native purge requires a fresh inventory while new jobs are paused');
  if (!Number.isFinite(inventory.graceMs) || inventory.graceMs < 48 * 3600000) throw new Error('Native retention grace must cover at least the existing 48-hour client/job window');
  return reconcileNativeRetention({ objects: inventory.objects, inventoryComplete: inventory.complete === true,
    retainedIds, rollbackIds, activePackIds: inventory.activePackIds, activeReferencesKnown: fresh && inventory.activeReferencesKnown === true,
    graceMs: inventory.graceMs, purge, now, deleteObject });
}
