// One visible-image queue for item and spell icons; off-screen entries don't exhaust API burst budget before visible icons load.
const cache = new Map<string, { promise: Promise<string | null>; expiresAt: number; consumers: (() => boolean)[] }>()
import { cachedMedia, saveMedia, mediaExpiry, EXPIRY } from './media-cache'
const MAX_ICONS = 2000
const queue: { run: () => Promise<void>; needed: () => boolean; readyAt: number }[] = []
let active = 0, nextStart = 0, pausedUntil = 0
let timer: ReturnType<typeof setTimeout> | undefined

function pump(): void {
  if (timer) { clearTimeout(timer); timer = undefined }
  // Discard obsolete views without spending a network slot or pacing interval.
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!queue[i]!.needed()) void queue.splice(i, 1)[0]!.run()
  }
  if (active >= 4 || !queue.length) return
  const delay = Math.max(nextStart, pausedUntil, Math.min(...queue.map(task => task.readyAt))) - Date.now()
  if (delay > 0) { timer = setTimeout(() => { timer = undefined; pump() }, delay); return }
  const [task] = queue.splice(queue.findIndex(task => task.readyAt <= Date.now()), 1)
  // Match the proxy's 8/s metadata refill; more parallel requests just trigger retries.
  nextStart = Date.now() + 125
  active++
  void task!.run().finally(() => { active--; pump() })
  pump()
}

export function loadIcon(url: string, needed: () => boolean = () => true): Promise<string | null> {
  if (!/^\/api\/wow\/(?:(icon|spell-icon)\/\d+(?:\?[^#]*)?|character-render\/(us|eu|kr|tw)\/[^/?#]+\/[^/?#]+\/avatar)$/.test(url)) return Promise.reject(new Error('Invalid icon URL'))
  const hit = cache.get(url)
  if (hit && hit.expiresAt > Date.now()) {
    if (hit.expiresAt === Infinity) hit.consumers.push(needed)
    return hit.promise
  }
  const entry = { promise: null as unknown as Promise<string | null>, expiresAt: Infinity, consumers: [needed] }
  const promise = new Promise<string | null>((resolve, reject) => {
    let attempt = 0
    const wanted = () => entry.consumers.some(wants => wants())
    const load = async (cached?: Response) => {
      try {
        if (!wanted()) {
          if (cache.get(url) === entry) cache.delete(url)
          entry.consumers = []; resolve(null); return
        }
        const response = cached ?? await fetch(url, { credentials: 'omit', priority: 'low', signal: AbortSignal.timeout(12000) })
        if (response.status === 404) { entry.expiresAt = Date.now() + 60000; entry.consumers = []; resolve(null); return }
        if (response.status === 429 || response.status >= 500) {
          attempt++
          const retry = response.headers.get('retry-after')
          const wait = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 1000 * 2 ** (attempt - 1)
          const readyAt = Date.now() + Math.min(30000, Math.max(1000, wait || 1000))
          // Only throttling pauses other icons. Retrying one bad asset releases its slot.
          if (response.status === 429) pausedUntil = Math.max(pausedUntil, readyAt)
          if (attempt >= 4) throw new Error('Icon temporarily unavailable')
          queue.push({ run: () => load(), needed: wanted, readyAt })
          return
        }
        if (!response.ok || !/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Icon unavailable')
        const reader = response.body!.getReader(), chunks: Uint8Array[] = []
        let size = 0
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('Icon too large'); chunks.push(value) } }
        finally { await reader.cancel().catch(() => {}) }
        let binary = ''
        for (const chunk of chunks) for (const byte of chunk) binary += String.fromCharCode(byte)
        entry.expiresAt = cached ? Number(response.headers.get(EXPIRY)) : mediaExpiry(response)
        if (!cached) void saveMedia(url, new Response(new Blob(chunks as BlobPart[]), { headers: response.headers }), entry.expiresAt)
        entry.consumers = []
        resolve(`data:${response.headers.get('content-type')!.split(';')[0]};base64,${btoa(binary)}`)
      } catch (e) {
        if (cache.get(url) === entry) cache.delete(url)
        entry.consumers = []; reject(e)
      }
    }
    void cachedMedia(url).then(cached => {
      if (cached) void load(cached)
      else { queue.push({ run: () => load(), needed: wanted, readyAt: 0 }); pump() }
    })
  })
  entry.promise = promise
  cache.set(url, entry)
  // ponytail: session cache capped at 2,000 icons; use byte LRU if material.
  if (cache.size > MAX_ICONS) cache.delete(cache.keys().next().value!)
  return promise
}

const waiting = new Map<Element, () => void>()
let observer: IntersectionObserver | undefined
/** Svelte action; successful bytes use data: URLs (CSP-permitted). Intersection observer defers off-screen loads, gen token prevents stale updates. */
export function deferredIcon(node: HTMLImageElement, url: string) {
  let generation = 0
  function watch(next: string) {
    const token = ++generation
    node.removeAttribute('src')
    const start = () => {
      observer?.unobserve(node); waiting.delete(node)
      void loadIcon(next, () => token === generation).then(src => {
        if (token !== generation) return
        if (src) node.src = src
        else node.dispatchEvent(new Event('error'))
      }).catch(() => { if (token === generation) node.dispatchEvent(new CustomEvent('error', { detail: { transient: true } })) })
    }
    if (typeof IntersectionObserver === 'undefined') { start(); return }
    observer ??= new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) waiting.get(entry.target)?.() }, { rootMargin: '160px' })
    waiting.set(node, start); observer.observe(node)
  }
  watch(url)
  return { update: watch, destroy() { generation++; observer?.unobserve(node); waiting.delete(node) } }
}
