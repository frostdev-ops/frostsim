// Engine manifest + browser capability check before downloading 60 MB wasm (P02.1, P02.8). Manifest from artifact, not build config; read maxThreads from it.

import { FALLBACK_MAX_THREADS, type Accuracy } from './options'
import { selectedEngine } from './versions'

export type EngineVariant = 'threaded' | 'fallback'

/** Two artifacts, two dirs. Threaded needs SharedArrayBuffer and cross-origin isolation; fallback has no profilesets. */
export const ENGINE_DIRS: Record<EngineVariant, string> = {
  threaded: '/engine/',
  fallback: '/engine/fallback/',
}

export const MANIFEST_URL = `${ENGINE_DIRS.threaded}manifest.json`

export interface EngineManifest {
  schemaVersion: number
  artifact: 'threaded' | 'fallback'
  engine: {
    simcVersion: string
    upstreamCommit: string
    upstreamRemote?: string
    upstreamBranch?: string
  }
  wow: {
    clientDataVersion: string
    hotfixHash?: string
    hotfixBuild?: number
    ptr?: boolean
  }
  capabilities: {
    threads: boolean
    pthreadPoolSize: number
    maxThreads: number
    profilesets: boolean
    networking: boolean
    reportVersions: number[]
    requiresSharedArrayBuffer?: boolean
  }
  files?: Record<string, { bytes: number; sha256: string }>
  lockMismatches?: string[]
  buildTreeMismatches?: string[]
}

export type CapabilityFailure =
  | 'no-secure-context'
  | 'no-wasm'
  | 'no-wasm-exceptions'
  | 'no-isolation'
  | 'no-shared-array-buffer'
  | 'manifest-unavailable'
  | 'manifest-invalid'
  | 'artifact-mismatch'
  | 'unsupported-report-version'

export type EngineCapability =
  | {
      ok: true
      artifact: EngineVariant
      /** Directory the engine's simc.js/simc.wasm live in. */
      engineDir: string
      /** Never 0. The fallback reports 0 meaning "threads are meaningless here". */
      maxThreads: number
      /** False on the fallback: upstream drops profilesets under SC_NO_THREADING. */
      profilesets: boolean
      manifest: EngineManifest
    }
  | { ok: false; reason: CapabilityFailure; detail: string; manifest?: EngineManifest }

/** The report format report.ts knows how to read. */
const REQUIRED_REPORT_VERSION = 2

function isManifest(v: unknown): v is EngineManifest {
  const m = v as EngineManifest | null
  return (
    !!m &&
    typeof m === 'object' &&
    (m.artifact === 'threaded' || m.artifact === 'fallback') &&
    !!m.capabilities &&
    typeof m.capabilities.maxThreads === 'number' &&
    Number.isInteger(m.capabilities.maxThreads) &&
    Array.isArray(m.capabilities.reportVersions) &&
    !!m.engine &&
    typeof m.engine.simcVersion === 'string'
  )
}

export async function fetchManifest(
  url = MANIFEST_URL,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<EngineManifest> {
  const res = await fetchImpl(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`engine manifest ${url} returned ${res.status}`)
  const body: unknown = await res.json()
  if (!isManifest(body)) throw new Error(`engine manifest ${url} is not a manifest this build understands`)
  return body
}

/** True when the page can actually share memory between engine threads. */
export function canShareMemory(): boolean {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined'
}

/** 28-byte module with try/catch_all to verify WebAssembly exception handling support. Both artifacts need this; legacy opcodes match actual binary. */
const WASM_EXCEPTION_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, // magic + version
  1, 4, 1, 96, 0, 0, //           type:  () -> ()
  3, 2, 1, 0, //                  func:  one function of that type
  10, 8, 1, 6, 0, 6, 64, 25, 11, 11, // code: try (void) catch_all end end
])

export function hasWasmExceptions(): boolean {
  try {
    return WebAssembly.validate(WASM_EXCEPTION_PROBE)
  } catch {
    return false
  }
}

async function evaluate(
  variant: EngineVariant,
  fetchImpl: typeof fetch | undefined,
  manifestUrl?: string,
  baseUrl = '/engine/',
): Promise<EngineCapability> {
  let manifest: EngineManifest
  try {
    manifest = await fetchManifest(manifestUrl ?? `${baseUrl}${variant === 'fallback' ? 'fallback/' : ''}manifest.json`, fetchImpl)
  } catch (err) {
    return { ok: false, reason: 'manifest-unavailable', detail: err instanceof Error ? err.message : String(err) }
  }

  const mismatches = [...(manifest.lockMismatches ?? []), ...(manifest.buildTreeMismatches ?? [])]
  if (mismatches.length) {
    // Binary doesn't match lock; refuse rather than produce unreproducible number.
    return {
      ok: false,
      reason: 'artifact-mismatch',
      detail: `The engine build does not match its lock: ${mismatches.join('; ')}`,
      manifest,
    }
  }

  if (!manifest.capabilities.reportVersions?.includes(REQUIRED_REPORT_VERSION)) {
    return {
      ok: false,
      reason: 'unsupported-report-version',
      detail: `This engine emits report versions ${manifest.capabilities.reportVersions?.join(', ') || 'none'}; the app reads ${REQUIRED_REPORT_VERSION}.`,
      manifest,
    }
  }

  // Branch on requiresSharedArrayBuffer, not `threads` (per-artifact statement of page requirements).
  if ((manifest.capabilities.requiresSharedArrayBuffer ?? manifest.capabilities.threads) && !canShareMemory()) {
    return globalThis.crossOriginIsolated
      ? {
          ok: false,
          reason: 'no-shared-array-buffer',
          detail: 'This browser has no SharedArrayBuffer, which the threaded engine needs.',
          manifest,
        }
      : {
          ok: false,
          reason: 'no-isolation',
          detail:
            'This page is not cross-origin isolated. The server must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
          manifest,
        }
  }

  return {
    ok: true,
    artifact: manifest.artifact,
    engineDir: `${baseUrl}${manifest.artifact === 'fallback' ? 'fallback/' : ''}`,
    // Fallback reports maxThreads 0 (option meaningless); enforce minimum 1.
    maxThreads: Math.max(1, manifest.capabilities.maxThreads || (manifest.capabilities.threads ? FALLBACK_MAX_THREADS : 1)),
    profilesets: manifest.capabilities.profilesets === true,
    manifest,
  }
}

/** All preconditions before starting a run and which artifact to use (P02.8). Returns reason instead of throwing. */
export async function detectEngineCapability(
  options: {
    /** Force one artifact instead of choosing. */
    variant?: EngineVariant
    manifestUrl?: string
    fetchImpl?: typeof fetch
    baseUrl?: string
  } = {},
): Promise<EngineCapability> {
  if (typeof WebAssembly === 'undefined') {
    return { ok: false, reason: 'no-wasm', detail: 'This browser has no WebAssembly support.' }
  }
  if (!hasWasmExceptions()) {
    return {
      ok: false,
      reason: 'no-wasm-exceptions',
      detail:
        'This browser does not support WebAssembly exception handling, which the simulation engine needs. Both engine builds require it.',
    }
  }
  if (globalThis.isSecureContext === false) {
    return {
      ok: false,
      reason: 'no-secure-context',
      detail: 'The engine needs a secure context (https, or localhost).',
    }
  }

  if (options.variant) return evaluate(options.variant, options.fetchImpl, options.manifestUrl, options.baseUrl)
  if (options.manifestUrl) return evaluate('threaded', options.fetchImpl, options.manifestUrl, options.baseUrl)

  let baseUrl = options.baseUrl ?? '/engine/'
  if (!options.baseUrl && !options.fetchImpl) {
    try { baseUrl = (await selectedEngine()).baseUrl }
    catch (err) { return { ok: false, reason: 'manifest-unavailable', detail: String(err) } }
  }
  const threaded = await evaluate('threaded', options.fetchImpl, undefined, baseUrl)
  if (threaded.ok) return threaded

  const fallback = await evaluate('fallback', options.fetchImpl, undefined, baseUrl)
  if (fallback.ok) return fallback

  // Report why preferred artifact can't run, not why fallback is also missing.
  return threaded
}

/** Cache identity: engine, game data, canonical input. Labels are not identity. */
export function engineIdentity(manifest: EngineManifest): string {
  return [
    manifest.artifact,
    manifest.engine.simcVersion,
    manifest.engine.upstreamCommit,
    manifest.wow.clientDataVersion,
    manifest.wow.hotfixHash ?? 'no-hotfix',
  ].join('|')
}

/** Precision half of cache key; different precision is not interchangeable. */
export function precisionKey(accuracy: Accuracy): string {
  switch (accuracy.mode) {
    case 'iterations':
      return `i${accuracy.iterations}`
    case 'targetError':
      return `e${accuracy.targetError}/${accuracy.maxIterations}`
    case 'script':
      // Script decides and is part of canonical input; nothing extra to key.
      return 'script'
  }
}

export interface CacheKeyParts {
  /** From `engineIdentity(manifest)`, or `outcome.engineIdentity`. */
  engineIdentity: string
  /** Version of the static catalogs the candidate was generated from. */
  catalogId?: string
  /** From `precisionKey(accuracy)`. */
  precision: string
  /** The caller's canonical form of the simulation-affecting input. */
  canonical: string
}

/** One hash, shared, so callers don't drift. Rejects on missing SubtleCrypto (collision worse than no cache). NUL-separated to prevent re-splitting. */
export async function cacheKey(parts: CacheKeyParts): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('SubtleCrypto is unavailable, so no cache key can be computed; do not cache')
  }
  const input = [parts.engineIdentity, parts.catalogId ?? 'no-catalog', parts.precision, parts.canonical].join('\0')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
