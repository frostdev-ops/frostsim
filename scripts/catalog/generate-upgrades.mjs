// Generate compact upgrade identity table from engine-pinned DB2s.
// Run: node scripts/catalog/generate-upgrades.mjs [--cache directory]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCsv } from './sources/db2-loot.mjs';

const lock = JSON.parse(readFileSync('engine.lock.json', 'utf8'));
const build = lock.expected.clientDataWowVersion;
const arg = process.argv.indexOf('--cache');
const cache = arg < 0 ? `build/upgrade-data-${build}` : process.argv[arg + 1];
mkdirSync(cache, { recursive: true });
const sources = [];
async function csv(name) {
  const file = `${cache}/${name}.csv`;
  const url = `https://wago.tools/db2/${name}/csv?build=${build}`;
  if (!existsSync(file)) {
    const response = await fetch(url);
    if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
    writeFileSync(file, await response.text());
  }
  const text = readFileSync(file, 'utf8');
  sources.push({ url, sha256: createHash('sha256').update(text).digest('hex') });
  const { header, rows } = parseCsv(text);
  return rows.map(row => Object.fromEntries(header.map((key, i) => [key, key.endsWith('_lang') ? row[i] : Number(row[i])])));
}
const entries = await csv('ItemBonusListGroupEntry');
const bonuses = await csv('ItemBonus');
const configs = new Map((await csv('ItemScalingConfig')).map(row => [row.ID, row]));
const offsets = new Map((await csv('ItemOffsetCurve')).map(row => [row.ID, row]));
const descriptions = await csv('ItemNameDescription');
const groups = new Map((await csv('ItemBonusListGroup')).map(row => [row.ID, row]));
const byBonus = Map.groupBy(bonuses, row => row.ParentItemBonusListID);
const catalogDir = readdirSync('public/catalogs').find(dir => dir.startsWith(build + '-'));
if (!catalogDir) throw Error('Build the engine-pinned catalog first');
const catalogRoot = `public/catalogs/${catalogDir}`;
const scaling = JSON.parse(readFileSync(`${catalogRoot}/scaling.json`, 'utf8'));
const engineBonus = JSON.parse(readFileSync(`${catalogRoot}/item-bonus.json`, 'utf8')).byBonusId;
const loot = JSON.parse(readFileSync(`${catalogRoot}/loot.json`, 'utf8'));

// Season identity explicit from DB2 groups, not inferred from item level (see season-upgrades.md).
const seasonGroups = [{ seasonId: 17, ids: [608, 609, 610, 611, 612] },
  { seasonId: 18, ids: [614, 615, 616, 617, 618] }];
const names = ['Adventurer', 'Veteran', 'Champion', 'Hero', 'Myth'];
function curveValue(id, point) {
  const flat = scaling.curves[id];
  if (!flat) throw Error(`Missing curve ${id}`);
  for (let i = 0; i < flat.length; i += 2) {
    if (point <= flat[i]) {
      if (!i) return flat[i + 1];
      return flat[i - 1] + (flat[i + 1] - flat[i - 1]) * (point - flat[i - 2]) / (flat[i] - flat[i - 2]);
    }
  }
  return flat.at(-1);
}
const tracks = seasonGroups.flatMap(({ seasonId, ids }) => ids.map((id, i) => {
  const label = names[i];
  if (!descriptions.some(row => row.Description_lang === label || row.Description_lang.includes(`Upgrade Level: ${label} `))) {
    throw Error(`Unverified track label ${label}`);
  }
  if (!groups.has(id)) throw Error(`Missing group ${id}`);
  const ranks = entries.filter(row => row.ItemBonusListGroupID === id).sort((a, b) => a.SequenceValue - b.SequenceValue).map(row => {
    const bonus = byBonus.get(row.ItemBonusListID) ?? [];
    const configBonus = bonus.find(b => b.Type === 49);
    const config = configs.get(configBonus?.Value_0);
    if (!config || config.RequiredLevel !== 90 || config.ItemSquishEraID !== 2) throw Error(`Unsupported rank scaling: ${row.ID}`);
    const offset = offsets.get(config.ItemOffsetCurveID);
    if (!offset) throw Error(`Missing offset curve: ${row.ID}`);
    const engineConfig = scaling.scalingConfigs.find(c => c[0] === config.ID);
    if (!engineConfig || engineConfig[2] !== config.ItemLevel || !engineBonus[row.ItemBonusListID]?.some(b => b[0] === 49 && b[1] === config.ID)) {
      throw Error(`Live data disagrees with pinned engine: ${row.ID}`);
    }
    return { rank: row.SequenceValue, itemLevel: Math.round(curveValue(offset.CurveID, config.ItemLevel)) + offset.Offset,
      bonusId: row.ItemBonusListID, extended: (row.Flags & 1) !== 0 };
  });
  const max = Math.max(...ranks.filter(rank => !rank.extended).map(rank => rank.rank));
  return { id, label, seasonId, max, ranks };
}));
if (!tracks.some(track => track.seasonId === loot.season?.id)) throw Error('Current loot season has no verified upgrade data');
const output = { build, engineCommit: lock.upstream.commit, season: loot.season, sources, tracks };
mkdirSync('src/lib/catalog/generated', { recursive: true });
writeFileSync('src/lib/catalog/generated/upgrades.json', JSON.stringify(output, null, 2) + '\n');
console.log(`Generated ${tracks.length} upgrade tracks for ${build}; current ${loot.season.name}`);
