// Local DB2 loot import seam (P05.2, P05.4). Reads operator-supplied DB2 table exports; nothing fetched or redistributed.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LOOT_SCHEMA_VERSION } from './loot-schema.mjs';

export const PROVIDER = 'local-db2';

export function configFromEnv(env = process.env) {
  const dir = env.FROSTSIM_DB2_DIR;
  if (!dir) return null;
  return {
    dir,
    origin: env.FROSTSIM_DB2_ORIGIN || 'unspecified',
    redistributable: env.FROSTSIM_DB2_REDISTRIBUTABLE === 'true',
  };
}

// --- CSV parsing (RFC 4180 subset) -----------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { header: [], rows: [] };
  return { header: rows[0].map((h) => h.trim()), rows: rows.slice(1).filter((r) => r.some((v) => v !== '')) };
}

// Find column by any known spelling, case-insensitive.
export function columnIndex(header, candidates, table) {
  const lower = header.map((h) => h.toLowerCase());
  for (const candidate of candidates) {
    const i = lower.indexOf(candidate.toLowerCase());
    if (i >= 0) return i;
  }
  throw new Error(
    `${table}: no column matching ${candidates.join(' / ')}. Columns present: ${header.join(', ') || '(none)'}`,
  );
}

/** A positive integer id, or null. Blank and non-numeric fields are not ids. */
function positiveId(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readTable(dir, table) {
  const direct = join(dir, `${table}.csv`);
  if (existsSync(direct)) return parseCsv(readFileSync(direct, 'utf8'));
  // Extractors suffix with build, e.g. JournalEncounterItem.12.1.0.69814.csv.
  const match = readdirSync(dir).find((f) => f.toLowerCase().startsWith(`${table.toLowerCase()}.`) && f.endsWith('.csv'));
  if (!match) return null;
  return parseCsv(readFileSync(join(dir, match), 'utf8'));
}

// --- Transform ---------------------------------------------------------------

const ENCOUNTER_ITEM_COLUMNS = {
  encounter: ['JournalEncounterID', 'JournalEncounterId', 'EncounterID'],
  item: ['ItemID', 'ItemId'],
};
const ENCOUNTER_COLUMNS = {
  id: ['ID', 'Id'],
  name: ['Name_lang', 'Name', 'Name_lang_enUS'],
  instance: ['JournalInstanceID', 'JournalInstanceId', 'InstanceID'],
};
const INSTANCE_COLUMNS = {
  id: ['ID', 'Id'],
  name: ['Name_lang', 'Name', 'Name_lang_enUS'],
};

// Build loot catalog from parsed tables. Pure; fixture test covers without WoW install.
export function buildLootCatalog(tables, config = { origin: 'unspecified' }, now = Date.now()) {
  const { encounterItem, encounter, instance } = tables;
  if (!encounterItem) {
    throw new Error('JournalEncounterItem is required; without it there is no loot membership to import');
  }

  const eiEncounter = columnIndex(encounterItem.header, ENCOUNTER_ITEM_COLUMNS.encounter, 'JournalEncounterItem');
  const eiItem = columnIndex(encounterItem.header, ENCOUNTER_ITEM_COLUMNS.item, 'JournalEncounterItem');

  const encounterNames = new Map();
  const encounterInstance = new Map();
  if (encounter) {
    const idIdx = columnIndex(encounter.header, ENCOUNTER_COLUMNS.id, 'JournalEncounter');
    const nameIdx = columnIndex(encounter.header, ENCOUNTER_COLUMNS.name, 'JournalEncounter');
    const instIdx = columnIndex(encounter.header, ENCOUNTER_COLUMNS.instance, 'JournalEncounter');
    for (const row of encounter.rows) {
      const id = positiveId(row[idIdx]);
      if (id === null) continue;
      encounterNames.set(id, row[nameIdx] ?? '');
      encounterInstance.set(id, positiveId(row[instIdx]));
    }
  }

  const instanceNames = new Map();
  if (instance) {
    const idIdx = columnIndex(instance.header, INSTANCE_COLUMNS.id, 'JournalInstance');
    const nameIdx = columnIndex(instance.header, INSTANCE_COLUMNS.name, 'JournalInstance');
    for (const row of instance.rows) {
      const id = positiveId(row[idIdx]);
      if (id !== null) instanceNames.set(id, row[nameIdx] ?? '');
    }
  }

  /** @type {Map<number, Set<number>>} */
  const byEncounter = new Map();
  const warnings = [];
  let skipped = 0;
  for (const row of encounterItem.rows) {
    // Blank CSV field parses to 0 (not valid id). Require positive id.
    const encounterId = positiveId(row[eiEncounter]);
    const itemId = positiveId(row[eiItem]);
    if (encounterId === null || itemId === null) { skipped++; continue; }
    if (!byEncounter.has(encounterId)) byEncounter.set(encounterId, new Set());
    byEncounter.get(encounterId).add(itemId);
  }
  if (skipped) warnings.push(`${skipped} JournalEncounterItem rows had no usable encounter or item id`);
  if (!encounter) warnings.push('JournalEncounter was not supplied, so sources are numbered rather than named');

  const sources = [];
  for (const [encounterId, items] of byEncounter) {
    const instanceId = encounterInstance.get(encounterId) ?? undefined;
    sources.push({
      id: `${PROVIDER}:encounter:${encounterId}`,
      kind: 'other',
      name: encounterNames.get(encounterId) || `Encounter ${encounterId}`,
      instanceName: instanceId ? instanceNames.get(instanceId) : undefined,
      instanceId: instanceId ?? undefined,
      itemIds: [...items].sort((a, b) => a - b),
      provider: PROVIDER,
    });
  }
  sources.sort((a, b) => a.id.localeCompare(b.id));

  return {
    schemaVersion: LOOT_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    // Local DB2 data has no API retention obligation; publication rights depend on operator's origin declaration.
    expiresAt: null,
    provenance: [{
      provider: PROVIDER,
      description: `Local DB2 export, JournalEncounterItem. Operator-declared origin: ${config.origin}.`,
      retention: 'No API retention obligation. Regenerate when the client data version changes.',
      attribution: 'Loot source data extracted from World of Warcraft client data files.',
      limitations: [
        'Redistribution rights depend entirely on where this export came from and have NOT been established by this build.',
        `Operator declared redistributable: ${config.redistributable ? 'yes' : 'no'}.`,
        'JournalEncounterItem does not state drop probabilities, so no expected value can be computed.',
        'Trash and zone drops outside the journal are not covered.',
      ],
      sourceCount: sources.length,
      itemCount: new Set(sources.flatMap((s) => s.itemIds)).size,
    }],
    sources,
    warnings,
  };
}

// Load and transform DB2 tables, or return null when unconfigured.
export function loadLootCatalog(opts = {}) {
  const config = opts.config ?? configFromEnv();
  if (!config) return null;
  if (!existsSync(config.dir)) {
    throw new Error(`FROSTSIM_DB2_DIR points at ${config.dir}, which does not exist`);
  }
  const tables = {
    encounterItem: readTable(config.dir, 'JournalEncounterItem'),
    encounter: readTable(config.dir, 'JournalEncounter'),
    instance: readTable(config.dir, 'JournalInstance'),
  };
  if (!tables.encounterItem) {
    throw new Error(`${config.dir} contains no JournalEncounterItem.csv; nothing to import`);
  }
  return buildLootCatalog(tables, config);
}
