// Loot catalog contract shared by ingestion sources. Says which items activity awards; optional with explanation when absent. No membership invented; retention required.

export const LOOT_SCHEMA_VERSION = 1;

/** Blizzard's API terms cap retention of API-derived data at 30 days. */
export const BLIZZARD_API_MAX_RETENTION_DAYS = 30;

/** @typedef {object} LootSource - id, seasonId, kind, name, instanceName, instanceId, difficulties, itemIds, provider. */
/** @typedef {object} LootCatalog - schemaVersion, season, generatedAt, expiresAt, provenance, sources, warnings. */
/** @typedef {object} LootProvenance - provider, description, retention, attribution, limitations, sourceCount, itemCount. */

/** Validates a loot catalog. Returns problems; an empty array means it is usable. */
export function validateLootCatalog(catalog) {
  const problems = [];
  if (!catalog || typeof catalog !== 'object') return ['loot catalog is not an object'];
  if (catalog.schemaVersion !== LOOT_SCHEMA_VERSION) {
    problems.push(`loot schema ${catalog.schemaVersion} is not supported (expected ${LOOT_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(catalog.sources)) return [...problems, 'sources is not an array'];
  if (!Array.isArray(catalog.provenance) || catalog.provenance.length === 0) {
    problems.push('loot catalog has no provenance; a source without provenance is not usable');
  }

  const seen = new Set();
  const providers = new Set(catalog.provenance?.map((p) => p.provider) ?? []);
  for (const source of catalog.sources) {
    if (!source.id || typeof source.id !== 'string') { problems.push('a source has no id'); continue; }
    if (seen.has(source.id)) problems.push(`duplicate source id ${source.id}`);
    seen.add(source.id);
    if (!source.provider || !providers.has(source.provider)) {
      problems.push(`source ${source.id} names provider ${source.provider}, which has no provenance entry`);
    }
    if (!Array.isArray(source.itemIds) || source.itemIds.length === 0) {
      problems.push(`source ${source.id} has no items`);
      continue;
    }
    for (const id of source.itemIds) {
      if (!Number.isInteger(id) || id <= 0) problems.push(`source ${source.id} has a non-item id ${id}`);
    }
    if (new Set(source.itemIds).size !== source.itemIds.length) {
      problems.push(`source ${source.id} lists an item more than once`);
    }
  }
  return problems;
}

/**
 * Items a loot catalog references that the item catalog does not carry. A source
 * naming an unknown item is a real coverage gap, not something to hide.
 */
export function unknownItems(catalog, knownItemIds) {
  const missing = new Set();
  for (const source of catalog.sources ?? []) {
    for (const id of source.itemIds ?? []) if (!knownItemIds.has(id)) missing.add(id);
  }
  return [...missing].sort((a, b) => a - b);
}

export function isExpired(catalog, now = Date.now()) {
  if (!catalog?.expiresAt) return false;
  const t = Date.parse(catalog.expiresAt);
  return Number.isFinite(t) && t <= now;
}

export function emptyLootCatalog(warnings = []) {
  return {
    schemaVersion: LOOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    expiresAt: null,
    provenance: [],
    sources: [],
    warnings,
  };
}

/** Merges adapter outputs, keeping the earliest expiry and every provenance entry. */
export function mergeLootCatalogs(parts) {
  const sources = [];
  const provenance = [];
  const warnings = [];
  let expiresAt = null;
  let season;
  const byId = new Map();

  for (const part of parts) {
    if (!part) continue;
    if (part.season) {
      if (season && season.id !== part.season.id) throw new Error('Cannot merge loot from different seasons');
      season = part.season;
    }
    provenance.push(...(part.provenance ?? []));
    warnings.push(...(part.warnings ?? []));
    if (part.expiresAt && (!expiresAt || Date.parse(part.expiresAt) < Date.parse(expiresAt))) {
      expiresAt = part.expiresAt;
    }
    for (const source of part.sources ?? []) {
      const existing = byId.get(source.id);
      if (!existing) {
        byId.set(source.id, { ...source, itemIds: [...source.itemIds] });
        sources.push(byId.get(source.id));
        continue;
      }
      // Two providers describing the same source: union the items, and say so.
      const merged = new Set([...existing.itemIds, ...source.itemIds]);
      existing.itemIds = [...merged].sort((a, b) => a - b);
      existing.provider = `${existing.provider}+${source.provider}`;
    }
  }

  return {
    schemaVersion: LOOT_SCHEMA_VERSION,
    ...(season ? { season } : {}),
    generatedAt: new Date().toISOString(),
    expiresAt,
    provenance,
    sources,
    warnings,
  };
}
