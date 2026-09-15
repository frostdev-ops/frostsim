// Top Gear: turn a user's selection into legal, budgeted, staged search (P08).

import type { Catalog } from '../catalog/catalog';
import type { CharacterConstraints } from '../catalog/legality';
import { GEAR_SLOTS, type GearSlot, type ItemInstance } from '../catalog/types';
import {
  collect, generate, growthDrivers, upperBound,
  type Dimension, type DimensionOption, type GenerationReport, type SetBonusRequirement,
} from './candidates';
import { DEFAULT_STAGE_PLAN, runStagedSearch, type RunBatch, type ResultCache, type SearchLedger } from './runner';
import type { Accuracy, Candidate, OptimizationProgress, OptimizationResult, StagePlan } from './types';

/** User-picked options, as UI collects them. */
export interface Selection {
  /** Per-slot item instances; baseline included by caller. */
  slots: Partial<Record<GearSlot, ItemInstance[]>>;
  /** Alternative talent strings including baseline. */
  loadouts?: string[];
  /** Consumable alternatives by simc option name. */
  consumables?: Record<string, string[]>;
  /** Per-slot whole gem loadouts applied to slot items. */
  gems?: Partial<Record<GearSlot, number[][]>>;
  /** Per-slot enchant ids. */
  enchants?: Partial<Record<GearSlot, number[]>>;
  /** Per-slot embellishment bonus ids (P08.2); include 0 for unembellished option. Slots not in engine data; caller chooses. */
  embellishments?: Partial<Record<GearSlot, number[]>>;
  /** Set bonuses the result must keep. A combination that breaks one is rejected. */
  requiredSets?: SetBonusRequirement[];
}

export interface WorkEstimate {
  /** False when combinations is product of dimension sizes not count of legal candidates. Always upper bound. */
  exact: boolean;
  combinations: number;
  /** True when product exceeded safe JavaScript integer. */
  overflowed: boolean;
  /** Per stage: candidates entering, relative cost vs cheapest stage. Samples scale with 1/targetError². */
  stages: {
    label: string;
    /** Human-readable precision, for display. */
    precision: string;
    /** The stage's actual accuracy setting, so a consumer can bound the work itself. */
    accuracy: Accuracy;
    candidates: number;
    relativeCost: number;
    /**
     * Worst-case engine samples this stage can consume: candidates x the stage's
     * iteration ceiling. A target-accuracy stage usually stops well short of it,
     * but this is the number a time estimate must not exceed.
     */
    maxSamples: number;
  }[];
  /** Dimensions ordered by how much they multiply the space. */
  growthDrivers: { dimension: string; factor: number }[];
  /** Set when the selection would be stopped by the work cap. */
  exceedsCap: boolean;
  workCap: number;
}

export interface TopGearOptions {
  catalog: Catalog;
  character: CharacterConstraints;
  baselineGear: Map<GearSlot, ItemInstance | null>;
  baselineTalents?: string;
  playerLevel?: number;
  plan?: StagePlan;
  /** Ceiling on generated candidates. Generation stops here and says so. */
  workCap?: number;
  /**
   * How many embellishments one character may wear. Not in the engine data, so it
   * is enforced only when supplied — see `GenerateOptions.embellishmentLimit`.
   */
  embellishmentLimit?: number;
}

export const DEFAULT_WORK_CAP = 5000;

// Samples needed scale as 1/targetError²; relative cost model not time prediction.
/** Iteration count a stage stops at in worst case. */
export function iterationCeiling(accuracy: Accuracy): number {
  return accuracy.mode === 'iterations' ? accuracy.iterations : accuracy.maxIterations;
}

export function perCandidateSamples(accuracy: Accuracy): number {
  if (accuracy.mode === 'iterations') return accuracy.iterations;
  if (!(accuracy.targetError > 0)) return accuracy.maxIterations;
  // Capped at the ceiling the stage will actually stop at.
  return Math.min(accuracy.maxIterations, 1 / (accuracy.targetError * accuracy.targetError));
}

/** Build search axes, pairing slots and existing enhancements as alternatives. */
export function selectionToDimensions(selection: Selection, opts: TopGearOptions): Dimension[] {
  const dimensions: Dimension[] = [];
  const slots = { ...selection.slots };
  const vaultOptions = new Map<string, DimensionOption>();
  // Global vault decision after owned gear so all rewards compete with same sets.
  for (const slot of GEAR_SLOTS) {
    const items = slots[slot];
    if (!items) continue;
    const rewards = items.filter((item) => item.vaultRewardId || item.source === 'vault');
    if (!rewards.length) continue;
    const owned = items.filter((item) => !item.vaultRewardId && item.source !== 'vault');
    const baseline = opts.baselineGear.get(slot);
    if (baseline && !owned.some((item) => item.instanceId === baseline.instanceId)) owned.unshift(baseline);
    slots[slot] = owned;
    for (const item of rewards) {
      const key = `${item.instanceId}:${slot}`;
      let reward = { ...item, slot };
      // Vault rewards unenchanted; inherit slot's enchant when item masks accept reward.
      if (!reward.enchantId && !reward.extra?.enchant && (baseline?.enchantId || baseline?.extra?.enchant)) {
        const resolved = opts.catalog.resolve(reward, opts.playerLevel);
        const named = baseline.extra?.enchant?.toLowerCase();
        const enchant = resolved && opts.catalog.enchantsFor(resolved).find((option) =>
          named ? named === `${option.option}${option.rank ? `_${option.rank}` : ''}`
            : option.enchantId === baseline.enchantId);
        if (enchant) reward = { ...reward, enchantId: enchant.enchantId };
      }
      vaultOptions.set(key, { key, label: item.addonName ?? `item ${item.itemId}`, item: reward,
        cost: { unknownCosts: ['upgrade currency', 'crafting reagents'] } });
    }
  }
  const paired = new Set<GearSlot>();
  for (const [first, second] of [['finger1', 'finger2'], ['trinket1', 'trinket2']] as const) {
    const a = slots[first];
    const b = slots[second];
    if (!a?.length || !b?.length) continue;
    const pool = [...new Map(a.map((item) => [item.instanceId, item])).values()];
    if (pool.length < 2) continue;
    const other = new Set(b.map((item) => item.instanceId));
    if (pool.length !== other.size || pool.some((item) => !other.has(item.instanceId))) continue;
    const options: DimensionOption[] = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      let left = pool[i], right = pool[j];
      // Keep a worn item in its current slot when possible; every physical pair is tried once.
      if (left.instanceId === opts.baselineGear.get(second)?.instanceId || right.instanceId === opts.baselineGear.get(first)?.instanceId) {
        [left, right] = [right, left];
      }
      options.push({
        key: `${left.instanceId}/${right.instanceId}`,
        label: [left, right].map((item) => item.addonName ?? `item ${item.itemId}`).join(' + '),
        gear: [{ ...left, slot: first }, { ...right, slot: second }],
        cost: { unknownCosts: ['upgrade currency', 'crafting reagents'] },
      });
      // Slot-specific enhancements can distinguish assignments; keep both, collapse after attachments applied.
      if (first === 'finger1' && [first, second].some((slot) =>
        selection.gems?.[slot]?.length || selection.enchants?.[slot]?.length || selection.embellishments?.[slot]?.length)) {
        options.push({ ...options[options.length - 1], key: `${right.instanceId}/${left.instanceId}`,
          gear: [{ ...right, slot: first }, { ...left, slot: second }] });
      }
    }
    dimensions.push({ key: `pair:${first}`, kind: 'gear', options });
    paired.add(first); paired.add(second);
  }

  for (const slot of GEAR_SLOTS) {
    if (paired.has(slot)) continue;
    const items = slots[slot];
    if (!items || items.length === 0) continue;
    const options: DimensionOption[] = items.map((item) => ({
      key: item.instanceId,
      label: item.addonName ?? `item ${item.itemId}`,
      item: { ...item, slot },
      // Upgrade/crafting costs unknown in catalog; saying "unknown" prevents zero-cost display (P05).
      cost: { unknownCosts: ['upgrade currency', 'crafting reagents'] },
    }));
    if (options.length < 2 && options[0]?.item?.instanceId === opts.baselineGear.get(slot)?.instanceId) continue;
    dimensions.push({ key: `slot:${slot}`, kind: 'gear', slot, options });
  }

  if (vaultOptions.size) {
    dimensions.push({ key: 'vault', kind: 'gear', options: [{ key: 'none', label: '' }, ...vaultOptions.values()] });
  }

  const loadouts = dedupe(selection.loadouts ?? []);
  if (loadouts.length > 1 || (loadouts.length === 1 && loadouts[0] !== opts.baselineTalents)) {
    dimensions.push({
      key: 'talents',
      kind: 'talent',
      options: loadouts.map((talents, i) => talents === opts.baselineTalents
        ? { key: `l${i}`, label: '' }
        : { key: `l${i}`, label: `Loadout ${i + 1}`, talents }),
    });
  }

  for (const [slot, loadouts] of Object.entries(selection.gems ?? {}) as [GearSlot, number[][]][]) {
    if (!loadouts?.length) continue;
    dimensions.push({
      key: `gems:${slot}`,
      kind: 'gem',
      slot,
      options: [{ key: 'current', label: '' }, ...loadouts.map((gemIds) => ({ key: gemIds.join('.'), label: `gems ${gemIds.join('/')}`, gemIds }))],
    });
  }

  for (const [slot, enchantIds] of Object.entries(selection.enchants ?? {}) as [GearSlot, number[]][]) {
    const list = [...new Set(enchantIds ?? [])];
    if (!list.length) continue;
    dimensions.push({
      key: `enchant:${slot}`,
      kind: 'enchant',
      slot,
      options: [{ key: 'current', label: '' }, ...list.map((enchantId) => ({ key: String(enchantId), label: `enchant ${enchantId}`, enchantId }))],
    });
  }

  for (const [slot, bonusIds] of Object.entries(selection.embellishments ?? {}) as [GearSlot, number[]][]) {
    const list = [...new Set(bonusIds ?? [])];
    if (!list.length) continue;
    dimensions.push({
      key: `embellishment:${slot}`,
      kind: 'embellishment',
      slot,
      options: [{ key: 'current', label: '' }, ...list.map((bonusId) => ({
        key: String(bonusId),
        label: bonusId === 0 ? 'no embellishment' : `embellishment ${bonusId}`,
        embellishmentBonusId: bonusId,
      }))],
    });
  }

  for (const [kind, values] of Object.entries(selection.consumables ?? {})) {
    const list = dedupe(values);
    if (!list.length) continue;
    // Actor-level options; global raid buffs in simulation settings, not per-profileset.
    if (!['flask', 'phial', 'potion', 'food', 'augmentation', 'temporary_enchant'].includes(kind) || list.some((value) => /[\n\r"\0]/.test(value))) {
      throw new Error(`Invalid consumable option: ${kind}`);
    }
    dimensions.push({
      key: `consumable:${kind}`,
      kind: 'consumable',
      options: [{ key: 'current', label: '' }, ...list.map((option) => ({ key: option, label: option, consumable: { kind, option } }))],
    });
  }

  return dimensions;
}

/** Estimate workload before launch (P08.7); multiplies dimension sizes, no candidate building. */
export function estimateWork(selection: Selection, opts: TopGearOptions): WorkEstimate {
  const dimensions = selectionToDimensions(selection, opts);
  const bound = upperBound(dimensions);
  const plan = opts.plan ?? DEFAULT_STAGE_PLAN;
  const workCap = opts.workCap ?? DEFAULT_WORK_CAP;
  const vaultChoices = new Set(Object.values(selection.slots).flatMap((items) => items ?? [])
    .filter((item) => item.vaultRewardId || item.source === 'vault')
    .map((item) => item.vaultRewardId ?? item.originalInstanceId ?? item.instanceId));
  const minimumSurvivors = vaultChoices.size ? vaultChoices.size + 1 : 1;

  // Only empty selection is exact; variants can be illegal or identical to baseline.
  const exact = dimensions.length === 0;

  // Unmodified baseline simulated alongside variants for same-batch gain measurements.
  const withBaseline = dimensions.length === 0 ? 1 : bound.overflow ? bound.value : bound.value + 1;
  let entering = Math.min(withBaseline, workCap);
  const raw = plan.stages.map((stage) => {
    const row = {
      label: stage.label,
      precision: stage.accuracy.mode === 'iterations'
        ? `${stage.accuracy.iterations} iterations`
        : `${stage.accuracy.targetError}% target error`,
      accuracy: stage.accuracy,
      candidates: entering,
      maxSamples: entering * iterationCeiling(stage.accuracy),
      work: entering * perCandidateSamples(stage.accuracy),
    };
    entering = Math.min(entering, Math.max(stage.maxSurvivors, minimumSurvivors));
    return row;
  });
  const cheapest = Math.min(...raw.map((r) => r.work).filter((w) => w > 0), Infinity);
  const stages = raw.map(({ work, ...row }) => ({
    ...row,
    relativeCost: Number.isFinite(cheapest) && cheapest > 0 ? work / cheapest : 1,
  }));

  return {
    exact,
    combinations: withBaseline,
    overflowed: bound.overflow,
    stages,
    growthDrivers: growthDrivers(dimensions).map((d) => ({ dimension: d.label, factor: d.options })),
    exceedsCap: withBaseline > workCap,
    workCap,
  };
}

export interface SearchHandle {
  result: Promise<TopGearResult>;
  cancel(): void;
}

export interface TopGearResult extends OptimizationResult {
  generation: GenerationReport;
}

export interface RunOptions extends TopGearOptions {
  profile: string;
  /** From the engine manifest. Without it, nothing is cached across runs. */
  engineIdentity?: string | null;
  runBatch: RunBatch;
  cache?: ResultCache;
  ledger?: SearchLedger;
  onProgress?: (p: OptimizationProgress) => void;
}

/** Generates candidates, then runs the staged search. Cancellable at batch edges. */
export function search(selection: Selection, opts: RunOptions): SearchHandle {
  const controller = new AbortController();
  const dimensions = selectionToDimensions(selection, opts);
  const workCap = opts.workCap ?? DEFAULT_WORK_CAP;

  const { candidates, report } = collect(
    generate(dimensions, {
      workCap,
      character: opts.character,
      catalog: opts.catalog,
      baselineGear: opts.baselineGear,
      playerLevel: opts.playerLevel,
      requiredSets: selection.requiredSets,
      embellishmentBonusIds: opts.catalog.embellishments().map((e) => e.bonusId),
      embellishmentLimit: opts.embellishmentLimit,
    }),
    workCap,
  );

  const result = runStagedSearch(candidates, {
    profile: opts.profile,
    plan: opts.plan ?? DEFAULT_STAGE_PLAN,
    catalogId: opts.catalog.catalogId,
    engineIdentity: opts.engineIdentity,
    runBatch: opts.runBatch,
    cache: opts.cache,
    ledger: opts.ledger,
    signal: controller.signal,
    onProgress: opts.onProgress,
  }).then((r): TopGearResult => {
    // Post-processing errors degrade to raw result + warning, never rejection of completed search.
    try {
      return decorate(r, report, workCap);
    } catch (err) {
      return {
        ...r,
        warnings: [
          ...r.warnings,
          `the search completed but its summary could not be assembled (${err instanceof Error ? err.message : String(err)}); ` +
          'the measurements below are unaffected',
        ],
        generation: report,
      };
    }
  });

  return { result, cancel: () => controller.abort() };
}

/** Add generation context to finished search. Pure, engine-untouched. */
function decorate(r: OptimizationResult, report: GenerationReport, workCap: number): TopGearResult {
  {
    const warnings = [...r.warnings];
    if (report.capped) {
      warnings.push(
        `generation stopped at the ${workCap}-candidate cap; the selected options describe at least ${report.upperBound} combinations, so this search is not exhaustive`,
      );
    }
    if (report.rejectedIllegal) {
      warnings.push(`${report.rejectedIllegal} combinations were rejected as illegal before reaching the engine`);
    }
    const unknownCosts = new Set<string>();
    for (const state of r.candidates) for (const c of state.candidate.cost?.unknownCosts ?? []) unknownCosts.add(c);
    if (unknownCosts.size) {
      warnings.push(`cost is unknown for: ${[...unknownCosts].join(', ')} — the catalog has no data for these, so no affordability constraint was applied`);
    }
    // Deduped to avoid repeated sentences in keyed {#each}.
    return { ...r, warnings: [...new Set(warnings)], generation: report };
  }
}

// Append caveat rather than replace reason; both facts matter.
function withProblems(reason: string, engineProblems: boolean): string {
  return engineProblems
    ? `${reason}, but the engine reported problems during this search and the numbers may be wrong`
    : reason;
}

/** Recommendation when nothing distinguishably better (P08.13); presentation decision, not ranking change. */
export function recommendation(result: OptimizationResult): {
  /** True when measurements support keeping current setup. False when measured is false. */
  keepCurrent: boolean;
  winner: Candidate | null;
  reason: string;
  /** Whether ANY candidate was measured. False means this is not advice, absence of advice. */
  measured: boolean;
  /** True when engine reported problems during search; ranking returned but not confident. */
  engineProblems: boolean;
} {
  const engineProblems = (result.problems ?? []).length > 0;
  const budgetDropped = new Set(result.droppedWhileAlive);
  const ranked = result.candidates.filter((s) => s.measurement && s.status === 'measured' && !budgetDropped.has(s.candidate.id));
  if (ranked.length === 0) {
    return {
      keepCurrent: false,
      winner: null,
      measured: false,
      engineProblems,
      reason: 'No candidate produced a result, so nothing was compared. This is not a recommendation.',
    };
  }

  const leader = ranked[0];
  const baselineState = ranked.find((s) => s.candidate.id === 'baseline');
  if (!baselineState?.measurement) {
    return { keepCurrent: false, winner: leader.candidate, measured: true, engineProblems, reason: withProblems('no baseline measurement to compare against', engineProblems) };
  }
  if (leader.candidate.id === 'baseline') {
    return { keepCurrent: true, winner: leader.candidate, measured: true, engineProblems, reason: withProblems('the current setup ranked first', engineProblems) };
  }
  if (result.unresolvedTie.includes('baseline')) {
    return {
      keepCurrent: true,
      winner: leader.candidate,
      measured: true,
      engineProblems,
      reason: withProblems('the best alternative is not distinguishable from the current setup at the measured precision', engineProblems),
    };
  }
  return { keepCurrent: false, winner: leader.candidate, measured: true, engineProblems, reason: withProblems('measurably better than the current setup', engineProblems) };
}

/** Re-measure finalists at higher precision than search reached (P08.14); independent samples answer selection bias. */
export function verifyFinalists(
  candidates: Candidate[],
  accuracy: Accuracy,
  opts: Omit<RunOptions, 'plan'> & { batchSize?: number },
): SearchHandle {
  const controller = new AbortController();
  const plan: StagePlan = {
    version: 1,
    retentionFactor: 1,
    minIterations: 0,
    // One stage, no elimination: every finalist is reported, none is dropped.
    stages: [{ label: 'Verify', accuracy, maxSurvivors: candidates.length, batchSize: opts.batchSize ?? candidates.length }],
  };
  const result = runStagedSearch(candidates, {
    profile: opts.profile,
    plan,
    catalogId: opts.catalog.catalogId,
    engineIdentity: opts.engineIdentity,
    // Verification run must take fresh samples, not cached number that ranked candidate.
    cache: undefined,
    runBatch: opts.runBatch,
    signal: controller.signal,
    onProgress: opts.onProgress,
  }).then((r): TopGearResult => ({
    ...r,
    generation: {
      produced: candidates.length, examined: candidates.length, rejectedIllegal: 0,
      duplicatesCollapsed: 0, capped: false, upperBound: candidates.length,
      upperBoundExceedsSafeInteger: false, growthDrivers: [],
    },
  }));
  return { result, cancel: () => controller.abort() };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}
