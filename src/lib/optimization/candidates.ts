// Legal candidate generation (P08.6): lazy iterator with per-slot then whole-set rules, duplicates by canonical form.

import { checkGearSet, isLegal, type CharacterConstraints, type LegalityIssue } from '../catalog/legality';
import { serializeItem } from '../catalog/serialize';
import { INVTYPE } from '../catalog/enums';
import type { Catalog } from '../catalog/catalog';
import { GEAR_SLOTS, type GearSlot, type ItemInstance, type ResolvedItem } from '../catalog/types';
import type { Candidate, CandidateCost, CandidateDelta } from './types';

/** One axis of the search: the alternatives selected for a single decision. */
export interface Dimension {
  key: string;
  kind: 'gear' | 'talent' | 'consumable' | 'gem' | 'enchant' | 'embellishment';
  /** Slot this dimension varies, for gear/gem/enchant dimensions. */
  slot?: GearSlot;
  options: DimensionOption[];
}

export interface DimensionOption {
  /** Stable within the dimension; part of the canonical form. */
  key: string;
  label: string;
  /** null means "leave this slot empty". */
  item?: ItemInstance | null;
  /** Atomic paired-slot choice, so ring/trinket permutations are never generated. */
  gear?: ItemInstance[];
  talents?: string;
  consumable?: { kind: string; option: string };
  /** Gem loadout for slot, applied to whichever item ends up there; composes with gear. */
  gemIds?: number[];
  /** Enchant for slot, applied the same way. */
  enchantId?: number;
  /** Embellishment bonus id (P08.2), applies as extra bonus; `0` means no embellishment. */
  embellishmentBonusId?: number;
  cost?: CandidateCost;
}

/** A minimum number of pieces from one set, enforced on the whole candidate (P08.3). */
export interface SetBonusRequirement {
  setId: number;
  pieces: number;
  label?: string;
}

export interface GenerateOptions {
  /** Hard ceiling on candidates produced. Generation stops here, honestly reported. */
  workCap: number;
  character: CharacterConstraints;
  /** Resolves instances for legality checks and display. */
  catalog: Catalog;
  /** The baseline gear, so a candidate can be checked as a whole set. */
  baselineGear: Map<GearSlot, ItemInstance | null>;
  /** Player level, for item resolution. */
  playerLevel?: number;
  /** Include the unmodified baseline as a candidate. Defaults to true. */
  includeBaseline?: boolean;
  /** Set bonuses the candidate must keep. A combination that breaks one is rejected. */
  requiredSets?: SetBonusRequirement[];
  /**
   * Every embellishment bonus id in the catalog, so a candidate can be counted
   * against `embellishmentLimit`. Without it the limit cannot be enforced.
   */
  embellishmentBonusIds?: Iterable<number>;
  /**
   * How many embellishments one character may wear.
   *
   * NOT IN THE ENGINE DATA. `embellishment_data.inc` carries name, bonus id, effect
   * id and spell id, and says nothing about how many may be worn at once. Supply the
   * number to have it enforced; leave it undefined and it is not checked, the same
   * treatment the talent point budget gets.
   */
  embellishmentLimit?: number;
}

export interface GenerationReport {
  /** Candidates actually produced. */
  produced: number;
  /** Combinations examined, including rejected ones. */
  examined: number;
  rejectedIllegal: number;
  duplicatesCollapsed: number;
  /** True when the work cap stopped generation before the space was exhausted. */
  capped: boolean;
  /**
   * Size of the selected space. `exact` is the product of the dimension sizes;
   * it is an UPPER BOUND on legal candidates, not a count of them.
   */
  upperBound: number;
  upperBoundExceedsSafeInteger: boolean;
  /** Dimensions ordered by how much they multiply the space, largest first. */
  growthDrivers: { key: string; label: string; options: number }[];
}

/** Upper bound: product of dimension sizes; legality and dedup only reduce it. */
export function upperBound(dimensions: Dimension[]): { value: number; overflow: boolean } {
  let value = 1;
  let overflow = false;
  for (const d of dimensions) {
    const n = Math.max(1, d.options.length);
    if (value > Number.MAX_SAFE_INTEGER / n) { overflow = true; value = Number.MAX_SAFE_INTEGER; break; }
    value *= n;
  }
  return { value, overflow };
}

export function growthDrivers(dimensions: Dimension[]): GenerationReport['growthDrivers'] {
  return dimensions
    .map((d) => ({ key: d.key, label: d.slot ? `${d.kind} (${d.slot})` : d.kind, options: d.options.length }))
    .filter((d) => d.options > 1)
    .sort((a, b) => b.options - a.options);
}

/** Deterministic, order-independent canonical form. */
export function canonicalize(delta: CandidateDelta): string {
  const parts: string[] = [];
  if (delta.gear) {
    const slots = [...delta.gear.keys()].sort();
    for (const slot of slots) {
      const item = delta.gear.get(slot) ?? null;
      parts.push(item ? `${slot}=${serializeItem(item).slice(slot.length + 1)}` : `${slot}=`);
    }
  }
  if (delta.talents !== undefined) parts.push(`talents=${delta.talents}`);
  if (delta.consumables) {
    for (const key of Object.keys(delta.consumables).sort()) parts.push(`${key}=${delta.consumables[key]}`);
  }
  // Extra lines order-sensitive; simc applies repeated options in order.
  for (const line of delta.extraLines ?? []) parts.push(line);
  return parts.join('\n');
}

/** Short opaque id. Safe as a profileset key: no quotes, equals signs or spaces. */
export function candidateId(canonical: string, index: number): string {
  return `c${index.toString(36)}-${fnv1a(canonical).toString(36)}`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function emptyCost(): CandidateCost {
  return { unknownCosts: [] };
}

function mergeCost(into: CandidateCost, from?: CandidateCost): CandidateCost {
  if (!from) return into;
  const currencies = { ...into.currencies };
  for (const [id, n] of Object.entries(from.currencies ?? {})) {
    currencies[Number(id)] = (currencies[Number(id)] ?? 0) + n;
  }
  return {
    currencies: Object.keys(currencies).length ? currencies : undefined,
    catalystCharges: (into.catalystCharges ?? 0) + (from.catalystCharges ?? 0) || undefined,
    unknownCosts: [...new Set([...into.unknownCosts, ...from.unknownCosts])],
  };
}

/** Yields legal, de-duplicated candidates; pull with a bound of your own. */
export function* generate(
  dimensions: Dimension[],
  opts: GenerateOptions,
): Generator<Candidate, GenerationReport, undefined> {
  const bound = upperBound(dimensions);
  const report: GenerationReport = {
    produced: 0, examined: 0, rejectedIllegal: 0, duplicatesCollapsed: 0, capped: false,
    upperBound: bound.value, upperBoundExceedsSafeInteger: bound.overflow,
    growthDrivers: growthDrivers(dimensions),
  };
  const seen = new Set<string>();
  const resolveCache = new Map<string, ResolvedItem | null>();

  const resolve = (item: ItemInstance): ResolvedItem | null => {
    const key = `${item.instanceId}:${serializeItem(item)}`;
    if (!resolveCache.has(key)) {
      resolveCache.set(key, opts.catalog.resolve(item, opts.playerLevel ?? 0));
    }
    return resolveCache.get(key) ?? null;
  };

  // Per-slot legality first: reject unusable items once, not per combination.
  const usable: Dimension[] = dimensions.map((d) => ({
    ...d,
    options: d.options.filter((o) => {
      return [...(o.gear ?? []), ...(o.item ? [{ ...o.item, slot: d.slot ?? o.item.slot }] : [])].every((item) => {
        const r = resolve(item);
        return r !== null && isLegal(checkGearSet(new Map([[item.slot, r]]), opts.character));
      });
    }),
  }));

  if (opts.includeBaseline !== false) {
    const delta: CandidateDelta = {};
    const canonical = canonicalize(delta);
    seen.add(canonical);
    report.produced++;
    yield {
      id: 'baseline',
      provenance: { kind: 'baseline', items: [], label: 'Current setup' },
      delta,
      cost: emptyCost(),
      lines: [],
      canonical,
    };
  }

  const counters = Array.from({ length: usable.length }, () => 0);
  const done = usable.some((d) => d.options.length === 0) || usable.length === 0;

  while (!done) {
    report.examined++;

    const picks = usable.map((d, i) => ({ dimension: d, option: d.options[counters[i]] }));
    const built = buildCandidate(picks, opts, resolve);

    if (built) {
      // Equal sims with different rewards stay separate but share simulation cache.
      const choiceKey = `${built.canonical}\nreward=${built.provenance.vaultRewardId ?? ''}`;
      if (seen.has(choiceKey) || (!built.provenance.vaultRewardId && seen.has(built.canonical))) {
        report.duplicatesCollapsed++;
      } else {
        seen.add(choiceKey);
        report.produced++;
        yield { ...built, id: candidateId(built.canonical, report.produced) };
        if (report.produced >= opts.workCap) { report.capped = true; return report; }
      }
    } else {
      report.rejectedIllegal++;
    }

    // Odometer step through cartesian product.
    let i = usable.length - 1;
    for (; i >= 0; i--) {
      counters[i]++;
      if (counters[i] < usable[i].options.length) break;
      counters[i] = 0;
    }
    if (i < 0) break;
  }

  return report;
}

interface Pick { dimension: Dimension; option: DimensionOption }

function buildCandidate(
  picks: Pick[],
  opts: GenerateOptions,
  resolve: (item: ItemInstance) => ResolvedItem | null,
): Omit<Candidate, 'id'> | null {
  const gear = new Map<GearSlot, ItemInstance | null>();
  const consumables: Record<string, string> = {};
  let talents: string | undefined;
  let cost = emptyCost();
  const labels: string[] = [];
  const kinds = new Set<Candidate['provenance']['kind']>();
  // Gem/enchant/embellishment picks applied after gear so they attach to chosen item.
  const attachments = new Map<GearSlot, { gemIds?: number[]; enchantId?: number; embellishmentBonusId?: number }>();

  for (const { dimension, option } of picks) {
    cost = mergeCost(cost, option.cost);
    if (option.item !== undefined) {
      const slot = dimension.slot ?? option.item?.slot;
      if (!slot) return null;
      gear.set(slot, option.item ? { ...option.item, slot } : null);
    }
    for (const item of option.gear ?? []) gear.set(item.slot, item);
    if (option.gemIds !== undefined || option.enchantId !== undefined || option.embellishmentBonusId !== undefined) {
      if (!dimension.slot) return null;
      const existing = attachments.get(dimension.slot) ?? {};
      attachments.set(dimension.slot, {
        gemIds: option.gemIds ?? existing.gemIds,
        enchantId: option.enchantId ?? existing.enchantId,
        embellishmentBonusId: option.embellishmentBonusId ?? existing.embellishmentBonusId,
      });
    }
    if (option.talents !== undefined) talents = option.talents;
    if (option.consumable) consumables[option.consumable.kind] = option.consumable.option;
    if (option.label) labels.push(option.label);
    kinds.add(dimension.kind);
  }

  const mainHand = gear.has('main_hand') ? gear.get('main_hand') : opts.baselineGear.get('main_hand');
  // Two-hand main clears off-hand unless Titans Grip.
  const clearsOffHand = mainHand && resolve(mainHand)?.inventoryType === INVTYPE.TWOHAND && !opts.character.canTitansGrip;
  if (clearsOffHand) gear.set('off_hand', null);

  const embellishmentIds = new Set(opts.embellishmentBonusIds ?? []);
  for (const [slot, attach] of attachments) {
    if (slot === 'off_hand' && clearsOffHand) continue;
    const target = gear.has(slot) ? gear.get(slot) : opts.baselineGear.get(slot) ?? null;
    // Gem/enchant/embellishment with nothing to attach is not a candidate.
    if (!target) return null;
    // Embellishment REPLACES the existing one, not stack; one per item.
    const bonusIds = attach.embellishmentBonusId === undefined
      ? target.bonusIds
      : [
          ...target.bonusIds.filter((id) => !embellishmentIds.has(id)),
          ...(attach.embellishmentBonusId ? [attach.embellishmentBonusId] : []),
        ];
    const extra = { ...target.extra };
    if (attach.enchantId !== undefined) delete extra.enchant;
    if (attach.gemIds !== undefined) {
      delete extra.gems;
      delete extra.gem_bonus_id;
      delete extra.gem_ilevel;
    }
    gear.set(slot, {
      ...target,
      gemIds: attach.gemIds ?? target.gemIds,
      enchantId: attach.enchantId ?? target.enchantId,
      bonusIds,
      extra,
      // Enchanting/socketing changes configuration, not ownership.
      instanceId: target.instanceId,
    });
  }

  // Whole-set rules need baseline filled in around changed slots.
  const fullSet = new Map<GearSlot, ResolvedItem | null>();
  const physicalItems = new Set<string>();
  let vaultRewardId: string | undefined;
  let vaultItem: ItemInstance | undefined;
  for (const slot of GEAR_SLOTS) {
    const chosen = gear.has(slot) ? gear.get(slot)! : opts.baselineGear.get(slot) ?? null;
    if (chosen) {
      const physicalId = chosen.originalInstanceId ?? chosen.instanceId;
      if (physicalItems.has(physicalId)) return null;
      physicalItems.add(physicalId);
      if (chosen.vaultRewardId || chosen.source === 'vault') {
        // Two variants of one vault reward cannot fill two slots.
        if (vaultRewardId !== undefined) return null;
        vaultRewardId = chosen.vaultRewardId ?? physicalId;
        vaultItem = chosen;
      }
    }
    fullSet.set(slot, chosen ? resolve(chosen) : null);
  }
  const issues: LegalityIssue[] = checkGearSet(fullSet, opts.character);
  if (!isLegal(issues)) return null;

  if (opts.embellishmentLimit !== undefined && embellishmentIds.size > 0) {
    let worn = 0;
    for (const item of gear.values()) {
      if (!item) continue;
      if (item.bonusIds.some((id) => embellishmentIds.has(id))) worn++;
    }
    for (const [slot, item] of opts.baselineGear) {
      if (!item || gear.has(slot)) continue; // changed slots were counted above
      if (item.bonusIds.some((id) => embellishmentIds.has(id))) worn++;
    }
    if (worn > opts.embellishmentLimit) return null;
  }

  for (const requirement of opts.requiredSets ?? []) {
    let pieces = 0;
    for (const item of fullSet.values()) if (item?.setId === requirement.setId) pieces++;
    if (pieces < requirement.pieces) return null;
  }

  // Unchanged choices collapse onto untouched baseline.
  for (const [slot, item] of gear) {
    const baseline = opts.baselineGear.get(slot) ?? null;
    if ((!item && !baseline) || (item && baseline && serializeItem(item) === serializeItem(baseline))) gear.delete(slot);
  }

  // Only changed items are provenance.
  const items: ResolvedItem[] = [];
  const names = new Map<number, string>();
  for (const [slot, item] of gear) {
    if (!item) continue;
    const r = fullSet.get(slot);
    if (!r) return null;
    items.push(r);
    names.set(r.itemId, r.name);
  }

  const delta: CandidateDelta = {
    gear: gear.size ? gear : undefined,
    talents,
    consumables: Object.keys(consumables).length ? consumables : undefined,
  };
  const identityGear = new Map(gear);
  if (picks.some(({ option }) => option.gear?.some((item) => item.slot === 'finger1'))) {
    // Finger rings interchangeable but enchants stay with physical ring; compare enhanced pairs.
    const rings = (set: Map<GearSlot, ItemInstance | null>) => ['finger1', 'finger2'].map((slot) => set.get(slot as GearSlot) ?? null)
      .map((item) => item ? { ...item, slot: 'finger1' as const } : null)
      .sort((a, b) => (a ? serializeItem(a) : '').localeCompare(b ? serializeItem(b) : ''));
    const pair = rings(new Map([...opts.baselineGear, ...gear]));
    const baselinePair = rings(opts.baselineGear);
    identityGear.delete('finger1'); identityGear.delete('finger2');
    if (pair.some((item, i) => (item ? serializeItem(item) : '') !== (baselinePair[i] ? serializeItem(baselinePair[i]!) : ''))) {
      identityGear.set('finger1', pair[0]);
      identityGear.set('finger2', pair[1] ? { ...pair[1], slot: 'finger2' } : null);
    }
  }
  const canonical = canonicalize({ ...delta, gear: identityGear.size ? identityGear : undefined });

  return {
    provenance: {
      kind: kinds.size === 1 ? [...kinds][0] : 'mixed',
      items,
      label: labels.join(', ') || 'Variant',
      ...(vaultRewardId ? { vaultRewardId, vaultItem } : {}),
    },
    delta,
    cost,
    lines: deltaToLines(delta, names),
    canonical,
  };
}

/** Profileset lines from delta; gear first in fixed slot order; names from catalog when available. */
export function deltaToLines(delta: CandidateDelta, names?: Map<number, string>): string[] {
  const lines: string[] = [];
  if (delta.gear) {
    for (const slot of GEAR_SLOTS) {
      if (!delta.gear.has(slot)) continue;
      const item = delta.gear.get(slot) ?? null;
      lines.push(item ? serializeItem(item, { name: names?.get(item.itemId) }) : `${slot}=`);
    }
  }
  if (delta.talents !== undefined) lines.push(`talents=${delta.talents}`);
  for (const [kind, option] of Object.entries(delta.consumables ?? {})) lines.push(`${kind}=${option}`);
  lines.push(...(delta.extraLines ?? []));
  return lines;
}

/** Drains generator up to limit and returns report; use for small spaces, prefer lazy otherwise. */
export function collect(
  gen: Generator<Candidate, GenerationReport, undefined>,
  limit: number,
): { candidates: Candidate[]; report: GenerationReport } {
  const candidates: Candidate[] = [];
  let step = gen.next();
  while (!step.done && candidates.length < limit) {
    candidates.push(step.value);
    step = gen.next();
  }
  const report = step.done
    ? step.value
    : { produced: candidates.length, examined: candidates.length, rejectedIllegal: 0, duplicatesCollapsed: 0, capped: true, upperBound: Number.NaN, upperBoundExceedsSafeInteger: false, growthDrivers: [] };
  return { candidates, report };
}
