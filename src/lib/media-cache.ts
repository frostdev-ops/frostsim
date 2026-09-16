// Independent of shell cache; see sw.js activation.
const MEDIA_CACHE = 'frostsim-media-v1'
export const EXPIRY = 'x-frostsim-media-expires'
const MAX_ENTRIES = 2000
const persistent = typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(MEDIA_CACHE).catch(() => null)
let pruning: Promise<void> | undefined

export function mediaExpiry(response: Response): number {
  const control = response.headers.get('cache-control') ?? ''
  if (/\b(no-store|no-cache|private)\b/i.test(control)) return 0
  const ttl = Number(control.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 0)
  const date = Date.parse(response.headers.get('date') ?? '')
  const age = Math.max(Number(response.headers.get('age') ?? 0) * 1000, Number.isFinite(date) ? Date.now() - date : 0)
  return Date.now() + Math.max(0, Math.min(ttl, 30 * 86400) * 1000 - age)
}

export async function cachedMedia(url: string): Promise<Response | undefined> {
  try {
    const disk = await persistent
    const hit = await disk?.match(url)
    if (hit && Number(hit.headers.get(EXPIRY)) > Date.now()) return hit
    if (hit) await disk?.delete(url)
  } catch { /* Storage disabled OK; network still works. */ }
  return undefined
}

export async function saveMedia(url: string, response: Response, expiry: number): Promise<void> {
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return
  try {
    const disk = await persistent
    if (!disk) return
    const headers = new Headers(response.headers)
    headers.set(EXPIRY, String(expiry))
    await disk.put(url, new Response(response.body, { headers }))
    // Coalesce bursts into one scan; writes during pruning get the following pass.
    const previous = pruning
    if (previous) await previous
    if (!pruning) pruning = (async () => {
      const keys = await disk.keys()
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await disk.delete(key)
    })().finally(() => { pruning = undefined })
    await pruning
  } catch { /* Full cache OK; don't break loaded icon. */ }
}

/** Cached character metadata; no remote URLs or failure storage. */
export async function fetchCharacterMedia(url: string): Promise<Response> {
  if (!/^\/api\/wow\/(raider-profile|character-media)\/(us|eu|kr|tw)\/[^/?#]+\/[^/?#]+$/.test(url)) throw new Error('Invalid character media URL')
  const hit = await cachedMedia(url)
  if (hit) return hit
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12000) })
  if (!response.ok) return response
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) throw new Error('Character metadata too large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const result = new Response(new Blob(chunks as BlobPart[]), { headers: response.headers })
  const body = await result.clone().json()
  const expiry = typeof body?.expiresAt === 'string' ? Math.min(mediaExpiry(response), Date.parse(body.expiresAt)) : mediaExpiry(response)
  void saveMedia(url, result.clone(), expiry)
  return result
}
