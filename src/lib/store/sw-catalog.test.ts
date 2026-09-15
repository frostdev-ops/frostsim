import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Rime review: worker is plain JS served verbatim, load in controlled scope, exercise two functions with indistinguishable failure modes.
//
// Defect: catalogUrls() fetched manifest network-only, returned [] on failure, so reportStatus said have:0 need:0 (complete). Offline is exactly when that happens.

function loadWorker(env: {
  fetch?: typeof fetch
  caches?: unknown
  origin?: string
  /** Omit to simulate a build that ran without the stamp plugin. */
  assets?: string[] | undefined
}) {
  const source = readFileSync('public/sw.js', 'utf8')
  const self: Record<string, unknown> = {
    location: { origin: env.origin ?? 'https://frostsim.test' },
    addEventListener: () => {},
    __FROSTSIM_ASSETS: 'assets' in env ? env.assets : ['/assets/a.js'],
  }
  const scope = {
    self,
    caches: env.caches ?? { open: async () => ({ match: async () => undefined, keys: async () => [] }), keys: async () => [], delete: async () => true },
    fetch: env.fetch ?? (async () => { throw new Error('offline') }),
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    console,
    setTimeout,
  }
  // Expose the internals the test needs without changing the worker's shape.
  const body = `${source}\n;return { catalogUrls, safeCatalogBase, manifestFiles, resolveCacheName };`
  const factory = new Function(...Object.keys(scope), body)
  return factory(...Object.values(scope)) as {
    catalogUrls: (b: string | null) => Promise<{ kind: string; urls?: string[]; reason?: string; source?: string }>
    safeCatalogBase: (b: string | null) => string | null
    manifestFiles: (b: string, m: unknown) => string[] | null
    resolveCacheName: () => Promise<{ name: string; assets: string[] }>
  }
}

/** The ten files a real build emits, in the order the stamp plugin sorts them. */
const REAL_ASSETS = [
  '/assets/Banner-CKCQZchh.js', '/assets/Banner-CgzxVw-b.css',
  '/assets/Help-C7uqiw_r.js', '/assets/Help-anCBtVnT.css',
  '/assets/Talents-D3jJOdvO.css', '/assets/Talents-cBC6FeOw.js',
  '/assets/catalog-worker-snHoWamn.js', '/assets/index-Cw8lqz1l.js',
  '/assets/index-DFjdeFhW.css', '/assets/report-worker-kH0HiZSa.js',
]

const ok = (body: unknown) => ({
  ok: true, status: 200,
  clone() { return this },
  json: async () => body,
})

// Cold-offline blocker: server down, cold worker, page reload produces Chrome error + empty cache beside 29-entry. resolveCacheName() fetched /index.html to identify, cannot work offline; caches.open() creates what it finds. Worker must never use network to identify own cache.
describe('cache identity on a cold offline start', () => {
  // Network is gone; this is the whole point.
  const offline = async () => { throw new Error('Failed to fetch') }

  it('resolves the SAME name offline as online, from embedded build metadata', async () => {
    const online = loadWorker({
      assets: REAL_ASSETS,
      fetch: (async () => ({
        ok: true, status: 200, clone() { return this },
        text: async () => REAL_ASSETS.map((a) => `<script src="${a}">`).join(''),
      })) as unknown as typeof fetch,
    })
    const cold = loadWorker({ assets: REAL_ASSETS, fetch: offline as unknown as typeof fetch })

    const a = await online.resolveCacheName()
    const b = await cold.resolveCacheName()
    expect(b.name).toBe(a.name)
    expect(b.name).toMatch(/^frostsim-[0-9a-f]{12}$/)
    // Never the fallback, which is what made the good cache unfindable.
    expect(b.name).not.toBe('frostsim-unknown')
  })

  it('carries all ten built assets with no network at all', async () => {
    const w = loadWorker({ assets: REAL_ASSETS, fetch: offline as unknown as typeof fetch })
    const { assets } = await w.resolveCacheName()
    // 10 assets + 4 shell entries is 29-entry cache once engine/catalogs added; ten are part this function handles.
    expect(assets).toEqual(REAL_ASSETS)
    expect(assets).toHaveLength(10)
  })

  it('never asks the network when the build metadata is present', async () => {
    let fetches = 0
    const w = loadWorker({
      assets: REAL_ASSETS,
      fetch: (async () => { fetches++; throw new Error('should not be called') }) as unknown as typeof fetch,
    })
    await w.resolveCacheName()
    expect(fetches).toBe(0)
  })

  it('does not pick a cache by scanning caches.keys()', async () => {
    // Selecting the most recent existing cache would silently mix versions —
    // serving yesterday's JavaScript against today's HTML — which is worse than
    // failing. The name comes from this build's own metadata or not at all.
    let scanned = false
    const w = loadWorker({
      assets: REAL_ASSETS,
      fetch: offline as unknown as typeof fetch,
      caches: {
        keys: async () => { scanned = true; return ['frostsim-deadbeefcafe'] },
        open: async () => ({ match: async () => undefined }),
      },
    })
    const { name } = await w.resolveCacheName()
    expect(scanned).toBe(false)
    expect(name).not.toBe('frostsim-deadbeefcafe')
  })

  // Control: without metadata worker cannot identify itself offline, says so not guessing; only path producing empty-unknown cache; ensures skipped stamp plugin still works online.
  it('falls back to frostsim-unknown ONLY with no metadata and no network', async () => {
    const w = loadWorker({ assets: undefined, fetch: offline as unknown as typeof fetch })
    const { name, assets } = await w.resolveCacheName()
    expect(name).toBe('frostsim-unknown')
    expect(assets).toEqual([])
  })

  it('still scrapes index.html when there is no metadata but there is a network', async () => {
    const w = loadWorker({
      assets: undefined,
      fetch: (async () => ({
        ok: true, status: 200, clone() { return this },
        text: async () => '<script src="/assets/index-abc.js"></script>',
      })) as unknown as typeof fetch,
    })
    const { name, assets } = await w.resolveCacheName()
    expect(assets).toEqual(['/assets/index-abc.js'])
    expect(name).not.toBe('frostsim-unknown')
  })

  it('treats an empty metadata array as absent rather than as a version', async () => {
    // Hashing [] would produce a stable, wrong name shared by every broken
    // build — the one collision that could mix versions across releases.
    const w = loadWorker({ assets: [], fetch: offline as unknown as typeof fetch })
    expect((await w.resolveCacheName()).name).toBe('frostsim-unknown')
  })
})

describe('safeCatalogBase', () => {
  it('accepts a same-origin catalog path', () => {
    const w = loadWorker({})
    expect(w.safeCatalogBase('/catalogs/12.1.0')).toBe('https://frostsim.test/catalogs/12.1.0')
    // Trailing slashes are normalised so URLs do not double up.
    expect(w.safeCatalogBase('/catalogs/12.1.0/')).toBe('https://frostsim.test/catalogs/12.1.0')
  })

  it('refuses another origin, so the worker cannot be made a fetch proxy', () => {
    // catalogBaseUrl arrives in a postMessage from a page. An unvalidated base
    // would let whoever can post here fetch any origin and have the result
    // written into our cache and served back as ours.
    const w = loadWorker({})
    expect(w.safeCatalogBase('https://evil.example/catalogs/x')).toBeNull()
    expect(w.safeCatalogBase('//evil.example/catalogs/x')).toBeNull()
  })

  it('refuses a same-origin path outside the catalog tree', () => {
    const w = loadWorker({})
    expect(w.safeCatalogBase('/engine')).toBeNull()
    expect(w.safeCatalogBase('/')).toBeNull()
  })

  it('treats no base as no base', () => {
    expect(loadWorker({}).safeCatalogBase(null)).toBeNull()
  })
})

describe('manifestFiles', () => {
  const base = 'https://frostsim.test/catalogs/x'

  it('builds the full url list from a well-formed manifest', () => {
    const w = loadWorker({})
    expect(w.manifestFiles(base, { files: [{ path: 'items.json' }, { path: 'sub/t.json' }] }))
      .toEqual([`${base}/manifest.json`, `${base}/items.json`, `${base}/sub/t.json`])
  })

  it('rejects a manifest that could name anything on the origin', () => {
    const w = loadWorker({})
    // A compromised or malformed manifest must not be able to walk out of the
    // catalog tree and have the result cached as ours.
    expect(w.manifestFiles(base, { files: [{ path: '../../secret' }] })).toBeNull()
    expect(w.manifestFiles(base, { files: [{ path: '/etc/passwd' }] })).toBeNull()
  })

  it('rejects a manifest with the wrong shape rather than guessing', () => {
    const w = loadWorker({})
    expect(w.manifestFiles(base, null)).toBeNull()
    expect(w.manifestFiles(base, {})).toBeNull()
    expect(w.manifestFiles(base, { files: [{ bytes: 1 }] })).toBeNull()
  })
})

describe('catalogUrls', () => {
  it('reports "absent" when no catalog is configured', async () => {
    const w = loadWorker({})
    expect(await w.catalogUrls(null)).toEqual({ kind: 'absent' })
  })

  it('reads the manifest from the network when online', async () => {
    const w = loadWorker({
      fetch: (async () => ok({ files: [{ path: 'items.json' }] })) as unknown as typeof fetch,
    })
    const r = await w.catalogUrls('/catalogs/x')
    expect(r.kind).toBe('ok')
    expect(r.source).toBe('network')
    expect(r.urls).toHaveLength(2)
  })

  it('falls back to the CACHED manifest when offline — the whole point', async () => {
    // Cold offline start: the network is gone, but the manifest is in the cache
    // from a previous visit, so the file list is still knowable.
    const w = loadWorker({
      fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
      caches: {
        open: async () => ({
          match: async (u: string) => (u.endsWith('manifest.json') ? ok({ files: [{ path: 'items.json' }] }) : undefined),
        }),
      },
    })
    const r = await w.catalogUrls('/catalogs/x')
    expect(r.kind).toBe('ok')
    expect(r.source).toBe('cache')
  })

  it('reports "unknown" — never an empty list — when the manifest cannot be read', async () => {
    // This is the defect. `[]` made reportStatus say have:0 need:0, which reads
    // as complete, so an offline user with no catalog was told they were ready.
    const w = loadWorker({
      fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
    })
    const r = await w.catalogUrls('/catalogs/x')
    expect(r.kind).toBe('unknown')
    expect(r.urls).toBeUndefined()
    expect(r.reason).toContain('could not be read')
  })

  it('reports "unknown" for a base it refuses, rather than "absent"', async () => {
    // A configured-but-rejected base is not the same as nothing configured.
    const w = loadWorker({})
    const r = await w.catalogUrls('https://evil.example/catalogs/x')
    expect(r.kind).toBe('unknown')
    expect(r.reason).toContain('not a path on this site')
  })

  it('reports "unknown" for a malformed cached manifest', async () => {
    const w = loadWorker({
      fetch: (async () => ok({ nope: true })) as unknown as typeof fetch,
    })
    expect((await w.catalogUrls('/catalogs/x')).kind).toBe('unknown')
  })
})
