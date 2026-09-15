// Service-worker registration and offline status (P11.7, P11.8, P11.11). Quiet by default; large downloads opt-in.

import { selectedEngine } from '../simc/versions'

export interface AssetGroup {
  /** Catalog group only: known=count, absent=unconfigured, unknown=unreadable list. Never render unknown as complete. */
  status?: 'known' | 'absent' | 'unknown'
  reason?: string
  have: number
  need: number
}

export interface OfflineStatus {
  /** Set when the service worker's precache failed outright. */
  precacheError?: string | null
  version: string
  shell: AssetGroup
  engine: AssetGroup
  catalog: AssetGroup
}

export const offline = $state({
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  registered: false,
  /** A newer release is installed and waiting for a safe moment to take over. */
  updateReady: false,
  caching: false,
  progress: null as { done: number; failed: number; total: number } | null,
  status: null as OfflineStatus | null,
  error: '',
})

let registration: ServiceWorkerRegistration | null = null

// Whether group is fully cached. status separates absent (ready) from unknown (never ready).
export function ready(group: AssetGroup | undefined): boolean {
  if (!group) return false
  if (group.status === 'unknown') return false
  if (group.status === 'absent') return true
  return group.need > 0 && group.have >= group.need
}

// True when app cannot say whether group is cached.
export function unknownState(group: AssetGroup | undefined): boolean {
  return group?.status === 'unknown'
}

// True only when app shell, engine, and catalog are all cached.
export function fullyOffline(): boolean {
  const s = offline.status
  return !!s && ready(s.shell) && ready(s.engine) && ready(s.catalog)
}

function onMessage(event: MessageEvent): void {
  const data = event.data as { type?: string } | null
  if (!data?.type) return
  if (data.type === 'offline-status') {
    offline.status = data as unknown as OfflineStatus
    offline.caching = false
    offline.progress = null
  }
  if (data.type === 'offline-progress') {
    offline.progress = data as unknown as { done: number; failed: number; total: number }
  }
}

export async function register(): Promise<void> {
  if (!offline.supported || offline.registered) return
  // Dev server has no versioned assets; registering caches Vite's module graph. Production only.
  if (import.meta.env.DEV) return
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    offline.registered = true
    navigator.serviceWorker.addEventListener('message', onMessage)

    if (registration.waiting) offline.updateReady = true
    registration.addEventListener('updatefound', () => {
      const installing = registration?.installing
      installing?.addEventListener('statechange', () => {
        // "installed" with existing controller = staged release, takes over when page asks (P11.8).
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          offline.updateReady = true
        }
      })
    })
  } catch (err) {
    offline.error = err instanceof Error ? err.message : String(err)
  }
}

function active(): ServiceWorker | null {
  return navigator.serviceWorker?.controller ?? registration?.active ?? null
}

export function refreshStatus(catalogBaseUrl: string | null): void {
  void selectedEngine().then(v => active()?.postMessage({ type: 'offline-status', catalogBaseUrl, engineBaseUrl: v.baseUrl }))
    .catch(err => { offline.error = String(err) })
}

export function cacheForOffline(catalogBaseUrl: string | null): void {
  const worker = active()
  if (!worker) {
    offline.error = 'The offline worker is not running yet. Reload and try again.'
    return
  }
  offline.caching = true
  offline.progress = null
  void selectedEngine().then(v => worker.postMessage({ type: 'cache-offline', catalogBaseUrl, engineBaseUrl: v.baseUrl }))
    .catch(err => { offline.error = String(err); offline.caching = false })
}

// Hand page to staged release. Caller must do this when no job running (P11.8).
export function applyUpdate(): void {
  const waiting = registration?.waiting
  if (!waiting) {
    offline.error = 'No staged update is waiting. Reload to pick up the latest version.'
    return
  }

  let reloaded = false
  const reload = () => {
    if (reloaded) return
    reloaded = true
    window.location.reload()
  }

  // Listen BEFORE posting: controller can change before next statement runs.
  navigator.serviceWorker?.addEventListener('controllerchange', reload, { once: true })
  waiting.postMessage({ type: 'skip-waiting' })

  // Timeout safety: new worker already installed, next navigation picks it up.
  setTimeout(reload, 3000)
}
