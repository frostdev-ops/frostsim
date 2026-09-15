// One visible-image queue for item and spell icons; off-screen entries don't exhaust API burst budget before visible icons load.
const cache = new Map<string, { promise: Promise<string | null>; expiresAt: number }>()
import { cachedMedia, saveMedia, mediaExpiry, EXPIRY } from './media-cache'
const MAX_ICONS = 2000
const queue: (() => Promise<void>)[] = []
let active = 0, nextStart = 0, pausedUntil = 0
let timer: ReturnType<typeof setTimeout> | undefined
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function pump(): void {
  if (timer || active >= 4 || !queue.length) return
  const delay = Math.max(nextStart, pausedUntil) - Date.now()
  if (delay > 0) { timer = setTimeout(() => { timer = undefined; pump() }, delay); return }
  const task = queue.shift()!
  nextStart = Date.now() + 100
  active++
  void task().finally(() => { active--; pump() })
  pump()
}

export function loadIcon(url: string): Promise<string | null> {
  if (!/^\/api\/wow\/(?:(icon|spell-icon)\/\d+(?:\?[^#]*)?|character-render\/(us|eu|kr|tw)\/[^/?#]+\/[^/?#]+\/avatar)$/.test(url)) return Promise.reject(new Error('Invalid icon URL'))
  const hit = cache.get(url)
  if (hit && hit.expiresAt > Date.now()) return hit.promise
  const entry = { promise: null as unknown as Promise<string | null>, expiresAt: Infinity }
  const promise = new Promise<string | null>((resolve, reject) => {
    const load = async (cached?: Response) => {
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!cached) await sleep(Math.max(0, pausedUntil - Date.now()))
          const response = cached ?? await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12000) })
          if (response.status === 404) { entry.expiresAt = Date.now() + 60000; resolve(null); return }
          if (response.status === 429 || response.status >= 500) {
            const retry = response.headers.get('retry-after')
            const wait = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 1000 * 2 ** attempt
            pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(30000, Math.max(1000, wait || 1000)))
            continue
          }
          if (!response.ok || !/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Icon unavailable')
          const reader = response.body!.getReader(), chunks: Uint8Array[] = []
          let size = 0
          try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('Icon too large'); chunks.push(value) } }
          finally { await reader.cancel().catch(() => {}) }
          let binary = ''
          for (const chunk of chunks) for (const byte of chunk) binary += String.fromCharCode(byte)
          entry.expiresAt = cached ? Number(response.headers.get(EXPIRY)) : mediaExpiry(response)
          if (!cached) await saveMedia(url, new Response(new Blob(chunks as BlobPart[]), { headers: response.headers }), entry.expiresAt)
          resolve(`data:${response.headers.get('content-type')!.split(';')[0]};base64,${btoa(binary)}`)
          return
        }
        throw new Error('Icon temporarily unavailable')
      } catch (e) { cache.delete(url); reject(e) }
    }
    void cachedMedia(url).then(cached => {
      if (cached) void load(cached)
      else { queue.push(() => load()); pump() }
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
      void loadIcon(next).then(src => {
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
