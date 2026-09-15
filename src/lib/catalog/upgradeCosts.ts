// Season upgrade costs and weekly crest supply from generated/upgrade-costs.json (engine-pinned DB2s). No hardcoded costs, currency ids, or caps.
import data from './generated/upgrade-costs.json';
import { GEAR_SLOTS, type GearSlot } from './types';

/** Crest wallet cap and weekly earn; unencoded fields are null and named in unavailable. */
export interface CapModel {
  /** CurrencyTypes.MaxQty (wallet cap). */
  maxQty: number | null;
  /** Weekly cap accumulation; null when unencoded in DB2. */
  perWeek: number | null;
  /** Season start quantity; null when unencoded. */
  startQuantity: number | null;
  rechargeAmount: number | null;
  cycleMs: number | null;
  maxQtyWorldStateId: number | null;
  unavailable: string[];
}

export interface CrestCurrency {
  id: number;
  name: string;
  /** Tier (1 = lowest); from CurrencyTypes.OrderIndex vs track order. */
  tier: number;
  trackId: number;
  trackLabel: string;
  cap: CapModel;
}

export interface Cost {
  /** Currency id to count mapping. */
  currencies: Record<number, number>;
  /** Gold in copper (ItemExtendedCost.Money), never waived. */
  money: number;
  fromRank: number;
  toRank: number;
  /** Non-empty when cost part missing from pinned data. */
  unavailable?: string[];
}

export interface SlotWatermarks {
  /** Enum.ItemRedundancySlot index as slot_high_watermarks writes; resolve from gear slot via watermarkSlotForGear. */
  slotIndex: number;
  watermarks: { slotIndex: number; current: number; max: number }[];
}

export const crestSeason = data.season;
export const crestBuild = data.build;
/** ISO season start (null if Raider.IO unavailable at generation). */
export const seasonStartsAt: string | null = data.season.startsAt ?? null;
/** Data-level gaps for whole table, not per-step. */
export const costUnavailable: string[] = data.unavailable;

const crests: CrestCurrency[] = data.crests.map(crest => ({
  id: crest.id, name: crest.name, tier: crest.tier,
  trackId: crest.trackId, trackLabel: crest.trackLabel, cap: crest.cap,
}));
const crestIds = new Set(crests.map(crest => crest.id));

/** Published weekly cap statement when available (not DB2 field; see capSearch in generated file). */
export const seasonCapSource: {
  url: string; fetchedAt: string; quote: string;
  perWeek: number | null; startQuantity: number | null; capRemovedAt: string | null;
} | null = data.seasonCapSource;

/** Enum.ItemRedundancySlot (addon watermark index space); from Blizzard API docs. */
export const watermarkSlots: readonly { index: number; name: string }[] = data.watermarkSlots ?? [];
export const watermarkSource = data.watermarkSource;

/** Enum field name for a watermark slot index, or null when it is not one. */
export function watermarkSlot(slotIndex: number): string | null {
  return watermarkSlots.find(entry => entry.index === slotIndex)?.name ?? null;
}

// Gear slot to Enum.ItemRedundancySlot mapping: redundancy groups (rings->Finger, trinkets->Trinket). Weapons absent (class-dependent). Only three spelling differences listed.
const GEAR_TO_ENUM: Partial<Record<GearSlot, string>> = {
  hands: 'Hand', back: 'Cloak', finger1: 'Finger', finger2: 'Finger',
  trinket1: 'Trinket', trinket2: 'Trinket',
};
const gearToIndex = new Map<GearSlot, number>(GEAR_SLOTS.flatMap(slot => {
  const name = GEAR_TO_ENUM[slot] ?? slot;
  const match = watermarkSlots.find(entry => entry.name.toLowerCase() === name.toLowerCase());
  return match ? [[slot, match.index] as const] : [];
}));
for (const slot of Object.keys(GEAR_TO_ENUM) as GearSlot[]) {
  if (watermarkSlots.length && !gearToIndex.has(slot)) {
    throw Error(`Enum.ItemRedundancySlot has no entry for ${slot}; regenerate upgrade-costs.json.`);
  }
}

/** Watermark slot index for gear slot; null for shirt/tabard and weapons (class-dependent). */
export function watermarkSlotForGear(slot: GearSlot): number | null {
  return gearToIndex.get(slot) ?? null;
}

/** Season crest currencies, lowest tier first. */
export function crestCurrencies(): CrestCurrency[] {
  return crests;
}

function track(trackId: number) {
  const found = data.tracks.find(entry => entry.trackId === trackId);
  if (!found) throw Error(`Unknown upgrade track ${trackId}.`);
  return found;
}

/** Summed cost fromRank to toRank on one track; unpurchasable steps list in unavailable, not treated as free. */
export function upgradeStepCost(trackId: number, fromRank: number, toRank: number): Cost {
  const steps = track(trackId).steps;
  if (!Number.isInteger(fromRank) || !Number.isInteger(toRank) || toRank < fromRank) {
    throw Error('Upgrade ranks must be whole numbers with toRank >= fromRank.');
  }
  const cost: Cost = { currencies: {}, money: 0, fromRank, toRank };
  const unavailable: string[] = [];
  for (let rank = fromRank + 1; rank <= toRank; rank++) {
    const step = steps.find(entry => entry.toRank === rank);
    if (!step) throw Error(`Unknown rank ${rank} on upgrade track ${trackId}.`);
    if (!step.currencies) {
      unavailable.push(`rank ${step.fromRank}->${rank}: ${step.unavailable?.join('; ') ?? 'no cost data'}`);
      continue;
    }
    for (const [id, count] of Object.entries(step.currencies)) {
      cost.currencies[Number(id)] = (cost.currencies[Number(id)] ?? 0) + count;
    }
    cost.money += step.money ?? 0;
  }
  if (unavailable.length) cost.unavailable = unavailable;
  return cost;
}

/** Slot discount watermark (max of character/account levels per simc-addon core.lua). */
export function effectiveWatermark(at: SlotWatermarks): number {
  const row = at.watermarks.find(entry => entry.slotIndex === at.slotIndex);
  return row ? Math.max(row.current, row.max) : 0;
}

/** Waive crests for steps at/below watermark; gold always charged. */
export function applyHighWatermark(cost: Cost, at: SlotWatermarks, trackId: number, toRank: number): Cost {
  if (toRank !== cost.toRank) throw Error('applyHighWatermark: toRank does not match the cost it was given.');
  const watermark = effectiveWatermark(at);
  const steps = track(trackId).steps;
  const waived: Cost = { ...cost, currencies: { ...cost.currencies } };
  for (let rank = cost.fromRank + 1; rank <= toRank; rank++) {
    const step = steps.find(entry => entry.toRank === rank);
    if (!step?.currencies || step.itemLevel > watermark) continue;
    for (const [id, count] of Object.entries(step.currencies)) {
      if (!crestIds.has(Number(id))) continue;
      const left = (waived.currencies[Number(id)] ?? 0) - count;
      if (left > 0) waived.currencies[Number(id)] = left;
      else delete waived.currencies[Number(id)];
    }
  }
  return waived;
}

/** Total crests obtainable by season week weekIndex (0 = first week); null if unencoded and no override. Mid-season removal is hotfix, not DB2 date. */
export function weeklyCrestCap(currency: CrestCurrency, weekIndex: number,
  opts?: { capRemoved?: boolean; perWeek?: number; startQuantity?: number }): number | null {
  if (!Number.isInteger(weekIndex) || weekIndex < 0) throw Error('weekIndex must be a whole number >= 0.');
  if (opts?.capRemoved) return Number.POSITIVE_INFINITY;
  const removedWeek = seasonCapSource?.capRemovedAt ? seasonWeekIndex(Date.parse(seasonCapSource.capRemovedAt)) : null;
  if (removedWeek !== null && weekIndex >= removedWeek) return Number.POSITIVE_INFINITY;
  const perWeek = opts?.perWeek ?? currency.cap.perWeek ?? seasonCapSource?.perWeek;
  if (perWeek === null || perWeek === undefined) return null;
  const start = opts?.startQuantity ?? currency.cap.startQuantity ?? seasonCapSource?.startQuantity ?? 0;
  return start + perWeek * (weekIndex + 1);
}

/** Season week at given date; null if season start unavailable. */
export function seasonWeekIndex(at: number | Date = Date.now()): number | null {
  if (!seasonStartsAt) return null;
  const elapsed = (at instanceof Date ? at.getTime() : at) - Date.parse(seasonStartsAt);
  return elapsed < 0 ? null : Math.floor(elapsed / 604_800_000);
}

/** Current crest amounts from an addon import, one entry per season crest. */
export function characterCrests(character: { currencies?: { upgrade?: Record<number, number> } }): Record<number, number> {
  const held = character.currencies?.upgrade ?? {};
  return Object.fromEntries(crests.map(crest => [crest.id, held[crest.id] ?? 0]));
}

/** Per-slot watermark levels from addon import, keyed by raw addon slot index. */
export function characterWatermarks(
  character: { highWatermarks?: { slotIndex: number; current: number; max: number }[] },
): Record<number, number> {
  return Object.fromEntries((character.highWatermarks ?? [])
    .map(row => [row.slotIndex, Math.max(row.current, row.max)]));
}
