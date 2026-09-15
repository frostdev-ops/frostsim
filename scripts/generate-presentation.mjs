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
if (!existsSync(miscPath)) {
  mkdirSync(miscPath.slice(0, miscPath.lastIndexOf('/')), { recursive: true });
  const response = await fetch('https://wago.tools/db2/SpellMisc/csv?build=' + lock.expected.clientDataWowVersion);
  if (!response.ok) throw Error('Spell icon data unavailable');
  writeFileSync(miscPath, await response.text());
}
const misc = parseCsv(readFileSync(miscPath, 'utf8'));
const spellColumn = misc.header.indexOf('SpellID'), iconColumn = misc.header.indexOf('SpellIconFileDataID');
if (spellColumn < 0 || iconColumn < 0) throw Error('SpellMisc schema changed');
const icons = new Map(misc.rows.filter(row => Number(row[iconColumn]) > 0).map(row => [Number(row[spellColumn]), Number(row[iconColumn])]));
const representatives = new Map();
for (const [id, icon] of icons) representatives.set(icon, Math.min(id, representatives.get(icon) ?? Infinity));
const aliases = Object.fromEntries(spells.flatMap(spell => { const target = representatives.get(icons.get(spell.id)); return target && target !== spell.id ? [[spell.id, target]] : []; }));
mkdirSync('src/lib/battlenet/generated', { recursive: true });
writeFileSync('src/lib/battlenet/generated/spell-icon-aliases.json', JSON.stringify({ build: lock.expected.clientDataWowVersion, engineCommit: lock.upstream.commit, source: 'https://wago.tools/db2/SpellMisc/csv?build=' + lock.expected.clientDataWowVersion, aliases }));
const names = Object.fromEntries([...grouped].filter(([, ids]) => ids.length === 1 || (icons.has(ids[0]) && ids.every(id => icons.get(id) === icons.get(ids[0])))).map(([key, ids]) => [key, ids[0]]));
const byId = new Map(spells.map(spell => [spell.id, spell.name]));
const consumableSource = readFileSync(root + 'player/consumable.cpp', 'utf8');
const augmentation = [...consumableSource.matchAll(/str_in_str_ci\( consumable_name, "([^"]+)"\s*\) \) return player->find_spell\( (\d+) \)/g)].map(match => ({ value: match[1], label: byId.get(Number(match[2])) ?? match[1].replaceAll('_', ' '), spellId: Number(match[2]) })).reverse();
const temporary = parseInc(readFileSync(root + 'dbc/generated/temporary_enchant.inc', 'utf8')).get('__temporary_enchant_data');
if (!temporary?.length || !augmentation.length) throw Error('Consumable extraction failed');
const weapon = temporary.map(([, rank, spellId, token]) => ({ value: token + (rank ? '_' + rank : ''), label: (byId.get(spellId) ?? token.replaceAll('_', ' ')) + (rank ? ' · Quality ' + rank : ''), spellId })).reverse();
writeFileSync('public/presentation.json', JSON.stringify({ engineCommit: lock.upstream.commit, names, augmentation, weapon }));
console.log(spells.length, 'spells;', Object.keys(names).length, 'unambiguous names;', augmentation.length, 'runes;', weapon.length, 'weapon enchants');
