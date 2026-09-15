// Generate the upgrade currency cost + crest cap table from the engine-pinned client DB2s.
// Companion to generate-upgrades.mjs: that script owns rank identity and item levels,
// this one owns what a rank step costs. Run it after it, so the track/rank set it
// verifies against is current.
//
//   node scripts/catalog/generate-upgrade-costs.mjs [--cache directory] [--offline]
//
// Nothing here may invent a cost. A field the pinned build does not encode is emitted
// as null with a matching entry in `unavailable`.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCsv } from './sources/db2-loot.mjs';

const lock = JSON.parse(readFileSync('engine.lock.json', 'utf8'));
const build = lock.expected.clientDataWowVersion;
const arg = process.argv.indexOf('--cache');
const cache = arg < 0 ? `build/upgrade-data-${build}` : process.argv[arg + 1];
const offline = process.argv.includes('--offline');
mkdirSync(cache, { recursive: true });

const sources = [];
function record(url, text) {
  sources.push({ url, sha256: createHash('sha256').update(text).digest('hex') });
}
async function csv(name) {
  const file = `${cache}/${name}.csv`;
  const url = `https://wago.tools/db2/${name}/csv?build=${build}`;
  if (!existsSync(file)) {
    const response = await fetch(url);
    if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
    writeFileSync(file, await response.text());
  }
  const text = readFileSync(file, 'utf8');
  record(url, text);
  const { header, rows } = parseCsv(text);
  return rows.map(row => Object.fromEntries(header.map((key, i) => [key, key.endsWith('_lang') ? row[i] : Number(row[i])])));
}

const entries = await csv('ItemBonusListGroupEntry');
const costs = new Map((await csv('ItemExtendedCost')).map(row => [row.ID, row]));
const currencyTypes = new Map((await csv('CurrencyTypes')).map(row => [row.ID, row]));

const catalogDir = readdirSync('public/catalogs').find(dir => dir.startsWith(build + '-'));
if (!catalogDir) throw Error('Build the engine-pinned catalog first');
const loot = JSON.parse(readFileSync(`public/catalogs/${catalogDir}/loot.json`, 'utf8'));
const upgrades = JSON.parse(readFileSync('src/lib/catalog/generated/upgrades.json', 'utf8'));
if (upgrades.build !== build) throw Error('upgrades.json was generated for a different build');
const seasonTracks = upgrades.tracks.filter(track => track.seasonId === loot.season?.id);
if (!seasonTracks.length) throw Error('No verified upgrade tracks for the current loot season');

// --- Season start date, from the same Raider.IO contract the loot catalog uses. ---
// https://raider.io/api - regional season starts keyed by Blizzard season id.
const region = process.env.BLIZZARD_REGION || 'us';
const expansion = Number(process.env.RAIDERIO_EXPANSION_ID ?? 11);
const seasonUrl = `https://raider.io/api/v1/mythic-plus/static-data?expansion_id=${expansion}`;
let startsAt = null;
const unavailable = [];
{
  const file = `${cache}/raiderio-mythic-plus.json`;
  try {
    if (!existsSync(file)) {
      if (offline) throw Error('--offline and no cached Raider.IO response');
      const response = await fetch(seasonUrl, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      writeFileSync(file, await response.text());
    }
    const text = readFileSync(file, 'utf8');
    record(seasonUrl, text);
    const matches = JSON.parse(text).seasons?.filter(s => s.is_main_season === true
      && s.blizzard_season_id === loot.season.id) ?? [];
    if (matches.length !== 1) throw Error('no unique main season matching Blizzard');
    const start = Date.parse(matches[0].starts?.[region]);
    if (!Number.isFinite(start)) throw Error(`no ${region} start date`);
    startsAt = new Date(start).toISOString();
  } catch (error) {
    unavailable.push(`seasonStartsAt: Raider.IO ${seasonUrl} (${region}): ${error.message}`);
  }
}

// --- Weekly cap: not in DB2, so look for an official published statement. ---
// The coordinator asked for a verifiable published source rather than a DB2 field.
// This fetches Blizzard's own season articles and records what they do or do not say.
// It never parses a number out of prose and never falls back to a fan site.
const CAP_ARTICLES = [
  'https://news.blizzard.com/en-us/article/24294369/the-shadows-deepen-midnight-season-2-begins-august-18',
  'https://news.blizzard.com/en-us/article/24294369/midnight-season-2-is-now-live',
  'https://news.blizzard.com/en-us/article/24295090/midnight-curse-of-ula-tek-pre-season-details',
  'https://news.blizzard.com/en-us/article/24293281/curse-of-ula-tek-content-update-notes',
  'https://news.blizzard.com/en-us/article/24296142/hotfixes-september-10-2026',
];
let seasonCapSource = null;
const capSearch = { checkedAt: new Date().toISOString(), articles: [] };
for (const url of CAP_ARTICLES) {
  const file = `${cache}/cap-${url.split('/').pop()}.html`;
  try {
    if (!existsSync(file)) {
      if (offline) throw Error('--offline and no cached copy');
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      writeFileSync(file, await response.text());
    }
    const text = readFileSync(file, 'utf8').replace(/<[^>]+>/g, ' ');
    // A statement of the cap has to name a season crest AND a weekly rate.
    const hit = /(Crests?)[^.]{0,200}?\b(per week|each week|weekly cap|cap[^.]{0,40}lifted)/i.exec(text);
    capSearch.articles.push({ url, sha256: createHash('sha256').update(text).digest('hex'),
      statesCap: Boolean(hit), excerpt: hit ? hit[0].replace(/\s+/g, ' ').trim().slice(0, 300) : null });
  } catch (error) {
    capSearch.articles.push({ url, sha256: null, statesCap: null, error: error.message });
  }
}
unavailable.push('crest weekly cap: no DB2 field and no official Blizzard article states it; see capSearch');
if (capSearch.articles.some(article => article.statesCap)) {
  // Found something that talks about a weekly crest rate. A human has to read the
  // excerpt and set the numbers; this script will not infer them from prose.
  capSearch.note = 'An article matched the weekly-cap pattern. Read the excerpts and, if one states the Season 18 numbers, fill seasonCapSource by hand-reviewed edit to this script, not to the generated file.';
} else {
  capSearch.note = 'No official Blizzard article checked states a Midnight Season 2 crest weekly cap. The only numeric crest cap in Blizzard news is the Dragonflight 10.1 Embers of Neltharion system (ten crests of each kind per week), which is a different expansion and must not be reused here.';
}

// --- Watermark slot enumeration (Enum.ItemRedundancySlot). ---
// simc-addon core.lua GetSlotHighWatermarks iterates slot 0..16 and comments
// "These are not normal equipment slots, they are Enum.ItemRedundancySlot".
// The enum itself ships in Blizzard's generated API documentation.
const UI_SOURCE_REPO = 'Gethe/wow-ui-source';
const UI_SOURCE_PATH = 'Interface/AddOns/Blizzard_APIDocumentationGenerated/ItemConstants_MainlineDocumentation.lua';
const ADDON_REPO = 'simulationcraft/simc-addon';
let watermarkSlots = null;
const watermarkSource = {};
try {
  const commitFile = `${cache}/ui-source-commit.txt`;
  if (!existsSync(commitFile)) {
    if (offline) throw Error('--offline and no cached commit');
    const head = await fetch(`https://api.github.com/repos/${UI_SOURCE_REPO}/commits/live`,
      { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (!head.ok) throw Error(`commit lookup: HTTP ${head.status}`);
    writeFileSync(commitFile, (await head.json()).sha);
  }
  const commit = readFileSync(commitFile, 'utf8').trim();
  const url = `https://raw.githubusercontent.com/${UI_SOURCE_REPO}/${commit}/${UI_SOURCE_PATH}`;
  const file = `${cache}/ItemConstants_MainlineDocumentation.lua`;
  if (!existsSync(file)) {
    if (offline) throw Error('--offline and no cached enum');
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    writeFileSync(file, await response.text());
  }
  const lua = readFileSync(file, 'utf8');
  record(url, lua);
  const section = /Name = "ItemRedundancySlot",\s*Type = "Enumeration",\s*NumValues = (\d+),[\s\S]*?Fields =\s*\{([\s\S]*?)\n\t*\},/.exec(lua);
  if (!section) throw Error('ItemRedundancySlot enumeration not found in the generated API documentation');
  const fields = [...section[2].matchAll(/Name = "(\w+)", Type = "ItemRedundancySlot", EnumValue = (\d+)/g)]
    .map(match => ({ index: Number(match[2]), name: match[1] }))
    .sort((a, b) => a.index - b.index);
  if (fields.length !== Number(section[1])) throw Error('ItemRedundancySlot field count disagrees with NumValues');
  if (fields.some((field, i) => field.index !== i)) throw Error('ItemRedundancySlot is not contiguous from 0');
  watermarkSlots = fields;
  watermarkSource.enum = { url, commit, sha256: createHash('sha256').update(lua).digest('hex'), count: fields.length };
} catch (error) {
  unavailable.push(`watermarkSlots: ${UI_SOURCE_REPO}/${UI_SOURCE_PATH}: ${error.message}`);
}
// The addon file that decides the iteration range and the field order.
try {
  const file = `${cache}/simc-addon-core.lua`;
  const commitFile = `${cache}/addon-commit.txt`;
  if (!existsSync(commitFile)) {
    if (offline) throw Error('--offline and no cached commit');
    const head = await fetch(`https://api.github.com/repos/${ADDON_REPO}/commits/master`,
      { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (!head.ok) throw Error(`commit lookup: HTTP ${head.status}`);
    writeFileSync(commitFile, (await head.json()).sha);
  }
  const commit = readFileSync(commitFile, 'utf8').trim();
  const url = `https://raw.githubusercontent.com/${ADDON_REPO}/${commit}/core.lua`;
  if (!existsSync(file)) {
    if (offline) throw Error('--offline and no cached addon source');
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    writeFileSync(file, await response.text());
  }
  const lua = readFileSync(file, 'utf8');
  record(url, lua);
  const fn = /function Simulationcraft:GetSlotHighWatermarks\(\)([\s\S]*?)\nend/.exec(lua);
  if (!fn) throw Error('GetSlotHighWatermarks not found');
  if (!/Enum\.ItemRedundancySlot/.test(fn[1])) throw Error('GetSlotHighWatermarks no longer names Enum.ItemRedundancySlot');
  const order = /table\.concat\(\{\s*slot,\s*(\w+),\s*(\w+)\s*\}/.exec(fn[1]);
  if (!order) throw Error('Cannot read the field order the addon writes');
  const range = /for slot = (\d+), (\d+) do/.exec(fn[1]);
  if (!range) throw Error('Cannot read the slot range the addon iterates');
  watermarkSource.addon = { url, commit, sha256: createHash('sha256').update(lua).digest('hex'),
    fields: ['slotIndex', order[1], order[2]], range: [Number(range[1]), Number(range[2])] };
  if (watermarkSlots && (Number(range[1]) !== 0 || Number(range[2]) !== watermarkSlots.length - 1)) {
    throw Error('The addon iterates a different slot range than the enum defines');
  }
} catch (error) {
  unavailable.push(`watermarkFields: ${ADDON_REPO}/core.lua: ${error.message}`);
}

// --- Per-track, per-rank-step costs. ---
const byGroup = Map.groupBy(entries, row => row.ItemBonusListGroupID);
const usedCurrencies = new Map();
const tracks = seasonTracks.map(track => {
  const rows = new Map((byGroup.get(track.id) ?? []).map(row => [row.SequenceValue, row]));
  const steps = track.ranks.filter(rank => rank.rank > 1).map(rank => {
    const row = rows.get(rank.rank);
    if (!row) throw Error(`Missing group entry for ${track.label} rank ${rank.rank}`);
    const step = { fromRank: rank.rank - 1, toRank: rank.rank, itemLevel: rank.itemLevel,
      extendedCostId: row.ItemExtendedCostID || null };
    if (!row.ItemExtendedCostID) {
      // Ranks upstream marks unreachable by ordinary upgrade carry no vendor cost.
      return { ...step, currencies: null, money: null,
        unavailable: [rank.extended
          ? 'ItemBonusListGroupEntry.ItemExtendedCostID is 0: this rank is not purchasable, it only drops'
          : 'ItemBonusListGroupEntry.ItemExtendedCostID is 0 at the pinned build'] };
    }
    const cost = costs.get(row.ItemExtendedCostID);
    if (!cost) throw Error(`Missing ItemExtendedCost ${row.ItemExtendedCostID}`);
    const currencies = {};
    for (let i = 0; i < 5; i++) {
      const id = cost[`CurrencyID_${i}`];
      const count = cost[`CurrencyCount_${i}`];
      if (!id) continue;
      if (!currencyTypes.has(id)) throw Error(`Unknown CurrencyTypes id ${id}`);
      currencies[id] = (currencies[id] ?? 0) + count;
      usedCurrencies.set(id, track);
    }
    const items = [];
    for (let i = 0; i < 5; i++) {
      if (cost[`ItemID_${i}`]) items.push({ itemId: cost[`ItemID_${i}`], count: cost[`ItemCount_${i}`] });
    }
    if (!Object.keys(currencies).length && !items.length && !cost.Money) {
      throw Error(`ItemExtendedCost ${cost.ID} has no cost at all`);
    }
    return { ...step, currencies, money: cost.Money, ...(items.length ? { items } : {}) };
  });
  return { trackId: track.id, label: track.label, seasonId: track.seasonId, steps };
});

// --- The crest currencies those costs actually reference. Discovered, never assumed. ---
const crests = [...usedCurrencies].map(([id, track]) => {
  const row = currencyTypes.get(id);
  const capUnavailable = [];
  // MaxEarnablePerWeek / the recharging pair are the only DB2 fields that could encode
  // an accumulating seasonal cap. When they are all zero the cap lives in the world
  // state named by MaxQtyWorldStateID, which is server data and not in any DB2.
  if (!row.MaxEarnablePerWeek && !row.RechargingAmountPerCycle && !row.RechargingCycleDurationMS) {
    capUnavailable.push(row.MaxQtyWorldStateID
      ? `perWeek: CurrencyTypes.MaxEarnablePerWeek and the recharging fields are 0; the cap is driven by world state ${row.MaxQtyWorldStateID}, which no DB2 exposes`
      : 'perWeek: CurrencyTypes.MaxEarnablePerWeek and the recharging fields are 0 at the pinned build');
  }
  return {
    id, name: row.Name_lang, trackId: track.id, trackLabel: track.label,
    orderIndex: row.OrderIndex, categoryId: row.CategoryID,
    flags: [row.Flags_0, row.Flags_1],
    cap: {
      maxQty: row.MaxQty || null,
      perWeek: row.MaxEarnablePerWeek || null,
      rechargeAmount: row.RechargingAmountPerCycle || null,
      cycleMs: row.RechargingCycleDurationMS || null,
      // No DB2 field carries a season-start grant. Absent, not zero.
      startQuantity: null,
      maxQtyWorldStateId: row.MaxQtyWorldStateID || null,
      unavailable: [...capUnavailable, 'startQuantity: no DB2 field encodes a season-start grant'],
    },
  };
}).sort((a, b) => a.orderIndex - b.orderIndex);

// The crest order the client sorts by must agree with the track order we already verified.
const trackOrder = seasonTracks.map(track => track.id);
if (crests.map(crest => crest.trackId).join() !== trackOrder.filter(id => crests.some(c => c.trackId === id)).join()) {
  throw Error('Crest OrderIndex disagrees with the verified upgrade track order');
}
if (new Set(crests.map(crest => crest.trackId)).size !== crests.length) {
  throw Error('More than one crest currency per track; the tier model does not hold');
}
crests.forEach((crest, i) => { crest.tier = i + 1; });

// --- Valorstones, or whatever non-crest upgrade currency this build uses. ---
// Season 11-17 charged a second, uncapped currency alongside crests. Report what the
// pinned costs actually reference rather than assuming that is still true.
const crestIds = new Set(crests.map(crest => crest.id));
const otherCurrencies = [...new Set(tracks.flatMap(track =>
  track.steps.flatMap(step => Object.keys(step.currencies ?? {}).map(Number))))].filter(id => !crestIds.has(id));
if (!otherCurrencies.length) {
  unavailable.push('valorstones: no non-crest currency appears in any season upgrade ItemExtendedCost at this build; the non-crest part of every step is CurrencyTypes-free gold (the Money field)');
}

const output = {
  schemaVersion: 1,
  build, engineCommit: lock.upstream.commit,
  season: { ...loot.season, startsAt, region },
  // Published-source cap statement. NOT DB2. Null means no official article states it.
  seasonCapSource, capSearch,
  // Enum.ItemRedundancySlot, the index space slot_high_watermarks is written in.
  watermarkSlots, watermarkSource,
  generatedAt: new Date().toISOString(),
  sources,
  unavailable,
  crests,
  otherCurrencies: otherCurrencies.map(id => ({ id, name: currencyTypes.get(id).Name_lang })),
  tracks,
};
mkdirSync('src/lib/catalog/generated', { recursive: true });
writeFileSync('src/lib/catalog/generated/upgrade-costs.json', JSON.stringify(output, null, 2) + '\n');
console.log(`Generated costs for ${tracks.length} tracks, ${crests.length} crests (${build}, season ${loot.season.id}).`);
for (const note of unavailable) console.log(`  unavailable: ${note}`);
