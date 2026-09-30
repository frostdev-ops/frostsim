// Engine pack for jobs with no browser (Discord, Loothing) (CLAUDE.md D14; DESIGN.md P2): the newest pack for this release's compat
// that has a native build. Web jobs send their own browser pack instead, so native and wasm are the same revision.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isEngineChannel, resolveEngineChannel, type EngineChannel } from '../../../src/lib/simc/channel';
import { rulesMatch, type SeasonRules } from '../../../src/lib/catalog/rules';
import type { CatalogManifest } from '../../../src/lib/catalog/types';
import type { AppCtx } from '../app';
import { PACK_ID, nativeEngine } from './native';

const DEFAULT_INDEX = '/opt/frostsim/engine-updates/engine-channels.json';

interface PackEntry { id?: unknown; compat?: unknown; commitDate?: unknown; publishedAt?: unknown; clientDataVersion?: unknown; engineChannel?: unknown; upstreamCommit?: unknown }

const text = (v: unknown) => (typeof v === 'string' ? v : '');
// Same order as scripts/update-engines.mjs and the browser's pickEngine.
const newestFirst = (a: PackEntry, b: PackEntry) =>
  text(b.commitDate).localeCompare(text(a.commitDate)) || text(b.publishedAt).localeCompare(text(a.publishedAt));

/** The deploy build writes this release's compat into server/.compat beside the bundle; ENGINE_COMPAT overrides it. */
function releaseCompat(env: Record<string, string | undefined>): string | null {
  if (env.ENGINE_COMPAT?.trim()) return env.ENGINE_COMPAT.trim();
  try {
    return readFileSync(new URL('./.compat', import.meta.url), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** ENGINE_INDEX_PATH and ENGINE_COMPAT are read from `env` (the process environment by default). config.ts lists them only so the
 *  startup report names them. Null when the index is unreadable or no pack of this compat has a native build. */
export async function defaultPack(app: Pick<AppCtx, 'config' | 'r2' | 'redis' | 'log'>, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  return (await defaultPackInfo(app, env))?.id ?? null;
}

/** defaultPack with the game build its data comes from (the index's clientDataVersion), for patch re-sims. */
export async function defaultPackInfo(
  app: Pick<AppCtx, 'config' | 'r2' | 'redis' | 'log'>, env: Record<string, string | undefined> = process.env,
): Promise<{ id: string; build: string | null } | null> {
  const compat = releaseCompat(env);
  if (!compat) return null;
  let index: { packs?: unknown };
  try {
    index = JSON.parse(await readFile(env.ENGINE_INDEX_PATH || DEFAULT_INDEX, 'utf8'));
  } catch {
    return null;
  }
  const packs = (Array.isArray(index?.packs) ? (index.packs as PackEntry[]) : [])
    .filter((p) => p?.compat === compat && typeof p.id === 'string' && PACK_ID.test(p.id) && (p.engineChannel === undefined || p.engineChannel === 'live'))
    .sort(newestFirst);
  for (const pack of packs) if (await nativeEngine(app, pack.id as string)) return { id: pack.id as string, build: text(pack.clientDataVersion) || null };
  return null;
}

export interface PackIdentity { engineChannel: EngineChannel; upstreamCommit: string; clientDataVersion: string }
interface PackManifest { engineChannel?: EngineChannel; engine: { upstreamCommit: string }; wow: { clientDataVersion: string; ptr?: boolean }; lockMismatches?: string[]; buildTreeMismatches?: string[] }

/** Only the server's published index and immutable manifest identify a requested pack. Never trust a caller's build/channel. */
export async function trustedPack(packId: string, env: Record<string, string | undefined> = process.env): Promise<{ manifest: PackManifest; identity: PackIdentity; rules: SeasonRules | null } | null> {
  if (!PACK_ID.test(packId)) return null;
  const compat = releaseCompat(env);
  if (!compat) return null;
  try {
    const indexPath = env.ENGINE_INDEX_PATH || DEFAULT_INDEX;
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    const entry = index.packs?.find((p: PackEntry) => p?.id === packId);
    if (!entry || typeof entry.compat !== 'string' || !entry.compat.trim() ||
        (entry.engineChannel !== undefined && !isEngineChannel(entry.engineChannel))) return null;
    if (index.schemaVersion === 3 && !isEngineChannel(entry.engineChannel)) return null;
    if (index.schemaVersion !== 3 && entry.engineChannel === 'ptr') return null;
    const manifest: PackManifest = JSON.parse(await readFile(join(dirname(indexPath), 'engine/versions', packId, 'manifest.json'), 'utf8'));
    const engineChannel = resolveEngineChannel(manifest.engineChannel);
    // Cached Live clients and queued legacy jobs retain their exact published pack.
    // PTR belongs to the current app contract; defaults still filter current compat.
    if (engineChannel === 'ptr' && entry.compat !== compat) return null;
    if ((manifest.engineChannel !== undefined && !isEngineChannel(manifest.engineChannel)) ||
        engineChannel !== resolveEngineChannel(entry.engineChannel) || (engineChannel === 'ptr' && manifest.wow?.ptr !== true) ||
        !/^[a-f0-9]{40}$/i.test(manifest.engine?.upstreamCommit) || !/^\d+\.\d+\.\d+\.\d+$/.test(manifest.wow?.clientDataVersion) ||
        (entry.upstreamCommit !== undefined && entry.upstreamCommit !== manifest.engine.upstreamCommit) ||
        (entry.clientDataVersion !== undefined && entry.clientDataVersion !== manifest.wow.clientDataVersion) ||
        manifest.lockMismatches?.length || manifest.buildTreeMismatches?.length) return null;
    let rules: SeasonRules | null = null;
    try {
      const candidate = JSON.parse(await readFile(join(dirname(indexPath), 'engine/versions', packId, 'catalog/rules.json'), 'utf8'));
      if (rulesMatch(candidate, { engineChannel, engine: { upstreamCommit: manifest.engine.upstreamCommit, clientDataVersion: manifest.wow.clientDataVersion } } as CatalogManifest)) rules = candidate;
    } catch { /* missing verified rules means no guided seasonal defaults */ }
    return { manifest, identity: { engineChannel, upstreamCommit: manifest.engine.upstreamCommit, clientDataVersion: manifest.wow.clientDataVersion }, rules };
  } catch { return null; }
}
