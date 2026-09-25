// Droptimizer: what one new item is worth (P09). Catalog sources require verified membership; results are hypothetical gains with no drop probabilities.

import type { Catalog } from '../catalog/catalog';
import { checkGearSet, isLegal, type CharacterConstraints, type LegalityIssue } from '../catalog/legality';
import { INVTYPE, ITEM_CLASS, ITEM_MOD, classMaskFor } from '../catalog/enums';
import { GEAR_SLOTS, type GearSlot, type ItemInstance, type ResolvedItem } from '../catalog/types';
import { canonicalize, candidateId, deltaToLines } from './candidates';
import { compareCandidates, gainOverBaseline, type Gain } from './statistics';
import { DEFAULT_STAGE_PLAN, runStagedSearch, type RunBatch, type ResultCache, type SearchLedger } from './runner';
import type { Candidate, CandidateDelta, OptimizationProgress, OptimizationResult, StagePlan } from './types';

export interface DropSource {
  id: string;
  label: string;
  /** How this source was established: 'user' or 'catalog' configured loot adapter. */
  provenance: 'user' | 'catalog';
  /** Journal instance media id for a source card, when the instance has art. */
  mediaId?: number;
  items: ItemInstance[];
  /** User receives exactly ONE item; results are alternatives, not cumulative upgrades (P09.9). Absent means items are independent. */
  exclusive?: boolean;
  /** Source describes an unearned situation; results answer "what would this be worth" (P09). */
  hypothetical?: boolean;
}

export interface DroptimizerOptions {
  catalog: Catalog;
  character: CharacterConstraints;
  baselineGear: Map<GearSlot, ItemInstance | null>;
  playerLevel?: number;
  /** Try the item in every eligible slot rather than only the weakest one. */
  allEligibleSlots?: boolean;
  /** Companion off-hand for two-handed candidates; without it the off hand empties (P09.4). */
  companionOffHand?: ItemInstance | null;
  plan?: StagePlan;
  /** Gems per slot for dropped items; applied only up to socket count, legality enforced (P09.3). */
  preferredGems?: Partial<Record<GearSlot, number[]>>;
  /** Enchant to apply to a dropped item, per slot. Same reasoning as the gems. */
  preferredEnchants?: Partial<Record<GearSlot, number>>;
  /** Crafted stat ids for dropped crafted items; ignored by non-crafted items. */
  preferredCraftedStats?: number[];
  /** Clock for the loot data's expiry check; the current time when absent. */
  now?: number;
}

export interface DropScenario {
  candidate: Candidate;
  sourceId: string;
  item: ResolvedItem;
  slot: GearSlot;
  /** The baseline item this would replace, or null for an empty slot. */
  replaces: ResolvedItem | null;
  /** Rules that could not be checked, shown rather than assumed satisfied. */
  unchecked: string[];
}

/** One scenario per (item, eligible slot); identical ones collapsed but source associations retained. */
export function buildScenarios(sources: DropSource[], opts: DroptimizerOptions): {
  scenarios: DropScenario[];
  sourcesFor: Map<string, string[]>;
  warnings: string[];
} {
  // Recheck at run time: an open picker can outlive its catalog's season/expiry.
  if (sources.some((s) => s.provenance === 'catalog')) {
    const loot = opts.catalog.lootSources(opts.now);
    const current = new Map(loot.sources.map((s) => [s.id, new Set(s.itemIds)]));
    for (const source of sources.filter((s) => s.provenance === 'catalog')) {
      const items = current.get(source.id);
      if (!items || source.items.some((item) => !items.has(item.itemId))) {
        throw new Error(loot.unavailableReason ?? 'Selected loot is no longer verified for the current season. Refresh the catalog.');
      }
    }
  }
  const scenarios: DropScenario[] = [];
  const sourcesFor = new Map<string, string[]>();
  const byCanonical = new Map<string, DropScenario>();
  const warnings: string[] = [];
  let index = 0;

  const resolveCache = new Map<string, ResolvedItem | null>();
  const resolve = (item: ItemInstance): ResolvedItem | null => {
    if (!resolveCache.has(item.instanceId)) {
      resolveCache.set(item.instanceId, opts.catalog.resolve(item, opts.playerLevel ?? 0));
    }
    return resolveCache.get(item.instanceId) ?? null;
  };

  const baselineResolved = new Map<GearSlot, ResolvedItem | null>();
  for (const slot of GEAR_SLOTS) {
    const item = opts.baselineGear.get(slot) ?? null;
    baselineResolved.set(slot, item ? resolve(item) : null);
  }
  // A candidate is refused only for what it breaks. Problems the character's own gear already has (a socket the catalog cannot see,
  // say) are not the candidate's, and counting them would refuse every candidate.
  const issueKey = (i: LegalityIssue) => `${i.code}|${i.slot}|${i.message}`;
  const baselineIssues = new Set(checkGearSet(baselineResolved, opts.character).map(issueKey));

  for (const source of sources) {
    for (const candidateItem of source.items) {
      const resolved = resolve(candidateItem);
      if (!resolved) {
        warnings.push(`item ${candidateItem.itemId} is not in the catalog and was skipped`);
        continue;
      }

      const slots = opts.allEligibleSlots === false ? resolved.eligibleSlots.slice(0, 1) : resolved.eligibleSlots;
      for (const slot of slots) {
        const gear = new Map<GearSlot, ItemInstance | null>();
        const unchecked: string[] = [];
        gear.set(slot, dress({ ...candidateItem, slot }, resolved, slot, opts, unchecked));

        // A two-hander clears the off hand; pairing companion weapon is user's choice.
        const twoHanded = resolved.inventoryType === 17;
        if (twoHanded && slot === 'main_hand') {
          if (opts.companionOffHand === undefined) {
            gear.set('off_hand', null);
            unchecked.push('two-handed: the off hand was emptied because no companion weapon was chosen');
          } else {
            gear.set('off_hand', opts.companionOffHand);
          }
        }

        const fullSet = new Map(baselineResolved);
        for (const [s, i] of gear) fullSet.set(s, i ? resolve(i) : null);
        if (!isLegal(checkGearSet(fullSet, opts.character).filter((i) => !baselineIssues.has(issueKey(i))))) continue;

        const delta: CandidateDelta = { gear };
        const canonical = canonicalize(delta);
        const existing = byCanonical.get(canonical);
        if (existing) {
          sourcesFor.get(existing.candidate.id)!.push(source.id);
          continue;
        }

        const candidate: Candidate = {
          id: candidateId(canonical, ++index),
          provenance: {
            kind: 'gear',
            items: [resolved],
            label: `${resolved.name} in ${slot}`,
            sourceId: source.id,
          },
          delta,
          // Upgrade and Catalyst costs are not in the catalog; they stay unknown.
          cost: { unknownCosts: ['upgrade currency', 'Catalyst charges'] },
          lines: deltaToLines(delta, new Map([[resolved.itemId, resolved.name]])),
          canonical,
        };
        const scenario: DropScenario = {
          candidate, sourceId: source.id, item: resolved, slot,
          replaces: baselineResolved.get(slot) ?? null,
          unchecked,
        };
        byCanonical.set(canonical, scenario);
        sourcesFor.set(candidate.id, [source.id]);
        scenarios.push(scenario);
      }
    }
  }

  return { scenarios, sourcesFor, warnings };
}

export interface DropResultRow {
  scenario: DropScenario;
  mean: number | null;
  /** This candidate's own confidence margin, for comparing rows against each other. */
  margin: number | null;
  iterations: number | null;
  /** Gain over baseline with margin; imported from gainOverBaseline return type. */
  gain: Gain | null;
  sourceIds: string[];
  status: string;
  note?: string;
}

/** Source user picks one reward from; rows are alternatives, best is the pick (P09.9). */
export interface ExclusiveChoice {
  sourceId: string;
  label: string;
  hypothetical: boolean;
  /** Every option in the choice, best first. */
  rows: DropResultRow[];
  /** The option to take, or null when nothing was measured. */
  best: DropResultRow | null;
  /** Options indistinguishable from best at measured precision; no single right answer. */
  indistinguishable: DropResultRow[];
}

export interface DroptimizerResult extends OptimizationResult {
  rows: DropResultRow[];
  /** Best row per item id, for the "only the best slot" view. */
  bestPerItem: DropResultRow[];
  /** One entry per source the user picks a single reward from. */
  exclusiveChoices: ExclusiveChoice[];
  /** Always true: no verified loot membership, no source priority or expected value. */
  probabilitiesUnavailable: true;
  probabilityExplanation: string;
}

export interface DropRunOptions extends DroptimizerOptions {
  profile: string;
  /** From the engine manifest. Without it, nothing is cached across runs. */
  engineIdentity?: string | null;
  runBatch: RunBatch;
  cache?: ResultCache;
  ledger?: SearchLedger;
  onProgress?: (p: OptimizationProgress) => void;
}

export function run(sources: DropSource[], opts: DropRunOptions): {
  result: Promise<DroptimizerResult>;
  cancel(): void;
} {
  const controller = new AbortController();
  const { scenarios, sourcesFor, warnings } = buildScenarios(sources, opts);

  // Baseline runs alongside so every gain is measured against same-batch sample.
  const baselineCandidate: Candidate = {
    id: 'baseline',
    provenance: { kind: 'baseline', items: [], label: 'Current gear' },
    delta: {},
    cost: { unknownCosts: [] },
    lines: [],
    canonical: '',
  };

  const result = runStagedSearch([baselineCandidate, ...scenarios.map((s) => s.candidate)], {
    profile: opts.profile,
    plan: opts.plan ?? DEFAULT_STAGE_PLAN,
    catalogId: opts.catalog.catalogId,
    engineIdentity: opts.engineIdentity,
    runBatch: opts.runBatch,
    cache: opts.cache,
    ledger: opts.ledger,
    signal: controller.signal,
    onProgress: opts.onProgress,
  }).then((r): DroptimizerResult => {
    const byId = new Map(r.candidates.map((s) => [s.candidate.id, s]));
    const baselineState = byId.get('baseline');
    const baseline = baselineState?.measurement ?? r.baseline;

    const rows: DropResultRow[] = scenarios.map((scenario) => {
      const state = byId.get(scenario.candidate.id);
      const m = state?.measurement ?? null;
      return {
        scenario,
        mean: m?.mean ?? null,
        margin: m?.margin ?? null,
        iterations: m?.iterations ?? null,
        gain: m && baseline
          ? gainOverBaseline(
              { mean: m.mean, margin: m.margin, iterations: m.iterations },
              { mean: baseline.mean, margin: baseline.margin, iterations: baseline.iterations },
            )
          : null,
        sourceIds: sourcesFor.get(scenario.candidate.id) ?? [scenario.sourceId],
        status: state?.status ?? 'pending',
        note: state?.note,
      };
    }).sort((a, b) => (b.gain?.absolute ?? -Infinity) - (a.gain?.absolute ?? -Infinity));

    const best = new Map<number, DropResultRow>();
    for (const row of rows) {
      const current = best.get(row.scenario.item.itemId);
      if (!current || (row.gain?.absolute ?? -Infinity) > (current.gain?.absolute ?? -Infinity)) {
        best.set(row.scenario.item.itemId, row);
      }
    }

    const exclusiveChoices: ExclusiveChoice[] = [];
    for (const source of sources) {
      if (!source.exclusive) continue;
      const choiceRows = rows
        .filter((row) => row.sourceIds.includes(source.id) && row.mean !== null)
        .sort((a, b) => (b.mean ?? -Infinity) - (a.mean ?? -Infinity));
      const top = choiceRows[0] ?? null;
      exclusiveChoices.push({
        sourceId: source.id,
        label: source.label,
        hypothetical: source.hypothetical === true,
        rows: choiceRows,
        best: top,
        // Indistinguishable rewards are not a recommendation.
        indistinguishable: top
          ? choiceRows.slice(1).filter((row) => compareCandidates(
              { mean: top.mean!, margin: top.margin, iterations: top.iterations ?? 0 },
              { mean: row.mean!, margin: row.margin, iterations: row.iterations ?? 0 },
            ) !== 'a_better')
          : [],
      });
    }

    return {
      ...r,
      warnings: [...r.warnings, ...warnings],
      rows,
      bestPerItem: [...best.values()],
      exclusiveChoices,
      probabilitiesUnavailable: true,
      probabilityExplanation:
        'Drop probabilities are not shown because this build has no verified loot table: ' +
        'the engine source carries no loot source membership, so neither the chance of ' +
        'an item dropping nor the set of eligible outcomes is known. Every figure here is ' +
        'the deterministic result of equipping that item, not an expected value.',
    };
  });

  return { result, cancel: () => controller.abort() };
}

/** Source navigation catalog-driven (P09.1); reason returned for unavailable sources. */
export function sourceAvailability(catalog: Catalog, now = Date.now()): {
  available: DropSource[];
  unavailableReason: string | null;
  attribution: string[];
  limitations: string[];
  /** When this loot data stops being usable, for display. The refusal is in `Catalog`. */
  expiresAt: string | null;
} {
  const loot = catalog.lootSources(now);
  const available: DropSource[] = loot.sources.map((source) => ({
    id: source.id,
    label: source.instanceName ? `${source.instanceName} — ${source.name}` : source.name,
    provenance: 'catalog',
    // For source card instance art without second round trip.
    mediaId: source.mediaId,
    // Items by id only, no bonus ids; loot table does not specify item level (P09).
    items: source.itemIds.map((itemId) => ({
      instanceId: `${source.id}:${itemId}`,
      source: 'hypothetical' as const,
      slot: 'head' as const, // replaced per eligible slot by buildScenarios
      itemId,
      bonusIds: [],
      // Present and empty, never absent.
      gemIds: [],
    })),
  }));

  return {
    available,
    unavailableReason: loot.unavailableReason,
    expiresAt: loot.expiresAt,
    attribution: loot.provenance.map((p) => p.attribution),
    limitations: [
      ...loot.provenance.flatMap((p) => p.limitations),
      'A loot source lists which items an encounter can award, not at what item level. ' +
      'Items from a source carry no bonus ids, so they resolve at their base item level ' +
      'until you choose a difficulty or reward level to evaluate.',
    ],
  };
}

// Applies chosen item level to source items; caller supplies level, not inferred.
// --- Filtering a source's loot (P09.2) ---------------------------------------

/** Why an item was filtered out; every reason is a fact from engine data. */
export type UsabilityReason = 'class' | 'armor_type' | 'primary_stat' | 'slot';

export interface UsabilityCriteria {
  /** Class id, checked against the item's class mask. */
  classId: number;
  /** Armor subclass the character wears (1 cloth, 2 leather, 3 mail, 4 plate); armor pieces only. */
  armorSubclass?: number | null;
  /** Primary stat (AGILITY, STRENGTH, INTELLECT); single different primary filtered, combined kept. */
  primaryStat?: number | null;
  /** Slots the character is filling. An item that fits none of them is filtered. */
  slots?: GearSlot[];
}

// Applies user's gem, enchant, crafted-stat preferences to dropped items (P09.3); nothing invented.
function dress(
  instance: ItemInstance,
  resolved: ResolvedItem,
  slot: GearSlot,
  opts: DroptimizerOptions,
  unchecked: string[],
): ItemInstance {
  let dressed = instance;

  const gems = opts.preferredGems?.[slot];
  if (gems && gems.length > 0) {
    // More gems than sockets is caller over-supplying, not a reason to reject.
    const fit = gems.slice(0, resolved.sockets.length);
    if (fit.length > 0) dressed = { ...dressed, gemIds: fit };
    if (gems.length > resolved.sockets.length) {
      unchecked.push(
        `${resolved.name} has ${resolved.sockets.length} socket(s); ` +
        `${gems.length - resolved.sockets.length} preferred gem(s) were not applied`,
      );
    }
  }

  const enchant = opts.preferredEnchants?.[slot];
  if (enchant !== undefined) dressed = { ...dressed, enchantId: enchant };

  // Crafted stats only apply to items with crafted-stat placeholders.
  if (opts.preferredCraftedStats?.length) {
    if (resolved.craftingQuality > 0) {
      dressed = { ...dressed, craftedStats: opts.preferredCraftedStats };
    } else {
      unchecked.push(`${resolved.name} is not a crafted item, so crafted stats were not applied`);
    }
  }

  // Any change creates different physical item from loot table original.
  if (dressed !== instance) {
    dressed = {
      ...dressed,
      instanceId: `${instance.instanceId}+g${(dressed.gemIds ?? []).join('.')}+e${dressed.enchantId ?? ''}+c${(dressed.craftedStats ?? []).join('.')}`,
    };
  }
  return dressed;
}

// NOT Blizzard's loot spec (not in ItemSpec DB2); filters on class, armor subclass, primary stat, slot instead.
export function usabilityReasons(item: ResolvedItem, criteria: UsabilityCriteria): UsabilityReason[] {
  const reasons: UsabilityReason[] = [];

  if (item.classMask !== 0 && criteria.classId > 0) {
    if ((item.classMask & classMaskFor(criteria.classId)) === 0) reasons.push('class');
  }

  const ARMOR_SUBCLASSES = [1, 2, 3, 4];
  if (
    item.itemClass === ITEM_CLASS.ARMOR &&
    // Every cloak is cloth and every class wears one.
    item.inventoryType !== INVTYPE.CLOAK &&
    ARMOR_SUBCLASSES.includes(item.itemSubclass) &&
    criteria.armorSubclass != null &&
    item.itemSubclass !== criteria.armorSubclass
  ) {
    reasons.push('armor_type');
  }

  if (criteria.primaryStat != null) {
    const SINGLE_PRIMARIES: number[] = [ITEM_MOD.AGILITY, ITEM_MOD.STRENGTH, ITEM_MOD.INTELLECT];
    const primaries = item.stats.filter((s) => SINGLE_PRIMARIES.includes(s.type));
    // Filter only for single wrong primary; no primary or combined primary is usable by anyone.
    if (primaries.length > 0 && !primaries.some((s) => s.type === criteria.primaryStat)) {
      reasons.push('primary_stat');
    }
  }

  if (criteria.slots && criteria.slots.length > 0) {
    if (!item.eligibleSlots.some((s) => criteria.slots!.includes(s))) reasons.push('slot');
  }

  return reasons;
}

/** Filters items from sources but keeps sources themselves for empty-result messaging. */
export function filterSources(
  sources: DropSource[],
  catalog: Catalog,
  criteria: UsabilityCriteria,
  playerLevel = 0,
): { sources: DropSource[]; removed: { sourceId: string; itemId: number; reasons: UsabilityReason[] }[] } {
  const removed: { sourceId: string; itemId: number; reasons: UsabilityReason[] }[] = [];
  const filtered = sources.map((source) => ({
    ...source,
    items: source.items.filter((instance) => {
      const item = catalog.resolve(instance, playerLevel);
      // Unresolved items are kept; hiding them would filter on ignorance.
      if (!item) return true;
      const reasons = usabilityReasons(item, criteria);
      if (reasons.length === 0) return true;
      removed.push({ sourceId: source.id, itemId: instance.itemId, reasons });
      return false;
    }),
  }));
  return { sources: filtered, removed };
}

export function atItemLevel(source: DropSource, itemLevel: number): DropSource {
  if (!Number.isInteger(itemLevel) || itemLevel <= 0) {
    throw new Error(`item level must be a positive integer, got ${itemLevel}`);
  }
  return {
    ...source,
    label: `${source.label} (item level ${itemLevel})`,
    hypothetical: true,
    items: source.items.map((item) => ({
      ...item,
      instanceId: `${item.instanceId}@${itemLevel}`,
      itemLevel,
    })),
  };
}
