// Blizzard Game Data API adapter for loot source membership (P05.4, P09.1); disabled unless credentials configured (API key from environment, never logged).

import { BLIZZARD_API_MAX_RETENTION_DAYS, LOOT_SCHEMA_VERSION } from './loot-schema.mjs';
import { fetchSeason, journalMembers } from './raiderio-season.mjs';

export const PROVIDER = 'blizzard-journal';

const DEFAULT_REGION = 'us';
const NAMESPACE_PREFIX = 'static';
/** Well under 36,000/hour ceiling; gentle on build machine. */
const DEFAULT_REQUESTS_PER_SECOND = 8;

/** Config from environment (CI secrets, never bundled/logged); returns null when unconfigured (normal). */
export function configFromEnv(env = process.env) {
  const clientId = env.BLIZZARD_CLIENT_ID;
  const clientSecret = env.BLIZZARD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    region: env.BLIZZARD_REGION || DEFAULT_REGION,
    locale: env.BLIZZARD_LOCALE || 'en_US',
    requestsPerSecond: Number(env.BLIZZARD_RPS) || DEFAULT_REQUESTS_PER_SECOND,
    raiderioExpansionId: Number(env.RAIDERIO_EXPANSION_ID ?? 11),
  };
}

/** Redact credentials from logs/files. */
export function redact(text, config) {
  if (!config) return text;
  return String(text)
    .split(config.clientSecret).join('[redacted]')
    .split(config.clientId).join('[redacted]');
}

// Pure transforms, testable without credentials.

/** Encounter from API -> loot source; null if it awards nothing usable. */
export function encounterToSource(encounter, instance) {
  if (!encounter || typeof encounter.id !== 'number') return null;

  const itemIds = [];
  for (const entry of encounter.items ?? []) {
    // API shape { id, item: { id, name, key } }; only item id is used.
    const id = entry?.item?.id ?? entry?.id;
    if (Number.isInteger(id) && id > 0 && !itemIds.includes(id)) itemIds.push(id);
  }
  if (itemIds.length === 0) return null;

  const instanceName = nameOf(encounter.instance ?? instance) ?? undefined;
  return {
    id: `${PROVIDER}:encounter:${encounter.id}`,
    kind: instanceKind(instance),
    name: nameOf(encounter) ?? `Encounter ${encounter.id}`,
    instanceName,
    instanceId: encounter.instance?.id ?? instance?.id,
    // Only instances have media (encounters don't); recorded so UI knows art exists before asking.
    mediaId: typeof instance?.media?.id === 'number' ? instance.media.id : undefined,
    difficulties: (instance?.modes ?? [])
      .map((m) => nameOf(m?.mode))
      .filter((n) => typeof n === 'string'),
    itemIds: itemIds.sort((a, b) => a - b),
    provider: PROVIDER,
  };
}

/** The API returns localized names as either a string or a locale map. */
function nameOf(node) {
  const name = node?.name;
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return name.en_US ?? Object.values(name)[0] ?? null;
  return null;
}

function instanceKind(instance) {
  const category = instance?.category?.type;
  if (category === 'RAID') return 'raid';
  if (category === 'DUNGEON') return 'dungeon';
  if (category === 'DELVE') return 'delve';
  return 'other';
}

export function provenanceRecord(sources, config) {
  const itemCount = new Set(sources.flatMap((s) => s.itemIds)).size;
  return {
    provider: PROVIDER,
    description:
      `Blizzard Game Data API, /data/wow/journal-encounter, ${config?.region ?? DEFAULT_REGION} region, ` +
      `${NAMESPACE_PREFIX}-${config?.region ?? DEFAULT_REGION} namespace.`,
    retention:
      `Must be regenerated at least every ${BLIZZARD_API_MAX_RETENTION_DAYS} days and must not be used after ` +
      'its expiry. Blizzard Developer API Terms of Use require a maximum 30-day TTL on API-derived data.',
    attribution: 'Loot source data from the Blizzard Game Data API. Blizzard Entertainment is the source of this data and does not endorse Frostsim.',
    limitations: [
      'The journal does not list every variant of an item, so item level and bonus ids are not covered.',
      'Instance zone drops, trash loot and bind-on-equip items are not in the journal and are absent here.',
      'The journal does not state drop probabilities, so no expected value can be computed from this data.',
      'Great Vault reward levels, upgrade currency costs and Catalyst mappings are not exposed by this API.',
    ],
    sourceCount: sources.length,
    itemCount,
  };
}

/** ISO expiry `days` from `from`, the retention obligation made mechanical. */
export function expiryFrom(from = Date.now(), days = BLIZZARD_API_MAX_RETENTION_DAYS) {
  return new Date(from + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Builds a loot catalog from already-fetched API responses. Separated from the
 * fetching so the transform is testable against committed fixtures with no
 * credentials and no network.
 */
export function buildLootCatalog(encounters, instancesById = new Map(), config = null, now = Date.now()) {
  const sources = [];
  const warnings = [];
  for (const encounter of encounters) {
    const source = encounterToSource(encounter, instancesById.get(encounter.instance?.id));
    if (source) sources.push(source);
    else warnings.push(`journal encounter ${encounter?.id ?? '?'} awarded no usable items and was skipped`);
  }
  sources.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: LOOT_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    expiresAt: expiryFrom(now),
    provenance: [provenanceRecord(sources, config)],
    sources,
    warnings,
  };
}

// --- Fetching ---------------------------------------------------------------

class Throttle {
  constructor(perSecond) { this.interval = 1000 / Math.max(1, perSecond); this.next = 0; }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

/** OAuth client-credentials token. The secret never leaves this function. */
async function accessToken(config, fetchImpl) {
  const res = await fetchImpl(`https://oauth.battle.net/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Blizzard OAuth failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('Blizzard OAuth returned no access token');
  return body.access_token;
}

/** Fetch journal and return loot catalog, or null when unconfigured. */
export async function fetchLootCatalog(opts = {}) {
  const config = opts.config ?? configFromEnv();
  if (!config) return null;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const log = (m) => opts.log?.(redact(m, config));
  const throttle = new Throttle(config.requestsPerSecond);
  const host = `https://${config.region}.api.blizzard.com`;
  const token = await accessToken(config, fetchImpl);
  const get = async (path, namespace = NAMESPACE_PREFIX, locale = config.locale) => {
    await throttle.wait();
    const url = `${host}${path}${path.includes('?') ? '&' : '?'}namespace=${namespace}-${config.region}&locale=${locale}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };

  // Named tier is a rotation; resolve in English even if catalog shows another locale.
  const index = await get('/data/wow/journal-expansion/index', 'static', 'en_US');
  const tier = index.tiers?.find((t) => nameOf(t) === 'Current Season');
  if (!Number.isInteger(tier?.id) || tier.id <= 0) throw new Error('Blizzard journal has no Current Season tier');
  const current = await get(`/data/wow/journal-expansion/${tier.id}`, 'static', 'en_US');
  const seasons = await get('/data/wow/mythic-keystone/season/index', 'dynamic');
  const seasonId = seasons.current_season?.id;
  if (!Number.isInteger(seasonId) || seasonId <= 0) throw new Error('Blizzard has no active season');
  const season = await get(`/data/wow/mythic-keystone/season/${seasonId}`, 'dynamic');
  if (season.id !== seasonId || typeof season.season_name !== 'string') throw new Error('Invalid Blizzard season detail');

  const membership = await fetchSeason(config, seasonId, fetchImpl);
  if (!Array.isArray(current.dungeons) || !Array.isArray(current.raids)) throw new Error('Invalid Current Season journal');
  const wanted = [
    ...journalMembers(membership.dungeons, current.dungeons),
    ...journalMembers(membership.raids, current.raids),
  ];
  log(`blizzard-journal: ${season.season_name}, ${wanted.length} seasonal journal entries`);

  const encounters = [];
  const instancesById = new Map();
  const warnings = [];
  for (const entry of wanted) {
    let instance;
    try {
      instance = await get(`/data/wow/journal-instance/${entry.id}`);
    } catch (err) {
      warnings.push(`Current-season instance ${entry.id} is unavailable and was omitted.`);
      log(`blizzard-journal: instance ${entry.id} failed: ${err}`);
      continue;
    }
    if (instance.id !== entry.id || !['raid', 'dungeon'].includes(instanceKind(instance))) {
      throw new Error(`Invalid current-season instance ${entry.id}`);
    }
    instancesById.set(instance.id, instance);
    for (const boss of instance.encounters ?? []) {
      if (opts.limit && encounters.length >= opts.limit) break;
      try {
        const encounter = await get(`/data/wow/journal-encounter/${boss.id}`);
        if (encounter.id !== boss.id || encounter.instance?.id !== instance.id) {
          throw new Error('Encounter does not belong to its seasonal instance');
        }
        encounters.push(encounter);
      } catch {
        warnings.push(`Current-season encounter ${boss.id} is unavailable and was omitted.`);
      }
    }
  }

  const catalog = buildLootCatalog(encounters, instancesById, config);
  // Filter non-equippable rewards (décor, mounts, tokens); keep unknowns visible.
  const nonEquipment = new Set();
  const itemIds = new Set(catalog.sources.flatMap((source) => source.itemIds));
  for (const id of itemIds) {
    if (opts.knownItemIds?.has(id)) continue;
    try {
      const item = await get(`/data/wow/item/${id}`);
      if (item.id === id && item.is_equippable === false && item.inventory_type?.type === 'NON_EQUIP') {
        nonEquipment.add(id);
      }
    } catch {
      warnings.push(`Loot item ${id} could not be classified; retained for catalog coverage checks.`);
    }
  }
  for (const source of catalog.sources) source.itemIds = source.itemIds.filter((id) => !nonEquipment.has(id));
  catalog.sources = catalog.sources.filter((source) => source.itemIds.length > 0);
  catalog.provenance[0] = provenanceRecord(catalog.sources, config);
  catalog.provenance[0].limitations.push('Non-equippable rewards are excluded. Tier tokens are not expanded into class-set rewards.');
  log(`blizzard-journal: excluded ${nonEquipment.size} verified non-equippable rewards`);
  catalog.season = { id: seasonId, name: season.season_name };
  if (Date.parse(membership.expiresAt) < Date.parse(catalog.expiresAt)) catalog.expiresAt = membership.expiresAt;
  for (const source of catalog.sources) source.seasonId = seasonId;
  catalog.warnings.push(...warnings);
  catalog.provenance[0].description += ` Current Season journal tier ${tier.id}; ${season.season_name}.`;
  catalog.provenance[0].limitations.push('Delve loot tables are not exposed by the Blizzard journal API and are unavailable.');
  catalog.provenance.push({
    provider: 'raiderio', description: 'Current raid and Mythic+ membership from https://raider.io/api, matched to Blizzard season and regional dates.',
    retention: 'Refreshed with the loot catalog; never used beyond a known season or raid rollover.',
    attribution: 'Seasonal raid and dungeon membership from Raider.IO (https://raider.io).',
    limitations: ['Delve loot is unavailable. Raider.IO supplies membership, not item drops or reward levels.'],
    sourceCount: catalog.sources.length, itemCount: 0,
  });
  await verifyInstanceArt(catalog, get, throttle, fetchImpl, log);
  return catalog;
}

/** Drop mediaId for sources whose art doesn't load (API advertises URLs the CDN refuses; 15 of 212 return 403). */
async function verifyInstanceArt(catalog, get, throttle, fetchImpl, log) {
  const ids = [...new Set(catalog.sources.map((s) => s.mediaId).filter((id) => typeof id === 'number'))];
  if (ids.length === 0) return;

  const usable = new Set();
  let refused = 0;
  for (const id of ids) {
    let asset;
    try {
      const media = await get(`/data/wow/media/journal-instance/${id}`);
      asset = (media?.assets ?? []).find((a) => typeof a?.value === 'string');
    } catch {
      continue; // Media lookup failed; treat as no art.
    }
    if (!asset) continue;
    try {
      await throttle.wait();
      const res = await fetchImpl(asset.value, { method: 'HEAD', redirect: 'error' });
      if (res.ok) usable.add(id);
      else refused++;
    } catch {
      refused++;
    }
  }

  for (const source of catalog.sources) {
    if (typeof source.mediaId === 'number' && !usable.has(source.mediaId)) delete source.mediaId;
  }
  log(
    `blizzard-journal: instance art verified, ${usable.size} of ${ids.length} tiles load` +
    (refused ? `; ${refused} advertised by the API but refused by the CDN and dropped` : ''),
  );
}
