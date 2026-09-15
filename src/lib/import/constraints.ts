// ImportedCharacter to legality track's CharacterConstraints. Class/race id tables from pinned upstream source, not hand-maintained.

import type { CharacterConstraints } from '../catalog/legality'
import type { ResolvedItem } from '../catalog/types'
import { ITEM_CLASS, INVTYPE } from '../catalog/enums'
import type { ImportedCharacter } from './character'

/** simc class option key -> DB2 class id. */
const CLASS_IDS: Record<string, number> = {
  warrior: 1, paladin: 2, hunter: 3, rogue: 4, priest: 5, deathknight: 6,
  shaman: 7, mage: 8, warlock: 9, monk: 10, druid: 11, demonhunter: 12, evoker: 13,
}

/** Simc race token to DB2 id. Faction-split races absent (export one token); absent race yields null (unverifiable). */
const RACE_IDS: Record<string, number> = {
  human: 1, orc: 2, dwarf: 3, night_elf: 4, undead: 5, tauren: 6, gnome: 7,
  troll: 8, goblin: 9, blood_elf: 10, draenei: 11, dark_iron_dwarf: 12,
  vulpera: 13, maghar_orc: 14, mechagnome: 15, worgen: 22,
  nightborne: 27, highmountain_tauren: 28, void_elf: 29,
  lightforged_draenei: 30, zandalari_troll: 31, kul_tiran: 32,
  // pandaren, dracthyr, earthen and haranir each have per-faction ids upstream
  // and one token here, so they are intentionally not mapped.
}

export function classId(character: ImportedCharacter): number {
  return CLASS_IDS[character.className] ?? 0
}

export function raceMaskBit(character: ImportedCharacter): number | null {
  const token = (character.race ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  const id = RACE_IDS[token]
  return id ? id - 1 : null
}

export interface ConstraintDerivation {
  constraints: CharacterConstraints
  /** What could not be determined, for the UI to state rather than hide. */
  unknown: string[]
}

/** Builds constraints from equipped items. Armor class from what worn; dual wield from off-hand weapon. Evidence from export, not hand-written. */
export function characterConstraints(
  character: ImportedCharacter,
  resolved: ReadonlyMap<string, ResolvedItem>,
  _playerLevel = character.level ?? 0,
): ConstraintDerivation {
  const unknown: string[] = []
  const cid = classId(character)
  if (!cid) unknown.push(`class "${character.className}" is not a class id this build knows`)

  const bit = raceMaskBit(character)
  if (bit === null && character.race) {
    unknown.push(`race "${character.race}" has per-faction ids upstream, so race restrictions cannot be checked`)
  }

  let armorSubclass: number | null = null
  let canDualWield = false
  let canTitansGrip = false

  if (resolved.size) {
    const counts = new Map<number, number>()
    for (const item of character.equipped) {
      const info = resolved.get(item.instanceId)
      if (!info) continue
      if (info.itemClass === ITEM_CLASS.ARMOR && info.itemSubclass > 0) {
        counts.set(info.itemSubclass, (counts.get(info.itemSubclass) ?? 0) + 1)
      }
      if (item.slot === 'off_hand') {
        // Weapon in off-hand proves dual wield; two-hander proves Titans Grip.
        if (info.itemClass === ITEM_CLASS.WEAPON) canDualWield = true
        if (info.inventoryType === INVTYPE.TWOHAND) canTitansGrip = true
      }
    }
    let best = 0
    for (const [subclass, n] of counts) {
      if (n > best) { best = n; armorSubclass = subclass }
    }
    if (armorSubclass === null) unknown.push('armor class could not be read from the equipped set')
  } else {
    unknown.push('no game data loaded, so no equipment legality can be checked')
  }

  return {
    constraints: {
      classId: cid,
      raceMaskBit: bit,
      armorSubclass,
      canDualWield,
      // Equipped two-hander off-hand is direct evidence.
      canTitansGrip,
    },
    unknown,
  }
}
