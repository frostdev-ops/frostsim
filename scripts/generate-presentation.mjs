import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseInc, tokenize } from './catalog/inc.mjs';
import { parseCsv } from './catalog/sources/db2-loot.mjs';
const lock = JSON.parse(readFileSync('engine.lock.json', 'utf8'));
const root = 'vendor/simc/engine/';
const spells = [];
for (const match of readFileSync(root + 'dbc/generated/sc_spell_data.inc', 'utf8').matchAll(/^\s*\{\s*("(?:[^"\\]|\\.)*")\s*,\s*(\d+),/gm)) spells.push({ name: JSON.parse(match[1]), id: Number(match[2]) });
if (spells.length < 10000) throw Error('Spell name extraction failed');
const grouped = new Map();
for (const spell of spells) { const key = tokenize(spell.name); grouped.set(key, [...(grouped.get(key) ?? []), spell.id]); }
const miscPath = 'build/talent-layout-' + lock.expected.clientDataWowVersion + '/SpellMisc.csv';
const spellMiscUrl = 'https://wago.tools/db2/SpellMisc/csv?build=' + lock.expected.clientDataWowVersion;
if (!existsSync(miscPath)) {
  mkdirSync(miscPath.slice(0, miscPath.lastIndexOf('/')), { recursive: true });
  const response = await fetch(spellMiscUrl);
  if (!response.ok) throw Error('Spell icon data unavailable');
  writeFileSync(miscPath, await response.text());
}
const misc = parseCsv(readFileSync(miscPath, 'utf8'));
const spellColumn = misc.header.indexOf('SpellID'), iconColumn = misc.header.indexOf('SpellIconFileDataID');
if (spellColumn < 0 || iconColumn < 0) throw Error('SpellMisc schema changed');
const icons = new Map(misc.rows.filter(row => Number(row[iconColumn]) > 0).map(row => [Number(row[spellColumn]), Number(row[iconColumn])]));
// Spell icons by file name. Blizzard's media API only indexes player-learnable spells, so
// consumables, enchants and pet or NPC abilities 404 there, and so does every other spell sharing
// their icon (checked 2026-09-23). Every interface icon is on the render CDN by file name, and
// ManifestInterfaceData names each icon file. The CDN drops the spaces some file names contain.
const manifestPath = 'build/talent-layout-' + lock.expected.clientDataWowVersion + '/ManifestInterfaceData.csv';
const manifestUrl = 'https://wago.tools/db2/ManifestInterfaceData/csv?build=' + lock.expected.clientDataWowVersion;
if (!existsSync(manifestPath)) {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw Error('Interface file names unavailable');
  writeFileSync(manifestPath, await response.text());
}
const interfaceFiles = parseCsv(readFileSync(manifestPath, 'utf8'));
const [fileColumn, pathColumn, nameColumn] = ['ID', 'FilePath', 'FileName'].map(key => interfaceFiles.header.indexOf(key));
if (fileColumn < 0 || pathColumn < 0 || nameColumn < 0) throw Error('ManifestInterfaceData schema changed');
const iconFiles = new Map(interfaceFiles.rows.filter(row => row[pathColumn].toLowerCase() === 'interface\\icons\\')
  .map(row => [Number(row[fileColumn]), row[nameColumn].replace(/\.blp$/i, '').replace(/\s+/g, '').toLowerCase()]));
const iconNames = [], nameIndex = new Map(), spellIcons = {};
for (const spell of spells) {
  const name = iconFiles.get(icons.get(spell.id));
  if (!name) continue;
  if (!nameIndex.has(name)) { nameIndex.set(name, iconNames.length); iconNames.push(name); }
  spellIcons[spell.id] = nameIndex.get(name);
}
if (Object.keys(spellIcons).length < spells.length * 0.9) throw Error('Spell icon name coverage collapsed');
mkdirSync('src/lib/battlenet/generated', { recursive: true });
writeFileSync('src/lib/battlenet/generated/spell-icons.json', JSON.stringify({ build: lock.expected.clientDataWowVersion, engineCommit: lock.upstream.commit, sources: [spellMiscUrl, manifestUrl], names: iconNames, spells: spellIcons }));
// A name several spells share resolves when one icon is on a strict majority of those that have
// an icon, to the lowest id carrying it (Hunter's Mark: the ability and its variants, not the debuff).
function nameTarget(ids) {
  if (ids.length === 1) return ids[0];
  const counts = new Map();
  for (const id of ids) { const icon = icons.get(id); if (icon) counts.set(icon, (counts.get(icon) ?? 0) + 1); }
  const withIcon = ids.filter(id => icons.has(id)).length;
  const [icon, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  return n * 2 > withIcon ? Math.min(...ids.filter(id => icons.get(id) === icon)) : undefined;
}
const names = Object.fromEntries([...grouped].flatMap(([key, ids]) => { const id = nameTarget(ids); return id === undefined ? [] : [[key, id]]; }));
const byId = new Map(spells.map(spell => [spell.id, spell.name]));
const consumableSource = readFileSync(root + 'player/consumable.cpp', 'utf8');
const augmentation = [...consumableSource.matchAll(/str_in_str_ci\( consumable_name, "([^"]+)"\s*\) \) return player->find_spell\( (\d+) \)/g)].map(match => ({ value: match[1], label: byId.get(Number(match[2])) ?? match[1].replaceAll('_', ' '), spellId: Number(match[2]) })).reverse();
const temporary = parseInc(readFileSync(root + 'dbc/generated/temporary_enchant.inc', 'utf8')).get('__temporary_enchant_data');
if (!temporary?.length || !augmentation.length) throw Error('Consumable extraction failed');
const weapon = temporary.map(([, rank, spellId, token]) => ({ value: token + (rank ? '_' + rank : ''), label: (byId.get(spellId) ?? token.replaceAll('_', ' ')) + (rank ? ' · Quality ' + rank : ''), spellId })).reverse();
writeFileSync('public/presentation.json', JSON.stringify({ engineCommit: lock.upstream.commit, names, augmentation, weapon }));
console.log(spells.length, 'spells;', Object.keys(names).length, 'unambiguous names;', augmentation.length, 'runes;', weapon.length, 'weapon enchants');
