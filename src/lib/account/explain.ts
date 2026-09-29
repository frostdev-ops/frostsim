// Explain a result (CLAUDE.md D17): one gzip request to /api/v1/ai/explain, sent only when the player presses Explain. The server takes
// the character's name out before anything reaches the model; this side sends every name the page knows so it can.

import { pipe } from '../store/share'
import type { ComparisonRow } from '../ui/ComparisonBars.svelte'
import { api } from './api'

export type ExplainKind = 'report' | 'vault' | 'droptimizer' | 'topgear' | 'weights' | 'error'

export interface Explained {
  text: string
  model: string
  costUsd: number
  /** Explanations left today, or null when the server does not meter this call. */
  remaining: number | null
}

/** Under the server's 1 MiB body cap with room for headers. */
const MAX_GZ = 900 * 1024
/** Under the server's 32 KiB context cap. */
const MAX_CONTEXT = 30_000
const MAX_ROWS = 40

// simc's actor lines: `mage="Name"`.
const CLASSES = ['warrior', 'paladin', 'hunter', 'rogue', 'priest', 'deathknight', 'death_knight', 'shaman', 'mage', 'warlock', 'monk', 'druid', 'demonhunter', 'demon_hunter', 'evoker']
const ACTOR = new RegExp(`^\\s*(?:${CLASSES.join('|')})\\s*=\\s*"?([^"\\n]+?)"?\\s*$`, 'gim')

/** The names of every character in a simc profile, up to 8. */
export function characterNames(profile: string): string[] {
  return [...new Set([...profile.matchAll(ACTOR)].map((m) => m[1].trim()).filter(Boolean))].slice(0, 8)
}

/** The rows a model needs to compare results: no item objects or icons. */
export function trimRows(rows: readonly ComparisonRow[]) {
  return rows.slice(0, MAX_ROWS).map((r) => ({
    label: r.label,
    ...(r.changes?.length ? { changes: r.changes.slice(0, 6).map(({ slot, name, replaces }) => ({ slot, name, replaces })) } : {}),
    mean: r.mean === undefined ? undefined : Math.round(r.mean),
    margin: r.margin === undefined ? undefined : Math.round(r.margin),
    iterations: r.iterations,
    indistinguishableFromBaseline: r.indistinguishable,
    status: r.status,
    note: r.detail,
  }))
}

/** Keeps the context under the server's cap. Only a log can outgrow it, and the failure is at its end, so the oldest lines go first. */
export function fitContext(context: unknown, max = MAX_CONTEXT): unknown {
  const c = (context ?? {}) as Record<string, unknown>
  if (JSON.stringify(c).length <= max || !Array.isArray(c.log)) return c
  const log = [...c.log]
  while (log.length > 1 && JSON.stringify({ ...c, log }).length > max) log.splice(0, Math.ceil(log.length / 4))
  return { ...c, log }
}

const pack = (envelope: unknown): Promise<Uint8Array | null> =>
  pipe(new TextEncoder().encode(JSON.stringify(envelope)), new CompressionStream('gzip'), MAX_GZ).catch(() => null)

export interface ExplainInput {
  kind: ExplainKind
  context?: unknown
  /** simc's JSON report, when the result has one. Dropped if it would not fit. */
  report?: string | null
  character?: { name: string; server?: string; region?: string } | null
  /** The simc profile that ran, for the names in an error log. */
  profile?: string
  /** The game build the engine simulated, for game-data lookups when there is no report. */
  build?: string
}

export async function explain(input: ExplainInput): Promise<Explained> {
  const c = input.character
  const envelope = {
    kind: input.kind,
    context: fitContext(input.context),
    report: input.report ?? undefined,
    ...(c?.name ? { character: { name: c.name, realm: c.server, region: c.region } } : {}),
    names: [...new Set([...(c?.name ? [c.name] : []), ...(input.profile ? characterNames(input.profile) : [])])],
    ...(input.build ? { build: input.build } : {}),
  }
  let gz = await pack(envelope)
  if (!gz && envelope.report) gz = await pack({ ...envelope, report: undefined })
  if (!gz) throw new Error('This result is too large to send.')
  return api<Explained>('/ai/explain', 'POST', gz)
}
