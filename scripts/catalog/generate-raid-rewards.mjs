// Generate source/item reward bonuses; never infer a track from overlapping item levels.
// Run after catalog:build and generate-upgrades.mjs. Cached DB2s are pinned to the engine build.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCsv } from './sources/db2-loot.mjs';

const lock = JSON.parse(readFileSync('engine.lock.json', 'utf8'));
const upgrades = JSON.parse(readFileSync('src/lib/catalog/generated/upgrades.json', 'utf8'));
const build = lock.expected.clientDataWowVersion;
if (upgrades.build !== build || upgrades.engineCommit !== lock.upstream.commit) throw Error('Regenerate upgrades for the pinned engine first');
const cache = `build/upgrade-data-${build}`;
mkdirSync(cache, { recursive: true });
const sources = [];
async function csv(name) {
  const path = `${cache}/${name}.csv`;
  const url = `https://wago.tools/db2/${name}/csv?build=${build}`;
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
    writeFileSync(path, await response.text());
  }
  const text = readFileSync(path, 'utf8');
  sources.push({ url, sha256: createHash('sha256').update(text).digest('hex') });
  const { header, rows } = parseCsv(text);
  return rows.map(row => Object.fromEntries(header.map((key, i) => [key, key.endsWith('_lang') ? row[i] : Number(row[i])])));
}

// The server-side IblGroupPointsModSet is not exported in DB2. This initial-rank
// policy is verified against the boss tables below, not guessed from OrderIndex.
// Item membership, rarity, track identity, rank bonuses and levels remain generated.
const policy = {
  seasonId: 18, instance: 'The Venomous Abyss', ranks: [1, 2, 2, 3, 3, 3, 4, 4], mythicFinalRank: 9,
  references: [
    'https://www.wowhead.com/guide/midnight/raids/the-venomous-abyss-rewards-gear-loot',
    'https://news.blizzard.com/en-us/article/24293281/curse-of-ula-tek-content-update-notes',
  ],
};
if (upgrades.season.id !== policy.seasonId) throw Error('Research the new season reward policy before generating raid rewards');
const instances = await csv('JournalInstance');
const instance = instances.find(row => row.Name_lang === policy.instance);
if (!instance) throw Error(`Missing ${policy.instance}`);
const encounters = (await csv('JournalEncounter')).filter(row => row.JournalInstanceID === instance.ID).sort((a, b) => a.OrderIndex - b.OrderIndex);
if (encounters.length !== policy.ranks.length || encounters.some((row, i) => row.OrderIndex !== i + 1)) throw Error('Raid boss order changed; review reward policy');
const journalItems = Map.groupBy(await csv('JournalEncounterItem'), row => row.JournalEncounterID);
const roots = Map.groupBy(await csv('ItemXBonusTree'), row => row.ItemID);
const nodes = Map.groupBy(await csv('ItemBonusTreeNode'), row => row.ParentItemBonusTreeID);
const itemContexts = Map.groupBy(await csv('ItemCreationContext'), row => row.ItemCreationContextGroupID);
const catalogId = `${build}-${lock.expected.clientDataHotfixHash.slice(0, 12)}-${lock.upstream.commit.slice(0, 7)}`;
const items = JSON.parse(readFileSync(`public/catalogs/${catalogId}/items.json`, 'utf8'));
const equipmentById = new Map(items.id.map((id, i) => [id, [2, 4].includes(items.itemClass[i]) && items.invType[i] > 0]));
const difficulties = { lfr: 4, normal: 3, heroic: 5, mythic: 6 };
function rewardTrack(itemId, context) {
  const found = new Set();
  const visited = new Set();
  function visit(tree) {
    if (visited.has(tree)) return;
    visited.add(tree);
    for (const node of nodes.get(tree) ?? []) {
      if (node.ItemContext && node.ItemContext !== context) continue;
      if (node.ItemCreationContextGroupID && !itemContexts.get(node.ItemCreationContextGroupID)?.some(row => row.ItemContext === context)) continue;
      if (node.ChildItemBonusListGroupID) found.add(node.ChildItemBonusListGroupID);
      if (node.ChildItemBonusTreeID) visit(node.ChildItemBonusTreeID);
    }
  }
  for (const row of roots.get(itemId) ?? []) visit(row.ItemBonusTreeID);
  const tracks = upgrades.tracks.filter(track => found.has(track.id) && track.seasonId === policy.seasonId);
  if (tracks.length !== 1) throw Error(`Item ${itemId}, context ${context}: ambiguous or missing seasonal track`);
  return tracks[0];
}
const rewards = encounters.map(boss => {
  const rows = journalItems.get(boss.ID) ?? [];
  // Journal collectible/cosmetic flags; some cosmetic rewards have armor slots in ItemSparse.
  const equipment = rows.filter(row => equipmentById.get(row.ItemID) === true && !(row.Flags & 6));
  const ignoredItemIds = rows.filter(row => equipmentById.get(row.ItemID) === false || (row.Flags & 6)).map(row => row.ItemID);
  const byDifficulty = Object.fromEntries(Object.entries(difficulties).map(([difficulty, context]) => [difficulty,
    Object.fromEntries(equipment.map(row => {
      const track = rewardTrack(row.ItemID, context);
      const rankNumber = difficulty === 'mythic' && (boss.OrderIndex >= encounters.length - 1 || (row.Flags & 8))
        ? policy.mythicFinalRank : policy.ranks[boss.OrderIndex - 1];
      const rank = track.ranks.find(rank => rank.rank === rankNumber);
      if (!rank) throw Error(`Missing ${difficulty} rank ${rankNumber} for ${boss.Name_lang}, item ${row.ItemID}`);
      return [row.ItemID, rank.bonusId];
    })),
  ]));
  return { id: `blizzard-journal:encounter:${boss.ID}`, name: boss.Name_lang, instanceId: instance.ID, ignoredItemIds, byDifficulty };
});
writeFileSync('src/lib/catalog/generated/raid-rewards.json', JSON.stringify({ build, seasonId: policy.seasonId, policy, sources, rewards }, null, 2) + '\n');
console.log(`Generated ${rewards.length} bosses with per-item rewards for ${build}`);
