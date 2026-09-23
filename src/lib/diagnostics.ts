// First-hand facts about installation for Help/status screen. EVERY FIELD IS MEASURED; no external service (third-party dot reports on service not browser).

export interface BuildIdentity {
  /** Hash of the emitted index.html, from the first line of the service worker. */
  stamp: string | null
  /** Cache names the service worker owns right now. */
  caches: string[]
  /** `installing` | `waiting` | `active` | `none`, or why it could not be read. */
  worker: string
  /** A waiting worker is an update deliberately held back, not a failure. */
  updateWaiting: boolean
}

const BUILD_STAMP = /^\/\/ build: ([0-9a-f]{12})/m

export async function buildIdentity(): Promise<BuildIdentity> {
  const out: BuildIdentity = { stamp: null, caches: [], worker: 'none', updateWaiting: false }

  try {
    // Cache-busted: what's deployed, not cached copy browser already has.
    const res = await fetch('/sw.js', { cache: 'no-store' })
    if (res.ok) out.stamp = BUILD_STAMP.exec(await res.text())?.[1] ?? null
  } catch { /* offline, or no service worker shipped */ }

  try {
    if (typeof caches !== 'undefined') {
      out.caches = (await caches.keys()).filter((k) => k.startsWith('frostsim-'))
    }
  } catch { /* storage blocked */ }

  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (!reg) out.worker = 'none'
    else if (reg.installing) out.worker = 'installing'
    else if (reg.waiting) { out.worker = 'waiting'; out.updateWaiting = true }
    else if (reg.active) out.worker = 'active'
  } catch {
    out.worker = 'unavailable'
  }

  return out
}

export interface BrowserFacts {
  crossOriginIsolated: boolean
  sharedArrayBuffer: boolean
  hardwareConcurrency: number | null
  deviceMemory: number | null
  userAgent: string
  storagePersisted: boolean | null
}

export async function browserFacts(): Promise<BrowserFacts> {
  let persisted: boolean | null = null
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null
  } catch { /* not supported */ }
  return {
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    userAgent: navigator.userAgent,
    storagePersisted: persisted,
  }
}

/** Whether engine binary is in cache; null means question could not be asked (not same as "no"). */
export async function engineCached(engineDir: string): Promise<boolean | null> {
  try {
    if (typeof caches === 'undefined') return null
    return Boolean(await caches.match(`${engineDir}simc.wasm`))
  } catch {
    return null
  }
}

export interface Diagnostic {
  generatedAt: string
  build: BuildIdentity
  browser: BrowserFacts
  engine: unknown
  catalog: unknown
  capability: unknown
  lastRun: unknown
}

/** Diagnostic file. DELIBERATELY ABSENT: character profile, name, realm, share link (not needed for bug reports, user shouldn't check public issue). Caller passes what belongs; function makes shape explicit. */
export function buildDiagnostic(parts: {
  build: BuildIdentity
  browser: BrowserFacts
  engineManifest: unknown
  catalogManifest: unknown
  capability: unknown
  lastRun: unknown
}): Diagnostic {
  return {
    generatedAt: new Date().toISOString(),
    build: parts.build,
    browser: parts.browser,
    engine: parts.engineManifest,
    catalog: parts.catalogManifest,
    capability: parts.capability,
    lastRun: parts.lastRun,
  }
}

/** Keys that must never appear anywhere in a diagnostic, at any depth. */
export const FORBIDDEN_DIAGNOSTIC_KEYS = [
  'profile', 'rawProfile', 'name', 'realm', 'characterName', 'shareLink', 'export', 'lines',
]

/** Walks built diagnostic reporting forbidden keys; exists because assembled from other tracks' objects (field added upstream could carry profile). Test asserts returns nothing for real one. */
export function auditDiagnostic(value: unknown, path = ''): string[] {
  const found: string[] = []
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...auditDiagnostic(v, `${path}[${i}]`)))
    return found
  }
  for (const [key, v] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key
    if (FORBIDDEN_DIAGNOSTIC_KEYS.includes(key)) found.push(here)
    found.push(...auditDiagnostic(v, here))
  }
  return found
}
