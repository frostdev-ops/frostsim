// Blizzard profile API (character summary, equipment, specializations) -> simc profile text in the /simc addon's shape, so
// parseAddonExport and everything after it treat an Armory lookup like a pasted export. Mirrors simc's own importer
// (vendor/simc/engine/interfaces/bcp_api.cpp parse_player, parse_talents, parse_items) and its id tables (util.cpp
// translate_class_id, translate_race_id, race_type_string).
// ponytail: no stats= override, unlike bcp_api: upgrade and catalyst variants copy an item's options, and a frozen stat line
// would make them look free. The API has no redirected_base_stats or content_tuning, so a catalyzed piece gets the tier
// item's own secondary split. The addon export stays the exact path; add stats= per item if armory results drift.

/** Blizzard class id -> simc class option key (util.cpp translate_class_id). */
export const CLASSES: Record<number, string> = {
  1: 'warrior', 2: 'paladin', 3: 'hunter', 4: 'rogue', 5: 'priest', 6: 'deathknight', 7: 'shaman',
  8: 'mage', 9: 'warlock', 10: 'monk', 11: 'druid', 12: 'demonhunter', 13: 'evoker',
}

/** Blizzard race id -> simc race token (util.cpp translate_race_id, then race_type_string). */
const RACES: Record<number, string> = {
  1: 'human', 2: 'orc', 3: 'dwarf', 4: 'night_elf', 5: 'undead', 6: 'tauren', 7: 'gnome', 8: 'troll', 9: 'goblin',
  10: 'blood_elf', 11: 'draenei', 12: 'dark_iron_dwarf', 14: 'maghar_orc', 22: 'worgen', 24: 'pandaren',
  25: 'pandaren_alliance', 26: 'pandaren_horde', 27: 'nightborne', 28: 'highmountain_tauren', 29: 'void_elf',
  30: 'lightforged_draenei', 31: 'zandalari_troll', 32: 'kul_tiran', 34: 'dark_iron_dwarf', 35: 'vulpera',
  36: 'maghar_orc', 37: 'mechagnome', 52: 'dracthyr_alliance', 70: 'dracthyr_horde', 84: 'earthen_horde',
  85: 'earthen_alliance', 86: 'haranir_alliance', 91: 'haranir_horde',
}

/** API slot type -> simc slot option (bcp_api translate_api_slot). */
const SLOTS: Record<string, string> = {
  HEAD: 'head', NECK: 'neck', SHOULDER: 'shoulder', SHIRT: 'shirt', CHEST: 'chest', WAIST: 'waist', LEGS: 'legs',
  FEET: 'feet', WRIST: 'wrist', HANDS: 'hands', FINGER_1: 'finger1', FINGER_2: 'finger2', TRINKET_1: 'trinket1',
  TRINKET_2: 'trinket2', BACK: 'back', MAIN_HAND: 'main_hand', OFF_HAND: 'off_hand', TABARD: 'tabard',
}

/** simc's MAX_GEM_SLOTS. */
const MAX_GEMS = 4

export class ArmoryError extends Error {}

export interface ArmoryResponses {
  region: string
  /** /profile/wow/character/{realm}/{name}, en_US. */
  summary: unknown
  /** .../equipment */
  equipment: unknown
  /** .../specializations */
  specializations: unknown
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const uint = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null)
const idOf = (v: unknown) => uint(obj(v).id)
const ids = (v: unknown) => arr(v).map(uint).filter((n): n is number => n !== null)

/** The active spec's active loadout code (bcp_api parse_talents), or null. */
function talents(specializations: unknown, specId: number | null): string | null {
  const spec = arr(obj(specializations).specializations).find((s) => idOf(obj(s).specialization) === specId)
  const active = arr(obj(spec).loadouts).find((l) => obj(l).is_active === true)
  const code = obj(active).talent_loadout_code
  return typeof code === 'string' && /^[A-Za-z0-9+/=]+$/.test(code) ? code : null
}

/** One equipped item as `slot=,id=...` (bcp_api parse_items), or null for a slot simc has no option for. */
function itemLine(entry: unknown): string | null {
  const e = obj(entry)
  const slot = SLOTS[String(obj(e.slot).type)]
  const id = idOf(e.item)
  if (!slot || !id) return null
  const parts = [`id=${id}`]
  let enchant: number | null = null
  let addon: number | null = null
  for (const ench of arr(e.enchantments)) {
    // enchantment_slot 0 PERMANENT, 7 ON_USE_SPELL; 6 BONUS_SOCKETS carries nothing simc reads.
    const kind = idOf(obj(ench).enchantment_slot)
    if (kind === 0) enchant = uint(obj(ench).enchantment_id)
    else if (kind === 7) addon = uint(obj(ench).enchantment_id)
  }
  if (enchant) parts.push(`enchant_id=${enchant}`)
  if (addon) parts.push(`addon_id=${addon}`)
  const gems = arr(e.sockets).slice(0, MAX_GEMS).map((s) => idOf(obj(s).item) ?? 0)
  while (gems.length && gems[gems.length - 1] === 0) gems.pop()
  if (gems.length) parts.push(`gem_id=${gems.join('/')}`)
  const bonus = ids(e.bonus_list)
  if (bonus.length) parts.push(`bonus_id=${bonus.join('/')}`)
  const crafted = arr(e.modified_crafting_stat).map(idOf).filter((n): n is number => n !== null)
  if (crafted.length) parts.push(`crafted_stats=${crafted.join('/')}`)
  const drop = uint(e.timewalker_level)
  if (drop) parts.push(`drop_level=${drop}`)
  return `${slot}=,${parts.join(',')}`
}

/** Profile text parseAddonExport reads; throws ArmoryError with a message for the user when the API answer is unusable. */
export function armoryProfile(r: ArmoryResponses, importedAt: Date): string {
  const s = obj(r.summary)
  const className = CLASSES[idOf(s.character_class) ?? -1]
  const name = typeof s.name === 'string' ? s.name.replace(/["\r\n]/g, '') : ''
  if (!className || !name) throw new ArmoryError('The Armory returned this character without a class or name.')
  const race = RACES[idOf(s.race) ?? -1]
  const realm = obj(s.realm)
  const server = typeof realm.slug === 'string' ? realm.slug.replace(/[^a-z0-9-]/g, '') : ''
  const specName = obj(s.active_spec).name
  const spec = typeof specName === 'string' ? specName.toLowerCase().replace(/[^a-z]+/g, '_') : ''
  const code = talents(r.specializations, idOf(s.active_spec))
  const level = uint(s.level)
  const items = arr(obj(r.equipment).equipped_items).map(itemLine).filter((l): l is string => l !== null)
  if (!items.length) throw new ArmoryError('The Armory shows no equipped items for this character.')

  const realmName = typeof realm.name === 'string' ? realm.name.replace(/[\r\n]/g, '') : server
  return [
    `# ${name} - ${spec} - ${importedAt.toISOString().slice(0, 10)}`,
    `# Imported from the Blizzard Armory (${r.region.toUpperCase()}, ${realmName}): equipped gear and active talents only.`,
    `${className}="${name}"`,
    ...(level ? [`level=${level}`] : []),
    ...(race ? [`race=${race}`] : []),
    `region=${r.region}`,
    ...(server ? [`server=${server}`] : []),
    ...(spec ? [`spec=${spec}`] : []),
    '',
    ...(code ? [`talents=${code}`, ''] : []),
    ...items,
    '',
  ].join('\n')
}
