// Catalog worker protocol: handler is plain function over plain state (testable without worker). Everything structured-clonable.

import { Catalog, type CatalogPayloads, type GemOption, type SearchQuery } from './catalog';
import { checkCompatibility, type CompatWarning, type EngineIdentity } from './load';
import type { CharacterConstraints } from './legality';
import { collect, generate, type GenerationReport } from '../optimization/candidates';
import {
  buildScenarios, filterSources, sourceAvailability,
  type DropScenario, type DropSource, type UsabilityCriteria, type UsabilityReason,
} from '../optimization/droptimizer';
import { DEFAULT_WORK_CAP, estimateWork, selectionToDimensions, type Selection, type WorkEstimate } from '../optimization/topgear';
import type { Candidate, StagePlan } from '../optimization/types';
import type {
  CatalogManifest, Consumable, Embellishment, EnchantOption, GearSlot, ItemInstance, LootCatalog,
  LootProvenance, LootSource, ResolvedItem, SetBonus, SpecEntry, TalentTree,
} from './types';

export const CATALOG_PROTOCOL_VERSION = 1;

export type CatalogRequest =
  | { kind: 'load'; baseUrl: string; engine: EngineIdentity | null }
  | { kind: 'resolve'; instances: ItemInstance[]; playerLevel?: number }
  | { kind: 'search'; query: SearchQuery }
  | { kind: 'enchantsFor'; instance: ItemInstance; playerLevel?: number }
  | { kind: 'gemsFor'; socketColors: number[] }
  | { kind: 'specs'; classId?: number }
  | { kind: 'embellishments' }
  | { kind: 'consumables'; consumableKind: Consumable['kind'] }
  | { kind: 'setBonuses'; setId: number }
  | { kind: 'talentTree'; classId: number }
  | { kind: 'coverage' }
  | { kind: 'lootSources' }
  | { kind: 'dropSources'; criteria?: UsabilityCriteria; playerLevel?: number }
  /** Candidate generation beside catalog (P08.6) so 15 MB item table parsed once in worker; result is plain structured-clonable data. */
  | { kind: 'planTopGear'; selection: Selection; options: WorkerPlanOptions }
  | { kind: 'estimateWork'; selection: Selection; options: WorkerPlanOptions }
  | {
      kind: 'planDroptimizer';
      sources: DropSource[];
      options: WorkerPlanOptions & {
        allEligibleSlots?: boolean;
        companionOffHand?: ItemInstance | null;
        /** P09.3 preferences. Caller-supplied values only; see `dress` in droptimizer.ts. */
        preferredGems?: Partial<Record<GearSlot, number[]>>;
        preferredEnchants?: Partial<Record<GearSlot, number>>;
        preferredCraftedStats?: number[];
      };
    };

/** Parts of optimizer's options that can cross worker boundary. */
/** Distinguishes "no loot data in build" from "nothing usable": itemsBefore=0 no reason = sources but no items; itemsAfter=0 itemsBefore>0 = filter removed all. */
export interface DropSourceCounts {
  sources: number;
  itemsBefore: number;
  itemsAfter: number;
  /** True when criteria were applied at all. False means nothing was filtered. */
  filtered: boolean;
}

export interface WorkerPlanOptions {
  character: CharacterConstraints;
  /** Slot -> instance as pairs (Map survives structured clone but pairs simpler to validate). */
  baselineGear: [GearSlot, ItemInstance | null][];
  playerLevel?: number;
  workCap?: number;
  plan?: StagePlan;
  /** How many embellishments character may wear (not in engine data; enforced only when supplied). */
  embellishmentLimit?: number;
}

export type CatalogResponse =
  | { kind: 'load'; ok: true; manifest: CatalogManifest; warnings: CompatWarning[] }
  | { kind: 'load'; ok: false; reason: string; message: string }
  | { kind: 'resolve'; items: [string, ResolvedItem][]; missing: string[] }
  | { kind: 'search'; items: ResolvedItem[] }
  | { kind: 'enchantsFor'; enchants: EnchantOption[] }
  | { kind: 'gemsFor'; gems: GemOption[] }
  | { kind: 'specs'; specs: SpecEntry[] }
  | { kind: 'embellishments'; embellishments: Embellishment[] }
  | { kind: 'consumables'; consumables: Consumable[] }
  | { kind: 'setBonuses'; sets: SetBonus[] }
  | { kind: 'talentTree'; tree: TalentTree | null }
  | { kind: 'coverage'; coverage: CatalogManifest['coverage'] }
  | { kind: 'lootSources'; sources: LootSource[]; provenance: LootProvenance[]; unavailableReason: string | null }
  | {
      kind: 'dropSources';
      available: DropSource[];
      unavailableReason: string | null;
      expiresAt: string | null;
      attribution: string[];
      limitations: string[];
      removed: { sourceId: string; itemId: number; reasons: UsabilityReason[] }[];
      counts: DropSourceCounts;
    }
  | { kind: 'planTopGear'; candidates: Candidate[]; report: GenerationReport; catalogId: string }
  | { kind: 'estimateWork'; estimate: WorkEstimate }
  | { kind: 'planDroptimizer'; scenarios: DropScenario[]; sourcesFor: [string, string[]][]; warnings: string[]; catalogId: string };

export interface Envelope<T> {
  protocol: number;
  id: number;
  payload: T;
}

export type WorkerMessage =
  | Envelope<{ ok: true; response: CatalogResponse }>
  | Envelope<{ ok: false; error: string }>;

export interface WorkerState {
  catalog: Catalog | null;
  baseUrl: string | null;
}

export class UnclonableRequestError extends Error {
  constructor(readonly path: string, readonly what: string) {
    super(
      `catalog request cannot cross a worker boundary: ${path} is ${what}. ` +
      'Every value in a request must be plain data — objects, arrays, numbers, strings, booleans, null. ' +
      'A reactive store value is usually a Proxy; take a snapshot of it first.',
    );
    this.name = 'UnclonableRequestError';
  }
}

/** Rebuilds request as plain data; postMessage rejects Proxy/functions/symbols/class instances. Caller gets exact path instead of bare "could not clone". */
export function toPlainRequest<T>(value: T, path = 'request'): T {
  return plain(value, path, new WeakSet()) as T;
}

function plain(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') return value;
  if (type === 'bigint') throw new UnclonableRequestError(path, 'a bigint');
  if (type === 'function') throw new UnclonableRequestError(path, 'a function');
  if (type === 'symbol') throw new UnclonableRequestError(path, 'a symbol');

  const object = value as object;
  if (seen.has(object)) throw new UnclonableRequestError(path, 'a circular reference');
  seen.add(object);
  try {
    if (Array.isArray(object)) return object.map((v, i) => plain(v, `${path}[${i}]`, seen));
    if (object instanceof Map) return new Map([...object].map(([k, v], i) => [k, plain(v, `${path}.get(${String(k)})[${i}]`, seen)]));
    if (object instanceof Set) return new Set([...object].map((v, i) => plain(v, `${path}[${i}]`, seen)));
    if (object instanceof Date) return new Date(object.getTime());

    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      // Proxy of plain object reports Object.prototype; rejects real class instances, not reactive state.
      throw new UnclonableRequestError(path, `an instance of ${object.constructor?.name ?? 'a class'}`);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      out[key] = plain((object as Record<string, unknown>)[key], `${path}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

export function newState(): WorkerState {
  return { catalog: null, baseUrl: null };
}

/** Injected so tests can drive the handler without a network. */
export type FetchJson = (url: string) => Promise<unknown>;

export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

const PAYLOAD_FILES = [
  'items.json', 'item-bonus.json', 'scaling.json', 'enchants.json',
  'gems.json', 'sets.json', 'embellishments.json', 'consumables.json',
] as const;

export class NotLoadedError extends Error {
  constructor() { super('catalog has not been loaded in this worker'); }
}

export async function handleRequest(
  state: WorkerState,
  request: CatalogRequest,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<CatalogResponse> {
  if (request.kind === 'load') {
    const base = request.baseUrl.replace(/\/+$/, '');
    let manifest: CatalogManifest;
    try {
      manifest = (await fetchJson(`${base}/manifest.json`)) as CatalogManifest;
    } catch (err) {
      return { kind: 'load', ok: false, reason: 'unavailable', message: `catalog manifest unavailable: ${String(err)}` };
    }
    if (manifest?.schemaVersion !== 1) {
      return { kind: 'load', ok: false, reason: 'unsupported_schema', message: `catalog schema ${manifest?.schemaVersion} is not supported` };
    }
    try {
      const parts = await Promise.all(PAYLOAD_FILES.map((f) => fetchJson(`${base}/${f}`)));
      const [items, bonus, scaling, enchants, gems, sets, embellishments, consumables] = parts;
      // Optional: catalog before spec table has no specs.json (must load not fail); specsFor() returns empty (documented as "rebuild catalog").
      const specs = await fetchJson(`${base}/specs.json`).catch(() => undefined);
      const payloads = { manifest, items, bonus, scaling, enchants, gems, sets, embellishments, consumables, specs } as CatalogPayloads;
      if (!payloads.items?.count || !Array.isArray(payloads.items.id)) {
        return { kind: 'load', ok: false, reason: 'malformed', message: 'items.json is missing its columns' };
      }
      const catalog = new Catalog(payloads);
      // Loot optional (only when adapter configured at build time); absence normal and never error.
      if (manifest.loot?.path) {
        try {
          catalog.registerLoot((await fetchJson(`${base}/${manifest.loot.path}`)) as LootCatalog);
        } catch {
          // Manifest promised loot but file not there; catalog still works, loot browsing off.
        }
      }
      state.catalog = catalog;
      state.baseUrl = base;
      return { kind: 'load', ok: true, manifest, warnings: checkCompatibility(manifest, request.engine) };
    } catch (err) {
      return { kind: 'load', ok: false, reason: 'unavailable', message: `catalog payload unavailable: ${String(err)}` };
    }
  }

  const catalog = state.catalog;
  if (!catalog) throw new NotLoadedError();

  switch (request.kind) {
    case 'resolve': {
      const items: [string, ResolvedItem][] = [];
      const missing: string[] = [];
      for (const instance of request.instances) {
        const r = catalog.resolve(instance, request.playerLevel ?? 0);
        if (r) items.push([instance.instanceId, r]);
        else missing.push(instance.instanceId);
      }
      return { kind: 'resolve', items, missing };
    }
    case 'search':
      return { kind: 'search', items: catalog.search(request.query) };
    case 'enchantsFor': {
      const r = catalog.resolve(request.instance, request.playerLevel ?? 0);
      return { kind: 'enchantsFor', enchants: r ? catalog.enchantsFor(r) : [] };
    }
    case 'gemsFor':
      return { kind: 'gemsFor', gems: catalog.gemsFor(request.socketColors) };
    case 'specs':
      return {
        kind: 'specs',
        specs: request.classId === undefined ? catalog.allSpecs() : catalog.specsFor(request.classId),
      };
    case 'embellishments':
      return { kind: 'embellishments', embellishments: catalog.embellishments() };
    case 'consumables':
      return { kind: 'consumables', consumables: catalog.consumablesOfKind(request.consumableKind) };
    case 'setBonuses':
      return { kind: 'setBonuses', sets: catalog.setBonusesFor(request.setId) };
    case 'talentTree': {
      const cached = catalog.talentTree(request.classId);
      if (cached) return { kind: 'talentTree', tree: cached };
      try {
        const tree = (await fetchJson(`${state.baseUrl}/talents/class-${request.classId}.json`)) as TalentTree;
        catalog.registerTalentTree(tree);
        return { kind: 'talentTree', tree };
      } catch {
        return { kind: 'talentTree', tree: null };
      }
    }
    case 'coverage':
      return { kind: 'coverage', coverage: catalog.manifest.coverage };

    case 'lootSources':
      return { kind: 'lootSources', ...catalog.lootSources() };

    // Whole P09 entry path in one call (both halves need Catalog; main thread never holds one).
    case 'dropSources': {
      const availability = sourceAvailability(catalog);
      const itemsBefore = countItems(availability.available);
      const base = {
        kind: 'dropSources' as const,
        unavailableReason: availability.unavailableReason,
        expiresAt: availability.expiresAt,
        attribution: availability.attribution,
        limitations: availability.limitations,
      };
      if (!request.criteria) {
        return {
          ...base,
          available: availability.available,
          removed: [],
          counts: {
            sources: availability.available.length, itemsBefore, itemsAfter: itemsBefore, filtered: false,
          },
        };
      }
      const filtered = filterSources(
        availability.available, catalog, request.criteria, request.playerLevel ?? 0,
      );
      return {
        ...base,
        available: filtered.sources,
        removed: filtered.removed,
        counts: {
          sources: filtered.sources.length,
          itemsBefore,
          itemsAfter: countItems(filtered.sources),
          filtered: true,
        },
      };
    }

    case 'estimateWork':
      return { kind: 'estimateWork', estimate: estimateWork(request.selection, planOptions(catalog, request.options)) };

    case 'planTopGear': {
      const opts = planOptions(catalog, request.options);
      const workCap = request.options.workCap ?? DEFAULT_WORK_CAP;
      const { candidates, report } = collect(
        generate(selectionToDimensions(request.selection, opts), {
          workCap,
          character: request.options.character,
          catalog,
          baselineGear: opts.baselineGear,
          playerLevel: request.options.playerLevel,
          requiredSets: request.selection.requiredSets,
          embellishmentBonusIds: opts.embellishmentBonusIds,
          embellishmentLimit: opts.embellishmentLimit,
        }),
        workCap,
      );
      return { kind: 'planTopGear', candidates, report, catalogId: catalog.catalogId };
    }

    case 'planDroptimizer': {
      const opts = planOptions(catalog, request.options);
      const { scenarios, sourcesFor, warnings } = buildScenarios(request.sources, {
        catalog,
        character: request.options.character,
        baselineGear: opts.baselineGear,
        playerLevel: request.options.playerLevel,
        allEligibleSlots: request.options.allEligibleSlots,
        companionOffHand: request.options.companionOffHand,
        preferredGems: request.options.preferredGems,
        preferredEnchants: request.options.preferredEnchants,
        preferredCraftedStats: request.options.preferredCraftedStats,
      });
      return {
        kind: 'planDroptimizer',
        scenarios,
        sourcesFor: [...sourcesFor.entries()],
        warnings,
        catalogId: catalog.catalogId,
      };
    }
  }
}

function countItems(sources: DropSource[]): number {
  return sources.reduce((n, s) => n + s.items.length, 0);
}

function planOptions(catalog: Catalog, options: WorkerPlanOptions) {
  return {
    catalog,
    character: options.character,
    baselineGear: new Map<GearSlot, ItemInstance | null>(options.baselineGear),
    playerLevel: options.playerLevel,
    workCap: options.workCap,
    plan: options.plan,
    // Generator can only enforce limit if it knows which bonus ids are embellishments; both travel together.
    embellishmentBonusIds: catalog.embellishments().map((e) => e.bonusId),
    embellishmentLimit: options.embellishmentLimit,
  };
}

/** Slot a resolved item can fill, for callers holding only the response. */
export function eligibleFor(item: ResolvedItem, slot: GearSlot): boolean {
  return item.eligibleSlots.includes(slot);
}
