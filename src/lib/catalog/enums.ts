// Engine enum values (transcribed from simc): format constants (how to read catalog, not game data).

import type { GearSlot } from './types';

export const INVTYPE = {
  NON_EQUIP: 0, HEAD: 1, NECK: 2, SHOULDERS: 3, BODY: 4, CHEST: 5, WAIST: 6, LEGS: 7,
  FEET: 8, WRISTS: 9, HANDS: 10, FINGER: 11, TRINKET: 12, WEAPON: 13, SHIELD: 14,
  RANGED: 15, CLOAK: 16, TWOHAND: 17, BAG: 18, TABARD: 19, ROBE: 20,
  WEAPONMAINHAND: 21, WEAPONOFFHAND: 22, HOLDABLE: 23, AMMO: 24, THROWN: 25, RANGEDRIGHT: 26,
} as const;

export const ITEM_CLASS = { CONSUMABLE: 0, CONTAINER: 1, WEAPON: 2, GEM: 3, ARMOR: 4 } as const;

export const SOCKET_COLOR = {
  NONE: 0x0, META: 0x1, RED: 0x2, YELLOW: 0x4, BLUE: 0x8,
  PRISMATIC: 0x2 | 0x4 | 0x8, COGWHEEL: 0x20,
} as const;

/** item_flag bits we act on: UNIQUE_EQUIPPED decides if two copies can wear. */
export const ITEM_FLAG = { UNIQUE_EQUIPPED: 0x00080000 } as const;

export const ITEM_BONUS = {
  ILEVEL: 1, MOD: 2, QUALITY: 3, DESC: 4, SUFFIX: 5, SOCKET: 6, REQ_LEVEL: 8,
  SCALING: 11, SCALING_2: 13, SET_ILEVEL: 14, ADD_RANK: 17, ADD_ITEM_EFFECT: 23,
  MOD_ITEM_STAT: 25, ILEVEL_IN_PVP: 36, SET_ILEVEL_2: 42, SQUISH_CURVE: 48,
  SCALE_CONFIG: 49, APPLY_BONUS: 50, SCALE_CONFIG_2: 51, CRAFTING_QUALITY: 52,
  POST_SQUISH_ITEM_LEVEL: 53,
} as const;

/** Bonus IDs that disable other item level adjustments (upstream: ITEM_BONUS_ILEVEL case). */
export const ILEVEL_OVERRIDE_BLOCKERS = new Set([7215, 7250]);

export const ITEM_MOD = {
  NONE: -1, MANA: 0, HEALTH: 1, AGILITY: 3, STRENGTH: 4, INTELLECT: 5, SPIRIT: 6,
  STAMINA: 7, CORRUPTION: 22, CORRUPTION_RESISTANCE: 23, BONUS_STAT_1: 24, BONUS_STAT_2: 25,
  CRIT_RATING: 32, HASTE_RATING: 36, ATTACK_POWER: 38, VERSATILITY_RATING: 40,
  SPELL_POWER: 45, MASTERY_RATING: 49, EXTRA_ARMOR: 50, SPEED_RATING: 61,
  LEECH_RATING: 62, AVOIDANCE_RATING: 63, INDESTRUCTIBLE: 64,
  // Combined primaries: resolve to character's spec (most current gear uses these).
  STRENGTH_AGILITY_INTELLECT: 71, STRENGTH_AGILITY: 72,
  AGILITY_INTELLECT: 73, STRENGTH_INTELLECT: 74,
} as const;

export const STAT_LABEL: Record<number, string> = {
  [ITEM_MOD.MANA]: 'Mana',
  [ITEM_MOD.HEALTH]: 'Health',
  [ITEM_MOD.AGILITY]: 'Agility',
  [ITEM_MOD.STRENGTH]: 'Strength',
  [ITEM_MOD.INTELLECT]: 'Intellect',
  [ITEM_MOD.SPIRIT]: 'Spirit',
  [ITEM_MOD.STAMINA]: 'Stamina',
  [ITEM_MOD.CRIT_RATING]: 'Critical Strike',
  [ITEM_MOD.HASTE_RATING]: 'Haste',
  [ITEM_MOD.ATTACK_POWER]: 'Attack Power',
  [ITEM_MOD.VERSATILITY_RATING]: 'Versatility',
  [ITEM_MOD.SPELL_POWER]: 'Spell Power',
  [ITEM_MOD.MASTERY_RATING]: 'Mastery',
  [ITEM_MOD.EXTRA_ARMOR]: 'Bonus Armor',
  [ITEM_MOD.SPEED_RATING]: 'Speed',
  [ITEM_MOD.LEECH_RATING]: 'Leech',
  [ITEM_MOD.AVOIDANCE_RATING]: 'Avoidance',
  [ITEM_MOD.BONUS_STAT_1]: 'Crafted Stat 1',
  [ITEM_MOD.BONUS_STAT_2]: 'Crafted Stat 2',
  [ITEM_MOD.INDESTRUCTIBLE]: 'Indestructible',
  // Engine names per spec resolved; label is the set the item can become.
  [ITEM_MOD.STRENGTH_AGILITY_INTELLECT]: 'Strength / Agility / Intellect',
  [ITEM_MOD.STRENGTH_AGILITY]: 'Strength / Agility',
  [ITEM_MOD.AGILITY_INTELLECT]: 'Agility / Intellect',
  [ITEM_MOD.STRENGTH_INTELLECT]: 'Strength / Intellect',
};

/** True when the stat is a combined primary that a spec resolves to one attribute. */
export function isCombinedPrimary(statType: number): boolean {
  return statType >= ITEM_MOD.STRENGTH_AGILITY_INTELLECT && statType <= ITEM_MOD.STRENGTH_INTELLECT;
}

/** Combat rating stats (take combat rating multiplier): transcribed from simc. */
const COMBAT_RATINGS = new Set([
  13, 14, 15, 16, 17, 18, 19, 20, 21, // dodge, parry, block, hit/crit by school
  26, 27, 28, 29, 30,                 // crit taken, haste by school
  31, 32, 33, 34, 35, 36, 37,         // hit, crit, hit/crit taken, resilience, haste, expertise
  40, 49, 50, 59, 61, 62, 63,         // versatility, mastery, bonus armor, multistrike, speed, leech, avoidance
]);

export function isCombatRating(statType: number): boolean {
  return COMBAT_RATINGS.has(statType);
}

export const QUALITY_LABEL: Record<number, string> = {
  0: 'Poor', 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic',
  5: 'Legendary', 6: 'Artifact', 7: 'Heirloom',
};

/** Combat rating multiplier type (indexes scaling.combatRatingMultByIlvl). */
export const CR_MULTIPLIER = { ARMOR: 0, WEAPON: 1, TRINKET: 2, JEWELRY: 3, INVALID: -1 } as const;

/** Item combat rating type per inventory type. */
export function combatRatingType(inventoryType: number): number {
  switch (inventoryType) {
    case INVTYPE.NECK: case INVTYPE.FINGER: return CR_MULTIPLIER.JEWELRY;
    case INVTYPE.TRINKET: return CR_MULTIPLIER.TRINKET;
    case INVTYPE.WEAPON: case INVTYPE.TWOHAND: case INVTYPE.WEAPONMAINHAND:
    case INVTYPE.WEAPONOFFHAND: case INVTYPE.RANGED: case INVTYPE.RANGEDRIGHT:
    case INVTYPE.THROWN:
      return CR_MULTIPLIER.WEAPON;
    case INVTYPE.ROBE: case INVTYPE.HEAD: case INVTYPE.SHOULDERS: case INVTYPE.CHEST:
    case INVTYPE.CLOAK: case INVTYPE.BODY: case INVTYPE.WRISTS: case INVTYPE.WAIST:
    case INVTYPE.LEGS: case INVTYPE.FEET: case INVTYPE.SHIELD: case INVTYPE.HOLDABLE:
    case INVTYPE.HANDS:
      return CR_MULTIPLIER.ARMOR;
    default: return CR_MULTIPLIER.INVALID;
  }
}

/** Random suffix type: which stat budget column (by item class/subclass/slot). */
export function randomSuffixType(itemClass: number, itemSubclass: number, inventoryType: number): number {
  if (itemClass === ITEM_CLASS.WEAPON) {
    // AXE2, MACE2, POLEARM, SWORD2, STAFF, GUN, BOW, CROSSBOW, THROWN: large budget; others: column 3.
    return [1, 2, 3, 5, 6, 8, 10, 16, 18].includes(itemSubclass) ? 0 : 3;
  }
  if (itemClass === ITEM_CLASS.ARMOR) {
    switch (inventoryType) {
      case INVTYPE.HEAD: case INVTYPE.CHEST: case INVTYPE.LEGS: case INVTYPE.ROBE: return 0;
      case INVTYPE.SHOULDERS: case INVTYPE.WAIST: case INVTYPE.FEET:
      case INVTYPE.HANDS: case INVTYPE.TRINKET: return 1;
      case INVTYPE.NECK: case INVTYPE.FINGER: case INVTYPE.CLOAK: case INVTYPE.WRISTS: return 2;
      case INVTYPE.WEAPONOFFHAND: case INVTYPE.HOLDABLE: case INVTYPE.SHIELD: return 3;
      default: return -1;
    }
  }
  return -1;
}

/** Eligible slots per inventory type (util::translate_invtype + finger/trinket + off-hand for one-handers). */
export function eligibleSlots(inventoryType: number, itemSubclass: number, itemClass: number): GearSlot[] {
  switch (inventoryType) {
    case INVTYPE.HEAD: return ['head'];
    case INVTYPE.NECK: return ['neck'];
    case INVTYPE.SHOULDERS: return ['shoulder'];
    case INVTYPE.BODY: return ['shirt'];
    case INVTYPE.CHEST: case INVTYPE.ROBE: return ['chest'];
    case INVTYPE.WAIST: return ['waist'];
    case INVTYPE.LEGS: return ['legs'];
    case INVTYPE.FEET: return ['feet'];
    case INVTYPE.WRISTS: return ['wrist'];
    case INVTYPE.HANDS: return ['hands'];
    case INVTYPE.FINGER: return ['finger1', 'finger2'];
    case INVTYPE.TRINKET: return ['trinket1', 'trinket2'];
    case INVTYPE.CLOAK: return ['back'];
    case INVTYPE.TABARD: return ['tabard'];
    case INVTYPE.TWOHAND: return ['main_hand'];
    case INVTYPE.WEAPONMAINHAND: return ['main_hand'];
    case INVTYPE.RANGED: case INVTYPE.RANGEDRIGHT: case INVTYPE.THROWN: return ['main_hand'];
    case INVTYPE.WEAPONOFFHAND: case INVTYPE.SHIELD: case INVTYPE.HOLDABLE: return ['off_hand'];
    case INVTYPE.WEAPON:
      // One-hand in either slot; dual-wield legality is character question.
      return itemClass === ITEM_CLASS.WEAPON ? ['main_hand', 'off_hand'] : ['main_hand'];
    default: return [];
  }
}

/** Class bit per WoW class ID (dbc_item_data_t::class_mask). */
export function classMaskFor(classId: number): number {
  return classId > 0 ? 1 << (classId - 1) : 0;
}
