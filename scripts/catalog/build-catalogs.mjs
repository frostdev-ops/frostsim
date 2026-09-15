#!/usr/bin/env node
// Generates versioned game-data catalogs (P05) from pinned SimulationCraft; traces to vendor/simc/engine/dbc/generated/*.inc, nothing hand-typed; PTR never read (SC_USE_PTR=0).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

import { parseInc, tokenize } from './inc.mjs';
import { structFields, mapRows } from './structs.mjs';
import * as blizzardJournal from './sources/blizzard-journal.mjs';
import * as localDb2 from './sources/db2-loot.mjs';
import { mergeLootCatalogs, unknownItems, validateLootCatalog } from './sources/loot-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DBC = join(ROOT, 'vendor/simc/engine/dbc');
const GEN = join(DBC, 'generated');

export const CATALOG_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Engine identity
// ---------------------------------------------------------------------------

/** Reads the same fields the engine manifest reports, from the same source files. */
export function engineIdentity() {
  const v = readFileSync(join(GEN, 'client_data_version.inc'), 'utf8');
  const pick = (re, label) => {
    const m = re.exec(v);
    if (!m) throw new Error(`client_data_version.inc: could not read ${label}`);
    return m[1];
  };
  const cfg = readFileSync(join(ROOT, 'vendor/simc/engine/config.hpp'), 'utf8');
  const major = /#define\s+SC_MAJOR_VERSION\s+"([^"]+)"/.exec(cfg);
  const minor = /#define\s+SC_MINOR_VERSION\s+"([^"]+)"/.exec(cfg);
  let upstreamCommit = null;
  const lock = join(ROOT, 'engine.lock.json');
  if (existsSync(lock)) upstreamCommit = JSON.parse(readFileSync(lock, 'utf8')).upstream?.commit ?? null;

  return {
    simcVersion: major && minor ? `${major[1]}-${minor[1]}` : null,
    upstreamCommit,
    clientDataVersion: pick(/#define\s+CLIENT_DATA_WOW_VERSION\s+"([^"]+)"/, 'CLIENT_DATA_WOW_VERSION'),
    simcWowVersion: pick(/#define\s+SIMC_WOW_VERSION\s+"([^"]+)"/, 'SIMC_WOW_VERSION'),
    hotfixDate: pick(/#define\s+CLIENT_DATA_HOTFIX_DATE\s+"([^"]+)"/, 'CLIENT_DATA_HOTFIX_DATE'),
    hotfixBuild: Number(pick(/#define\s+CLIENT_DATA_HOTFIX_BUILD\s+\((\d+)\)/, 'CLIENT_DATA_HOTFIX_BUILD')),
    hotfixHash: pick(/#define\s+CLIENT_DATA_HOTFIX_HASH\s+"([^"]+)"/, 'CLIENT_DATA_HOTFIX_HASH'),
    ptr: false,
  };
}

/**
 * Catalog identity. WoW version alone is not enough: hotfixes move under a fixed
 * client build, and a different engine revision can read the same tables differently.
 */
export function catalogId(engine) {
  const commit = engine.upstreamCommit ? engine.upstreamCommit.slice(0, 7) : 'unknown';
  return `${engine.clientDataVersion}-${engine.hotfixHash.slice(0, 12)}-${commit}`;
}

// ---------------------------------------------------------------------------
// Table readers
// ---------------------------------------------------------------------------

const cache = new Map();
/** @param {string} file .inc basename */
function inc(file) {
  if (!cache.has(file)) cache.set(file, parseInc(readFileSync(join(GEN, file), 'utf8')));
  return cache.get(file);
}

/** @param {string} file .inc basename @param {string} decl __array name */
function rows(file, decl) {
  const t = inc(file).get(decl);
  if (!t) throw new Error(`${file}: declaration ${decl} not found`);
  return t;
}

function table(file, decl, header, struct, dims) {
  return mapRows(rows(file, decl), structFields(join(DBC, header), struct, dims), struct);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

// Slots player can equip and sim models; INVTYPE_BAG/AMMO/QUIVER/RELIC excluded.
const EQUIPPABLE_INVTYPE = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 26]);
const ITEM_CLASS_CONSUMABLE = 0;
const ITEM_CLASS_WEAPON = 2;
const ITEM_CLASS_GEM = 3;
const ITEM_CLASS_ARMOR = 4;
const CONSUMABLE_SUBCLASSES = new Set([1, 2, 3, 5]); // potion, elixir, flask, food

function readItems() {
  const stats = rows('item_data.inc', '__item_stats_data');
  const fields = structFields(join(DBC, 'item_data.hpp'), 'dbc_item_data_t', {
    MAX_ITEM_EFFECT: 5, MAX_ITEM_STAT: 10, MAX_ITEM_SOCKET_SLOT: 3,
  });
  const out = [];
  for (let c = 0; ; c++) {
    const decl = `__item_data_chunk${c}`;
    if (!inc('item_data.inc').has(decl)) break;
    for (const row of rows('item_data.inc', decl)) {
      const it = mapRows([row], fields, 'dbc_item_data_t')[0];
      if (!it.name || it.id === 0) continue;
      const isGear = EQUIPPABLE_INVTYPE.has(it.inventory_type) &&
        (it.item_class === ITEM_CLASS_WEAPON || it.item_class === ITEM_CLASS_ARMOR) && it.quality >= 2;
      const isConsumable = it.item_class === ITEM_CLASS_CONSUMABLE && CONSUMABLE_SUBCLASSES.has(it.item_subclass);
      const isGem = it.item_class === ITEM_CLASS_GEM;
      if (!isGear && !isConsumable && !isGem) continue;
      const s = [];
      if (it._dbc_stats) {
        for (let i = 0; i < it._dbc_stats_count; i++) {
          const r = stats[it._dbc_stats.index + i];
          s.push(r[0], r[1], r[2]);
        }
      }
      out.push({ ...it, _stats: s });
    }
  }
  return out;
}

/** Columnar layout: ~3x smaller than row objects, parses in one pass. */
function columnarItems(items) {
  const col = {
    count: items.length,
    id: [], name: [], level: [], reqLevel: [], quality: [], invType: [], itemClass: [], itemSubclass: [],
    bindType: [], delay: [], dmgRange: [], classMask: [], raceMask: [], socketColor: [], gemProperties: [],
    socketBonusId: [], setId: [], curveId: [], craftingQuality: [], flags1: [], flags2: [], typeFlags: [],
    stats: [],
  };
  for (const it of items) {
    col.id.push(it.id);
    col.name.push(it.name);
    col.level.push(it.level);
    col.reqLevel.push(it.req_level);
    col.quality.push(it.quality);
    col.invType.push(it.inventory_type);
    col.itemClass.push(it.item_class);
    col.itemSubclass.push(it.item_subclass);
    col.bindType.push(it.bind_type);
    col.delay.push(it.delay);
    col.dmgRange.push(it.dmg_range);
    col.classMask.push(it.class_mask);
    col.raceMask.push(typeof it.race_mask === 'string' ? it.race_mask : it.race_mask);
    col.socketColor.push(it.socket_color.some(Boolean) ? it.socket_color : 0);
    col.gemProperties.push(it.gem_properties);
    col.socketBonusId.push(it.id_socket_bonus);
    col.setId.push(it.id_set);
    col.curveId.push(it.id_curve);
    col.craftingQuality.push(it.crafting_quality);
    col.flags1.push(it.flags_1);
    col.flags2.push(it.flags_2);
    col.typeFlags.push(it.type_flags);
    col.stats.push(it._stats.length ? it._stats : 0);
  }
  return col;
}

// ---------------------------------------------------------------------------
// Scaling tables (item level curves + stat budget)
// ---------------------------------------------------------------------------

const SQUISH_CURVE_MIDNIGHT = (() => {
  const src = readFileSync(join(ROOT, 'vendor/simc/engine/sc_enums.hpp'), 'utf8');
  const m = /SQUISH_CURVE_MIDNIGHT\s*=\s*(\d+)u?/.exec(src);
  if (!m) throw new Error('sc_enums.hpp: SQUISH_CURVE_MIDNIGHT not found');
  return Number(m[1]);
})();

/** Only curves an item bonus can actually reach are shipped; the full table is 171k points. */
function readScaling(bonusEntries) {
  const scalingConfigs = table('item_scaling.inc', '__item_scaling_config_data', 'item_scaling.hpp', 'item_scaling_config_data_t');
  const offsetCurves = table('item_scaling.inc', '__item_offset_curve_data', 'item_scaling.hpp', 'item_offset_curve_data_t');
  const allPoints = table('item_scaling.inc', '__curve_point_data', 'item_scaling.hpp', 'curve_point_t');

  const wanted = new Set([SQUISH_CURVE_MIDNIGHT]);
  for (const e of offsetCurves) wanted.add(e.curve_id);
  for (const e of bonusEntries) {
    if (e.type === 48) wanted.add(e.value_1);            // ITEM_BONUS_SQUISH_CURVE
    if (e.type === 11 || e.type === 13) wanted.add(e.value_4); // ITEM_BONUS_SCALING / _2
  }

  /** @type {Record<number, number[]>} curveId -> flat [primary1, primary2, ...] sorted by primary1 */
  const curves = {};
  for (const p of allPoints) {
    if (!wanted.has(p.curve_id)) continue;
    (curves[p.curve_id] ??= []).push([p.primary1, p.primary2]);
  }
  for (const id of Object.keys(curves)) {
    curves[id].sort((a, b) => a[0] - b[0]);
    curves[id] = curves[id].flat();
  }
  // Stat budget per item level, indexed by ilvl - 1 in source arrays.

  const randProp = table('rand_prop_points.inc', '__rand_prop_points_data', 'rand_prop_points.hpp', 'random_prop_data_t');
  const socketCost = rows('sc_scale_data.inc', '__item_socket_cost_per_level').map((r) => r[0]);
  const crMult = rows('sc_scale_data.inc', '__combat_ratings_mult_by_ilvl');
  const stamMult = rows('sc_scale_data.inc', '__stamina_mult_by_ilvl');

  return {
    squishCurveMidnight: SQUISH_CURVE_MIDNIGHT,
    curves,
    scalingConfigs: scalingConfigs.map((s) => [s.id, s.item_offset_curve_id, s.item_level, s.player_level, s.squish_era_id]),
    offsetCurves: offsetCurves.map((o) => [o.id, o.curve_id, o.offset]),
    // Stat budget per item level, indexed by ilvl - 1 in the source arrays.
    randProp: randProp.map((r) => [r.ilevel, r.p_epic, r.p_rare, r.p_uncommon]),
    socketCostPerLevel: socketCost,
    combatRatingMultByIlvl: crMult,
    staminaMultByIlvl: stamMult,
  };
}

// ---------------------------------------------------------------------------
// Bonus ids, enchants, gems, sets, embellishments, talents
// ---------------------------------------------------------------------------

function readBonuses() {
  const entries = table('item_bonus.inc', '__item_bonus_data', 'item_bonus.hpp', 'item_bonus_entry_t');
  /** @type {Record<number, number[][]>} bonusId -> [type, v1, v2, v3, v4, index][] */
  const byBonusId = {};
  for (const e of entries) {
    (byBonusId[e.bonus_id] ??= []).push([e.type, e.value_1, e.value_2, e.value_3, e.value_4, e.index]);
  }
  for (const k of Object.keys(byBonusId)) byBonusId[k].sort((a, b) => a[5] - b[5]);
  return { entries, byBonusId };
}

function readNameDescriptions() {
  const t = table('item_naming.inc', '__item_name_description_data', 'item_naming.hpp', 'item_name_description_t');
  return Object.fromEntries(t.map((r) => [r.id, r.description]));
}

function readEnchants() {
  const ench = table('spell_item_enchantment.inc', '__spell_item_ench_data', 'spell_item_enchantment.hpp', 'item_enchantment_data_t');
  const perm = table('permanent_enchant.inc', '__permanent_enchant_data', 'permanent_enchant.hpp', 'permanent_enchant_entry_t');
  const temp = table('temporary_enchant.inc', '__temporary_enchant_data', 'temporary_enchant.hpp', 'temporary_enchant_entry_t');
  const byId = new Map(ench.map((e) => [e.id, e]));

  // A permanent enchant is offered for a slot when the item's inventory type and
  // subclass pass the masks upstream stores alongside the tokenized option name.
  const permanent = perm.map((p) => {
    const e = byId.get(p.enchant_id);
    return {
      enchantId: p.enchant_id,
      rank: p.rank,
      name: e?.name ?? null,
      option: p.tokenized_name,
      itemClass: p.item_class,
      invTypeMask: p.mask_inventory_type,
      subclassMask: p.mask_item_subclass,
      effects: e ? enchantEffects(e) : [],
    };
  });

  const temporary = temp.map((t) => {
    const e = byId.get(t.enchant_id);
    return {
      enchantId: t.enchant_id,
      rank: t.rank,
      spellId: t.spell_id,
      name: e?.name ?? null,
      option: t.tokenized_name,
      effects: e ? enchantEffects(e) : [],
    };
  });

  return { permanent, temporary, enchantments: ench.map(compactEnchantment) };
}

const ITEM_ENCHANTMENT_RESISTANCE = 4;
const ITEM_ENCHANTMENT_STAT = 5;

/** Mirrors item_database::item_enchantment_effect_stats for the flat (non-spell) case. */
function enchantEffects(e) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    if (e.ench_type[i] === ITEM_ENCHANTMENT_STAT) out.push({ statType: e.ench_prop[i], amount: e.ench_amount[i], coeff: e.ench_coeff[i] });
    else if (e.ench_type[i] === ITEM_ENCHANTMENT_RESISTANCE) out.push({ statType: 'bonus_armor', amount: e.ench_amount[i], coeff: e.ench_coeff[i] });
  }
  return out;
}

function compactEnchantment(e) {
  return {
    id: e.id, name: e.name, gemId: e.id_gem, spellId: e.id_spell,
    scalingId: e.id_scaling, minScalingLevel: e.min_scaling_level, maxScalingLevel: e.max_scaling_level,
    minIlevel: e.min_ilevel, maxIlevel: e.max_ilevel,
    type: e.ench_type, amount: e.ench_amount, prop: e.ench_prop, coeff: e.ench_coeff,
  };
}

function readGems() {
  return table('gem_data.inc', '__gem_property_data', 'gem_data.hpp', 'gem_property_data_t')
    .map((g) => ({ id: g.id, enchantId: g.enchant_id, color: g.color, descId: g.desc_id }));
}

function readSets() {
  return table('item_set_bonus.inc', '__set_bonus_data', 'item_set_bonus.hpp', 'item_set_bonus_t', { SET_BONUS_ITEM_ID_MAX: 17 })
    .map((s) => ({
      name: s.set_name, option: s.set_opt_name, tier: s.tier, enumId: s.enum_id, setId: s.set_id,
      pieces: s.bonus, classId: s.class_id, specId: s.spec, traitSubTree: s.trait_sub_tree,
      spellId: s.spell_id, itemIds: s.item_ids.filter(Boolean),
    }));
}

function readEmbellishments() {
  return table('embellishment_data.inc', '__embellishment_data', 'embellishment_data.hpp', 'embellishment_data_t')
    .map((e) => ({ name: e.name, option: tokenize(e.name), bonusId: e.bonus_id, effectId: e.effect_id, spellId: e.spell_id }));
}

/** Specializations: id, class, display name; three sources no hand-typed names; token with no case falls back to suffix. */
function readSpecs() {
  const enumSrc = readFileSync(join(GEN, 'sc_specialization_data.inc'), 'utf8');
  const idByToken = new Map();
  for (const m of enumSrc.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*,/gm)) {
    idByToken.set(m[1], Number(m[2]));
  }

  const util = readFileSync(join(ROOT, 'vendor/simc/engine/util/util.cpp'), 'utf8');
  const nameByToken = new Map();
  for (const m of util.matchAll(/case\s+([A-Z][A-Z0-9_]*)\s*:\s*return\s+"([^"]*)"\s*;/g)) {
    if (!nameByToken.has(m[1])) nameByToken.set(m[1], m[2]);
  }

  // __class_spec_id[class][spec]: outer index is class id, 0 is pets.
  const listSrc = readFileSync(join(GEN, 'sc_spec_list.inc'), 'utf8');
  const table = /__class_spec_id\s*\[[^\]]*\]\s*\[[^\]]*\]\s*=\s*\{([\s\S]*?)\n\};/.exec(listSrc);
  if (!table) throw new Error('sc_spec_list.inc: could not find __class_spec_id');

  const byClass = {};
  let classId = 0;
  for (const group of table[1].matchAll(/\{([^{}]*)\}/g)) {
    const tokens = group[1].split(',').map((t) => t.trim()).filter(Boolean);
    const specs = [];
    for (const token of tokens) {
      if (token === 'SPEC_NONE') continue;
      const id = idByToken.get(token);
      if (id === undefined) continue;
      const named = nameByToken.get(token);
      // Fallback: suffix of token title-cased, marked so consumer can distinguish from engine name.
      specs.push({
        id,
        token,
        name: named ?? titleCase(token.slice(token.indexOf('_') + 1).replace(/_/g, ' ')),
        nameFromEngine: named !== undefined,
      });
    }
    if (specs.length) byClass[classId] = specs;
    classId++;
  }
  return byClass;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function readTalents() {
  const traits = table('trait_data.inc', '__trait_data_data', 'trait_data.hpp', 'trait_data_t');
  const subTrees = rows('trait_data.inc', '__trait_sub_tree_data')
    .map(([id, name, classId]) => ({ id, name, classId }));

  /** @type {Record<number, any>} classId -> tree */
  const byClass = {};
  for (const t of traits) {
    const tree = (byClass[t.id_class] ??= { classId: t.id_class, nodes: [], subTrees: [] });
    tree.nodes.push({
      treeIndex: t.tree_index,
      entryId: t.id_trait_node_entry,
      nodeId: t.id_node,
      maxRanks: t.max_ranks,
      reqPoints: t.req_points,
      definitionId: t.id_trait_definition,
      spellId: t.id_spell,
      replacesSpellId: t.id_replace_spell,
      overriddenBySpellId: t.id_override_spell,
      row: t.row,
      col: t.col,
      selectionIndex: t.selection_index,
      name: t.name,
      specIds: t.id_spec.filter(Boolean),
      starterSpecIds: t.id_spec_starter.filter(Boolean),
      subTreeId: t.id_sub_tree,
      nodeType: t.node_type,
    });
  }
  for (const st of subTrees) {
    const tree = byClass[st.classId];
    if (tree) tree.subTrees.push({ id: st.id, name: st.name });
  }
  return byClass;
}

function readConsumables(items) {
  // simc resolves flask=/potion=/food= by tokenized item name plus crafting quality (engine/player/consumable.cpp); exact tokens keep round trip honest.
  const KIND = { 1: 'potion', 2: 'elixir', 3: 'flask', 5: 'food' };
  return items
    .filter((i) => i.item_class === ITEM_CLASS_CONSUMABLE && KIND[i.item_subclass])
    .map((i) => ({
      itemId: i.id,
      name: i.name,
      kind: KIND[i.item_subclass],
      option: tokenize(i.name) + (i.crafting_quality > 0 ? `_${i.crafting_quality}` : ''),
      craftingQuality: i.crafting_quality,
      level: i.level,
      reqLevel: i.req_level,
    }));
}

// ---------------------------------------------------------------------------
// Coverage matrix (P05.1 / P05.2)
// ---------------------------------------------------------------------------

/** Every catalog field with authoritative source and status; unavailable entries are real gaps so feature stays off. Loot sources are optional and off by default. */
async function collectLoot(log, knownItemIds) {
  const parts = [];
  const attempted = [];

  // Local dev credentials if present, read here never printed; production gets from CI secrets.
  let env = process.env;
  try {
    const { loadDevVars } = await import('../battlenet/dev-vars.mjs');
    const devVars = loadDevVars();
    for (const warning of devVars.warnings) log?.(`dev-vars: ${warning}`);
    if (devVars.present) {
      env = { ...process.env };
      for (const name of devVars.names) env[name] ??= devVars.get(name);
      log?.(`dev-vars: loaded ${devVars.names.length} variable name(s) from ${devVars.path}`);
    }
  } catch {
    // Normal in CI: no loader or local secrets file.
  }

  const db2Config = localDb2.configFromEnv(env);
  if (db2Config) {
    attempted.push(localDb2.PROVIDER);
    parts.push(localDb2.loadLootCatalog({ config: db2Config }));
  }

  const blizzardConfig = blizzardJournal.configFromEnv(env);
  if (blizzardConfig) {
    attempted.push(blizzardJournal.PROVIDER);
    const limit = Number(env.BLIZZARD_JOURNAL_LIMIT) || undefined;
    parts.push(await blizzardJournal.fetchLootCatalog({ config: blizzardConfig, log, limit, knownItemIds }));
  }

  if (parts.length === 0) return { catalog: null, attempted };
  return { catalog: mergeLootCatalogs(parts.filter(Boolean)), attempted };
}

function coverage(counts, loot) {
  const SIMC = 'vendor/simc/engine/dbc/generated (upstream DB2 export)';

  // Loot membership verified only when adapter produced sources; "configured" != "covered".
  const lootEntry = loot?.sources?.length
    ? {
        field: 'loot source membership (which boss/dungeon drops an item)',
        status: 'partial',
        source: loot.provenance.map((p) => p.description).join(' | '),
        count: loot.sources.length,
        notes:
          'Supplied by a configured loot adapter, not by the engine source. ' +
          loot.provenance.flatMap((p) => p.limitations).join(' ') +
          (loot.expiresAt ? ` This data must not be used after ${loot.expiresAt}.` : ''),
      }
    : {
        field: 'loot source membership (which boss/dungeon drops an item)',
        status: 'unavailable',
        source: 'not present in the engine source, and no loot adapter is configured',
        notes:
          'JournalEncounterItem.db2 appears only in dbc_extract3/formats/*.json as a schema; no extracted rows ship ' +
          'with simc, and no .db2 files exist in the checkout. Configure FROSTSIM_DB2_DIR for a local export, or ' +
          'BLIZZARD_CLIENT_ID/BLIZZARD_CLIENT_SECRET for the Blizzard Game Data API journal, to supply it. Until ' +
          'then Droptimizer source browsing stays disabled. Do not infer membership from item id ranges or profile gear.',
      };

  return [
    { field: 'item identity and base stats', status: 'verified', source: `${SIMC}/item_data.inc`, count: counts.items },
    { field: 'item bonus ids (ilevel, stats, sockets, quality, crafting)', status: 'verified', source: `${SIMC}/item_bonus.inc`, count: counts.bonusIds },
    { field: 'item level scaling curves', status: 'verified', source: `${SIMC}/item_scaling.inc, rand_prop_points.inc, sc_scale_data.inc` },
    { field: 'item name descriptors (track labels)', status: 'verified', source: `${SIMC}/item_naming.inc`, count: counts.nameDescriptions,
      notes: 'Reached through ITEM_BONUS_DESC entries. Gives the label ("Champion Equipment"), not a track/step model.' },
    { field: 'equip restrictions (class, race, slot, subclass)', status: 'verified', source: `${SIMC}/item_data.inc class_mask/race_mask/inventory_type` },
    { field: 'sockets and gems', status: 'verified', source: `${SIMC}/item_data.inc socket_color, gem_data.inc, spell_item_enchantment.inc` },
    { field: 'permanent enchants', status: 'verified', source: `${SIMC}/permanent_enchant.inc`, count: counts.permanentEnchants },
    { field: 'temporary enchants (weapon oils/stones)', status: 'verified', source: `${SIMC}/temporary_enchant.inc`, count: counts.temporaryEnchants },
    { field: 'consumables (flask, potion, food, elixir)', status: 'verified', source: `${SIMC}/item_data.inc item_class=0`, count: counts.consumables,
      notes: 'Option token is util::tokenize of the item name; simc matches on that plus crafting quality.' },
    { field: 'embellishments', status: 'verified', source: `${SIMC}/embellishment_data.inc`, count: counts.embellishments },
    { field: 'set membership and set bonuses', status: 'verified', source: `${SIMC}/item_set_bonus.inc`, count: counts.sets },
    // Corrected: trait_data has no prerequisite edges, simc ships no trait edge table, graph connecting talents NOT in catalog.
    { field: 'talent tree structure (nodes, ranks, hero trees)', status: 'verified', source: `${SIMC}/trait_data.inc`, count: counts.traitNodes,
      notes: 'Nodes, entries, ranks, req_points, row/col positions and hero sub-trees. Prerequisite EDGES are not included; see below.' },
    { field: 'talent prerequisite edges', status: 'unavailable', source: 'none',
      notes: 'trait_data_t has row, col and req_points but no parent link, and simc ships no trait edge table. Loadout validity is checked for ranks, spec, req_points and hero tree only; connectivity is not checked.' },
    { field: 'talent point budgets (how many points a character has)', status: 'unavailable', source: 'none',
      notes: 'A level- and patch-dependent game rule, in no DB2 table simc exports. Enforced only against a caller-supplied budget.' },
    { field: 'specializations (id, class, name)', status: 'verified', source: `${SIMC}/sc_specialization_data.inc + sc_spec_list.inc + util/util.cpp`, count: counts.specs },
    { field: 'embellishment slot applicability and per-character cap', status: 'unavailable', source: 'none',
      notes: 'embellishment_data.inc carries name, bonus id, effect id and spell id only. Which slots accept one, and how many may be worn, are not in the engine data.' },

    lootEntry,
    { field: 'drop probabilities and eligible denominators', status: 'unavailable', source: 'none',
      notes: 'Requires loot tables plus per-difficulty drop rates. Droptimizer shows deterministic hypothetical gains only (P09.8).' },
    { field: 'Great Vault reward levels', status: 'unavailable', source: 'none',
      notes: 'Reward-level to item-level mapping is not in the engine data. Vault scenarios need the user to supply an item level.' },
    { field: 'upgrade currency costs and discounts', status: 'partial', source: 'scripts/catalog/generate-upgrade-costs.mjs: engine-pinned ItemBonusListGroupEntry, ItemExtendedCost and CurrencyTypes DB2s, plus the Raider.IO season start',
      notes: 'Per-rank-step crest counts and the gold portion are generated and verified for the current season (src/lib/catalog/upgradeCosts.ts). The weekly crest cap is NOT in DB2 - MaxEarnablePerWeek and the recharging fields are zero and the cap lives in a world state - so it stays a caller-supplied override, as does mid-season cap removal. Slot high-watermark discounts are computed from the addon export, whose slot-index-to-gear-slot mapping is unverified.' },
    { field: 'Catalyst conversion mapping', status: 'unavailable', source: 'none',
      notes: 'Slot-to-tier-item mapping is not in the engine data. Catalyst candidates are only generated from an explicit user-supplied target item id.' },
    { field: 'item upgrade track steps (e.g. Champion 3/8)', status: 'partial', source: 'scripts/catalog/generate-upgrades.mjs: engine-pinned ItemBonusListGroupEntry, ItemBonus and ItemScalingConfig DB2s',
      notes: 'The matching generated upgrade module identifies Midnight Season 1 and 2 Adventurer through Myth tracks by bonus identity, with ordinary ranks and restricted imported drops. Other groups remain unknown. Custom item levels and explicitly chosen hypothetical tracks are supported; unlock eligibility is not inferred. Currency costs for these tracks come from the separate upgrade-costs table. Regenerate upgrades after changing the engine pin.' },
    { field: 'item icons', status: 'unavailable', source: 'none',
      notes: 'No icon ids in the engine data. UI falls back to slot/quality indicators; icons are never a simulation dependency (P05.10).' },
    { field: 'crafting reagent requirements and profession restrictions', status: 'unavailable', source: 'none',
      notes: 'Crafted item stats and quality are supported (crafted_stats/crafting_quality); the resource cost of crafting is not.' },
  ];
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main(argv) {
  const pretty = argv.includes('--pretty');
  const outIdx = argv.indexOf('--out');
  const engine = engineIdentity();
  const id = catalogId(engine);
  const outDir = outIdx >= 0 ? resolve(argv[outIdx + 1]) : join(ROOT, 'public/catalogs', id);

  const started = Date.now();
  const items = readItems();
  const bonuses = readBonuses();
  const scaling = readScaling(bonuses.entries);
  const enchants = readEnchants();
  const files = [];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'talents'), { recursive: true });

  const emit = (name, data) => {
    const json = JSON.stringify(data, null, pretty ? 2 : undefined);
    const buf = Buffer.from(json);
    writeFileSync(join(outDir, name), buf);
    files.push({
      path: name,
      bytes: buf.length,
      brotliBytes: brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }).length,
      sha256: sha256(buf),
    });
  };

  emit('items.json', columnarItems(items));
  emit('item-bonus.json', { byBonusId: bonuses.byBonusId, nameDescriptions: readNameDescriptions() });
  emit('scaling.json', scaling);
  emit('enchants.json', enchants);
  emit('gems.json', { properties: readGems() });
  emit('sets.json', { sets: readSets() });
  emit('embellishments.json', { embellishments: readEmbellishments() });
  emit('consumables.json', { consumables: readConsumables(items) });

  const talents = readTalents();
  const specs = readSpecs();
  emit('specs.json', { specs });
  for (const [classId, tree] of Object.entries(talents)) emit(`talents/class-${classId}.json`, tree);

  const { catalog: loot, attempted } = await collectLoot((m) => process.stdout.write(`  ${m}\n`), new Set(items.map((item) => item.id)));
  const lootWarnings = [];
  if (loot) {
    const problems = validateLootCatalog(loot);
    if (problems.length) {
      // Malformed loot catalog dropped not shipped: wrong loot table produces confidently wrong upgrade advice.
      lootWarnings.push(...problems.map((p) => `loot catalog rejected: ${p}`));
    } else {
      const known = new Set(items.map((i) => i.id));
      const missing = unknownItems(loot, known);
      if (missing.length) {
        loot.warnings.push(
          `${missing.length} loot items are not in the item catalog and will be shown as unresolved`,
        );
      }
      emit('loot.json', loot);
    }
  }

  const counts = {
    items: items.length,
    gear: items.filter((i) => i.item_class === ITEM_CLASS_WEAPON || i.item_class === ITEM_CLASS_ARMOR).length,
    gems: items.filter((i) => i.item_class === ITEM_CLASS_GEM).length,
    bonusIds: Object.keys(bonuses.byBonusId).length,
    nameDescriptions: Object.keys(readNameDescriptions()).length,
    permanentEnchants: enchants.permanent.length,
    temporaryEnchants: enchants.temporary.length,
    consumables: readConsumables(items).length,
    embellishments: readEmbellishments().length,
    sets: readSets().length,
    traitNodes: Object.values(talents).reduce((n, t) => n + t.nodes.length, 0),
    specs: Object.values(specs).reduce((n, list) => n + list.length, 0),
    talentClasses: Object.keys(talents).length,
    curves: Object.keys(scaling.curves).length,
  };

  const manifest = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    catalogId: id,
    generatedAt: new Date().toISOString(),
    generator: { script: 'scripts/catalog/build-catalogs.mjs', node: process.version, elapsedMs: Date.now() - started },
    engine,
    counts,
    files,
    totals: {
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      brotliBytes: files.reduce((n, f) => n + f.brotliBytes, 0),
      fileCount: files.length,
    },
    loot: loot && files.some((f) => f.path === 'loot.json')
      ? { path: 'loot.json', expiresAt: loot.expiresAt, sources: loot.sources.length, providers: loot.provenance.map((p) => p.provider) }
      : null,
    lootAdaptersAttempted: attempted,
    warnings: lootWarnings,
    coverage: coverage(counts, files.some((f) => f.path === 'loot.json') ? loot : null),
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const w of lootWarnings) process.stderr.write(`warning: ${w}\n`);

  process.stdout.write(
    `catalog ${id}\n` +
    `  ${counts.items} items (${counts.gear} gear, ${counts.gems} gems, ${counts.consumables} consumables)\n` +
    `  ${counts.bonusIds} bonus ids, ${counts.traitNodes} trait nodes across ${counts.talentClasses} classes\n` +
    `  ${manifest.totals.fileCount + 1} files, ${(manifest.totals.bytes / 1e6).toFixed(1)} MB raw, ` +
    `${(manifest.totals.brotliBytes / 1e6).toFixed(2)} MB brotli\n` +
    `  -> ${outDir}\n`
  );
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2));
}

export { main, readItems, readBonuses, readScaling, readTalents, readConsumables, coverage };
