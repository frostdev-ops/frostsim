// Direct port of item_database functions from vendor/simc/engine/dbc/sc_item_data.cpp so UI shows item's real level and stats before sim runs; engine authoritative for results.

import { CR_MULTIPLIER, ITEM_BONUS, ITEM_MOD, ILEVEL_OVERRIDE_BLOCKERS, combatRatingType, isCombatRating, randomSuffixType } from './enums';
import type { BonusEntry, BonusPayload, ScalingPayload } from './types';

const MAX_ITEM_STAT = 10;

export interface BaseItem {
  id: number;
  name: string;
  level: number;
  reqLevel: number;
  quality: number;
  invType: number;
  itemClass: number;
  itemSubclass: number;
  bindType: number;
  delay: number;
  dmgRange: number;
  classMask: number;
  raceMask: string;
  socketColor: number[];
  gemProperties: number;
  socketBonusId: number;
  setId: number;
  curveId: number;
  craftingQuality: number;
  /** item_flag bitfield; UNIQUE_EQUIPPED lives here. */
  flags1: number;
  /** Flat [type, alloc, socketMul] triples from engine table. */
  stats: number[];
}

export interface BuildInput {
  bonusIds: number[];
  craftedStats?: number[];
  /** Supplies stat types and allocations in place of item's own (redirected_base_stats). */
  redirect?: BaseItem;
  dropLevel?: number;
  contentTuningId?: number;
  /** Used only by the legacy ITEM_BONUS_SCALING path. */
  playerLevel?: number;
}

export interface BuiltItem {
  level: number;
  baseLevel: number;
  quality: number;
  reqLevel: number;
  socketColor: number[];
  craftingQuality: number;
  statTypes: number[];
  statAllocs: number[];
  socketMuls: number[];
  descriptionIds: number[];
  /** Reasons field could not be derived, surfaced not swallowed. */
  warnings: string[];
}

/** Indexed views over the scaling payload, built once per catalog load. */
export class ScalingTables {
  readonly squishCurveMidnight: number;
  private readonly curves: Record<string, number[]>;
  private readonly scalingConfigs = new Map<number, [number, number, number, number, number]>();
  private readonly offsetCurves = new Map<number, [number, number, number]>();
  private readonly randProp = new Map<number, [number[], number[], number[]]>();
  private readonly socketCost: number[];
  private readonly crMult: number[][];
  private readonly stamMult: number[][];

  constructor(p: ScalingPayload) {
    this.squishCurveMidnight = p.squishCurveMidnight;
    this.curves = p.curves;
    // Engine find() returns first matching row so keep first only.
    for (const c of p.scalingConfigs) if (!this.scalingConfigs.has(c[0])) this.scalingConfigs.set(c[0], c);
    for (const o of p.offsetCurves) if (!this.offsetCurves.has(o[0])) this.offsetCurves.set(o[0], o);
    for (const [ilvl, epic, rare, uncommon] of p.randProp) this.randProp.set(ilvl, [epic, rare, uncommon]);
    this.socketCost = p.socketCostPerLevel;
    this.crMult = p.combatRatingMultByIlvl;
    this.stamMult = p.staminaMultByIlvl;
  }

  scalingConfig(id: number) { return this.scalingConfigs.get(id); }
  offsetCurve(id: number) { return this.offsetCurves.get(id); }
  randomProperty(ilevel: number) { return this.randProp.get(ilevel); }

  socketCostPerLevel(ilevel: number): number {
    return this.socketCost[ilevel - 1] ?? 0;
  }

  combatRatingMultiplier(ilevel: number, type: number): number {
    return this.crMult[type]?.[ilevel - 1] ?? 0;
  }

  staminaMultiplier(ilevel: number, type: number): number {
    return this.stamMult[type]?.[ilevel - 1] ?? 0;
  }

  /** item_database::curve_point_value: clamp at ends, linear interpolation between. */
  curveValue(curveId: number, point: number): number | null {
    const flat = this.curves[String(curveId)];
    if (!flat || flat.length < 2) return null;
    const n = flat.length / 2;
    const x = (i: number) => flat[i * 2];
    const y = (i: number) => flat[i * 2 + 1];

    if (point <= x(0)) return y(0);
    if (point >= x(n - 1)) return y(n - 1);

    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x(mid) <= point) lo = mid; else hi = mid;
    }
    if (x(lo) === point) return y(lo);
    return y(lo) + ((y(hi) - y(lo)) * (point - x(lo))) / (x(hi) - x(lo));
  }
}

export interface BonusTables {
  entriesFor(bonusId: number): BonusEntry[];
  description(id: number): string | undefined;
}

export function bonusTables(p: BonusPayload): BonusTables {
  return {
    entriesFor: (bonusId) => p.byBonusId[String(bonusId)] ?? [],
    description: (id) => p.nameDescriptions[String(id)],
  };
}

/**
 * item_database::sort_item_bonuses — scaling bonuses apply last so an item level
 * adjustment lands on the already-set base level.
 */
export function sortBonusIds(bonusIds: number[], bonus: BonusTables): number[] {
  const isScaling = (id: number) =>
    bonus.entriesFor(id).some(([type]) => type === ITEM_BONUS.POST_SQUISH_ITEM_LEVEL || type === ITEM_BONUS.CRAFTING_QUALITY);
  return [...bonusIds].sort((a, b) => {
    const sa = isScaling(a);
    const sb = isScaling(b);
    if (sa !== sb) return sa ? 1 : -1;
    return a - b;
  });
}

export function buildItem(
  base: BaseItem,
  input: BuildInput,
  bonus: BonusTables,
  scaling: ScalingTables,
): BuiltItem {
  const statSource = input.redirect ?? base;
  const statTypes: number[] = Array.from({ length: MAX_ITEM_STAT }, () => ITEM_MOD.NONE);
  const statAllocs = Array.from({ length: MAX_ITEM_STAT }, () => 0);
  // socket_mul stays with item's own stat rows even when redirect supplies types and allocations.
  const socketMuls = Array.from({ length: MAX_ITEM_STAT }, () => 0);
  for (let i = 0; i * 3 < statSource.stats.length && i < MAX_ITEM_STAT; i++) {
    statTypes[i] = statSource.stats[i * 3];
    statAllocs[i] = statSource.stats[i * 3 + 1];
  }
  for (let i = 0; i * 3 < base.stats.length && i < MAX_ITEM_STAT; i++) {
    socketMuls[i] = base.stats[i * 3 + 2];
  }

  const st: BuiltItem & { bonusLevel: number; hasMidnightScaling: boolean; baseLevelPriority: number; scalingLevelPriority: number } = {
    level: base.level,
    baseLevel: base.level,
    quality: base.quality,
    reqLevel: base.reqLevel,
    socketColor: [...base.socketColor],
    craftingQuality: base.craftingQuality,
    statTypes,
    statAllocs,
    socketMuls,
    descriptionIds: [],
    warnings: [],
    bonusLevel: 0,
    hasMidnightScaling: false,
    baseLevelPriority: Number.MAX_SAFE_INTEGER,
    scalingLevelPriority: Number.MAX_SAFE_INTEGER,
  };

  const ordered = sortBonusIds(input.bonusIds, bonus);
  const blocked = input.bonusIds.some((id) => ILEVEL_OVERRIDE_BLOCKERS.has(id));

  const applyEntry = (entry: BonusEntry, depth: number) => {
    const [type, v1, v2, v3, v4] = entry;
    switch (type) {
      case ITEM_BONUS.APPLY_BONUS: {
        if (depth > 8) { st.warnings.push(`bonus ${v1}: nesting too deep`); break; }
        for (const e of bonus.entriesFor(v1)) applyEntry(e, depth + 1);
        break;
      }
      case ITEM_BONUS.SQUISH_CURVE: {
        const v = scaling.curveValue(v1, v2);
        if (v === null) { st.warnings.push(`curve ${v1} missing`); break; }
        st.level = Math.round(v);
        if (v3 === 1) {
          const squished = scaling.curveValue(scaling.squishCurveMidnight, st.level);
          if (squished !== null) st.level = Math.round(squished);
        }
        st.hasMidnightScaling = true;
        break;
      }
      case ITEM_BONUS.SCALE_CONFIG: {
        const cfg = scaling.scalingConfig(v1);
        if (!cfg) { st.warnings.push(`scaling config ${v1} missing`); break; }
        const [, offsetCurveId, itemLevel, playerLevel, squishEraId] = cfg;
        const off = scaling.offsetCurve(offsetCurveId);
        if (!off) { st.warnings.push(`offset curve ${offsetCurveId} missing`); break; }
        let level = playerLevel;
        const drop = input.dropLevel ?? 0;
        if (drop !== 0 && drop <= 80 && (level > drop || level === 0)) level = drop;
        // Content tuning caps required level; ceiling is catalog field.
        const curveId = squishEraId < 2 ? scaling.squishCurveMidnight : off[1];
        const v = scaling.curveValue(curveId, itemLevel);
        if (v === null) { st.warnings.push(`curve ${curveId} missing`); break; }
        st.level = Math.round(v) + off[2];
        st.hasMidnightScaling = true;
        st.reqLevel = level;
        break;
      }
      case ITEM_BONUS.SCALE_CONFIG_2: {
        const cfg = scaling.scalingConfig(v1);
        if (!cfg) { st.warnings.push(`scaling config ${v1} missing`); break; }
        const [, offsetCurveId, itemLevel, playerLevel] = cfg;
        const off = scaling.offsetCurve(offsetCurveId);
        if (!off) { st.warnings.push(`offset curve ${offsetCurveId} missing`); break; }
        const drop = input.dropLevel ?? 0;
        const point = drop > 0 ? drop : itemLevel;
        const v = scaling.curveValue(off[1], point);
        if (v === null) { st.warnings.push(`curve ${off[1]} missing`); break; }
        st.level = Math.round(v) + off[2];
        st.hasMidnightScaling = true;
        st.reqLevel = playerLevel;
        break;
      }
      case ITEM_BONUS.CRAFTING_QUALITY:
        st.bonusLevel += v1;
        st.level += v1;
        st.craftingQuality = v3 + 1;
        break;
      case ITEM_BONUS.POST_SQUISH_ITEM_LEVEL:
        if (!st.hasMidnightScaling) break;
        st.bonusLevel += v1;
        st.level += v1;
        break;
      case ITEM_BONUS.ILEVEL:
        if (blocked || st.hasMidnightScaling) break;
        st.bonusLevel += v1;
        st.level += v1;
        break;
      case ITEM_BONUS.SET_ILEVEL_2:
        if (blocked || st.hasMidnightScaling) break;
        if (v2 < st.baseLevelPriority) {
          st.level = v1 + st.bonusLevel;
          st.baseLevelPriority = v2;
        }
        break;
      case ITEM_BONUS.MOD: {
        let found = -1;
        let free = -1;
        for (let i = 0; i < MAX_ITEM_STAT; i++) {
          if (free === -1 && st.statTypes[i] === ITEM_MOD.NONE) free = i;
          if (found === -1 && st.statTypes[i] === v1) found = i;
        }
        if (found === -1 && free !== -1) {
          st.statTypes[free] = v1;
          st.statAllocs[free] = v2;
        } else if (found !== -1) {
          st.statAllocs[found] += v2;
        } else {
          st.warnings.push(`stat slots full, dropped item mod ${v1}`);
        }
        break;
      }
      case ITEM_BONUS.MOD_ITEM_STAT: {
        // Replaces first remaining crafted placeholder with real stat type plus every later slot with same placeholder.
        if (v1 === 0) break;
        for (let i = 0; i < MAX_ITEM_STAT; i++) {
          const oldType = st.statTypes[i];
          if (oldType !== ITEM_MOD.BONUS_STAT_1 && oldType !== ITEM_MOD.BONUS_STAT_2) continue;
          st.statTypes[i] = v1;
          for (let k = i + 1; k < MAX_ITEM_STAT; k++) {
            if (st.statTypes[k] === oldType) st.statTypes[k] = v1;
          }
          break;
        }
        break;
      }
      case ITEM_BONUS.QUALITY:
        st.quality = v1;
        break;
      case ITEM_BONUS.DESC:
        st.descriptionIds.push(v1);
        break;
      case ITEM_BONUS.REQ_LEVEL:
        st.reqLevel += v1;
        break;
      case ITEM_BONUS.SOCKET: {
        let added = 0;
        for (let i = 0; i < st.socketColor.length && added < v1; i++) {
          if (st.socketColor[i] !== 0) continue;
          st.socketColor[i] = v2;
          added++;
        }
        if (added < v1) st.warnings.push(`could not fit ${v1} sockets`);
        break;
      }
      case ITEM_BONUS.SCALING: {
        if (v2 < st.scalingLevelPriority) {
          applyItemScaling(st, v4, input.playerLevel ?? 0, scaling);
          st.scalingLevelPriority = v2;
        }
        break;
      }
      case ITEM_BONUS.SCALING_2: {
        const drop = input.dropLevel ?? 0;
        if (drop > 0 && v2 < st.scalingLevelPriority) {
          applyItemScaling(st, v4, drop, scaling);
          st.scalingLevelPriority = v2;
        }
        break;
      }
      default:
        break; // SUFFIX, ADD_RANK, ADD_ITEM_EFFECT, ILEVEL_IN_PVP: no catalog effect
    }
  };

  for (const id of ordered) {
    const entries = bonus.entriesFor(id);
    if (entries.length === 0) st.warnings.push(`unknown bonus id ${id}`);
    for (const e of entries) applyEntry(e, 0);
  }

  // item_t::decode_stats: item's own scaling curve applies when no scaling bonus set one.
  const hasScalingBonus = ordered.some((id) =>
    bonus.entriesFor(id).some(([t]) => t === ITEM_BONUS.SCALING || t === ITEM_BONUS.SCALING_2));
  if (!hasScalingBonus && base.curveId) {
    applyItemScaling(st, base.curveId, input.playerLevel ?? 0, scaling);
  }

  // Crafted stats replace BONUS_STAT_1/2 placeholders in placeholder order; missive already consumed placeholder so wins.
  if (input.craftedStats?.length) {
    let placeholder = ITEM_MOD.BONUS_STAT_1;
    for (const mod of input.craftedStats) {
      for (let i = 0; i < MAX_ITEM_STAT; i++) {
        if (st.statTypes[i] === placeholder) st.statTypes[i] = mod;
      }
      placeholder++;
    }
  }

  return st;
}

/** item_database::apply_item_scaling */
function applyItemScaling(
  st: { level: number; warnings: string[] } & { bonusLevel: number },
  curveId: number,
  playerLevel: number,
  scaling: ScalingTables,
): void {
  if (!curveId) return;
  // Engine clamps input at curve's last primary1; curveValue clamps at both ends so passing level through gives same result.
  const v = scaling.curveValue(curveId, playerLevel);
  if (v === null) { st.warnings.push(`curve ${curveId} missing`); return; }
  st.level = Math.round(v) + st.bonusLevel;
}

/** item_database::scaled_stat: value of one stat index at given item level; null when engine falls back to approximation path. */
export function scaledStat(
  base: BaseItem,
  built: BuiltItem,
  index: number,
  ilevel: number,
  scaling: ScalingTables,
): number | null {
  if (index >= built.statTypes.length - 1) return null;
  if (built.level === 0) return null;

  const statType = built.statTypes[index];
  if (statType === ITEM_MOD.CORRUPTION || statType === ITEM_MOD.CORRUPTION_RESISTANCE) {
    return built.statAllocs[index];
  }

  const slotType = randomSuffixType(base.itemClass, base.itemSubclass, base.invType);
  if (slotType === -1 || built.quality <= 0) return null;

  const prop = scaling.randomProperty(ilevel);
  if (!prop) return null;
  const [pEpic, pRare, pUncommon] = prop;
  const budget = built.quality === 4 || built.quality === 5 ? pEpic[slotType]
    : built.quality === 3 || built.quality === 7 ? pRare[slotType]
      : pUncommon[slotType];

  const alloc = built.statAllocs[index];
  if (!(alloc > 0) || !(budget > 0)) return null;

  // Banker's rounding matching std::nearbyint under default rounding mode.
  const socketPenalty = nearbyint((built.socketMuls[index] ?? 0) * scaling.socketCostPerLevel(ilevel));
  let raw = alloc * budget * 0.0001 - socketPenalty;

  const crType = combatRatingType(base.invType);
  if (crType !== CR_MULTIPLIER.INVALID) {
    if (isCombatRating(statType)) {
      const mult = scaling.combatRatingMultiplier(ilevel, crType);
      if (mult !== 0) raw *= mult;
    } else if (statType === ITEM_MOD.STAMINA) {
      const mult = scaling.staminaMultiplier(ilevel, crType);
      if (mult !== 0) raw *= mult;
    }
  }

  return Math.round(raw);
}

/** std::nearbyint with default FE_TONEAREST mode: ties go to even integer. */
export function nearbyint(x: number): number {
  const r = Math.round(x);
  // Math.round differs only in exact .5 cases.
  if (Math.abs(x % 1) === 0.5) {
    const floor = Math.floor(x);
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return r;
}
