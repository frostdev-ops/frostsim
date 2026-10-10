import type { CatalogPayloads } from './catalog';
import type { CatalogManifest, LootCatalog, TalentTree } from './types';
import { rulesMatch } from './rules';

const positive = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const unique = (values: unknown[]) => new Set(values).size === values.length;
export const catalogFilePath = (path: unknown): path is string => typeof path === 'string'
  && /^[\w.-]+(?:\/[\w.-]+)*\.json$/.test(path) && !path.split('/').some(part => part === '..' || part === '.');

/** Validate metadata before any path is fetched or payload is used. */
export function manifestProblems(manifest: CatalogManifest): string[] {
  try {
    const engine = manifest.engine;
    if (manifest.schemaVersion !== 1 || !text(manifest.catalogId) || !date(manifest.generatedAt)
      || !engine || !text(engine.clientDataVersion) || !text(engine.hotfixHash)
      || !(engine.upstreamCommit === null || /^[a-f0-9]{40}$/.test(engine.upstreamCommit))
      || typeof engine.ptr !== 'boolean') return ['Catalog identity is malformed.'];
    const channel = manifest.engineChannel ?? engine.engineChannel ?? (engine.ptr ? 'ptr' : 'live');
    if (!['live', 'ptr'].includes(channel) || engine.ptr !== (channel === 'ptr')
      || engine.engineChannel && engine.engineChannel !== channel) return ['Catalog channel identity disagrees.'];
    if (!Array.isArray(manifest.coverage) || !unique(manifest.coverage.map(row => row.field))
      || manifest.coverage.some(row => !text(row.field) || !text(row.source)
        || !['verified', 'partial', 'unavailable'].includes(row.status))) return ['Catalog coverage is malformed.'];
    if (!manifest.counts || Object.values(manifest.counts).some(n => !Number.isInteger(n) || n < 0)
      || !Array.isArray(manifest.files) || !manifest.files.length || !unique(manifest.files.map(file => file.path))
      || manifest.files.some(file => !catalogFilePath(file.path) || !positive(file.bytes) || !positive(file.brotliBytes)
        || !/^[a-f0-9]{64}$/.test(file.sha256))) return ['Catalog file metadata is malformed.'];
    if (manifest.totals?.fileCount !== manifest.files.length
      || manifest.totals.bytes !== manifest.files.reduce((n, file) => n + file.bytes, 0)
      || manifest.totals.brotliBytes !== manifest.files.reduce((n, file) => n + file.brotliBytes, 0)) return ['Catalog totals disagree with files.'];
    if (manifest.loot && (!catalogFilePath(manifest.loot.path) || !manifest.files.some(file => file.path === manifest.loot!.path)
      || !(manifest.loot.expiresAt === null || date(manifest.loot.expiresAt)) || !positive(manifest.loot.sources)
      || !Array.isArray(manifest.loot.providers) || !manifest.loot.providers.every(text))) return ['Loot manifest metadata is malformed.'];
    return [];
  } catch { return ['Catalog manifest is malformed.']; }
}

/** Required engine tables must be coherent; optional season rules are validated separately. */
export function payloadProblems(payloads: CatalogPayloads): string[] {
  const problems: string[] = [];
  try {
    const { items, bonus, enchants, gems, sets, scaling } = payloads;
    const columns = ['id', 'name', 'level', 'reqLevel', 'quality', 'invType', 'itemClass', 'itemSubclass',
      'bindType', 'delay', 'dmgRange', 'classMask', 'raceMask', 'socketColor', 'gemProperties', 'socketBonusId',
      'setId', 'curveId', 'craftingQuality', 'flags1', 'flags2', 'typeFlags', 'stats'] as const;
    if (!positive(items.count) || columns.some(key => !Array.isArray(items[key]) || items[key].length !== items.count)
      || !items.id.every(positive) || !unique(items.id) || !items.name.every(text)) return ['Item columns are malformed or duplicate item IDs.'];
    if (columns.filter(key => !['name', 'raceMask', 'socketColor', 'stats'].includes(key)).some(key =>
      (items[key] as number[]).some(value => !Number.isFinite(value)))
      || items.stats.some(value => value !== 0 && (!Array.isArray(value) || value.length % 3 || !value.every(Number.isFinite)))
      || items.socketColor.some(value => value !== 0 && (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)))) problems.push('Malformed item numeric/stat/socket columns.');
    const itemIds = new Set(items.id);
    const enchantIds = new Set(enchants.enchantments.map(row => row.id));
    const gemIds = new Set(gems.properties.map(row => row.id));
    if (!unique(enchants.enchantments.map(row => row.id)) || !unique(gems.properties.map(row => row.id))) problems.push('Duplicate enchantment or gem-property IDs.');
    if (items.gemProperties.some(id => id && !gemIds.has(id))
      || gems.properties.some(row => row.enchantId && !enchantIds.has(row.enchantId))
      || [...enchants.permanent, ...enchants.temporary].some(row => !enchantIds.has(row.enchantId))) problems.push('Broken gem/enchantment reference.');
    if (Object.entries(bonus.byBonusId).some(([id, entries]) => !positive(Number(id)) || !Array.isArray(entries)
      || entries.some(entry => entry.length !== 6 || !entry.every(Number.isFinite)))) problems.push('Malformed bonus entries.');
    if (Object.values(scaling.curves).some(curve => curve.length % 2 || !curve.every(Number.isFinite)
      || curve.some((value, index) => index % 2 === 0 && index > 0 && value < curve[index - 2]))) problems.push('Malformed item-level curve.');
    const offsets = new Set(scaling.offsetCurves.map(row => row[0]));
    if (scaling.scalingConfigs.some(row => row.length !== 5 || !row.every(Number.isFinite) || row[1] && !offsets.has(row[1]))
      || scaling.offsetCurves.some(row => row.length !== 3 || !row.every(Number.isFinite) || !scaling.curves[row[1]])) problems.push('Broken scaling configuration/curve reference.');
    if (sets.sets.some(row => !positive(row.setId) || !positive(row.pieces) || !Array.isArray(row.itemIds)
      || !unique(row.itemIds) || row.itemIds.some(id => !itemIds.has(id)))) problems.push('Broken set item reference.');
    if (payloads.consumables.consumables.some(row => !itemIds.has(row.itemId) || !text(row.option))) problems.push('Broken consumable item reference.');
    if (payloads.embellishments.embellishments.some(row => !bonus.byBonusId[row.bonusId])) problems.push('Broken embellishment bonus reference.');
    if (payloads.rules && !rulesMatch(payloads.rules, payloads.manifest)) problems.push('Season rules are malformed or incompatible.');
    if (payloads.rules?.upgrades?.tracks.some(track => track.ranks.some(rank => !bonus.byBonusId[rank.bonusId]))) problems.push('Upgrade rank names an unknown bonus.');
    if (payloads.rules?.vault && !bonus.byBonusId[payloads.rules.vault.socketBonusId]) problems.push('Vault socket bonus is unknown.');
    if (payloads.rules?.raid?.rewards.some(reward => Object.keys(reward.byDifficulty.heroic).some(id => !itemIds.has(Number(id))))) problems.push('Raid reward names an unknown item.');
  } catch { problems.push('Catalog payload schema is malformed.'); }
  return problems;
}

export function talentTreeProblems(tree: TalentTree, classId = tree?.classId): string[] {
  try {
    if (!positive(classId) || tree.classId !== classId || !Array.isArray(tree.nodes) || !tree.nodes.length
      || !Array.isArray(tree.subTrees) || !unique(tree.nodes.map(node => node.entryId))
      || !unique(tree.subTrees.map(row => row.id))) return ['Talent tree schema is malformed.'];
    const subTrees = new Set(tree.subTrees.map(row => row.id));
    if (tree.nodes.some(node => !positive(node.entryId) || !positive(node.nodeId) || !Number.isInteger(node.maxRanks) || node.maxRanks < 0
      || !Number.isInteger(node.reqPoints) || node.reqPoints < 0 || !Number.isFinite(node.row) || !Number.isFinite(node.col)
      || !Array.isArray(node.specIds) || !Array.isArray(node.starterSpecIds)
      || node.subTreeId && !subTrees.has(node.subTreeId))) return ['Talent node/reference is malformed.'];
    return [];
  } catch { return ['Talent tree schema is malformed.']; }
}

/** Invalid expiry is unusable, and merged provider names must resolve each provenance entry. */
export function lootProblems(loot: LootCatalog, now = Date.now()): string[] {
  try {
    if (loot.schemaVersion !== 1 || !date(loot.generatedAt) || !(loot.expiresAt === null || date(loot.expiresAt))
      || !Array.isArray(loot.provenance) || !loot.provenance.length || !Array.isArray(loot.sources)
      || !Array.isArray(loot.warnings)) return ['Loot schema, expiry or provenance is malformed.'];
    if (loot.season && (!positive(loot.season.id) || !text(loot.season.name))) return ['Loot season identity is malformed.'];
    if (loot.expiresAt && Date.parse(loot.expiresAt) <= now) return [`Loot data expired on ${loot.expiresAt}; rebuild the catalog to refresh it.`];
    if (loot.expiresAt && Date.parse(loot.expiresAt) <= Date.parse(loot.generatedAt)) return ['Loot expiry precedes generation.'];
    if (!unique(loot.provenance.map(row => row.provider)) || loot.provenance.some(row => !text(row.provider)
      || !text(row.description) || !text(row.retention) || !text(row.attribution) || !Array.isArray(row.limitations)
      || !row.limitations.every(text) || !Number.isInteger(row.sourceCount) || row.sourceCount < 0
      || !Number.isInteger(row.itemCount) || row.itemCount < 0)) return ['Loot provenance is malformed.'];
    const providers = new Set(loot.provenance.map(row => row.provider));
    if (providers.has('blizzard-journal') && (!loot.expiresAt
      || Date.parse(loot.expiresAt) - Date.parse(loot.generatedAt) > 30 * 86_400_000)) return ['Blizzard loot data exceeds its recorded 30-day retention limit.'];
    if (!unique(loot.sources.map(row => row.id)) || loot.sources.some(row => !text(row.id) || !text(row.name)
      || !['raid', 'dungeon', 'delve', 'pvp', 'profession', 'vault', 'other'].includes(row.kind)
      || row.seasonId !== undefined && !positive(row.seasonId)
      || !text(row.provider) || !row.provider.split('+').every(provider => providers.has(provider))
      || !Array.isArray(row.itemIds) || !row.itemIds.length || !row.itemIds.every(positive) || !unique(row.itemIds))) return ['Loot source IDs, items or provider references are malformed.'];
    return [];
  } catch { return ['Loot schema is malformed.']; }
}
