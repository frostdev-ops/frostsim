import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cacheKey,
  detectEngineCapability,
  engineIdentity,
  ENGINE_DIRS,
  hasWasmExceptions,
  precisionKey,
  type EngineManifest,
} from './capability'
import { engineWorkerUrl } from './job'
import { parseEngineVersions } from './versions'

// Real manifest values from scripts/engine-manifest.mjs.
const threadedManifest: EngineManifest = {
  schemaVersion: 1,
  artifact: 'threaded',
  engine: {
    simcVersion: '1210-01',
    upstreamCommit: 'c01572044af513f9d85b79080b8d14619f1c00c5',
    upstreamBranch: 'midnight',
  },
  wow: { clientDataVersion: '12.1.0.69814', hotfixHash: 'dca34b3038a3', ptr: false },
  capabilities: {
    threads: true,
    pthreadPoolSize: 16,
    maxThreads: 16,
    profilesets: true,
    networking: false,
    reportVersions: [2],
    requiresSharedArrayBuffer: true,
  },
  lockMismatches: [],
  buildTreeMismatches: [],
}

const fallbackManifest: EngineManifest = {
  ...threadedManifest,
  artifact: 'fallback',
  capabilities: {
    threads: false,
    pthreadPoolSize: 0,
    maxThreads: 0,
    profilesets: false,
    networking: false,
    reportVersions: [2],
    requiresSharedArrayBuffer: false,
  },
}

/** Answers each manifest URL from a map; anything else 404s. */
function fetcher(bodies: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const key = String(url)
    if (!(key in bodies)) return { ok: false, status: 404, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => bodies[key] } as Response
  }) as unknown as typeof fetch
}

const THREADED_URL = `${ENGINE_DIRS.threaded}manifest.json`
const FALLBACK_URL = `${ENGINE_DIRS.fallback}manifest.json`

function isolate(on: boolean) {
  vi.stubGlobal('crossOriginIsolated', on)
  if (on) {
    vi.stubGlobal('SharedArrayBuffer', globalThis.SharedArrayBuffer ?? ArrayBuffer)
  } else {
    vi.stubGlobal('SharedArrayBuffer', undefined)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('detectEngineCapability', () => {
  it('picks the threaded artifact when the page can share memory', async () => {
    isolate(true)
    const cap = await detectEngineCapability({
      fetchImpl: fetcher({ [THREADED_URL]: threadedManifest, [FALLBACK_URL]: fallbackManifest }),
    })
    expect(cap.ok).toBe(true)
    if (!cap.ok) return
    expect(cap.artifact).toBe('threaded')
    expect(cap.maxThreads).toBe(16)
    expect(cap.profilesets).toBe(true)
    expect(cap.engineDir).toBe('/engine/')
  })

  it('falls back to the single-threaded artifact when it cannot', async () => {
    isolate(false)
    const cap = await detectEngineCapability({
      fetchImpl: fetcher({ [THREADED_URL]: threadedManifest, [FALLBACK_URL]: fallbackManifest }),
    })
    expect(cap.ok).toBe(true)
    if (!cap.ok) return
    expect(cap.artifact).toBe('fallback')
    expect(cap.profilesets).toBe(false)
    expect(cap.engineDir).toBe('/engine/fallback/')
    // maxThreads 0 means "meaningless here", not "unlimited".
    expect(cap.maxThreads).toBe(1)
  })

  it('explains the threaded artifact when neither can run', async () => {
    isolate(false)
    const cap = await detectEngineCapability({ fetchImpl: fetcher({ [THREADED_URL]: threadedManifest }) })
    expect(cap.ok).toBe(false)
    if (cap.ok) return
    // Reason is why wanted artifact cannot run, not that fallback also missing.
    expect(cap.reason).toBe('no-isolation')
    expect(cap.detail).toMatch(/Cross-Origin-Embedder-Policy/)
  })

  it('distinguishes a missing SharedArrayBuffer from a missing isolation header', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const cap = await detectEngineCapability({ fetchImpl: fetcher({ [THREADED_URL]: threadedManifest }) })
    expect(cap.ok).toBe(false)
    if (!cap.ok) expect(cap.reason).toBe('no-shared-array-buffer')
  })

  it('refuses an artifact that does not match its lock', async () => {
    isolate(true)
    const cap = await detectEngineCapability({
      fetchImpl: fetcher({
        [THREADED_URL]: {
          ...threadedManifest,
          buildTreeMismatches: ['pthread pool: build tree configured 8, artifact has 16'],
        },
      }),
    })
    expect(cap.ok).toBe(false)
    if (!cap.ok) {
      expect(cap.reason).toBe('artifact-mismatch')
      expect(cap.detail).toMatch(/pthread pool/)
    }
  })

  it('refuses an engine that writes a report format this build cannot read', async () => {
    isolate(true)
    const cap = await detectEngineCapability({
      fetchImpl: fetcher({
        [THREADED_URL]: {
          ...threadedManifest,
          capabilities: { ...threadedManifest.capabilities, reportVersions: [3] },
        },
      }),
    })
    expect(cap.ok).toBe(false)
    if (!cap.ok) expect(cap.reason).toBe('unsupported-report-version')
  })

  it('reports a missing manifest rather than assuming a default engine', async () => {
    isolate(true)
    const cap = await detectEngineCapability({ fetchImpl: fetcher({}) })
    expect(cap.ok).toBe(false)
    if (!cap.ok) expect(cap.reason).toBe('manifest-unavailable')
  })

  it('rejects a manifest that is not one', async () => {
    isolate(true)
    const cap = await detectEngineCapability({ fetchImpl: fetcher({ [THREADED_URL]: { hello: 'world' } }) })
    expect(cap.ok).toBe(false)
    if (!cap.ok) expect(cap.detail).toMatch(/not a manifest/)
  })

  it('honours a forced variant without probing the other', async () => {
    isolate(true)
    const fetchImpl = fetcher({ [THREADED_URL]: threadedManifest, [FALLBACK_URL]: fallbackManifest })
    const cap = await detectEngineCapability({ variant: 'fallback', fetchImpl })
    expect(cap.ok && cap.artifact).toBe('fallback')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('engineWorkerUrl', () => {
  it('selects the artifact through the worker URL, which is what boots it', () => {
    expect(engineWorkerUrl('threaded')).toBe('/engine/sim-worker.js?worker=3')
    expect(engineWorkerUrl('fallback')).toBe('/engine/sim-worker.js?variant=fallback&worker=3')
    expect(engineWorkerUrl('fallback', '/engine/versions/stable-abc/fallback/')).toBe('/engine/versions/stable-abc/sim-worker.js?variant=fallback&worker=3')
  })
})

describe('selectable engine versions', () => {
  it('keeps the current tab on its original engine when another tab changes the preference', async () => {
    vi.resetModules()
    let preference = 'stable-abc'
    vi.stubGlobal('localStorage', { getItem: () => preference })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, defaultId: 'stable-abc', versions: [
      { id: 'stable-abc', label: 'Stable', channel: 'stable', baseUrl: '/engine/versions/stable-abc/' },
      { id: 'beta-def', label: 'Beta', channel: 'beta', baseUrl: '/engine/versions/beta-def/' },
    ] }))))
    const { selectedEngine } = await import('./versions')
    expect((await selectedEngine()).id).toBe('stable-abc')
    preference = 'beta-def'
    expect((await selectedEngine()).id).toBe('stable-abc')
  })
  it('allows validated nightlies, keeps beta opt-in and confines engine directories', () => {
    const stable = { id: 'stable-abc', label: 'Stable', channel: 'stable', baseUrl: '/engine/versions/stable-abc/' }
    const list = { schemaVersion: 1, defaultId: stable.id, versions: [stable] }
    expect(parseEngineVersions(list).defaultId).toBe(stable.id)
    expect(parseEngineVersions({ ...list, versions: [{ ...stable, channel: 'nightly' }] }).defaultId).toBe(stable.id)
    expect(() => parseEngineVersions({ ...list, versions: [{ ...stable, channel: 'beta' }] })).toThrow()
    expect(() => parseEngineVersions({ ...list, versions: [{ ...stable, baseUrl: 'https://example.com/' }] })).toThrow()
    expect(() => parseEngineVersions({ ...list, versions: [{ ...stable, baseUrl: '/engine/versions/../../' }] })).toThrow()
    expect(() => parseEngineVersions({ ...list, versions: [stable, stable] })).toThrow()
  })
  it('selects the matching fallback within the same version pack', async () => {
    vi.stubGlobal('crossOriginIsolated', false)
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).includes('/fallback/')
      ? fallbackManifest : threadedManifest)))
    const cap = await detectEngineCapability({ baseUrl: '/engine/versions/stable-abc/', fetchImpl: fetchImpl as typeof fetch })
    expect(cap.ok && cap.engineDir).toBe('/engine/versions/stable-abc/fallback/')
  })
})

describe('wasm exception probe', () => {
  it('validates the legacy try/catch_all encoding our binary actually uses', () => {
    // wasm-opt reports `try`/`rethrow` not try_table; probe must use legacy pair.
    expect(hasWasmExceptions()).toBe(true)
  })
})

describe('cacheKey', () => {
  const parts = {
    engineIdentity: engineIdentity(threadedManifest),
    catalogId: 'catalog-2026-09-14',
    precision: precisionKey({ mode: 'iterations', iterations: 10000 }),
    canonical: 'head=,id=1,bonus_id=2\ntalents=AB',
  }

  it('is stable for identical input', async () => {
    expect(await cacheKey(parts)).toBe(await cacheKey({ ...parts }))
    expect(await cacheKey(parts)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when anything that changes the number changes', async () => {
    const base = await cacheKey(parts)
    expect(await cacheKey({ ...parts, canonical: parts.canonical + '\n' })).not.toBe(base)
    expect(await cacheKey({ ...parts, catalogId: 'other' })).not.toBe(base)
    expect(await cacheKey({ ...parts, precision: 'i20000' })).not.toBe(base)
    expect(await cacheKey({ ...parts, engineIdentity: engineIdentity(fallbackManifest) })).not.toBe(base)
  })

  it('distinguishes a missing catalog from a catalog literally named that', async () => {
    const without = await cacheKey({ ...parts, catalogId: undefined })
    expect(without).not.toBe(await cacheKey(parts))
  })
})

describe('precisionKey', () => {
  it('separates the accuracy modes, which are not interchangeable results', () => {
    expect(precisionKey({ mode: 'iterations', iterations: 10000 })).toBe('i10000')
    expect(precisionKey({ mode: 'targetError', targetError: 0.5, maxIterations: 100000 })).toBe('e0.5/100000')
    expect(precisionKey({ mode: 'script' })).toBe('script')
  })
})

describe('engineIdentity', () => {
  it('covers everything that changes a number', () => {
    const id = engineIdentity(threadedManifest)
    expect(id).toContain('1210-01')
    expect(id).toContain('c01572044af513f9d85b79080b8d14619f1c00c5')
    expect(id).toContain('12.1.0.69814')
    expect(id).toContain('dca34b3038a3')
  })

  it('separates the two artifacts, which do not produce identical numbers', () => {
    expect(engineIdentity(threadedManifest)).not.toBe(engineIdentity(fallbackManifest))
  })
})
