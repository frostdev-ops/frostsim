// Versioned presentation/rules data; engine codec untouched. Run: node --env-file=.dev.vars
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCsv } from './catalog/sources/db2-loot.mjs';
const lock = JSON.parse(readFileSync('engine.lock.json', 'utf8'));
const build = lock.expected.clientDataWowVersion;
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const cache = arg('--cache', 'build/talent-layout-' + build);
const out = arg('--out', 'public/talent-layout');
mkdirSync(cache, { recursive: true });
const sources = [];
async function csv(name) {
  const path = cache + '/' + name + '.csv';
  const url = 'https://wago.tools/db2/' + name + '/csv?build=' + build;
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw Error(name + ': HTTP ' + response.status);
    writeFileSync(path, await response.text());
  }
  const text = readFileSync(path, 'utf8');
  sources.push({ url, sha256: createHash('sha256').update(text).digest('hex') });
  const { header, rows } = parseCsv(text);
  if (!header.includes('ID')) throw Error(name + ': missing ID column');
  return rows.map(row => Object.fromEntries(header.map((key, i) => [key, key.endsWith('_lang') ? row[i] : Number(row[i])])));
}
const nodeRows = await csv('TraitNode');
const entryRows = await csv('TraitNodeEntry');
const definitions = await csv('TraitDefinition');
const edges = await csv('TraitEdge');
const currencies = await csv('TraitCurrency');
const currencySources = await csv('TraitCurrencySource');
const treeCurrencies = await csv('TraitTreeXTraitCurrency');
const conditions = await csv('TraitCond');
const nodeConditions = await csv('TraitNodeXTraitCond');
const nodeGroups = await csv('TraitNodeGroupXTraitNode');
const groupConditions = await csv('TraitNodeGroupXTraitCond');
const nodesById = new Map(nodeRows.map(row => [row.ID, row]));
const entriesById = new Map(entryRows.map(row => [row.ID, row]));
const definitionsById = new Map(definitions.map(row => [row.ID, row]));

const oauth = await fetch('https://oauth.battle.net/token', { method: 'POST', headers: {
  Authorization: 'Basic ' + Buffer.from(process.env.BLIZZARD_CLIENT_ID + ':' + process.env.BLIZZARD_CLIENT_SECRET).toString('base64'),
  'Content-Type': 'application/x-www-form-urlencoded',
}, body: 'grant_type=client_credentials' });
const token = (await oauth.json()).access_token;
if (!token) throw Error('Blizzard authentication failed');
async function get(url) {
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!response.ok) throw Error('Blizzard talent data: HTTP ' + response.status);
  return response.json();
}
const index = await get('https://us.api.blizzard.com/data/wow/talent-tree/index?namespace=static-us&locale=en_US');
const tooltips = new Map();
const shapes = new Map();
for (const spec of index.spec_talent_trees) {
  const response = await get(spec.key.href + '&locale=en_US');
  for (const node of [...response.class_talent_nodes, ...response.spec_talent_nodes, ...(response.hero_talent_trees ?? []).flatMap(tree => tree.hero_talent_nodes)]) {
    shapes.set(node.id, node.node_type?.type);
    for (const rank of node.ranks ?? []) {
      for (const tip of [rank.tooltip, ...(rank.choice_of_tooltips ?? [])].filter(Boolean)) {
        if (tip.spell_tooltip) tooltips.set(tip.talent.id, { spellId: tip.spell_tooltip.spell.id, description: tip.spell_tooltip.description, castTime: tip.spell_tooltip.cast_time });
      }
    }
  }
}
const catalogRoot = arg('--catalog', null) ?? ('public/catalogs/' + readdirSync('public/catalogs').find(name => name.startsWith(build + '-') && !name.includes(' ')));
const manifest = JSON.parse(readFileSync(catalogRoot + '/manifest.json', 'utf8'));
if (manifest.engine.upstreamCommit !== lock.upstream.commit || manifest.engine.clientDataVersion !== build) throw Error('Talent catalog does not match the engine lock');
const generatedAt = new Date().toISOString();
const provenance = { schemaVersion: 1, build, engineCommit: lock.upstream.commit, generatedAt, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), sources, tooltipSource: index._links.self.href };
mkdirSync(out, { recursive: true });
for (let classId = 1; classId <= 13; classId++) {
  const tree = JSON.parse(readFileSync(catalogRoot + '/talents/class-' + classId + '.json', 'utf8'));
  const ids = new Set(tree.nodes.map(node => node.nodeId));
  const treeIds = [...new Set([...ids].map(id => nodesById.get(id)?.TraitTreeID).filter(Boolean))];
  const layoutNodes = {};
  const descriptions = {};
  for (const node of tree.nodes) {
    const raw = nodesById.get(node.nodeId);
    const entry = entriesById.get(node.entryId);
    const definition = entry && definitionsById.get(entry.TraitDefinitionID);
    if (!raw || !entry || !definition || entry.TraitDefinitionID !== node.definitionId) continue;
    layoutNodes[node.nodeId] = { x: raw.PosX, y: raw.PosY, flags: raw.Flags, shape: shapes.get(node.nodeId) ?? (entry.NodeEntryType === 2 ? 'PASSIVE' : 'ACTIVE'), entryType: entry.NodeEntryType };
    const tip = tooltips.get(node.entryId);
    if (tip?.spellId === node.spellId) descriptions[node.entryId] = { text: tip.description, castTime: tip.castTime };
  }
  const linked = treeCurrencies.filter(row => treeIds.includes(row.TraitTreeID));
  const budgetSources = { class: [], spec: [], hero: [] };
  for (const kind of ['class', 'spec', 'hero']) {
    const matching = linked.filter(link => {
      const currency = currencies.find(row => row.ID === link.TraitCurrencyID);
      return kind === 'class' ? currency?.Flags === 4 : kind === 'spec' ? currency?.Flags === 8 : currency?.Flags === 0 && currency.Type === 2;
    });
    const amounts = matching.map(link => currencySources.filter(row => row.TraitCurrencyID === link.TraitCurrencyID && !row.QuestID && !row.AchievementID && !row.TraitNodeEntryID).map(row => ({ level: row.PlayerLevel, amount: row.Amount })).sort((a, b) => a.level - b.level));
    if (amounts.length && !amounts.every(rows => JSON.stringify(rows) === JSON.stringify(amounts[0]))) throw Error('Unequal ' + kind + ' budgets for class ' + classId);
    budgetSources[kind] = amounts[0] ?? [];
  }
  const grantLinks = [...nodeConditions, ...groupConditions.flatMap(link => nodeGroups
    .filter(group => group.TraitNodeGroupID === link.TraitNodeGroupID)
    .map(group => ({ TraitNodeID: group.TraitNodeID, TraitCondID: link.TraitCondID })))];
  const grants = Object.fromEntries(grantLinks.filter(link => ids.has(link.TraitNodeID)).flatMap(link => {
    const condition = conditions.find(row => row.ID === link.TraitCondID);
    return condition?.CondType === 2 && condition.GrantedRanks === 1 && !condition.SpecSetID && !condition.QuestID && !condition.AchievementID && !condition.TraitNodeEntryID && !condition.SpentAmountRequired && !condition.TraitCurrencyID && !condition.TraitCondAccountElementID
      ? [[link.TraitNodeID, condition.RequiredLevel]] : [];
  }));
  const payload = { ...provenance, grants, classId, nodes: layoutNodes, descriptions, budgetSources, edges: edges.filter(edge => ids.has(edge.LeftTraitNodeID) && ids.has(edge.RightTraitNodeID)).map(edge => ({ from: edge.LeftTraitNodeID, to: edge.RightTraitNodeID, type: edge.Type, visual: edge.VisualStyle })) };
  writeFileSync(out + '/class-' + classId + '.json', JSON.stringify(payload));
  console.log('Class', classId, Object.keys(layoutNodes).length + '/' + ids.size, 'nodes;', payload.edges.length, 'edges; budgets at 90:', Object.fromEntries(Object.entries(budgetSources).map(([key, rows]) => [key, rows.filter(row => row.level <= 90).reduce((sum, row) => sum + row.amount, 0)])));
}
