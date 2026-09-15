// Every public entry point must evaluate at import time; tsc/vite pass on init-time throws; this guards against shipped bundle failures.

import { describe, expect, it } from 'vitest';

describe('public entry points evaluate', () => {
  it('src/lib/catalog', async () => {
    const mod = await import('./catalog/index');
    expect(typeof mod.Catalog).toBe('function');
    expect(typeof mod.CatalogClient).toBe('function');
    expect(typeof mod.loadCatalog).toBe('function');
    expect(typeof mod.serializeItem).toBe('function');
    expect(typeof mod.checkGearSet).toBe('function');
    expect(typeof mod.toPlainRequest).toBe('function');
    expect(mod.GEAR_SLOTS.length).toBeGreaterThan(0);
    expect(mod.enums.INVTYPE.HEAD).toBe(1);
  });

  it('src/lib/optimization', async () => {
    const mod = await import('./optimization/index');
    expect(typeof mod.runStagedSearch).toBe('function');
    expect(typeof mod.estimateWork).toBe('function');
    expect(typeof mod.search).toBe('function');
    expect(typeof mod.verifyFinalists).toBe('function');
    expect(typeof mod.retain).toBe('function');
    expect(typeof mod.engineRunBatch).toBe('function');
    expect(typeof mod.droptimizer.sourceAvailability).toBe('function');
    // Module-scope constant from import: exactly what circular import turns undefined (tools miss it).
    expect(mod.DEFAULT_STAGE_PLAN.stages.length).toBeGreaterThan(0);
    expect(mod.DEFAULT_MAX_ITERATIONS).toBeGreaterThan(0);
  });

  it('src/lib/battlenet', async () => {
    const contract = await import('./battlenet/contract');
    const client = await import('./battlenet/client');
    expect(typeof client.BattleNetClient).toBe('function');
    expect(typeof client.mergeWithCatalog).toBe('function');
    expect(contract.ALLOWED_REGIONS).toContain('us');
    expect(contract.MAX_RETENTION_SECONDS).toBe(30 * 24 * 60 * 60);
    // Construction doesn't touch network or read credentials.
    expect(() => new client.BattleNetClient()).not.toThrow();
  });

  it('the server handler, which the client bundle must never pull in', async () => {
    const mod = await import('../../functions/api/[[path]]');
    expect(typeof mod.onRequest).toBe('function');
    expect(typeof mod.default).toBe('function');
  });
});

describe('entry points load together', () => {
  // Import cycle shows as undefined export at runtime while type checker sees declaration; load in bundle order to catch cycles.
  it('catalog and optimization load together', async () => {
    const [catalog, optimization] = await Promise.all([
      import('./catalog/index'),
      import('./optimization/index'),
    ]);
    expect(typeof catalog.Catalog).toBe('function');
    expect(typeof optimization.runStagedSearch).toBe('function');
    expect(typeof catalog.handleRequest).toBe('function');
    expect(typeof optimization.canonicalize).toBe('function');
    expect(optimization.canonicalize({})).toBe('');
  });
});
