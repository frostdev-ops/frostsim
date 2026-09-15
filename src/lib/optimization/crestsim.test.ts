import { describe, expect, it } from 'vitest';
import {
  anchorSteps, crestBudget, crestCandidates, dominates, marginalsFrom, planCandidate,
  PHASE_WEIGHTS, phaseFraction, planItemLevels, planLines, planMoney, planTargetError, planTotals,
  preferredPlan, searchFraction, solveKnapsack, stepCandidate,
  type Cost, type CrestCurrency, type CrestPlan, type Marginal, type UpgradeCosts, type WeeklyCap,
} from './crestsim';
import { upgradeTracks } from '../catalog/upgrades';
import type { ItemInstance } from '../catalog/types';
import type { OptimizationProgress } from './types';

const WEATHERED = 1;
const CARVED = 2;
const RUNED = 3;
const cap = (maxQty: number | null, perWeek: number | null = null) => ({
  maxQty, perWeek, startQuantity: null, rechargeAmount: null, cycleMs: null,
  maxQtyWorldStateId: null, unavailable: [],
});
const CURRENCIES: CrestCurrency[] = [
  { id: WEATHERED, name: 'Weathered Crest', tier: 1, trackId: 614, trackLabel: 'Adventurer', cap: cap(100) },
  { id: CARVED, name: 'Carved Crest', tier: 2, trackId: 615, trackLabel: 'Veteran', cap: cap(100) },
  { id: RUNED, name: 'Runed Crest', tier: 3, trackId: 616, trackLabel: 'Champion', cap: cap(null) },
];

/** Stands in for catalog's cost table; prices are test fixtures, real numbers from upgradeCosts.ts. */
function fakeCosts(over: Partial<UpgradeCosts> = {}): UpgradeCosts {
  return {
    upgradeStepCost: (_trackId, fromRank, toRank) => {
      const currencies: Record<number, number> = {};
      for (let r = fromRank + 1; r <= toRank; r++) {
        const id = r <= 3 ? WEATHERED : r <= 5 ? CARVED : RUNED;
        currencies[id] = (currencies[id] ?? 0) + 15;
      }
      return { currencies, money: 100_000 * (toRank - fromRank), fromRank, toRank };
    },
    ...over,
  };
}

const track = upgradeTracks[0];
function item(bonusId: number, extra: Partial<ItemInstance> = {}): ItemInstance {
  return { instanceId: `i${bonusId}`, itemId: 1234, slot: 'head', bonusIds: [bonusId], gemIds: [], ...extra };
}

describe('crestCandidates', () => {
  it('produces one step per reachable rank, costed, with the item level delta', () => {
    const from = track.ranks[1]; // rank 2
    const { steps, excluded } = crestCandidates(
      [{ slot: 'head', item: item(from.bonusId) }],
      { costs: fakeCosts() },
    );
    expect(excluded).toEqual([]);
    expect(steps.map((s) => s.toRank)).toEqual([3, 4, 5, 6]);
    expect(steps.every((s) => s.fromRank === 2 && s.slot === 'head' && s.maxRank === track.max)).toBe(true);
    expect(steps.every((s) => /^[A-Za-z0-9_-]+$/.test(s.id))).toBe(true);
    const last = steps[steps.length - 1];
    expect(last.ilvlDelta).toBe(track.ranks[5].itemLevel - from.itemLevel);
    // 4 ranks: rank 3 weathered, 4 and 5 carved, 6 runed.
    expect(last.cost).toEqual({ [WEATHERED]: 15, [CARVED]: 30, [RUNED]: 15 });
    // Upgraded instance is same physical item at new rank.
    expect(last.item.originalInstanceId).toBe('i' + from.bonusId);
    expect(last.item.bonusIds).toContain(track.ranks[5].bonusId);
  });

  it('excludes and reports ranks whose cost is unavailable, and items with no track', () => {
    const costs = fakeCosts({
      upgradeStepCost: (_t, fromRank, toRank): Cost => toRank >= 5
        ? { currencies: {}, money: 0, fromRank, toRank, unavailable: ['no price for rank ' + toRank] }
        : { currencies: { [WEATHERED]: 10 }, money: 0, fromRank, toRank },
    });
    const { steps, excluded } = crestCandidates([
      { slot: 'head', item: item(track.ranks[0].bonusId) },
      { slot: 'chest', item: { ...item(track.ranks[0].bonusId), slot: 'chest', instanceId: 'crafted', craftingQuality: 5 } },
      { slot: 'hands', item: { ...item(0), slot: 'hands', instanceId: 'unknown', bonusIds: [] } },
    ], { costs });
    expect(steps.map((s) => s.toRank)).toEqual([2, 3, 4]);
    expect(excluded.filter((e) => e.slot === 'head').map((e) => e.rank)).toEqual([5, 6]);
    expect(excluded.find((e) => e.slot === 'head')?.reason).toContain('no price for rank 5');
    expect(excluded.find((e) => e.slot === 'chest')?.reason).toContain('crafted');
    expect(excluded.find((e) => e.slot === 'hands')?.reason).toContain('no upgrade track');
  });

  it('applies the high watermark discount by raw slot index and marks the step discounted', () => {
    const costs = fakeCosts({
      applyHighWatermark: (cost, at, _trackId, toRank) => {
        expect(at.slotIndex).toBe(0);
        expect(at.watermarks).toEqual([{ slotIndex: 0, current: 328, max: 328 }]);
        return toRank <= 3 ? { ...cost, currencies: {} } : cost;
      },
    });
    const opts = {
      costs,
      watermarks: [{ slotIndex: 0, current: 328, max: 328 }],
      slotIndexFor: (slot: string) => (slot === 'head' ? 0 : null),
    };
    const { steps } = crestCandidates([{ slot: 'head', item: item(track.ranks[0].bonusId) }], opts);
    expect(steps.filter((s) => s.discounted).map((s) => s.toRank)).toEqual([2, 3]);
    expect(steps[0].cost).toEqual({});

    // No slot-index mapping: no discount, not guessed one.
    const undiscounted = crestCandidates(
      [{ slot: 'head', item: item(track.ranks[0].bonusId) }],
      { ...opts, slotIndexFor: () => null },
    );
    expect(undiscounted.steps.some((s) => s.discounted)).toBe(false);
    expect(undiscounted.steps[0].cost).toEqual({ [WEATHERED]: 15 });
  });

  it('keeps one item per slot and skips an item already at max rank', () => {
    const maxed = item(track.ranks[track.max - 1].bonusId);
    const { steps, excluded } = crestCandidates([
      { slot: 'head', item: maxed },
      { slot: 'head', item: item(track.ranks[0].bonusId) },
    ], { costs: fakeCosts() });
    expect(steps).toEqual([]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].reason).toContain('already at');
  });
});

// --- knapsack --------------------------------------------------------------

function brute(marginals: Marginal[], budget: Record<number, number>): number {
  const slots = [...new Set(marginals.map((m) => m.slot))];
  let best = 0;
  const walk = (i: number, gain: number, spent: Record<number, number>): void => {
    if (i === slots.length) { best = Math.max(best, gain); return; }
    walk(i + 1, gain, spent);
    for (const option of marginals.filter((m) => m.slot === slots[i])) {
      const next = { ...spent };
      let ok = true;
      for (const [id, n] of Object.entries(option.cost)) {
        next[Number(id)] = (next[Number(id)] ?? 0) + n;
        if (next[Number(id)] > (budget[Number(id)] ?? 0)) ok = false;
      }
      if (ok) walk(i + 1, gain + option.gain, next);
    }
  };
  walk(0, 0, {});
  return best;
}

describe('solveKnapsack', () => {
  it('matches brute force on random small instances', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let trial = 0; trial < 40; trial++) {
      const marginals: Marginal[] = [];
      for (let slot = 0; slot < 5; slot++) {
        for (let rank = 0; rank < 4; rank++) {
          marginals.push({
            id: `s${slot}r${rank}`,
            slot: `slot${slot}`,
            gain: 100 + rnd(900),
            cost: { [WEATHERED]: 5 + rnd(40), [CARVED]: rnd(30) },
          });
        }
      }
      const budget = { [WEATHERED]: 40 + rnd(80), [CARVED]: 20 + rnd(60) };
      const r = solveKnapsack(marginals, budget, 5);
      expect(r.exhaustive).toBe(true);
      expect(r.plans[0].gain).toBeCloseTo(brute(marginals, budget), 6);
    }
  });

  it('never picks two ranks of one slot and never exceeds a budget', () => {
    const marginals: Marginal[] = [
      { id: 'a1', slot: 'head', gain: 100, cost: { [WEATHERED]: 10 } },
      { id: 'a2', slot: 'head', gain: 180, cost: { [WEATHERED]: 20 } },
      { id: 'b1', slot: 'chest', gain: 90, cost: { [WEATHERED]: 10 } },
      { id: 'b2', slot: 'chest', gain: 150, cost: { [WEATHERED]: 25 } },
    ];
    const r = solveKnapsack(marginals, { [WEATHERED]: 30 }, 8);
    for (const plan of r.plans) {
      expect(new Set(plan.ids.map((id) => id[0])).size).toBe(plan.ids.length);
      expect(plan.spent[WEATHERED]).toBeLessThanOrEqual(30);
    }
    expect(r.plans[0].ids.sort()).toEqual(['a2', 'b1']);
  });

  it('reports every option it leaves out instead of dropping it silently', () => {
    const r = solveKnapsack([
      { id: 'too-dear', slot: 'head', gain: 5000, cost: { [RUNED]: 1 } },
      { id: 'flat', slot: 'chest', gain: 0, cost: { [WEATHERED]: 1 }, significant: false },
      { id: 'worse', slot: 'waist', gain: -50, cost: { [WEATHERED]: 1 }, significant: true },
      { id: 'guessed', slot: 'feet', gain: 0, cost: { [WEATHERED]: 1 }, modelled: true },
      { id: 'real', slot: 'legs', gain: 10, cost: { [WEATHERED]: 1 } },
    ], { [WEATHERED]: 10 }, 5);
    expect(r.plans.map((p) => p.ids)).toEqual([['real']]);
    // Only SEPARABLE non-gain refused outright.
    expect(r.skipped.map((s) => s.id).sort()).toEqual(['too-dear', 'worse']);
    expect(r.skipped.find((s) => s.id === 'worse')?.reason).toBe('measured no improvement over the current gear');
    expect(r.skipped.find((s) => s.id === 'too-dear')?.reason).toBe('costs more than the budget');
    // One engine could not separate from baseline stays eligible, named as precision limit not verdict. Same for derived zero.
    expect(r.notSeparable.sort()).toEqual(['flat', 'guessed']);
  });

  it('surfaces tied plans rather than collapsing them', () => {
    const r = solveKnapsack([
      { id: 'a', slot: 'head', gain: 100, cost: { [WEATHERED]: 10 } },
      { id: 'b', slot: 'chest', gain: 100, cost: { [WEATHERED]: 10 } },
    ], { [WEATHERED]: 10 }, 5);
    expect(r.plans.slice(0, 2).map((p) => p.gain)).toEqual([100, 100]);
    expect(r.plans.slice(0, 2).map((p) => p.ids[0]).sort()).toEqual(['a', 'b']);
  });

  it('reports a truncated search instead of claiming an exhaustive one', () => {
    const marginals: Marginal[] = [];
    for (let slot = 0; slot < 16; slot++) {
      for (let rank = 0; rank < 8; rank++) {
        marginals.push({ id: `s${slot}r${rank}`, slot: `slot${slot}`, gain: rank + 1, cost: { [WEATHERED]: 1 } });
      }
    }
    const r = solveKnapsack(marginals, { [WEATHERED]: 999 }, 5, 50);
    expect(r.exhaustive).toBe(false);
    expect(r.nodes).toBeGreaterThan(50);
  });

  it('returns nothing when there is no budget', () => {
    expect(solveKnapsack([{ id: 'a', slot: 'head', gain: 1, cost: { [WEATHERED]: 1 } }], {}, 5).plans).toEqual([]);
  });
});

// --- anchors and derived marginals -----------------------------------------

describe('anchorSteps and marginalsFrom', () => {
  const { steps } = crestCandidates([
    { slot: 'head', item: { ...item(track.ranks[0].bonusId), instanceId: 'head-1' } },
    { slot: 'chest', item: { ...item(track.ranks[0].bonusId), slot: 'chest', instanceId: 'chest-1' } },
  ], { costs: fakeCosts() });

  it('measures one rank per item: the highest reachable one', () => {
    const anchors = anchorSteps(steps);
    expect(anchors).toHaveLength(2);
    expect(anchors.every((a) => a.toRank === track.max)).toBe(true);
    expect(new Set(anchors.map((a) => a.slot))).toEqual(new Set(['head', 'chest']));
  });

  it('shares the anchor gain across the ranks below it by item level', () => {
    const anchor = steps.find((s) => s.slot === 'head' && s.toRank === track.max)!;
    const { marginals, unmeasured } = marginalsFrom(
      steps.filter((s) => s.slot === 'head'),
      new Map([[anchor.id, { gain: 1000, margin: 40, significant: true }]]),
    );
    expect(unmeasured).toEqual([]);
    const top = marginals.find((m) => m.id === anchor.id)!;
    expect(top).toMatchObject({ gain: 1000, margin: 40, significant: true });
    expect(top.modelled).toBeUndefined();

    const mid = marginals.find((m) => m.id === 'crest-head-3')!;
    const midStep = steps.find((s) => s.id === 'crest-head-3')!;
    expect(mid.modelled).toBe(true);
    expect(mid.gain).toBeCloseTo(1000 * (midStep.ilvlDelta / anchor.ilvlDelta), 6);
    // Monotone within a track: no derived rank beats the top one, or goes below zero.
    for (const m of marginals) expect(m.gain).toBeGreaterThanOrEqual(0);
    for (const m of marginals) expect(m.gain).toBeLessThanOrEqual(1000);
    // Gain rises with rank, so a cheaper rank is never modelled as worth more.
    const byRank = marginals
      .map((m) => ({ rank: steps.find((s) => s.id === m.id)!.toRank, gain: m.gain }))
      .sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < byRank.length; i++) expect(byRank[i].gain).toBeGreaterThanOrEqual(byRank[i - 1].gain);
  });

  it('zeroes a negative anchor that is not separable, rather than calling it a loss', () => {
    const anchor = steps.find((s) => s.slot === 'head' && s.toRank === track.max)!;
    const { marginals } = marginalsFrom(
      steps.filter((s) => s.slot === 'head'),
      new Map([[anchor.id, { gain: -120, margin: 400, significant: false }]]),
    );
    // -120 against ±400 margin is not loss evidence, so worth nothing not negative; item stays in running.
    expect(marginals.find((m) => m.id === anchor.id)).toMatchObject({ gain: 0, margin: 400, significant: false });
    // Model bounded by monotonicity not extrapolating noise.
    expect(marginals.filter((m) => m.modelled).every((m) => m.gain === 0)).toBe(true);
  });

  it('keeps a negative anchor the engine could separate exactly as measured', () => {
    const anchor = steps.find((s) => s.slot === 'head' && s.toRank === track.max)!;
    const { marginals } = marginalsFrom(
      steps.filter((s) => s.slot === 'head'),
      new Map([[anchor.id, { gain: -300, margin: 40, significant: true }]]),
    );
    // Separated from zero: real finding, never clamped upward.
    expect(marginals.find((m) => m.id === anchor.id)).toMatchObject({ gain: -300, significant: true });
  });

  it('names the slots the engine returned nothing for rather than inventing a gain', () => {
    const { marginals, unmeasured } = marginalsFrom(steps, new Map());
    expect(marginals).toEqual([]);
    expect(unmeasured.sort()).toEqual(['chest', 'head']);
  });
});

// --- tie-breaking ----------------------------------------------------------

describe('dominates and preferredPlan', () => {
  const { steps } = crestCandidates([
    { slot: 'head', item: { ...item(track.ranks[0].bonusId), instanceId: 'head-1' } },
    { slot: 'chest', item: { ...item(track.ranks[0].bonusId), slot: 'chest', instanceId: 'chest-1' } },
  ], { costs: fakeCosts() });
  const byId = new Map(steps.map((s) => [s.id, s] as const));
  const plan = (...ids: string[]): CrestPlan => ({ ids, gain: 0, spent: {} });

  it('recognises a plan that buys everything another buys, and more', () => {
    // Same slots, one rank higher in one of them.
    expect(dominates(plan('crest-head-4', 'crest-chest-2'), plan('crest-head-3', 'crest-chest-2'), byId)).toBe(true);
    expect(dominates(plan('crest-head-3', 'crest-chest-2'), plan('crest-head-4', 'crest-chest-2'), byId)).toBe(false);
    // Extra slot upgraded also dominates: untouched slot is rank 0.
    expect(dominates(plan('crest-head-3', 'crest-chest-2'), plan('crest-head-3'), byId)).toBe(true);
    // Trading rank in one slot for another is not domination.
    expect(dominates(plan('crest-head-4', 'crest-chest-2'), plan('crest-head-3', 'crest-chest-3'), byId)).toBe(false);
    expect(dominates(plan('crest-head-3'), plan('crest-head-3'), byId)).toBe(false);
  });

  it('prefers the dominant plan over the one that merely measured higher', () => {
    // The browser finding: the leader left crests unspent and the runner-up was
    // the same plan with one more rank. Order given is by mean, leader first.
    const id = preferredPlan([
      { id: 'plan-0', plan: plan('crest-head-3') },
      { id: 'plan-1', plan: plan('crest-head-4') },
    ], byId);
    expect(id).toBe('plan-1');
  });

  it('falls back to the most item levels bought when neither dominates', () => {
    const a = plan('crest-head-2');
    const b = plan('crest-chest-4');
    expect(dominates(a, b, byId)).toBe(false);
    expect(dominates(b, a, byId)).toBe(false);
    expect(planItemLevels(b, byId)).toBeGreaterThan(planItemLevels(a, byId));
    expect(preferredPlan([{ id: 'a', plan: a }, { id: 'b', plan: b }], byId)).toBe('b');
  });

  it('keeps the given order when the plans are genuinely equivalent', () => {
    expect(preferredPlan([
      { id: 'a', plan: plan('crest-head-3') },
      { id: 'b', plan: plan('crest-chest-3') },
    ], byId)).toBe('a');
    expect(preferredPlan([], byId)).toBeNull();
  });
});

// --- budget, lines, candidates ---------------------------------------------

describe('crestBudget', () => {
  it('uses only what is held when not planning ahead, and says where it came from', () => {
    const b = crestBudget({ currencies: CURRENCIES, held: { [WEATHERED]: 120 }, heldKnown: true });
    expect(b.amounts).toEqual({ [WEATHERED]: 120, [CARVED]: 0, [RUNED]: 0 });
    expect(b.sources[0].note).toContain('120 held (from the import)');
    expect(b.warnings).toEqual([]);
  });

  it('warns rather than inventing amounts when the import has no currency block', () => {
    const b = crestBudget({ currencies: CURRENCIES, held: {}, heldKnown: false });
    expect(b.amounts[WEATHERED]).toBe(0);
    expect(b.warnings[0]).toContain('entered by hand');
  });

  it('adds only what can still be earned between the current week and the planned one', () => {
    // Cumulative cap, exactly as the catalog states it: start + perWeek * (week + 1).
    const weeklyCap: WeeklyCap = (c, week) => (c.id === RUNED ? null : 90 * (week + 1));
    const b = crestBudget({
      currencies: CURRENCIES, held: { [WEATHERED]: 10 }, heldKnown: true,
      planAhead: { week: 5, capRemoved: false }, currentWeek: 2, weeklyCap,
    });
    expect(b.amounts[WEATHERED]).toBe(10 + 90 * 3);
    expect(b.amounts[CARVED]).toBe(270);
    expect(b.weeksCounted).toBe(3);
    expect(b.sources[0].note).toContain('earnable over 3 weeks to week 6');
    // Currency pinned build cannot price is reported, never guessed.
    expect(b.amounts[RUNED]).toBe(0);
    expect(b.warnings.some((w) => w.includes('No weekly earn rate for Runed Crest'))).toBe(true);
  });

  it('uses a hand-entered per-week rate for a currency the data does not encode', () => {
    const weeklyCap: WeeklyCap = (_c, week, o) => (typeof o?.perWeek === 'number' ? o.perWeek * (week + 1) : null);
    const b = crestBudget({
      currencies: [CURRENCIES[0]], held: {}, heldKnown: true,
      planAhead: { week: 3, capRemoved: false }, currentWeek: 1, weeklyCap, perWeek: { [WEATHERED]: 50 },
    });
    expect(b.amounts[WEATHERED]).toBe(100);
    expect(b.sources[0].note).toContain('at 50/week (entered by hand)');
  });

  it('treats a removed cap as no limit, and never as the wallet cap', () => {
    const weeklyCap: WeeklyCap = (_c, _w, o) => (o?.capRemoved ? Number.POSITIVE_INFINITY : 10);
    const b = crestBudget({
      // The first currency has a 100 wallet cap. That is how many may be HELD,
      // not how many may be earned, so it must not bound the budget.
      currencies: [CURRENCIES[0], CURRENCIES[2]], held: { [WEATHERED]: 40 }, heldKnown: true,
      planAhead: { week: 4, capRemoved: true }, currentWeek: 0, weeklyCap,
    });
    expect(b.amounts[WEATHERED]).toBe(Number.POSITIVE_INFINITY);
    expect(b.amounts[RUNED]).toBe(Number.POSITIVE_INFINITY);
    expect(b.sources[0].note).toContain('no limit');
  });

  it('passes a hand-entered season-start grant through to the cap model', () => {
    const seen: { perWeek?: number; startQuantity?: number }[] = [];
    const weeklyCap: WeeklyCap = (_c, week, o) => {
      seen.push({ perWeek: o?.perWeek, startQuantity: o?.startQuantity });
      return (o?.startQuantity ?? 0) + (o?.perWeek ?? 0) * (week + 1);
    };
    const b = crestBudget({
      currencies: [CURRENCIES[0]], held: {}, heldKnown: true,
      planAhead: { week: 3, capRemoved: false }, currentWeek: 1, weeklyCap,
      perWeek: { [WEATHERED]: 40 }, startQuantity: { [WEATHERED]: 90 },
    });
    expect(seen[0]).toEqual({ perWeek: 40, startQuantity: 90 });
    // Grant already banked by current week, so only two weeks count.
    expect(b.amounts[WEATHERED]).toBe(80);
    expect(b.sources[0].note).toContain('90 at season start (entered by hand)');
  });

  it('says plainly that the season week is unknown instead of pretending to know it', () => {
    const weeklyCap: WeeklyCap = (_c, week) => 90 * (week + 1);
    const b = crestBudget({
      currencies: [CURRENCIES[0]], held: { [WEATHERED]: 5 }, heldKnown: true,
      planAhead: { week: 2, capRemoved: false }, currentWeek: null, weeklyCap,
    });
    expect(b.amounts[WEATHERED]).toBe(5 + 270);
    expect(b.warnings.some((w) => w.includes('season start is not in this build'))).toBe(true);
  });
});

describe('planLines, planTotals and engine candidates', () => {
  const { steps } = crestCandidates([
    { slot: 'chest', item: { ...item(track.ranks[0].bonusId), slot: 'chest', instanceId: 'chest-1', addonName: 'Robe' } },
    { slot: 'head', item: { ...item(track.ranks[0].bonusId), instanceId: 'head-1', addonName: 'Hood' } },
  ], { costs: fakeCosts() });
  const byId = new Map(steps.map((s) => [s.id, s] as const));

  it('orders rows by gear slot and prices each one by name', () => {
    const plan = { ids: ['crest-chest-3', 'crest-head-2'], gain: 10, spent: { [WEATHERED]: 45 } };
    const lines = planLines(plan, byId, CURRENCIES, { slotLabels: { head: 'Head', chest: 'Chest' } });
    expect(lines.map((l) => l.slot)).toEqual(['head', 'chest']);
    expect(lines[0].text).toBe(
      `Head — Hood: rank 1 → 2 (+${track.ranks[1].itemLevel - track.ranks[0].itemLevel} ilvl), costs 15 Weathered Crest`,
    );
    expect(lines[1].costs).toEqual([{ currencyId: WEATHERED, name: 'Weathered Crest', amount: 30 }]);
  });

  it('totals spend against the budget, and gold separately from crests', () => {
    const plan = { ids: ['crest-head-2', 'crest-chest-3'], gain: 0, spent: { [WEATHERED]: 45 } };
    const totals = planTotals(plan, { [WEATHERED]: 100, [CARVED]: 20 }, CURRENCIES);
    expect(totals[0]).toMatchObject({ spent: 45, budget: 100, remaining: 55 });
    expect(totals[1]).toMatchObject({ spent: 0, budget: 20, remaining: 20 });
    // Gold charged whatever crest budget says, so never inside it.
    expect(planMoney(plan, byId)).toBe(100_000 + 200_000);
  });

  it('builds profileset-safe candidates for one step and for a whole plan', () => {
    const one = stepCandidate(byId.get('crest-head-3')!);
    expect(one.id).toBe('crest-head-3');
    expect(one.lines).toHaveLength(1);
    expect(one.lines[0].startsWith('head=')).toBe(true);
    expect(one.cost.currencies).toEqual({ [WEATHERED]: 30 });

    const whole = planCandidate({ ids: ['crest-head-3', 'crest-chest-2'], gain: 1, spent: { [WEATHERED]: 45 } }, byId, 0);
    expect(whole.id).toBe('plan-0');
    expect(whole.lines.map((l) => l.split('=')[0])).toEqual(['head', 'chest']);
    expect(whole.canonical).toContain('head=');
    expect(whole.canonical).toContain('chest=');
  });
});

describe('searchFraction', () => {
  /**
   * One `onProgress` payload. Defaults are a survey pass that has spent nothing
   * yet, which is the case the sample ratio alone cannot see.
   */
  const at = (over: Partial<OptimizationProgress>): OptimizationProgress => ({
    stageIndex: 0, stageCount: 3, stageLabel: 'Survey',
    accuracy: { mode: 'targetError', targetError: 0.1, maxIterations: 30_000 },
    batchIndex: 0, batchCount: 1,
    candidatesMeasured: 0, candidatesRemaining: 0,
    samplesSpent: 0, estimatedSamplesRemaining: 0,
    ...over,
  });

  it('is 0 before the search has said anything', () => {
    expect(searchFraction(null)).toBe(0);
  });

  /** H2: survey one batch spending no samples until end (sample ratio flat at 0); racing pass starts near 0 again; pass counter carries both. */
  it('keeps moving through a racing pass the survey never estimated', () => {
    const SURVEY = 10_000;
    const RACE = 120_000;
    const survey = Array.from({ length: 10 }, (_, done) => at({
      candidatesInBatch: 10, candidatesDoneInBatch: done,
      samplesSpent: 0, estimatedSamplesRemaining: SURVEY,
    }));
    const race = Array.from({ length: 10 }, (_, batch) => at({
      stageIndex: 1, stageLabel: 'Race 1', batchIndex: batch, batchCount: 10,
      candidatesInBatch: 1, candidatesDoneInBatch: 0,
      samplesSpent: SURVEY + batch * (RACE / 10), estimatedSamplesRemaining: RACE,
    }));
    const seq = [...survey, ...race].map(searchFraction);

    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    // The survey moves at all…
    expect(seq[survey.length - 1]).toBeGreaterThan(seq[0]);
    // …and the race is not a flat line under a monotone floor, which is the defect.
    const inRace = seq.slice(survey.length);
    expect(inRace[inRace.length - 1] - inRace[0]).toBeGreaterThan(0.25);
    expect(new Set(inRace).size).toBeGreaterThan(5);
  });

  it('takes the sample ratio once it is ahead of the pass counter', () => {
    const p = at({ stageIndex: 1, batchIndex: 0, batchCount: 4, samplesSpent: 900, estimatedSamplesRemaining: 100 });
    // Pass counter alone would say 1/3; the samples say 90%.
    expect(searchFraction(p)).toBeCloseTo(0.9);
  });

  it('stays inside 0..1 when the runner reports nothing usable', () => {
    expect(searchFraction(at({ batchCount: 0, stageCount: 0 }))).toBe(0);
    expect(searchFraction(at({ stageIndex: 9, stageCount: 3, batchIndex: 9, batchCount: 1 }))).toBe(1);
    expect(searchFraction(at({ samplesSpent: 5, estimatedSamplesRemaining: 0 }))).toBe(1);
  });
});

/** J1: fifth browser run measured precision going into wrong phase: nine anchors at 0.096-0.099%, six plans at ~0.33% for headline DPS, ±592-634 against 139-246 DPS differences. */
describe('planTargetError', () => {
  /** The fifth run's shape: 9 anchors at 0.1%, 6 plans, 181,569 DPS baseline. */
  const run = {
    planGains: [5600, 5550, 5400, 5200, 5100, 4950],
    baselineMean: 181_569,
    anchorTargetError: 0.1,
    anchorCount: 9,
    userTargetError: 0.5,
  };

  it('never runs phase 3 looser than the phase-1 anchors', () => {
    expect(planTargetError(run)).toBeLessThanOrEqual(run.anchorTargetError);
  });

  it('ignores a loose accuracy setting — it is a ceiling, not a floor', () => {
    expect(planTargetError({ ...run, userTargetError: 10 })).toBe(planTargetError(run));
  });

  it('honours an accuracy setting tighter than anything it would choose itself', () => {
    expect(planTargetError({ ...run, userTargetError: 0.02 })).toBe(0.02);
  });

  it('floors at cost parity with phase 1: anchorTargetError * sqrt(plans / anchors)', () => {
    // 6 plans at this fineness cost same engine samples as 9 anchors at 0.1% (already shown affordable).
    expect(planTargetError(run)).toBeCloseTo(0.1 * Math.sqrt(6 / 9), 6);
  });

  it('loosens toward the ceiling when the top two plans are far apart', () => {
    // A 400 DPS gap needs only 400/sqrt(2) = 283 DPS of margin, 0.156% — above
    // the ceiling, so the ceiling stands and nothing is overspent.
    const wide = planTargetError({ ...run, planGains: [6000, 5600, 5400] });
    expect(wide).toBe(0.1);
  });

  it('asks for what separating the observed gap actually needs, between the bounds', () => {
    // A 250 DPS gap: m < 250/sqrt(2) = 177 DPS on 181,569 = 0.0974%.
    const got = planTargetError({ ...run, planGains: [5600, 5350] });
    expect(got).toBeCloseTo((100 * 250) / (Math.SQRT2 * 181_569), 6);
    expect(got).toBeGreaterThan(0.1 * Math.sqrt(6 / 9));
    expect(got).toBeLessThan(0.1);
  });

  it('spends the most it is willing to when phase 2 cannot separate the top two at all', () => {
    const tied = planTargetError({ ...run, planGains: [5600, 5600, 5600] });
    expect(tied).toBeCloseTo(0.1 * Math.sqrt(3 / 9), 6);
  });

  it('takes the floor rather than dividing by a missing baseline', () => {
    expect(planTargetError({ ...run, baselineMean: 0 })).toBeCloseTo(0.1 * Math.sqrt(6 / 9), 6);
    expect(planTargetError({ ...run, planGains: [5600] })).toBeCloseTo(0.1 * Math.sqrt(1 / 9), 6);
  });

  it('is at least four times finer than the 0.33% the engine delivered before', () => {
    expect(planTargetError(run)).toBeLessThan(0.33 / 4);
  });
});

/** J3/I3: Phase 1 was 85% wall clock and 11% bar. */
describe('phaseFraction', () => {
  const at = (over: Partial<OptimizationProgress>): OptimizationProgress => ({
    stageIndex: 0, stageCount: 3, stageLabel: 'Survey',
    accuracy: { mode: 'targetError', targetError: 0.1, maxIterations: 30_000 },
    batchIndex: 0, batchCount: 1,
    candidatesMeasured: 0, candidatesRemaining: 0,
    samplesSpent: 0, estimatedSamplesRemaining: 0,
    ...over,
  });

  it('gives phases 1 and 3 the same share, because they buy the same samples', () => {
    expect(PHASE_WEIGHTS[0]).toBe(PHASE_WEIGHTS[2]);
    expect(PHASE_WEIGHTS.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('does not give a pure, instant phase a third of the bar', () => {
    // The whole of phase 2 must cost less of the bar than phase 1's first pass.
    expect(PHASE_WEIGHTS[1]).toBeLessThan(0.05);
    expect(phaseFraction(null, 2)).toBeCloseTo(PHASE_WEIGHTS[0], 6);
  });

  it('spends most of the bar on phase 1, where most of the engine time goes', () => {
    // The old rule left a completed phase 1 at 1/3; the wall clock said ~half.
    const done = at({ stageIndex: 2, stageCount: 3, batchIndex: 0, batchCount: 1, candidatesInBatch: 9, candidatesDoneInBatch: 9 });
    expect(phaseFraction(done, 1)).toBeCloseTo(PHASE_WEIGHTS[0], 6);
    expect(phaseFraction(done, 1)).toBeGreaterThan(0.4);
  });

  it('is non-decreasing across the whole run and ends at 1', () => {
    const sweep = [1, 2, 3].flatMap((phase) => [0, 0.5, 1].map((done) => phaseFraction(
      at({ stageIndex: 2, stageCount: 3, candidatesInBatch: 10, candidatesDoneInBatch: done * 10 }),
      phase,
    )));
    for (let i = 1; i < sweep.length; i++) expect(sweep[i]).toBeGreaterThanOrEqual(sweep[i - 1]);
    expect(sweep[sweep.length - 1]).toBeCloseTo(1, 6);
  });

  it('is 0 before the first phase starts', () => {
    expect(phaseFraction(null, 0)).toBe(0);
    expect(phaseFraction(null, 1)).toBe(0);
  });
});
