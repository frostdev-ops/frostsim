// Engine pack for jobs with no browser (Discord, Loothing) (CLAUDE.md D14; DESIGN.md P2): the newest pack for this release's compat
// that has a native build. Web jobs send their own browser pack instead, so native and wasm are the same revision.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { AppCtx } from '../app';
import { PACK_ID, nativeEngine } from './native';

const DEFAULT_INDEX = '/opt/frostsim/engine-updates/engine-versions.json';

interface PackEntry { id?: unknown; compat?: unknown; commitDate?: unknown; publishedAt?: unknown; clientDataVersion?: unknown }

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
    .filter((p) => p?.compat === compat && typeof p.id === 'string' && PACK_ID.test(p.id))
    .sort(newestFirst);
  for (const pack of packs) if (await nativeEngine(app, pack.id as string)) return { id: pack.id as string, build: text(pack.clientDataVersion) || null };
  return null;
}
