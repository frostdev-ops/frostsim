// Stored record shapes and portable file/link format (P11.4-P11.6); everything pure for testing without IndexedDB.

import type { ImportedCharacter } from '../import/character'

export interface EngineIdentity {
  simcVersion?: string
  upstreamCommit?: string
  wowVersion?: string
  artifact?: string
}

export interface StoredCharacter {
  id: string
  label: string
  character: ImportedCharacter
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export type ToolId = 'quick' | 'compare' | 'gear' | 'droptimizer' | 'crests' | 'advanced'

export const TOOL_LABELS: Record<ToolId, string> = {
  quick: 'Quick Sim',
  compare: 'Compare',
  gear: 'Top Gear',
  droptimizer: 'Droptimizer',
  crests: 'Crest Sim',
  advanced: 'Advanced',
}

/** What a history row renders. Never holds the raw engine report. */
export interface ReportSummary {
  dps?: number
  /** Half-width of confidence interval in DPS when report supplies estimator; undefined honest, zero not. */
  confidenceMargin?: number
  confidenceLevel?: number
  standardError?: number
  actualIterations?: number
  targetReached?: boolean
  elapsedSeconds?: number
  /** Batch throughput and baseline precision for future search estimates. */
  searchTiming?: { iterationsPerSecond: number; iterations: number; errorPct: number | null }
  playerName?: string
  specialization?: string
  candidateCount?: number
  /** Best few candidates for a preview row; the full table comes from the blob. */
  topCandidates?: { id: string; label: string; mean: number; delta: number }[]
  warnings?: string[]
}

export type ReportCompletion = 'complete' | 'partial' | 'cancelled' | 'failed'

export interface StoredReport {
  id: string
  tool: ToolId
  title: string
  characterId?: string
  characterLabel: string
  /** Exact input the run used; editing character afterwards cannot change what finished report says (P01.3, P06.12). */
  requestSnapshot: unknown
  engine: EngineIdentity
  completion: ReportCompletion
  summary: ReportSummary
  hasRaw: boolean
  createdAt: number
  pinned: boolean
  note?: string
}

export interface StoredSetup {
  id: string
  tool: ToolId
  label: string
  characterId?: string
  settings: unknown
  createdAt: number
  updatedAt: number
}

export interface RawBlob {
  id: string
  /** The engine's JSON report text, kept for export and detail views. */
  text: string
  bytes: number
}

export const PORTABLE_FORMAT = 'frostsim'
export const PORTABLE_VERSION = 1

export type PortableKind = 'character' | 'setup' | 'report'

export interface PortableFile {
  format: typeof PORTABLE_FORMAT
  version: number
  kind: PortableKind
  exportedAt: number
  engine?: EngineIdentity
  /** True when character identity stripped before export (P11.4). */
  redacted?: boolean
  payload: unknown
}

/** Portable file above this size rejected before parsing (P11.4). */
export const MAX_PORTABLE_BYTES = 8 * 1024 * 1024
/** Share link above this compressed size falls back to file (P11.5). */
export const MAX_SHARE_BYTES = 6 * 1024

export function newId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function makePortable(
  kind: PortableKind,
  payload: unknown,
  engine?: EngineIdentity,
  redacted = false,
): PortableFile {
  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    kind,
    exportedAt: Date.now(),
    engine,
    redacted: redacted || undefined,
    payload,
  }
}

export type PortableCheck =
  | { ok: true; file: PortableFile }
  | { ok: false; reason: string }

/** Validates untrusted portable file; rejects before touching payload so oversized/foreign file cannot cost anything (P11.4). */
export function readPortable(text: string): PortableCheck {
  if (text.length > MAX_PORTABLE_BYTES) {
    const mb = Math.round(MAX_PORTABLE_BYTES / 1024 / 1024)
    return { ok: false, reason: `File is larger than the ${mb} MB import limit.` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'File is not valid JSON. Frostsim exports are .json files.' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'File does not contain a Frostsim export.' }
  }
  const f = parsed as Partial<PortableFile>
  if (f.format !== PORTABLE_FORMAT) {
    return { ok: false, reason: 'File was not exported by Frostsim.' }
  }
  if (typeof f.version !== 'number' || f.version > PORTABLE_VERSION) {
    return {
      ok: false,
      reason: `File uses export format v${f.version} and this build reads up to v${PORTABLE_VERSION}. Update Frostsim, then import it again.`,
    }
  }
  if (f.kind !== 'character' && f.kind !== 'setup' && f.kind !== 'report') {
    return { ok: false, reason: 'File does not say what it contains.' }
  }
  if (f.payload === undefined || f.payload === null) {
    return { ok: false, reason: 'File has no contents.' }
  }
  return { ok: true, file: f as PortableFile }
}

/** Removes three fields identifying real person's character (P11.4). */
export function redactCharacter(c: ImportedCharacter): ImportedCharacter {
  const swap = (text: string) => {
    let out = text
    if (c.name) out = out.split(c.name).join('Shared')
    if (c.server) out = out.split(c.server).join('realm')
    return out
  }
  return {
    ...c,
    name: 'Shared',
    server: c.server ? 'realm' : undefined,
    region: c.region ? 'xx' : undefined,
    raw: swap(c.raw),
    profileLines: c.profileLines.map(swap),
  }
}

/** Whether imported report can be reopened with current engine; matching input on different engine is NEW result not rewritten (P11.6), gates display not recomputation. */
export function engineCompatibility(
  stored: EngineIdentity | undefined,
  current: EngineIdentity | undefined,
): { compatible: boolean; reason?: string } {
  if (!stored?.upstreamCommit || !current?.upstreamCommit) {
    return {
      compatible: false,
      reason: 'The engine build that produced this report is not recorded.',
    }
  }
  if (stored.upstreamCommit !== current.upstreamCommit) {
    const was = stored.simcVersion ?? stored.upstreamCommit.slice(0, 7)
    const now = current.simcVersion ?? current.upstreamCommit.slice(0, 7)
    return {
      compatible: false,
      reason: `Produced by engine ${was}; this build is ${now}. Rerun to compare against current numbers.`,
    }
  }
  if (stored.wowVersion && current.wowVersion && stored.wowVersion !== current.wowVersion) {
    return {
      compatible: false,
      reason: `Produced against game data ${stored.wowVersion}; this build carries ${current.wowVersion}.`,
    }
  }
  return { compatible: true }
}
