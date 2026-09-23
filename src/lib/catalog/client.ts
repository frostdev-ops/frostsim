// Main-thread handle for catalog worker; parsing 15MB JSON and scanning 110k rows off main thread (P05.7).

import {
  CATALOG_PROTOCOL_VERSION, handleRequest, newState, toPlainRequest,
  type CatalogRequest, type CatalogResponse, type DropSourceCounts, type Envelope,
  type WorkerMessage, type WorkerPlanOptions, type WorkerState,
} from './protocol';
import type { GenerationReport } from '../optimization/candidates';
import type { Candidate } from '../optimization/types';
import type {
  DropScenario, DropSource, UsabilityCriteria, UsabilityReason,
} from '../optimization/droptimizer';
import type { Selection, WorkEstimate } from '../optimization/topgear';
import type { GemOption, SearchQuery } from './catalog';
import type { CompatWarning, EngineIdentity } from './load';
import type {
  CatalogManifest, Consumable, Embellishment, EnchantOption, GearSlot, ItemInstance, LootProvenance,
  LootSource, ResolvedItem, SetBonus, SpecEntry, TalentTree,
} from './types';

export type CatalogHandleResult =
  | { ok: true; manifest: CatalogManifest; warnings: CompatWarning[] }
  | { ok: false; reason: string; message: string };

interface Transport {
  send(request: CatalogRequest): Promise<CatalogResponse>;
  dispose(): void;
}

function workerTransport(): Transport {
  const worker = new Worker(new URL('./catalog-worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (r: CatalogResponse) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const { id, payload } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (payload.ok) entry.resolve(payload.response);
    else entry.reject(new Error(payload.error));
  };
  worker.onerror = (event) => {
    // Worker-level failure settles all pending; hung promise would leave UI waiting forever.
    const error = new Error(`catalog worker failed: ${event.message}`);
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  return {
    send(request) {
      const id = nextId++;
      // Reduce to plain data before posting; Proxy objects fail structured clone with opaque error.
      let payload: CatalogRequest;
      try {
        payload = toPlainRequest(request);
      } catch (err) {
        return Promise.reject(err);
      }
      const envelope: Envelope<CatalogRequest> = { protocol: CATALOG_PROTOCOL_VERSION, id, payload };
      return new Promise<CatalogResponse>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage(envelope);
        } catch (err) {
          pending.delete(id);
          reject(new Error(`catalog worker rejected the ${request.kind} request: ${String(err)}`));
        }
      });
    },
    dispose() {
      for (const [, entry] of pending) entry.reject(new Error('catalog worker disposed'));
      pending.clear();
      worker.terminate();
    },
  };
}

/** In-process handler for tests and no-worker environments; still reduces to plain data to catch failures. */
export function inlineTransport(state: WorkerState = newState()): Transport {
  return {
    send: (request) => handleRequest(state, toPlainRequest(request)),
    dispose: () => { state.catalog = null; },
  };
}

export class CatalogClient {
  private readonly talentTrees = new Map<number, Promise<TalentTree | null>>();
  private constructor(private readonly transport: Transport) {}

  static create(transport?: Transport): CatalogClient {
    return new CatalogClient(transport ?? workerTransport());
  }

  /** Discriminated result, never a throw; UI shows stale-catalog state when needed. */
  async load(baseUrl: string, engine: EngineIdentity | null): Promise<CatalogHandleResult> {
    const r = await this.transport.send({ kind: 'load', baseUrl, engine });
    if (r.kind !== 'load') throw new Error(`unexpected response ${r.kind}`);
    return r.ok
      ? { ok: true, manifest: r.manifest, warnings: r.warnings }
      : { ok: false, reason: r.reason, message: r.message };
  }

  async resolve(instances: ItemInstance[], playerLevel?: number): Promise<{
    items: Map<string, ResolvedItem>;
    missing: string[];
  }> {
    const r = await this.transport.send({ kind: 'resolve', instances, playerLevel });
    if (r.kind !== 'resolve') throw new Error(`unexpected response ${r.kind}`);
    return { items: new Map(r.items), missing: r.missing };
  }

  async search(query: SearchQuery): Promise<ResolvedItem[]> {
    const r = await this.transport.send({ kind: 'search', query });
    return r.kind === 'search' ? r.items : [];
  }

  async enchantsFor(instance: ItemInstance, playerLevel?: number): Promise<EnchantOption[]> {
    const r = await this.transport.send({ kind: 'enchantsFor', instance, playerLevel });
    return r.kind === 'enchantsFor' ? r.enchants : [];
  }

  /** Gems that at least one socket accepts; each carries uniqueEquipped to prevent same unique in two sockets. */
  async gemsFor(socketColors: number[]): Promise<GemOption[]> {
    const r = await this.transport.send({ kind: 'gemsFor', socketColors });
    return r.kind === 'gemsFor' ? r.gems : [];
  }

  /** Specs for a class, or all when classId omitted. Empty array means catalog outdated, not no specs. */
  async specs(classId?: number): Promise<SpecEntry[]> {
    const r = await this.transport.send({ kind: 'specs', classId });
    return r.kind === 'specs' ? r.specs : [];
  }

  /** Every embellishment: name, option token, bonus/effect/spell id; slot and wear limit not in data. */
  async embellishments(): Promise<Embellishment[]> {
    const r = await this.transport.send({ kind: 'embellishments' });
    return r.kind === 'embellishments' ? r.embellishments : [];
  }

  async consumables(kind: Consumable['kind']): Promise<Consumable[]> {
    const r = await this.transport.send({ kind: 'consumables', consumableKind: kind });
    return r.kind === 'consumables' ? r.consumables : [];
  }

  async setBonuses(setId: number): Promise<SetBonus[]> {
    const r = await this.transport.send({ kind: 'setBonuses', setId });
    return r.kind === 'setBonuses' ? r.sets : [];
  }

  /** Cached per class: every talent preview on a page would otherwise copy the whole tree out of the worker. Read-only. */
  talentTree(classId: number): Promise<TalentTree | null> {
    let request = this.talentTrees.get(classId);
    if (!request) {
      request = this.transport.send({ kind: 'talentTree', classId }).then((r) => r.kind === 'talentTree' ? r.tree : null);
      // A failed fetch is not remembered, so the next caller retries.
      request.then((tree) => { if (!tree) this.talentTrees.delete(classId); }, () => this.talentTrees.delete(classId));
      this.talentTrees.set(classId, request);
    }
    return request;
  }

  /** Coverage matrix for gating features and explaining missing data. */
  async coverage(): Promise<CatalogManifest['coverage']> {
    const r = await this.transport.send({ kind: 'coverage' });
    return r.kind === 'coverage' ? r.coverage : [];
  }

  /** Loot sources ready for planDroptimizer, optionally filtered. criteria filters CLASS/ARMOR/STAT/SLOT (not loot specialization). Rendered sources must show attribution. */
  async dropSources(criteria?: UsabilityCriteria, playerLevel?: number): Promise<{
    available: DropSource[];
    unavailableReason: string | null;
    /** When loot data stops being usable. */
    expiresAt: string | null;
    attribution: string[];
    limitations: string[];
    removed: { sourceId: string; itemId: number; reasons: UsabilityReason[] }[];
    counts: DropSourceCounts;
  }> {
    const r = await this.transport.send({ kind: 'dropSources', criteria, playerLevel });
    return r.kind === 'dropSources'
      ? {
          available: r.available,
          unavailableReason: r.unavailableReason,
          expiresAt: r.expiresAt,
          attribution: r.attribution,
          limitations: r.limitations,
          removed: r.removed,
          counts: r.counts,
        }
      : {
          available: [],
          unavailableReason: 'the catalog worker did not answer',
          expiresAt: null,
          attribution: [],
          limitations: [],
          removed: [],
          counts: { sources: 0, itemsBefore: 0, itemsAfter: 0, filtered: false },
        };
  }

  async lootSources(): Promise<{ sources: LootSource[]; provenance: LootProvenance[]; unavailableReason: string | null }> {
    const r = await this.transport.send({ kind: 'lootSources' });
    return r.kind === 'lootSources'
      ? { sources: r.sources, provenance: r.provenance, unavailableReason: r.unavailableReason }
      : { sources: [], provenance: [], unavailableReason: 'the catalog worker did not answer' };
  }

  /** Pre-launch workload estimate (P08.7), computed in worker to parse item table once. */
  async estimateWork(selection: Selection, options: WorkerPlanOptions): Promise<WorkEstimate | null> {
    const r = await this.transport.send({ kind: 'estimateWork', selection, options });
    return r.kind === 'estimateWork' ? r.estimate : null;
  }

  /** Generates legal Top Gear candidates; execution on caller side. Feed to runStagedSearch. */
  async planTopGear(selection: Selection, options: WorkerPlanOptions): Promise<{
    candidates: Candidate[];
    report: GenerationReport;
    catalogId: string;
  } | null> {
    const r = await this.transport.send({ kind: 'planTopGear', selection, options });
    return r.kind === 'planTopGear' ? { candidates: r.candidates, report: r.report, catalogId: r.catalogId } : null;
  }

  /** The Droptimizer equivalent: scenarios in, execution left to the caller. */
  async planDroptimizer(
    sources: DropSource[],
    options: WorkerPlanOptions & {
      allEligibleSlots?: boolean;
      companionOffHand?: ItemInstance | null;
      /** Gems, enchant, crafted stats for dropped items (P09.3). No upgrade-ceiling option: would be a guess. */
      preferredGems?: Partial<Record<GearSlot, number[]>>;
      preferredEnchants?: Partial<Record<GearSlot, number>>;
      preferredCraftedStats?: number[];
    },
  ): Promise<{ scenarios: DropScenario[]; sourcesFor: Map<string, string[]>; warnings: string[]; catalogId: string } | null> {
    const r = await this.transport.send({ kind: 'planDroptimizer', sources, options });
    return r.kind === 'planDroptimizer'
      ? { scenarios: r.scenarios, sourcesFor: new Map(r.sourcesFor), warnings: r.warnings, catalogId: r.catalogId }
      : null;
  }

  dispose(): void {
    this.transport.dispose();
  }
}
