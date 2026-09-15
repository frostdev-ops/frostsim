// Equipment legality; failing candidate never reaches engine (P07.3). Rules checked against catalog fields from engine.

import { INVTYPE, ITEM_CLASS, classMaskFor } from './enums';
import type { GearSlot, ItemInstance, ResolvedItem } from './types';

export type LegalityCode =
  | 'slot_mismatch'
  | 'class_restricted'
  | 'race_restricted'
  | 'armor_class_mismatch'
  | 'two_hand_conflict'
  | 'off_hand_without_dual_wield'
  | 'duplicate_unique_item'
  | 'duplicate_unique_gem'
  | 'socket_overflow'
  | 'gem_color_mismatch'
  | 'instance_reused'
  | 'unverifiable';

export interface LegalityIssue {
  code: LegalityCode;
  slot?: GearSlot;
  message: string;
  /** True when the catalog lacks the data to decide; the candidate is not rejected. */
  advisory?: boolean;
}

export interface CharacterConstraints {
  classId: number;
  /** Race bit index, or null when the importer did not supply one. */
  raceMaskBit: number | null;
  /** Armor subclass the class wears, or null when unknown; from the equipped set. */
  armorSubclass: number | null;
  canDualWield: boolean;
  canTitansGrip: boolean;
}

/** Race mask is 64-bit hex; test one bit. */
export function raceAllowed(raceMask: string, bit: number | null): boolean | null {
  if (bit === null) return null;
  try {
    const mask = BigInt(raceMask);
    if (mask === 0n) return true; // unrestricted
    return (mask & (1n << BigInt(bit))) !== 0n;
  } catch {
    return null;
  }
}

export function checkItemForSlot(
  item: ResolvedItem,
  slot: GearSlot,
  character: CharacterConstraints,
): LegalityIssue[] {
  const issues: LegalityIssue[] = [];

  if (!item.eligibleSlots.includes(slot) && !(slot === 'off_hand' && item.inventoryType === INVTYPE.TWOHAND && character.canTitansGrip)) {
    issues.push({ code: 'slot_mismatch', slot, message: `${item.name} cannot be equipped in ${slot}` });
  }

  if (item.classMask !== 0 && character.classId > 0) {
    const bit = classMaskFor(character.classId);
    if ((item.classMask & bit) === 0) {
      issues.push({ code: 'class_restricted', slot, message: `${item.name} is not usable by this class` });
    }
  }

  const race = raceAllowed(item.raceMask, character.raceMaskBit);
  if (race === false) {
    issues.push({ code: 'race_restricted', slot, message: `${item.name} is not usable by this race` });
  } else if (race === null && character.raceMaskBit !== null) {
    issues.push({ code: 'unverifiable', slot, advisory: true, message: `race restriction for ${item.name} could not be checked` });
  }

  // Armor class for real armor pieces only.
  const ARMOR_CLASSES = [1, 2, 3, 4];
  if (
    item.itemClass === ITEM_CLASS.ARMOR &&
    ARMOR_CLASSES.includes(item.itemSubclass) &&
    character.armorSubclass !== null &&
    item.itemSubclass !== character.armorSubclass
  ) {
    issues.push({ code: 'armor_class_mismatch', slot, message: `${item.name} is the wrong armor type` });
  }

  if (slot === 'off_hand') {
    const isOneHandWeapon = item.itemClass === ITEM_CLASS.WEAPON && item.inventoryType === INVTYPE.WEAPON;
    if (isOneHandWeapon && !character.canDualWield) {
      issues.push({ code: 'off_hand_without_dual_wield', slot, message: `${item.name} needs dual wield` });
    }
    if (item.inventoryType === INVTYPE.TWOHAND && !character.canTitansGrip) {
      issues.push({ code: 'two_hand_conflict', slot, message: `${item.name} is two-handed` });
    }
  }

  return issues;
}

/** Socket rules (P08.4): gem per socket, color check. Color 0 = catalog couldn't identify (unverifiable) or prismatic socket. */
export function checkSockets(item: ResolvedItem, slot: GearSlot): LegalityIssue[] {
  const issues: LegalityIssue[] = [];
  const gems = item.gemIds ?? [];
  if (gems.length === 0) return issues;

  if (gems.length > item.sockets.length) {
    issues.push({
      code: 'socket_overflow', slot,
      message: `${item.name} has ${item.sockets.length} socket(s) but ${gems.length} gem(s)`,
    });
  }

  for (let i = 0; i < gems.length && i < item.sockets.length; i++) {
    const socket = item.sockets[i];
    const gemColor = item.gemColors?.[i] ?? 0;
    if (gemColor === 0) {
      issues.push({
        code: 'unverifiable', slot, advisory: true,
        message: `gem ${gems[i]} is not in the catalog, so its colour could not be checked against ${item.name}`,
      });
      continue;
    }
    // Socket 0 takes any gem; non-0 socket restricts by color.
    if (socket !== 0 && (socket & gemColor) === 0) {
      issues.push({
        code: 'gem_color_mismatch', slot,
        message: `gem ${gems[i]} does not fit socket ${i + 1} of ${item.name}`,
      });
    }
  }
  return issues;
}

/** Whole-set rules: weapon pairing, unique items, sockets, and instance reuse. */
export function checkGearSet(
  set: Map<GearSlot, ResolvedItem | null>,
  character: CharacterConstraints,
): LegalityIssue[] {
  const issues: LegalityIssue[] = [];

  for (const [slot, item] of set) {
    if (item) {
      issues.push(...checkItemForSlot(item, slot, character));
      issues.push(...checkSockets(item, slot));
    }
  }

  // Unique-equipped: real engine flag; one per character. Exact-id only (unique GROUPS not in catalog).
  const uniqueCounts = new Map<number, { n: number; name: string }>();
  for (const item of set.values()) {
    if (!item?.uniqueEquipped) continue;
    const seen = uniqueCounts.get(item.itemId) ?? { n: 0, name: item.name };
    seen.n++;
    uniqueCounts.set(item.itemId, seen);
  }
  for (const [, seen] of uniqueCounts) {
    if (seen.n > 1) {
      issues.push({
        code: 'duplicate_unique_item',
        message: `${seen.name} is unique-equipped and appears ${seen.n} times`,
      });
    }
  }

  // Unique gem counts across whole character; without this generator repeats same gem in every socket.
  const gemCounts = new Map<number, number>();
  for (const item of set.values()) {
    if (!item) continue;
    item.gemIds.forEach((gemId, i) => {
      if (!item.gemUnique?.[i]) return;
      gemCounts.set(gemId, (gemCounts.get(gemId) ?? 0) + 1);
    });
  }
  for (const [gemId, n] of gemCounts) {
    if (n > 1) {
      issues.push({
        code: 'duplicate_unique_gem',
        message: `gem ${gemId} is unique-equipped and is socketed ${n} times`,
      });
    }
  }

  const mh = set.get('main_hand') ?? null;
  const oh = set.get('off_hand') ?? null;
  if (mh?.inventoryType === INVTYPE.TWOHAND && oh && !character.canTitansGrip) {
    issues.push({
      code: 'two_hand_conflict',
      slot: 'off_hand',
      message: `${mh.name} is two-handed and leaves no off hand slot`,
    });
  }

  // Same physical item cannot be worn twice. Instance identity, not item id.
  const seenInstances = new Set<string>();
  for (const item of set.values()) {
    if (!item) continue;
    if (seenInstances.has(item.instanceId)) {
      issues.push({ code: 'instance_reused', message: `${item.name} is used in two slots at once` });
    }
    seenInstances.add(item.instanceId);
  }

  // Item repeat without unique flag is legal for flag, but unique GROUPS not in catalog (unchecked).
  const byId = new Map<number, number>();
  for (const item of set.values()) {
    if (!item || item.uniqueEquipped) continue;
    byId.set(item.itemId, (byId.get(item.itemId) ?? 0) + 1);
  }
  for (const [itemId, n] of byId) {
    if (n > 1) {
      issues.push({
        code: 'unverifiable',
        advisory: true,
        message: `item ${itemId} appears ${n} times; unique-equipped grouping is not in the catalog and was not checked`,
      });
    }
  }

  return issues;
}

/** Blocking issues only; advisory ones are shown but do not reject a candidate. */
export function isLegal(issues: LegalityIssue[]): boolean {
  return issues.every((i) => i.advisory === true);
}

/** Convenience for callers holding raw instances rather than resolved items. */
export function slotOf(instance: ItemInstance): GearSlot {
  return instance.slot;
}
