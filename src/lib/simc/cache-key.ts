export interface CacheKeyParts {
  engineIdentity: string
  catalogId?: string
  precision: string
  canonical: string
}

/** One pure hash shared with the server; missing SubtleCrypto must never permit cache reuse. */
export async function cacheKey(parts: CacheKeyParts): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('SubtleCrypto is unavailable, so no cache key can be computed; do not cache')
  const input = [parts.engineIdentity, parts.catalogId ?? 'no-catalog', parts.precision, parts.canonical].join('\0')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
