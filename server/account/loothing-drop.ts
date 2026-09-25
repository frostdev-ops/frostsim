// Droptimizer for the Loothing integration (DESIGN.md P3): one cloud job measuring every drop of the chosen raid or dungeon bosses
// against the character's own gear. Candidates come from the web Droptimizer's own code (sourceAvailability, filterSources,
// buildScenarios) over the engine pack's own catalog, at the same verified raid and Mythic+ reward levels. Unlike the browser's adaptive
// search it is one profileset run at a fixed target error, because a server job is one sim with one report.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Catalog, type CatalogPayloads } from '../../src/lib/catalog/catalog';
import { SUPPORTED_CATALOG_SCHEMA } from '../../src/lib/catalog/load';
import { isMplusSource, mplusReward, MIN_KEY } from '../../src/lib/catalog/mplusRewards';
import { atRaidDifficulty, hasRaidRewards, type RaidDifficulty } from '../../src/lib/catalog/raidRewards';
import { GEAR_SLOTS, type GearSlot, type ItemInstance, type LootSource, type ResolvedItem } from '../../src/lib/catalog/types';
import { seasonBuildOf, withMaxUpgrade, withUpgradeRank } from '../../src/lib/catalog/upgrades';
import type { ImportedCharacter } from '../../src/lib/import/character';
import { characterConstraints } from '../../src/lib/import/constraints';
import { buildScenarios, filterSources, sourceAvailability, type DropSource } from '../../src/lib/optimization/droptimizer';
import type { SimRequest } from '../../src/lib/simc/assemble';
import type { Accuracy } from '../../src/lib/simc/options';
import { quickRequest } from '../../src/lib/simc/quick-request';
import { parseReport } from '../../src/lib/simc/report';

const DEFAULT_INDEX = '/opt/frostsim/engine-updates/engine-versions.json';
/** Every candidate runs to this error inside one job, which the worker stops at 1800 s (cloud/worker/agent.mjs RuntimeMaxSec). */
export const DROP_ACCURACY: Accuracy = { mode: 'targetError', targetError: 0.2, maxIterations: 10_000 };
/** Every Mythic+ dungeon of a season is about 160 for one character. At the 2,700 iterations/s measured on 32 cores, 200 candidates
 *  need about 2 minutes at a typical 1,500 iterations each and 12 at the iteration ceiling; an 8-thread plan takes four times that.
 *  ponytail: fixed cap, not scaled by the plan's threads; derive it from recorded droptimizer job timings once there are some. */
export const MAX_CANDIDATES = 200;
export const MAX_INSTANCES = 12;
/** Loothing's names for the raid difficulties, as Raidbots spells them. */
export const DIFFICULTIES: Readonly<Record<string, RaidDifficulty>> = { 'raid-finder': 'lfr', normal: 'normal', heroic: 'heroic', mythic: 'mythic' };

export class DropProblem extends Error {
  constructor(readonly code: 'unavailable' | 'no-candidates' | 'too-many-candidates' | 'invalid', message: string) {
    super(message);
  }
}

// One parsed catalog at a time: a pack's items.json is 15 MB, and every job uses the newest pack.
let cached: { packId: string; catalog: Promise<Catalog> } | null = null;

/** The catalog shipped inside engine pack `packId`, beside the index (scripts/update-engines.mjs writes engine/versions/<id>/catalog). */
export function packCatalog(packId: string, env: Record<string, string | undefined> = process.env): Promise<Catalog> {
  if (cached?.packId === packId) return cached.catalog;
  const dir = join(dirname(env.ENGINE_INDEX_PATH || DEFAULT_INDEX), 'engine/versions', packId, 'catalog');
  const read = async (file: string) => JSON.parse(await readFile(join(dir, file), 'utf8'));
  const catalog = (async () => {
    const manifest = await read('manifest.json');
    if (manifest?.schemaVersion !== SUPPORTED_CATALOG_SCHEMA) throw new Error(`catalog schema ${manifest?.schemaVersion} is not supported`);
    // As the catalog worker loads it (protocol.ts 'load'): loot is optional and named by the manifest.
    const [items, bonus, scaling, enchants, gems, sets, embellishments, consumables] = await Promise.all(
      ['items', 'item-bonus', 'scaling', 'enchants', 'gems', 'sets', 'embellishments', 'consumables'].map((f) => read(`${f}.json`)));
    const catalog = new Catalog({ manifest, items, bonus, scaling, enchants, gems, sets, embellishments, consumables } as CatalogPayloads);
    if (manifest.loot?.path) catalog.registerLoot(await read(manifest.loot.path));
    return catalog;
  })();
  cached = { packId, catalog };
  // A failed read is not cached: the next call retries.
  catalog.catch(() => { if (cached?.catalog === catalog) cached = null; });
  return catalog;
}

const encounterIdOf = (source: LootSource) => Number(/:encounter:(\d+)$/.exec(source.id)?.[1]) || undefined;

/** GET /droptimizer/sources: instances with their encounters and the reward levels Frostsim has verified for them. */
export function dropSources(catalog: Catalog, now = Date.now()) {
  const loot = catalog.lootSources(now);
  const build = seasonBuildOf(catalog.manifest);
  const byInstance = new Map<number, LootSource[]>();
  for (const s of loot.sources) {
    if ((s.kind !== 'raid' && s.kind !== 'dungeon') || s.instanceId === undefined) continue;
    byInstance.set(s.instanceId, [...(byInstance.get(s.instanceId) ?? []), s]);
  }
  return {
    ...(loot.unavailableReason ? { unavailableReason: loot.unavailableReason } : {}),
    attribution: [...new Set(loot.provenance.map((p) => p.attribution))],
    instances: [...byInstance].map(([instanceId, bosses]) => ({
      instanceId,
      name: bosses[0].instanceName ?? bosses[0].name,
      kind: bosses[0].kind,
      encounters: bosses.map((b) => ({ encounterId: encounterIdOf(b), name: b.name, itemCount: b.itemIds.length })),
      rewards: bosses.every((b) => hasRaidRewards(b, build)) ? { difficulties: Object.keys(DIFFICULTIES) }
        : bosses.every(isMplusSource) ? { keyLevels: { min: MIN_KEY } } : null,
    })),
  };
}

export interface DropSelector {
  instanceIds: number[];
  encounterIds?: number[];
  difficulty?: string;
  keyLevel?: number;
  bonusRoll?: boolean;
  maxUpgrade?: boolean;
}

/** What the detail needs and the report cannot say: which item, slot and bosses each profileset is. Kept in compute_jobs.meta. */
export interface DropMeta {
  kind: 'droptimizer';
  selector: DropSelector;
  candidates: {
    id: string; itemId: number; name: string; slot: GearSlot; itemLevel: number; bonusIds: number[];
    replaces: { itemId: number; name: string } | null;
    sources: { encounterId?: number; encounterName: string; instanceId?: number; instanceName?: string }[];
  }[];
}

/** Checks the body fields of a droptimizer create; throws DropProblem('invalid') with the first problem. */
export function parseSelector(body: Record<string, unknown>): DropSelector {
  const ints = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && (n as number) > 0);
  const { instanceIds, encounterIds, difficulty, keyLevel, bonusRoll, maxUpgrade } = body;
  if (!ints(instanceIds) || (instanceIds as number[]).length > MAX_INSTANCES) throw new DropProblem('invalid', `instanceIds must be 1-${MAX_INSTANCES} journal instance ids.`);
  if (encounterIds !== undefined && !ints(encounterIds)) throw new DropProblem('invalid', 'encounterIds must be journal encounter ids.');
  if ((difficulty === undefined) === (keyLevel === undefined)) throw new DropProblem('invalid', 'Give difficulty (raids) or keyLevel (dungeons), not both.');
  if (difficulty !== undefined && !Object.hasOwn(DIFFICULTIES, difficulty as string)) throw new DropProblem('invalid', `difficulty must be one of ${Object.keys(DIFFICULTIES).join(', ')}.`);
  if (keyLevel !== undefined && (!Number.isInteger(keyLevel) || (keyLevel as number) < MIN_KEY || (keyLevel as number) > 99)) throw new DropProblem('invalid', `keyLevel must be a whole number from ${MIN_KEY}.`);
  for (const [name, v] of [['bonusRoll', bonusRoll], ['maxUpgrade', maxUpgrade]] as const) {
    if (v !== undefined && typeof v !== 'boolean') throw new DropProblem('invalid', `${name} must be true or false.`);
  }
  return {
    instanceIds: [...new Set(instanceIds as number[])],
    ...(encounterIds ? { encounterIds: [...new Set(encounterIds as number[])] } : {}),
    ...(difficulty !== undefined ? { difficulty: difficulty as string } : { keyLevel: keyLevel as number }),
    bonusRoll: bonusRoll === true, maxUpgrade: maxUpgrade === true,
  };
}

/** The job's request and meta: the web Droptimizer's candidates for `character`, as profilesets on Quick Sim's scenario for `presetId`. */
export function droptimizerRequest(catalog: Catalog, character: ImportedCharacter, selector: DropSelector, presetId: string, now = Date.now()):
  { request: SimRequest; meta: DropMeta } {
  const loot = catalog.lootSources(now);
  if (loot.unavailableReason) throw new DropProblem('unavailable', loot.unavailableReason);
  const chosen = loot.sources.filter((s) => s.instanceId !== undefined && selector.instanceIds.includes(s.instanceId)
    && (!selector.encounterIds || selector.encounterIds.includes(encounterIdOf(s) ?? -1)));
  const missing = selector.instanceIds.filter((id) => !chosen.some((s) => s.instanceId === id));
  if (missing.length) throw new DropProblem('unavailable', `No loot is known for instance ${missing.join(', ')} with those encounters this season.`);

  const level = character.level ?? 0;
  const build = seasonBuildOf(catalog.manifest);
  let evaluate: (source: DropSource, loot: LootSource) => DropSource;
  if (selector.difficulty !== undefined) {
    const bad = chosen.find((s) => !hasRaidRewards(s, build));
    if (bad) throw new DropProblem('unavailable', `Verified raid reward levels are unavailable for ${bad.name}; difficulty applies to raids only.`);
    evaluate = (source, l) => atRaidDifficulty(source, l, build, DIFFICULTIES[selector.difficulty!], selector.maxUpgrade, selector.bonusRoll);
  } else {
    const bad = chosen.find((s) => !isMplusSource(s));
    if (bad) throw new DropProblem('unavailable', `Mythic+ reward levels are unavailable for ${bad.instanceName ?? bad.name}; keyLevel applies to this season's dungeons only.`);
    const reward = mplusReward(selector.keyLevel!, selector.bonusRoll === true);
    if (!reward) throw new DropProblem('unavailable', 'No verified Mythic+ reward level for that key this season.');
    // As Droptimizer.svelte evaluatedSource: the key's track and rank, optionally fully upgraded.
    evaluate = (source) => ({ ...source, hypothetical: true, items: source.items.map((item) => {
      const drop = withUpgradeRank(item, reward.track.id, reward.rank.rank);
      return selector.maxUpgrade ? withMaxUpgrade(drop)! : drop;
    }) });
  }

  const resolved = new Map<string, ResolvedItem>();
  for (const item of character.equipped) {
    const r = catalog.resolve(item, level);
    if (r) resolved.set(item.instanceId, r);
  }
  const { constraints } = characterConstraints(character, resolved, level);
  const ids = new Set(chosen.map((s) => s.id));
  const available = sourceAvailability(catalog, now).available.filter((s) => ids.has(s.id));
  // "Only items I can use", as the web filter: class and armor type. Primary stat stays unchecked there too.
  const usable = filterSources(available, catalog, { classId: constraints.classId, armorSubclass: constraints.armorSubclass, primaryStat: null, slots: [...GEAR_SLOTS] }, level).sources;
  const lootById = new Map(chosen.map((s) => [s.id, s]));
  const sources = usable.filter((s) => s.items.length).map((s) => evaluate(s, lootById.get(s.id)!));
  const equipped = new Map<GearSlot, ItemInstance | null>(GEAR_SLOTS.map((slot) => [slot, character.equipped.find((i) => i.slot === slot) ?? null]));
  const { scenarios, sourcesFor } = sources.length
    ? buildScenarios(sources, { catalog, character: constraints, baselineGear: equipped, playerLevel: level, allEligibleSlots: true })
    : { scenarios: [], sourcesFor: new Map<string, string[]>() };
  if (!scenarios.length) throw new DropProblem('no-candidates', 'Nothing from those bosses is an item this character can use.');
  if (scenarios.length > MAX_CANDIDATES) {
    throw new DropProblem('too-many-candidates', `${scenarios.length} candidates; at most ${MAX_CANDIDATES} run in one job. Choose fewer encounters.`);
  }

  const base = quickRequest(character, { presetId, threads: 1, accuracy: DROP_ACCURACY });
  const request: SimRequest = { ...base, profilesets: scenarios.map((s) => ({ id: s.candidate.id, lines: s.candidate.lines })) };
  const meta: DropMeta = {
    kind: 'droptimizer', selector,
    candidates: scenarios.map((s) => {
      const item = s.candidate.delta.gear!.get(s.slot)!;
      return {
        id: s.candidate.id, itemId: s.item.itemId, name: s.item.name, slot: s.slot, itemLevel: s.item.itemLevel, bonusIds: item.bonusIds ?? [],
        replaces: s.replaces ? { itemId: s.replaces.itemId, name: s.replaces.name } : null,
        sources: (sourcesFor.get(s.candidate.id) ?? [s.sourceId]).map((id) => lootById.get(id)!).map((l) => ({
          encounterId: encounterIdOf(l), encounterName: l.name, instanceId: l.instanceId, instanceName: l.instanceName,
        })),
      };
    }),
  };
  return { request, meta };
}

const round = (v: number | undefined, places = 0) => (v === undefined || !Number.isFinite(v) ? undefined : Number(v.toFixed(places)));

/** Baseline and every candidate of a finished droptimizer report, best gain first. A candidate simc left out is 'missing'. */
export function droptimizerResult(raw: unknown, meta: DropMeta) {
  const report = parseReport(raw);
  const player = report.players[0];
  const baseline = player?.dps.mean;
  const sets = new Map(report.profilesets.map((p) => [p.name, p]));
  const { selector } = meta;
  const reward = selector.difficulty !== undefined ? { difficulty: selector.difficulty } : { keyLevel: selector.keyLevel };
  const candidates = meta.candidates.map(({ id, ...c }) => {
    const set = sets.get(id);
    const delta = set && baseline !== undefined ? set.mean - baseline : undefined;
    return {
      ...c, ...reward,
      ...(set ? { dps: round(set.mean), error95: round(set.meanError) } : {}),
      ...(delta !== undefined ? { delta: round(delta), deltaPct: round(baseline ? (100 * delta) / baseline : undefined, 2) } : {}),
      status: set ? 'measured' as const : 'missing' as const,
    };
  }).sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
  return {
    baseline: { dps: round(baseline), error95: round(player?.dpsConfidence?.margin) },
    droptimizer: { instanceIds: selector.instanceIds, ...(selector.encounterIds ? { encounterIds: selector.encounterIds } : {}), ...reward,
      bonusRoll: selector.bonusRoll === true, maxUpgrade: selector.maxUpgrade === true },
    candidates,
  };
}
