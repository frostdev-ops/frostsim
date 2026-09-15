// Loot ingestion adapters (both disabled unless configured): test pure transforms and schema with no credentials/network/WoW.
// Can't prove live API matches fixture (Blizzard fixture from documented structure, not captured).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as blizzard from './blizzard-journal.mjs';
import * as db2 from './db2-loot.mjs';
import {
  BLIZZARD_API_MAX_RETENTION_DAYS, emptyLootCatalog, isExpired, mergeLootCatalogs,
  unknownItems, validateLootCatalog,
} from './loot-schema.mjs';

const FIXTURES = 'tests/fixtures/loot';
const readJson = (f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
const readCsv = (f) => db2.parseCsv(readFileSync(join(FIXTURES, f), 'utf8'));

describe('loot catalog schema', () => {
  it('rejects a catalog whose source names a provider with no provenance', () => {
    const problems = validateLootCatalog({
      schemaVersion: 1, provenance: [{ provider: 'a' }],
      sources: [{ id: 's', provider: 'ghost', itemIds: [1] }],
    });
    expect(problems.join(' ')).toMatch(/has no provenance entry/);
  });

  it('rejects a source with no items, a duplicate id, or a repeated item', () => {
    const problems = validateLootCatalog({
      schemaVersion: 1, provenance: [{ provider: 'p' }],
      sources: [
        { id: 'dup', provider: 'p', itemIds: [1, 1] },
        { id: 'dup', provider: 'p', itemIds: [] },
      ],
    });
    expect(problems.join(' ')).toMatch(/duplicate source id/);
    expect(problems.join(' ')).toMatch(/lists an item more than once/);
    expect(problems.join(' ')).toMatch(/has no items/);
  });

  it('treats a catalog with no provenance as unusable', () => {
    expect(validateLootCatalog(emptyLootCatalog()).join(' ')).toMatch(/no provenance/);
  });

  it('names loot items the item catalog does not carry', () => {
    const catalog = { sources: [{ id: 's', provider: 'p', itemIds: [1, 2, 3] }] };
    expect(unknownItems(catalog, new Set([1, 3]))).toEqual([2]);
  });

  it('treats a past expiry as expired and a null expiry as permanent', () => {
    expect(isExpired({ expiresAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    expect(isExpired({ expiresAt: null })).toBe(false);
  });

  it('keeps the earliest expiry when merging, and unions shared sources', () => {
    const merged = mergeLootCatalogs([
      {
        expiresAt: '2030-01-01T00:00:00.000Z', provenance: [{ provider: 'a' }], warnings: [],
        sources: [{ id: 'x', provider: 'a', itemIds: [1, 2] }],
      },
      {
        expiresAt: '2026-01-01T00:00:00.000Z', provenance: [{ provider: 'b' }], warnings: ['careful'],
        sources: [{ id: 'x', provider: 'b', itemIds: [2, 3] }],
      },
    ]);
    expect(merged.expiresAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0].itemIds).toEqual([1, 2, 3]);
    expect(merged.sources[0].provider).toBe('a+b');
    expect(merged.provenance.map((p) => p.provider)).toEqual(['a', 'b']);
    expect(merged.warnings).toEqual(['careful']);
  });
});

describe('blizzard journal adapter', () => {
  it('is disabled without credentials', () => {
    expect(blizzard.configFromEnv({})).toBeNull();
    expect(blizzard.configFromEnv({ BLIZZARD_CLIENT_ID: 'only-id' })).toBeNull();
  });

  it('reads credentials from the environment when both are present', () => {
    const config = blizzard.configFromEnv({ BLIZZARD_CLIENT_ID: 'id', BLIZZARD_CLIENT_SECRET: 'secret' });
    expect(config).toMatchObject({ clientId: 'id', clientSecret: 'secret', region: 'us' });
  });

  it('redacts credentials out of anything it would log', () => {
    const config = { clientId: 'my-id', clientSecret: 'my-secret' };
    expect(blizzard.redact('failed for my-id using my-secret', config))
      .toBe('failed for [redacted] using [redacted]');
  });

  it('turns an encounter into a source, deduplicating repeated items', () => {
    const source = blizzard.encounterToSource(readJson('blizzard-journal-encounter.json'), readJson('blizzard-journal-instance.json'));
    expect(source.id).toBe('blizzard-journal:encounter:2599');
    expect(source.name).toBe('Example Boss');
    expect(source.kind).toBe('raid');
    expect(source.instanceName).toBe('Example Raid');
    // Item 251136 appears twice in fixture, must dedup to once.
    expect(source.itemIds).toEqual([251136, 271564]);
    expect(source.difficulties).toEqual(['Raid Finder', 'Normal', 'Heroic', 'Mythic']);
  });

  // Live: /data/wow/journal-instance/1310 returned 404; encounters resolved. Instance loss mustn't lose loot.
  it('keeps an encounter whose instance lookup is unavailable', () => {
    const encounter = readJson('blizzard-journal-encounter.json');
    const source = blizzard.encounterToSource(encounter, undefined);
    expect(source).not.toBeNull();
    expect(source.itemIds).toEqual([251136, 271564]);
    // Instance name comes from encounter's embedded reference.
    expect(source.instanceName).toBe('Example Raid');
    // Kind unknown without instance document, not guessed.
    expect(source.kind).toBe('other');
    expect(source.difficulties).toEqual([]);
  });

  it('returns nothing for an encounter that awards no items', () => {
    expect(blizzard.encounterToSource({ id: 1, name: 'Empty', items: [] })).toBeNull();
    expect(blizzard.encounterToSource(null)).toBeNull();
  });

  it('stamps the 30-day retention the API terms require', () => {
    const now = Date.parse('2026-09-14T00:00:00.000Z');
    const catalog = blizzard.buildLootCatalog(
      [readJson('blizzard-journal-encounter.json')],
      new Map([[1273, readJson('blizzard-journal-instance.json')]]),
      null,
      now,
    );
    expect(catalog.expiresAt).toBe(new Date(now + BLIZZARD_API_MAX_RETENTION_DAYS * 86_400_000).toISOString());
    expect(isExpired(catalog, now + 29 * 86_400_000)).toBe(false);
    expect(isExpired(catalog, now + 31 * 86_400_000)).toBe(true);
  });

  it('carries the attribution and the limitations with the data', () => {
    const catalog = blizzard.buildLootCatalog([readJson('blizzard-journal-encounter.json')]);
    const [provenance] = catalog.provenance;
    expect(provenance.attribution).toMatch(/Blizzard Entertainment is the source/);
    expect(provenance.attribution).toMatch(/does not endorse/);
    expect(provenance.retention).toMatch(/30 days/);
    expect(provenance.limitations.join(' ')).toMatch(/drop probabilities/);
    expect(provenance.limitations.join(' ')).toMatch(/trash loot|bind-on-equip/i);
  });

  it('produces a catalog that passes validation', () => {
    const catalog = blizzard.buildLootCatalog([readJson('blizzard-journal-encounter.json')]);
    expect(validateLootCatalog(catalog)).toEqual([]);
  });
});

describe('local DB2 adapter', () => {
  it('is disabled without a directory', () => {
    expect(db2.configFromEnv({})).toBeNull();
    expect(db2.configFromEnv({ FROSTSIM_DB2_DIR: '/tmp/x' })).toMatchObject({ dir: '/tmp/x', redistributable: false });
  });

  it('parses quoted CSV fields containing commas', () => {
    const { header, rows } = db2.parseCsv('ID,Name\n1,"Second, Boss"\n');
    expect(header).toEqual(['ID', 'Name']);
    expect(rows[0]).toEqual(['1', 'Second, Boss']);
  });

  it('names the missing column instead of producing an empty catalog', () => {
    expect(() => db2.columnIndex(['ID', 'Other'], ['ItemID', 'ItemId'], 'JournalEncounterItem'))
      .toThrow(/no column matching ItemID \/ ItemId.*Columns present: ID, Other/);
  });

  it('builds sources from the three tables, skipping malformed rows', () => {
    const catalog = db2.buildLootCatalog({
      encounterItem: readCsv('JournalEncounterItem.csv'),
      encounter: readCsv('JournalEncounter.csv'),
      instance: readCsv('JournalInstance.csv'),
    });
    expect(catalog.sources.map((s) => s.id)).toEqual([
      'local-db2:encounter:2599', 'local-db2:encounter:2600',
    ]);
    const [boss] = catalog.sources;
    expect(boss.name).toBe('Example Boss');
    expect(boss.instanceName).toBe('Example Raid');
    expect(boss.itemIds).toEqual([251136, 271564]); // the duplicate collapsed
    // Two fixture rows with blank encounter/item id reported.
    expect(catalog.warnings.join(' ')).toMatch(/2 JournalEncounterItem rows/);
    expect(validateLootCatalog(catalog)).toEqual([]);
  });

  it('works without the name tables, and says the sources are unnamed', () => {
    const catalog = db2.buildLootCatalog({ encounterItem: readCsv('JournalEncounterItem.csv') });
    expect(catalog.sources[0].name).toBe('Encounter 2599');
    expect(catalog.warnings.join(' ')).toMatch(/numbered rather than named/);
  });

  it('refuses to guess when membership is missing entirely', () => {
    expect(() => db2.buildLootCatalog({})).toThrow(/JournalEncounterItem is required/);
  });

  it('records that redistribution rights are not established by the build', () => {
    const catalog = db2.buildLootCatalog(
      { encounterItem: readCsv('JournalEncounterItem.csv') },
      { origin: 'my own WoW install', redistributable: false },
    );
    const [provenance] = catalog.provenance;
    expect(provenance.description).toMatch(/my own WoW install/);
    expect(provenance.limitations.join(' ')).toMatch(/have NOT been established by this build/);
    // Local data has no API retention clock.
    expect(catalog.expiresAt).toBeNull();
  });
});
