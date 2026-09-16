/* Service worker: offline assets and staged updates. Build embeds hashed filenames for offline ID (P11.7, P11.8, P11.11). */

const PREFIX = 'frostsim'
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest']

// Large optional assets; keep variants in step with engineWorkerUrl() in simc/job.ts.
const BIG = {
  engine: ['/engine/manifest.json', '/engine/simc.js', '/engine/simc.wasm', '/engine/sim-worker.js?worker=3', '/engine/sim-worker.js?variant=fallback&worker=3'],
}

function engineUrls(base = '/engine/') {
  if (base !== '/engine/' && !/^\/engine\/versions\/[a-z0-9][a-z0-9.-]{0,100}\/$/.test(base)) throw new Error('Invalid engine path')
  return ['/engine-versions.json', ...BIG.engine.map(url => url.replace('/engine/', base)),
    ...['manifest.json', 'simc.js', 'simc.wasm'].map(file => `${base}fallback/${file}`),
    ...Array.from({ length: 13 }, (_, i) => `${base === '/engine/' ? '/' : base}talent-layout/class-${i + 1}.json`)]
}

let cacheNamePromise = null
/** Precache error to report instead of guessing. */
let precacheError = null

async function nameFor(assets) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(assets.join('|')))
  const hex = [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${PREFIX}-${hex}`
}

/** Cache identity from embedded asset list, never from network (offline-safe and mutable-proof). */
async function resolveCacheName() {
  if (cacheNamePromise) return cacheNamePromise
  cacheNamePromise = (async () => {
    const embedded = self.__FROSTSIM_ASSETS
    if (Array.isArray(embedded) && embedded.length) {
      return { name: await nameFor(embedded), assets: embedded }
    }

    // No embedded list: fallback scrape needs network; cold offline genuinely cannot identify itself.
    try {
      const res = await fetch('/index.html', { cache: 'no-cache' })
      const html = await res.text()
      // HTML names only initial route, not lazy chunks or workers; incomplete fallback.
      const assets = [...html.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]).sort()
      return { name: await nameFor(assets), assets }
    } catch {
      return { name: `${PREFIX}-unknown`, assets: [] }
    }
  })()
  return cacheNamePromise
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const { name, assets } = await resolveCacheName()
      const cache = await caches.open(name)
      // All-or-nothing addAll: partial release is worse than failure; report loudly.
      try {
        await cache.addAll([...SHELL, ...assets])
        precacheError = null
      } catch (err) {
        precacheError = String(err && err.message ? err.message : err)
        // Delete incomplete cache; empty cache looks like success.
        await caches.delete(name).catch(() => {})
      }
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Claim first; housekeeping delay would look like hung update.
      await self.clients.claim()
      try {
        const { name } = await resolveCacheName()
        const keys = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== name && k !== 'frostsim-media-v1')
        // Keep one previous version; drop older.
        for (const stale of keys.slice(0, Math.max(0, keys.length - 1))) await caches.delete(stale)
      } catch {}
    })(),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return

  if (data.type === 'skip-waiting') {
    // Hold skipWaiting() with waitUntil; async promise must complete before activation.
    event.waitUntil(self.skipWaiting())
    return
  }

  if (data.type === 'cache-offline') {
    event.waitUntil(cacheOffline(data.catalogBaseUrl, event.source, data.engineBaseUrl))
    return
  }

  if (data.type === 'offline-status') {
    event.waitUntil(reportStatus(data.catalogBaseUrl, event.source, data.engineBaseUrl))
  }
})

/** Same-origin catalog base validation (postMessage is trust boundary). */
function safeCatalogBase(base) {
  if (!base) return null
  try {
    const url = new URL(base, self.location.origin)
    if (url.origin !== self.location.origin) return null
    // One prefix prevents walk-out; validates /catalogs/ or engine version catalog paths.
    if (!url.pathname.startsWith('/catalogs/') && !/^\/engine\/versions\/[a-z0-9][a-z0-9.-]{0,100}\/catalog\/?$/.test(url.pathname)) return null
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function manifestFiles(base, manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const files = Array.isArray(manifest.files) ? manifest.files : null
  if (!files) return null
  const urls = []
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path) return null
    // Validate manifest paths: no `..` walk-out or `/` absolute paths on origin.
    if (f.path.includes('..') || f.path.startsWith('/')) return null
    urls.push(`${base}/${f.path}`)
  }
  return [`${base}/manifest.json`, ...urls]
}

/** Returns discriminated state: absent (not configured), ok (known list), unknown (fetch failed). */
async function catalogUrls(rawBase) {
  const base = safeCatalogBase(rawBase)
  if (!base) return rawBase ? { kind: 'unknown', reason: 'the catalog location is not a path on this site' } : { kind: 'absent' }

  const cache = await caches.open((await resolveCacheName()).name)
  const manifestUrl = `${base}/manifest.json`

  // Try network first so new catalogs are noticed; cache second for offline (don't erase known state).
  for (const source of ['network', 'cache']) {
    try {
      const res = source === 'network'
        ? await fetch(manifestUrl, { cache: 'no-cache' })
        : await cache.match(manifestUrl)
      if (!res || !res.ok) continue
      const urls = manifestFiles(base, await res.clone().json())
      if (urls) return { kind: 'ok', urls, source }
    } catch {}
  }
  return { kind: 'unknown', reason: 'the catalog description could not be read online or from the cache' }
}

async function cacheOffline(catalogBaseUrl, client, engineBaseUrl) {
  const { name } = await resolveCacheName()
  const cache = await caches.open(name)
  const catalog = await catalogUrls(catalogBaseUrl)
  // Report unreadable manifest, never treat as "not needed" (would mislead user about offline readiness).
  if (catalog.kind === 'unknown') {
    client?.postMessage({
      type: 'offline-progress', done: 0, failed: 0, total: 0,
      error: `Game data could not be prepared: ${catalog.reason}.`,
    })
  }
  const urls = [...engineUrls(engineBaseUrl), ...(catalog.kind === 'ok' ? catalog.urls : [])]
  let done = 0
  let failed = 0

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-cache' })
      // Reject failed responses; broken cache is worse than reporting failure now.
      if (!res.ok) throw new Error(`${url}: ${res.status}`)
      await cache.put(url, res.clone())
      done++
    } catch {
      failed++
    }
    client?.postMessage({ type: 'offline-progress', done, failed, total: urls.length })
  }

  await reportStatus(catalogBaseUrl, client, engineBaseUrl)
}

async function reportStatus(catalogBaseUrl, client, engineBaseUrl) {
  const { name, assets } = await resolveCacheName()
  const cache = await caches.open(name)
  const required = [...SHELL, ...assets]
  const engine = engineUrls(engineBaseUrl)
  const catalog = await catalogUrls(catalogBaseUrl)

  const present = async (urls) => {
    let n = 0
    for (const url of urls) if (await cache.match(url)) n++
    return n
  }

  client?.postMessage({
    type: 'offline-status',
    version: name,
    shell: { have: await present(required), need: required.length },
    // Report precacheError explicitly; 0/0 with named cache is ambiguous without it.
    precacheError,
    engine: { have: await present(engine), need: engine.length },
    // `status` distinguishes: absent (not configured), known (list available), unknown (fetch failed).
    catalog: catalog.kind === 'ok'
      ? { status: 'known', have: await present(catalog.urls), need: catalog.urls.length }
      : catalog.kind === 'absent'
        ? { status: 'absent', have: 0, need: 0 }
        : { status: 'unknown', have: 0, need: 0, reason: catalog.reason },
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // API requests use the browser network path without waiting for the shell cache.
  if (url.pathname.startsWith('/api/')) return

  event.respondWith(
    (async () => {
      const { name } = await resolveCacheName()
      const cache = await caches.open(name)

      // Version index moves; engine directories are immutable.
      if (url.pathname === '/engine-versions.json') {
        try {
          const res = await fetch(request, { cache: 'no-cache' })
          if (res.ok) await cache.put(request, res.clone())
          return res
        } catch (err) {
          const hit = await cache.match(request)
          if (hit) return hit
          throw err
        }
      }

      // Immutable hashed assets and artifacts: cache wins, never touched network.
      const immutable = url.pathname.startsWith('/assets/')
        || url.pathname.startsWith('/engine/')
        || url.pathname.startsWith('/catalogs/')
      if (immutable) {
        const hit = await cache.match(request)
        if (hit) return hit
        // Catalog refreshes under same engine ID; revalidate instead of inheriting browser's old copy.
        const res = await fetch(request, url.pathname.startsWith('/catalogs/') ? { cache: 'no-cache' } : undefined)
        if (res.ok) cache.put(request, res.clone()).catch(() => {})
        return res
      }

      // Everything else: network-first so deploys are picked up immediately; cache is offline fallback.
      try {
        const res = await fetch(request)
        if (res.ok && request.mode === 'navigate') cache.put('/index.html', res.clone()).catch(() => {})
        return res
      } catch (err) {
        const hit = (await cache.match(request)) ?? (await cache.match('/index.html'))
        if (hit) return hit
        throw err
      }
    })(),
  )
})
