// Crest Sim: pure; three-phase search (phase 1: anchor measurements, phase 2: knapsack, phase 3: top-K sims).

import { GEAR_SLOTS, type GearSlot, type ItemInstance, type ResolvedItem } from '../catalog/types';
import { itemUpgradeTrack, upgradeTracks, withUpgradeRank, type UpgradeTrack } from '../catalog/upgrades';
import { canonicalize, deltaToLines } from './candidates';
import type { Candidate, CandidateDelta, OptimizationProgress } from './types';

// Catalog port: cost table; shape changes fail at the adapter rather than throughout.

export type { CrestCurrency, Cost, SlotWatermarks } from '../catalog/upgradeCosts';
import type { CrestCurrency, Cost, SlotWatermarks } from '../catalog/upgradeCosts';

export interface UpgradeCosts {
  upgradeStepCost(trackId: number, fromRank: number, toRank: number): Cost;
  /** Waives crest costs covered by the slot's watermark, keyed by addon's Enum.ItemRedundancySlot index. */
  applyHighWatermark?(cost: Cost, at: SlotWatermarks, trackId: number, toRank: number): Cost;
}

/** Cumulative crests obtainable by season week; null if cap unknown, Infinity if removed. */
export type WeeklyCap = (
  currency: CrestCurrency,
  weekIndex: number,
  opts?: { capRemoved?: boolean; perWeek?: number; startQuantity?: number },
) => number | null;

// Candidate space

export interface CrestStep {
  /** Profileset-safe: `[A-Za-z0-9_-]` only. */
  id: string;
  slot: GearSlot;
  /** The baseline item, unchanged. */
  baseline: ItemInstance;
  /** The same physical item at `toRank`. */
  item: ItemInstance;
  trackId: number;
  trackLabel: string;
  fromRank: number;
  toRank: number;
  maxRank: number;
  itemLevel: number;
  ilvlDelta: number;
  /** Crest cost of going from `fromRank` straight to `toRank`, after watermarks. */
  cost: Record<number, number>;
  /** Gold portion, in copper. Never waived, and never part of the crest budget. */
  money: number;
  /** True when the watermark discount was applied to this step. */
  discounted: boolean;
}

export interface CrestExclusion {
  slot: GearSlot;
  itemName: string;
  rank: number | null;
  reason: string;
}

export interface CrestCandidateSet {
  steps: CrestStep[];
  excluded: CrestExclusion[];
}

export interface CrestCandidateOptions {
  costs: UpgradeCosts;
  /** The addon's rows, verbatim. Absent means no watermark discount is applied. */
  watermarks?: { slotIndex: number; current: number; max: number }[];
  /**
   * Gear slot -> the watermark slot index the addon writes. The catalog pins
   * `Enum.ItemRedundancySlot` in upgrade-costs.json and resolves this with
   * `watermarkSlotForGear`, which returns null for the slots the enum splits by
   * weapon class. A null, or no function at all, means the waiver is skipped and
   * the full cost stands — never a discount against a guessed index.
   */
  slotIndexFor?: (slot: GearSlot) => number | null | undefined;
  /** Display names by item id, for exclusion messages. */
  names?: ReadonlyMap<string, ResolvedItem>;
  /** Track table override, for tests. Defaults to the current season's tracks. */
  tracks?: UpgradeTrack[];
}

function nameOf(item: ItemInstance, names?: ReadonlyMap<string, ResolvedItem>): string {
  return names?.get(item.instanceId)?.name ?? item.addonName ?? `Item ${item.itemId}`;
}

/** `head`, `finger1`… are already safe; this only guards a future slot rename. */
function stepId(slot: GearSlot, rank: number): string {
  return `crest-${slot.replace(/[^A-Za-z0-9_-]/g, '_')}-${rank}`;
}

/** Every rank per (slot, rank); measured against baseline (as engine will simulate in phase 1), not rank below. */
export function crestCandidates(
  items: { slot: GearSlot; item: ItemInstance }[],
  opts: CrestCandidateOptions,
): CrestCandidateSet {
  const steps: CrestStep[] = [];
  const excluded: CrestExclusion[] = [];
  const tracks = opts.tracks ?? upgradeTracks;
  const seenSlots = new Set<GearSlot>();

  for (const { slot, item } of items) {
    // One item per slot: the baseline occupies it, and two candidates for one
    // slot would break the knapsack's exclusivity.
    if (seenSlots.has(slot)) continue;
    seenSlots.add(slot);
    const label = nameOf(item, opts.names);
    const known = itemUpgradeTrack(item);
    const track = known && tracks.find((t) => t.id === known.track.id);
    if (!known || !track) {
      excluded.push({ slot, itemName: label, rank: null, reason: 'no upgrade track this season recognises' });
      continue;
    }
    if (item.craftingQuality || item.craftedStats?.length) {
      excluded.push({ slot, itemName: label, rank: null, reason: 'crafted items use crafting quality, not crest upgrades' });
      continue;
    }
    const from = known.rank.rank;
    if (from >= track.max) {
      excluded.push({ slot, itemName: label, rank: null, reason: `already at ${track.label} ${from}/${track.max}` });
      continue;
    }

    for (const rank of track.ranks) {
      if (rank.rank <= from || rank.extended || rank.rank > track.max) continue;
      let cost: Cost;
      try {
        cost = opts.costs.upgradeStepCost(track.id, from, rank.rank);
      } catch (err) {
        excluded.push({ slot, itemName: label, rank: rank.rank, reason: reason(err) });
        continue;
      }
      let discounted = false;
      const slotIndex = opts.slotIndexFor?.(slot);
      if (opts.costs.applyHighWatermark && opts.watermarks && typeof slotIndex === 'number') {
        try {
          const after = opts.costs.applyHighWatermark(
            cost, { slotIndex, watermarks: opts.watermarks }, track.id, rank.rank,
          );
          discounted = total(after.currencies) < total(cost.currencies);
          cost = after;
        } catch (err) {
          excluded.push({ slot, itemName: label, rank: rank.rank, reason: reason(err) });
          continue;
        }
      }
      if (cost.unavailable?.length) {
        excluded.push({ slot, itemName: label, rank: rank.rank, reason: cost.unavailable.join('; ') });
        continue;
      }
      let upgraded: ItemInstance;
      try {
        upgraded = withUpgradeRank(item, track.id, rank.rank);
      } catch (err) {
        excluded.push({ slot, itemName: label, rank: rank.rank, reason: reason(err) });
        continue;
      }
      steps.push({
        id: stepId(slot, rank.rank),
        slot,
        baseline: item,
        item: upgraded,
        trackId: track.id,
        trackLabel: track.label,
        fromRank: from,
        toRank: rank.rank,
        maxRank: track.max,
        itemLevel: rank.itemLevel,
        ilvlDelta: rank.itemLevel - known.rank.itemLevel,
        cost: { ...cost.currencies },
        money: cost.money ?? 0,
        discounted,
      });
    }
  }
  return { steps, excluded };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function total(costs: Record<number, number>): number {
  return Object.values(costs).reduce((n, v) => n + v, 0);
}

// Budget

export interface BudgetSource {
  currencyId: number;
  name: string;
  held: number;
  /** Obtainable between now and the planned week, from the weekly caps. */
  earnable: number;
  total: number;
  /** Where the two numbers came from, shown verbatim. */
  note: string;
}

export interface CrestBudget {
  amounts: Record<number, number>;
  sources: BudgetSource[];
  /** Weeks the cap model actually covered; below the requested week means it ran out. */
  weeksCounted: number;
  warnings: string[];
}

export interface BudgetOptions {
  currencies: readonly CrestCurrency[];
  /** Crests on hand, by currency id. */
  held: Record<number, number>;
  /** False when the import had no currency block and nothing was typed in. */
  heldKnown: boolean;
  /** Absent means "spend only what is held". `week` is 0-based, like the catalog. */
  planAhead?: { week: number; capRemoved: boolean } | null;
  /** The season week the character is in now. Null when the season start is unknown. */
  currentWeek?: number | null;
  weeklyCap?: WeeklyCap;
  /**
   * Per-week earn rate the user supplied, by currency id. NEITHER THE PINNED
   * BUILD NOR ANY PUBLISHED SOURCE STATES ONE (crest-data.md D3), so without
   * this, planning ahead adds nothing rather than inventing a rate.
   */
  perWeek?: Record<number, number>;
  /** Season-start grant the user supplied, by currency id. Same rule. */
  startQuantity?: Record<number, number>;
}

/** Budget and sources; weeklyCrestCap is cumulative from season start; unknown current week triggers warning (no silent overlap). */
export function crestBudget(opts: BudgetOptions): CrestBudget {
  const amounts: Record<number, number> = {};
  const sources: BudgetSource[] = [];
  const warnings: string[] = [];
  if (!opts.heldKnown) {
    warnings.push('This export carries no crest amounts, so they have to be entered by hand.');
  }
  const ahead = opts.planAhead ?? null;
  const cap = opts.weeklyCap;
  const from = typeof opts.currentWeek === 'number' && opts.currentWeek >= 0 ? opts.currentWeek : null;
  const weeksCounted = ahead && from !== null ? Math.max(0, ahead.week - from) : 0;

  for (const currency of opts.currencies) {
    const held = Math.max(0, Math.floor(opts.held[currency.id] ?? 0));
    let earnable = 0;
    let note = `${held} held ${opts.heldKnown ? '(from the import)' : '(entered by hand)'}`;

    if (ahead && cap) {
      const perWeek = opts.perWeek?.[currency.id];
      const startQuantity = opts.startQuantity?.[currency.id];
      const at = (week: number) => cap(currency, week, {
        capRemoved: ahead.capRemoved,
        ...(typeof perWeek === 'number' && Number.isFinite(perWeek) ? { perWeek } : {}),
        ...(typeof startQuantity === 'number' && Number.isFinite(startQuantity) ? { startQuantity } : {}),
      });
      const target = at(ahead.week);
      if (target === null) {
        warnings.push(
          `No weekly earn rate for ${currency.name} is in the pinned game data or in any published `
          + 'source, so planning ahead adds nothing for it. Enter a per-week amount to include it.',
        );
      } else if (target === Number.POSITIVE_INFINITY) {
        // No cap means no ceiling here. `cap.maxQty` is the WALLET cap — how many
        // may be held at once, not how many may be earned — so it is not a bound
        // on this and must not be used as one.
        earnable = Number.POSITIVE_INFINITY;
        note += ' + no limit (the weekly cap is treated as removed)';
      } else {
        const base = from !== null ? at(from) : null;
        earnable = Math.max(0, Math.floor(target - (base ?? 0)));
        note += from !== null
          ? ` + ${earnable} earnable over ${weeksCounted} week${weeksCounted === 1 ? '' : 's'} to week ${ahead.week + 1}`
          : ` + ${earnable} = the whole season cap through week ${ahead.week + 1}`;
        if (from === null) {
          warnings.push(
            'The season start is not in this build, so the current week is unknown: the plan-ahead '
            + 'figure is the whole season cap and overlaps the crests already held.',
          );
        }
        if (typeof perWeek === 'number') note += ` at ${perWeek}/week (entered by hand)`;
        if (typeof startQuantity === 'number') note += `, ${startQuantity} at season start (entered by hand)`;
      }
    } else if (ahead && !cap) {
      warnings.push('This build has no weekly cap model, so planning ahead adds nothing.');
    }

    amounts[currency.id] = held + earnable;
    sources.push({ currencyId: currency.id, name: currency.name, held, earnable, total: held + earnable, note });
  }
  return { amounts, sources, weeksCounted, warnings };
}

// Phase 2: knapsack

export interface Marginal {
  id: string;
  /** Exclusivity group. One choice per group; the slot, in practice. */
  slot: string;
  /** DPS gain over the baseline: measured for an anchor, modelled otherwise. */
  gain: number;
  cost: Record<number, number>;
  /** The measurement's own confidence margin. Absent on a modelled gain. */
  margin?: number | null;
  /** False when the measured gain sits inside its error bars. Null when unknown. */
  significant?: boolean | null;
  /** True when the gain was derived from another rank rather than measured. */
  modelled?: boolean;
}

/** One measurement per item yields gain for every rank; gain interpolated from anchor (modelled, clamped to [0, anchor]); phase 3 re-simulates. */
export function marginalsFrom(
  steps: readonly CrestStep[],
  measured: ReadonlyMap<string, { gain: number; margin: number | null; significant: boolean | null }>,
): { marginals: Marginal[]; unmeasured: GearSlot[] } {
  const bySlot = new Map<GearSlot, CrestStep[]>();
  for (const step of steps) bySlot.set(step.slot, [...(bySlot.get(step.slot) ?? []), step]);

  const marginals: Marginal[] = [];
  const unmeasured: GearSlot[] = [];
  for (const [slot, list] of bySlot) {
    // The highest-ranked step that actually has a measurement anchors the slot.
    const anchor = [...list]
      .sort((a, b) => b.toRank - a.toRank)
      .find((step) => measured.has(step.id));
    if (!anchor) { unmeasured.push(slot); continue; }
    const at = measured.get(anchor.id)!;
    for (const step of list) {
      const own = measured.get(step.id);
      if (own) {
        // A NEGATIVE MEASUREMENT THAT IS NOT SEPARABLE IS NOT A LOSS. Two
        // identical browser runs picked different plans because each dropped a
        // different item on an anchor that came back slightly below the
        // baseline, well inside its own error bars. "Below zero" and "cannot be
        // told apart from zero" are different findings: the second becomes a
        // zero gain and stays eligible, so the item can still be bought when
        // nothing better competes for the crests.
        const separable = own.significant === true;
        marginals.push({
          id: step.id, slot, cost: step.cost,
          gain: !separable && own.gain < 0 ? 0 : own.gain,
          margin: own.margin, significant: own.significant,
        });
        continue;
      }
      const share = anchor.ilvlDelta > 0 ? step.ilvlDelta / anchor.ilvlDelta : 0;
      const bound = Math.max(0, at.gain);
      marginals.push({
        id: step.id, slot, cost: step.cost,
        gain: Math.min(bound, Math.max(0, at.gain * share)),
        modelled: true,
      });
    }
  }
  return { marginals, unmeasured };
}

export interface CrestPlan {
  ids: string[];
  /** Sum of the per-item marginal gains. An estimate — phase 3 measures the truth. */
  gain: number;
  spent: Record<number, number>;
}

/** Highest reachable rank per item: the one rank phase 1 actually simulates. */
export function anchorSteps(steps: readonly CrestStep[]): CrestStep[] {
  const best = new Map<GearSlot, CrestStep>();
  for (const step of steps) {
    const current = best.get(step.slot);
    if (!current || step.toRank > current.toRank) best.set(step.slot, step);
  }
  return [...best.values()];
}

export interface KnapsackResult {
  plans: CrestPlan[];
  /** False when the node cap stopped the search before the space was exhausted. */
  exhaustive: boolean;
  nodes: number;
  /**
   * Options the search could not use, and why. An upgrade the engine measured as
   * no better than the baseline is reported here rather than vanishing: the
   * difference between "not worth buying" and "silently missing" is the whole
   * reason this list exists.
   */
  skipped: { id: string; slot: string; reason: string }[];
  /**
   * Ranks the engine measured at or below the baseline but could NOT separate
   * from it. Still eligible — the search simply never prefers them — and named
   * so the UI reports a precision limit rather than a verdict.
   */
  notSeparable: string[];
}

/** Top-K plans, branch-and-bound; nodeCap is safety rail (ponytail: raise if tripped). */
export function solveKnapsack(
  marginals: Marginal[],
  budget: Record<number, number>,
  k = 5,
  nodeCap = 500_000,
): KnapsackResult {
  const byGroup = new Map<string, Marginal[]>();
  const skipped: KnapsackResult['skipped'] = [];
  const notSeparable: string[] = [];
  for (const m of marginals) {
    // Non-positive gain is reported (not silently dropped) to distinguish "cannot tell apart" from "not worth it".
    if (m.gain <= 0 && m.significant === true) {
      // A measured, separable non-gain. Spending a budget on it is never right.
      skipped.push({ id: m.id, slot: m.slot, reason: 'measured no improvement over the current gear' });
      continue;
    }
    if (!(m.gain > 0)) {
      // Zero gain: evidence doesn't rule it out; skip enumeration (only unmeasurable rank differs); fix via precision.
      notSeparable.push(m.id);
      continue;
    }
    if (!affordable(m.cost, budget)) {
      skipped.push({ id: m.id, slot: m.slot, reason: 'costs more than the budget' });
      continue;
    }
    const list = byGroup.get(m.slot) ?? [];
    list.push(m);
    byGroup.set(m.slot, list);
  }
  const groups = [...byGroup.values()].map((list) => [...list].sort((a, b) => b.gain - a.gain));
  // Biggest opportunity first: a strong incumbent early is what makes the bound bite.
  groups.sort((a, b) => b[0].gain - a[0].gain);

  const suffix = Array.from({ length: groups.length + 1 }, () => 0);
  for (let i = groups.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + groups[i][0].gain;

  const best: CrestPlan[] = [];
  let nodes = 0;
  let exhaustive = true;

  const record = (ids: string[], gain: number, spent: Record<number, number>): void => {
    if (!ids.length) return;
    best.push({ ids: [...ids], gain, spent: { ...spent } });
    best.sort((a, b) => b.gain - a.gain);
    if (best.length > k) best.length = k;
  };

  const chosen: string[] = [];
  const spent: Record<number, number> = {};

  const walk = (i: number, gain: number): void => {
    if (!exhaustive) return;
    if (++nodes > nodeCap) { exhaustive = false; return; }
    if (i === groups.length) { record(chosen, gain, spent); return; }
    // Strictly worse than the K-th kept plan can never enter it.
    if (best.length >= k && gain + suffix[i] < best[best.length - 1].gain) return;

    for (const option of groups[i]) {
      if (!affordable(option.cost, budget, spent)) continue;
      for (const [id, n] of Object.entries(option.cost)) spent[Number(id)] = (spent[Number(id)] ?? 0) + n;
      chosen.push(option.id);
      walk(i + 1, gain + option.gain);
      chosen.pop();
      for (const [id, n] of Object.entries(option.cost)) spent[Number(id)] = (spent[Number(id)] ?? 0) - n;
      if (!exhaustive) return;
    }
    walk(i + 1, gain); // take nothing in this group
  };

  walk(0, 0);
  return { plans: best, exhaustive, nodes, skipped, notSeparable };
}

function affordable(cost: Record<number, number>, budget: Record<number, number>, spent?: Record<number, number>): boolean {
  for (const [id, n] of Object.entries(cost)) {
    if (n <= 0) continue;
    if ((budget[Number(id)] ?? 0) - (spent?.[Number(id)] ?? 0) < n) return false;
  }
  return true;
}

// Breaking a tie between plans

/** Rank reached in each slot. A slot the plan does not touch keeps rank 0. */
function ranksOf(plan: CrestPlan, steps: ReadonlyMap<string, CrestStep>): Map<GearSlot, number> {
  const ranks = new Map<GearSlot, number>();
  for (const id of plan.ids) {
    const step = steps.get(id);
    if (step) ranks.set(step.slot, step.toRank);
  }
  return ranks;
}

/** Total item levels a plan adds, across every slot it upgrades. */
export function planItemLevels(plan: CrestPlan, steps: ReadonlyMap<string, CrestStep>): number {
  return plan.ids.reduce((sum, id) => sum + (steps.get(id)?.ilvlDelta ?? 0), 0);
}

/**
 * True when `a` reaches at least `b`'s rank in every slot and beats it somewhere.
 * `a` is then the same plan with more bought, and is never the worse choice.
 */
export function dominates(a: CrestPlan, b: CrestPlan, steps: ReadonlyMap<string, CrestStep>): boolean {
  const left = ranksOf(a, steps);
  const right = ranksOf(b, steps);
  let better = false;
  for (const slot of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(slot) ?? 0;
    const y = right.get(slot) ?? 0;
    if (x < y) return false;
    if (x > y) better = true;
  }
  return better;
}

/** Which plan to recommend from tied plans: undominated > most item levels > order given (mean carries no info in tie). */
export function preferredPlan(
  tied: readonly { id: string; plan: CrestPlan }[],
  steps: ReadonlyMap<string, CrestStep>,
): string | null {
  if (!tied.length) return null;
  const undominated = tied.filter((x) => !tied.some((y) => y !== x && dominates(y.plan, x.plan, steps)));
  const field = undominated.length ? undominated : tied;
  let best = field[0];
  for (const entry of field.slice(1)) {
    if (planItemLevels(entry.plan, steps) > planItemLevels(best.plan, steps)) best = entry;
  }
  return best.id;
}

// Presentation

export interface PlanLine {
  stepId: string;
  slot: GearSlot;
  slotLabel: string;
  itemName: string;
  trackLabel: string;
  fromRank: number;
  toRank: number;
  maxRank: number;
  ilvlDelta: number;
  discounted: boolean;
  hypothetical: boolean;
  /** True when this rank's gain was interpolated rather than measured on its own. */
  modelled: boolean;
  costs: { currencyId: number; name: string; amount: number }[];
  /** The whole row as one sentence, which is also what a screen reader gets. */
  text: string;
}

const SLOT_ORDER = new Map(GEAR_SLOTS.map((slot, i) => [slot, i] as const));

/** One ordered row per upgrade in the plan, gear-slot order; slotLabels from UI. */
export function planLines(
  plan: CrestPlan,
  steps: ReadonlyMap<string, CrestStep>,
  currencies: readonly CrestCurrency[],
  opts: {
    slotLabels?: Record<string, string>;
    names?: ReadonlyMap<string, ResolvedItem>;
    /** Step ids whose gain was modelled rather than measured. */
    modelled?: ReadonlySet<string>;
  } = {},
): PlanLine[] {
  const currencyName = new Map(currencies.map((c) => [c.id, c.name] as const));
  return plan.ids
    .flatMap((id) => { const step = steps.get(id); return step ? [step] : []; })
    .sort((a, b) => (SLOT_ORDER.get(a.slot) ?? 99) - (SLOT_ORDER.get(b.slot) ?? 99))
    .map((step) => {
      const slotLabel = opts.slotLabels?.[step.slot] ?? step.slot;
      const itemName = nameOf(step.baseline, opts.names);
      const costs = Object.entries(step.cost)
        .map(([id, amount]) => ({ currencyId: Number(id), name: currencyName.get(Number(id)) ?? `Currency ${id}`, amount }))
        .filter((c) => c.amount > 0)
        .sort((a, b) => b.amount - a.amount);
      const priced = costs.length
        ? `costs ${costs.map((c) => `${c.amount.toLocaleString()} ${c.name}`).join(', ')}`
        : 'costs nothing';
      return {
        stepId: step.id,
        slot: step.slot,
        slotLabel,
        itemName,
        trackLabel: step.trackLabel,
        fromRank: step.fromRank,
        toRank: step.toRank,
        maxRank: step.maxRank,
        ilvlDelta: step.ilvlDelta,
        discounted: step.discounted,
        modelled: opts.modelled?.has(step.id) ?? false,
        hypothetical: step.item.source === 'hypothetical' || step.item.upgradeTrackHypothetical === true,
        costs,
        text: `${slotLabel} — ${itemName}: rank ${step.fromRank} → ${step.toRank}`
          + ` (+${step.ilvlDelta} ilvl), ${priced}`,
      };
    });
}

export interface CurrencyTotal {
  currencyId: number;
  name: string;
  spent: number;
  budget: number;
  remaining: number;
}

/** Gold the plan costs, in copper. Never waived, and never part of the crest budget. */
export function planMoney(plan: CrestPlan, steps: ReadonlyMap<string, CrestStep>): number {
  return plan.ids.reduce((sum, id) => sum + (steps.get(id)?.money ?? 0), 0);
}

export function planTotals(
  plan: CrestPlan,
  budget: Record<number, number>,
  currencies: readonly CrestCurrency[],
): CurrencyTotal[] {
  return currencies.map((currency) => {
    const spent = plan.spent[currency.id] ?? 0;
    const available = budget[currency.id] ?? 0;
    return { currencyId: currency.id, name: currency.name, spent, budget: available, remaining: available - spent };
  });
}

// Candidates for the engine

function toCandidate(
  id: string,
  label: string,
  gear: Map<GearSlot, ItemInstance>,
  costs: Record<number, number>,
  resolved?: ReadonlyMap<string, ResolvedItem>,
): Candidate {
  const delta: CandidateDelta = { gear: new Map<GearSlot, ItemInstance | null>(gear) };
  const names = new Map<number, string>();
  const items: ResolvedItem[] = [];
  for (const item of gear.values()) {
    const r = resolved?.get(item.instanceId) ?? resolved?.get(item.originalInstanceId ?? '');
    if (r) { items.push(r); names.set(r.itemId, r.name); }
  }
  return {
    id,
    provenance: { kind: 'gear', items, label },
    delta,
    cost: { currencies: Object.keys(costs).length ? { ...costs } : undefined, unknownCosts: [] },
    lines: deltaToLines(delta, names),
    canonical: canonicalize(delta),
  };
}

/** Phase 1: one item at one rank, everything else untouched. */
export function stepCandidate(step: CrestStep, resolved?: ReadonlyMap<string, ResolvedItem>): Candidate {
  const label = `${nameOf(step.baseline, resolved)} ${step.trackLabel} ${step.toRank}/${step.maxRank}`;
  return toCandidate(step.id, label, new Map([[step.slot, step.item]]), step.cost, resolved);
}

/** Phase 3: a whole plan, since per-item gains do not simply add up. */
export function planCandidate(
  plan: CrestPlan,
  steps: ReadonlyMap<string, CrestStep>,
  index: number,
  resolved?: ReadonlyMap<string, ResolvedItem>,
): Candidate {
  const gear = new Map<GearSlot, ItemInstance>();
  for (const id of plan.ids) {
    const step = steps.get(id);
    if (step) gear.set(step.slot, step.item);
  }
  return toCandidate(`plan-${index}`, `Plan ${index + 1} — ${gear.size} upgrade${gear.size === 1 ? '' : 's'}`, gear, plan.spent, resolved);
}

// Progress

/** Progress 0..1: max(engine samples, pass counter); keep high-water mark from onProgress, not $derived (state inside derived crashed screen). */
export function searchFraction(p: OptimizationProgress | null): number {
  if (!p) return 0;
  const spent = p.samplesSpent ?? 0;
  const total = spent + (p.estimatedSamplesRemaining ?? 0);
  const bySamples = total > 0 ? spent / total : 0;
  const inBatch = p.candidatesInBatch ? (p.candidatesDoneInBatch ?? 0) / p.candidatesInBatch : 0;
  const inPass = (p.batchIndex + clamp01(inBatch)) / Math.max(1, p.batchCount);
  const byPass = (p.stageIndex + clamp01(inPass)) / Math.max(p.stageCount, p.stageIndex + 1);
  return clamp01(Math.max(bySamples, byPass));
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Phase 3 target error: ceiling = min(user, phase-1); floor = cost parity (anchorTargetError · √(plans/anchors)); separates top two plans. */
export function planTargetError(opts: {
  /** Phase 2's estimated gain per plan, best first — the plans phase 3 will run. */
  planGains: readonly number[];
  /** The phase-1 baseline mean the target error is a percentage of. */
  baselineMean: number;
  /** Phase 1's anchor precision, and how many anchors it bought at that price. */
  anchorTargetError: number;
  anchorCount: number;
  /** The user's accuracy setting. A CEILING on looseness, never a floor on tightness. */
  userTargetError: number;
}): number {
  const ceiling = Math.min(opts.userTargetError, opts.anchorTargetError);
  const plans = Math.max(1, opts.planGains.length);
  const anchors = Math.max(1, opts.anchorCount);
  const floor = Math.min(ceiling, opts.anchorTargetError * Math.sqrt(plans / anchors));
  const gap = opts.planGains.length >= 2 ? opts.planGains[0] - opts.planGains[1] : 0;
  if (!(gap > 0) || !(opts.baselineMean > 0)) return floor;
  const needed = (100 * gap) / (Math.SQRT2 * opts.baselineMean);
  return Math.min(ceiling, Math.max(floor, needed));
}

/** Phase weights: 1 & 3 buy equal samples (cost parity), 2 is sliver (pure, milliseconds); fixed weights not live model (ponytail). */
export const PHASE_WEIGHTS = [0.49, 0.02, 0.49] as const;

/** Progress across the whole run: the phase's own share, scaled by `searchFraction`. */
export function phaseFraction(
  p: OptimizationProgress | null,
  phase: number,
  weights: readonly number[] = PHASE_WEIGHTS,
): number {
  if (phase < 1 || !weights.length) return 0;
  const i = Math.min(phase, weights.length) - 1;
  let before = 0;
  for (let n = 0; n < i; n++) before += weights[n];
  return clamp01(before + weights[i] * searchFraction(p));
}
