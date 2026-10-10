// Catalog loading: discriminated result instead of throw for UI "stale catalog" state (P03.7).

import { Catalog, type CatalogPayloads } from './catalog';
import type { CatalogManifest, TalentTree } from './types';
import { rulesMatch, type SeasonRules } from './rules';
import type { EngineChannel } from '../simc/channel';
import { manifestProblems, payloadProblems, talentTreeProblems } from './validation';

export const SUPPORTED_CATALOG_SCHEMA = 1;

/** Validate fields read before and during catalog use; malformed metadata must settle loading. */
export function validCatalogManifest(manifest: CatalogManifest): boolean {
  return manifestProblems(manifest).length === 0;
}

export interface EngineIdentity {
  engineChannel?: EngineChannel;
  upstreamCommit?: string | null;
  clientDataVersion?: string;
  hotfixHash?: string;
  ptr?: boolean;
}

export type CatalogLoadResult =
  | { ok: true; catalog: Catalog; warnings: CompatWarning[] }
  | { ok: false; reason: 'unavailable' | 'malformed' | 'unsupported_schema'; message: string };

export interface CompatWarning {
  code: 'wow_version_mismatch' | 'hotfix_mismatch' | 'engine_commit_mismatch' | 'ptr_mismatch' | 'engine_identity_unknown';
  message: string;
}

/** Catalog and engine must agree on client data; WoW version + hotfix hash = identity. */
export function checkCompatibility(manifest: CatalogManifest, engine: EngineIdentity | null): CompatWarning[] {
  if (!engine) {
    return [{ code: 'engine_identity_unknown', message: 'engine manifest not loaded; catalog/engine match unverified' }];
  }
  const out: CompatWarning[] = [];
  const c = manifest.engine;
  const channel = manifest.engineChannel ?? c.engineChannel ?? 'live';
  if (engine.engineChannel && engine.engineChannel !== channel) {
    out.push({ code: 'ptr_mismatch', message: 'catalog and engine channels do not match' });
  }
  if (engine.clientDataVersion && engine.clientDataVersion !== c.clientDataVersion) {
    out.push({
      code: 'wow_version_mismatch',
      message: `catalog is for WoW ${c.clientDataVersion}, engine is ${engine.clientDataVersion}`,
    });
  }
  if (engine.hotfixHash && engine.hotfixHash !== c.hotfixHash) {
    out.push({
      code: 'hotfix_mismatch',
      message: `catalog hotfix ${c.hotfixHash.slice(0, 12)} does not match engine hotfix ${engine.hotfixHash.slice(0, 12)}`,
    });
  }
  if (engine.upstreamCommit && engine.upstreamCommit !== c.upstreamCommit) {
    out.push({
      code: 'engine_commit_mismatch',
      message: `catalog built from ${c.upstreamCommit?.slice(0, 7) ?? 'unknown'}, engine from ${engine.upstreamCommit.slice(0, 7)}`,
    });
  }
  if (!engine.engineChannel && engine.ptr !== undefined && engine.ptr !== c.ptr) {
    out.push({ code: 'ptr_mismatch', message: 'catalog and engine disagree on PTR data' });
  }
  return out;
}

async function fetchJson(base: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${base}/${path}`, { signal });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export interface LoadOptions {
  /** Directory holding manifest.json, e.g. `/catalogs/<catalogId>`. */
  baseUrl: string;
  engine?: EngineIdentity | null;
  signal?: AbortSignal;
}

export async function loadCatalog(opts: LoadOptions): Promise<CatalogLoadResult> {
  const { baseUrl, signal } = opts;
  let manifest: CatalogManifest;
  try {
    manifest = (await fetchJson(baseUrl, 'manifest.json', signal)) as CatalogManifest;
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: `catalog manifest unavailable: ${String(err)}` };
  }
  if (manifest?.schemaVersion !== SUPPORTED_CATALOG_SCHEMA) {
    return {
      ok: false,
      reason: 'unsupported_schema',
      message: `catalog schema ${manifest?.schemaVersion} is not supported (expected ${SUPPORTED_CATALOG_SCHEMA})`,
    };
  }
  if (!validCatalogManifest(manifest)) return { ok: false, reason: 'malformed', message: 'Catalog manifest is missing valid engine identity or metadata.' };
  const warnings = checkCompatibility(manifest, opts.engine ?? null);
  if (warnings.some(w => w.code !== 'engine_identity_unknown')) return { ok: false, reason: 'malformed', message: warnings.map(w => w.message).join('; ') };

  try {
    const [items, bonus, scaling, enchants, gems, sets, embellishments, consumables] = await Promise.all([
      fetchJson(baseUrl, 'items.json', signal),
      fetchJson(baseUrl, 'item-bonus.json', signal),
      fetchJson(baseUrl, 'scaling.json', signal),
      fetchJson(baseUrl, 'enchants.json', signal),
      fetchJson(baseUrl, 'gems.json', signal),
      fetchJson(baseUrl, 'sets.json', signal),
      fetchJson(baseUrl, 'embellishments.json', signal),
      fetchJson(baseUrl, 'consumables.json', signal),
    ]);
    const payloads = { manifest, items, bonus, scaling, enchants, gems, sets, embellishments, consumables } as CatalogPayloads;
    const rules = await fetchJson(baseUrl, 'rules.json', signal).catch(() => null) as SeasonRules | null;
    payloads.rules = rules && rulesMatch(rules, manifest) ? rules : null;
    const problems = payloadProblems(payloads);
    if (problems.length) return { ok: false, reason: 'malformed', message: problems.join('; ') };
    return { ok: true, catalog: new Catalog(payloads), warnings: checkCompatibility(manifest, opts.engine ?? null) };
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: `catalog payload unavailable: ${String(err)}` };
  }
}

/** Talent trees are per class and loaded only for the character in front of the user. */
export async function loadTalentTree(baseUrl: string, classId: number, signal?: AbortSignal): Promise<TalentTree | null> {
  try {
    const tree = (await fetchJson(baseUrl, `talents/class-${classId}.json`, signal)) as TalentTree;
    return talentTreeProblems(tree, classId).length ? null : tree;
  } catch {
    return null;
  }
}
