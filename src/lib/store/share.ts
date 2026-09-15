// Share links (P11.5): compressed into URL fragment, never sent to server, uses platform DEFLATE.

import { MAX_SHARE_BYTES, readPortable, type PortableCheck, type PortableFile } from './records'

const SHARE_PREFIX = 'share'

export function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
}

export async function pipe(data: Uint8Array, stream: TransformStream, limit = 8 * 1024 * 1024): Promise<Uint8Array> {
  // Copy to plain ArrayBuffer: Blob refuses SharedArrayBuffer views; cross-origin isolation makes that possible.
  const bytes = new Uint8Array(data.length)
  bytes.set(data)
  const reader = new Blob([bytes.buffer]).stream().pipeThrough(stream).getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error('Shared data exceeds the size limit.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

export type ShareResult =
  | { ok: true; fragment: string; bytes: number }
  | { ok: false; reason: 'too-large' | 'unsupported'; bytes?: number }

/** Returns fragment (without #) or refusal. Too large means caller offers downloadable file instead. */
export async function encodeShare(file: PortableFile): Promise<ShareResult> {
  if (typeof CompressionStream === 'undefined') return { ok: false, reason: 'unsupported' }
  const raw = new TextEncoder().encode(JSON.stringify(file))
  const packed = await pipe(raw, new CompressionStream('deflate-raw'))
  const encoded = toBase64Url(packed)
  if (encoded.length > MAX_SHARE_BYTES) {
    return { ok: false, reason: 'too-large', bytes: encoded.length }
  }
  return { ok: true, fragment: `/${SHARE_PREFIX}/${encoded}`, bytes: encoded.length }
}

export function isShareFragment(hash: string): boolean {
  return hash.replace(/^#\/?/, '').startsWith(`${SHARE_PREFIX}/`)
}

export async function decodeShare(hash: string): Promise<PortableCheck> {
  const body = hash.replace(/^#\/?/, '').slice(SHARE_PREFIX.length + 1)
  if (!body) return { ok: false, reason: 'The link has no payload.' }
  if (body.length > MAX_SHARE_BYTES * 2) {
    return {
      ok: false,
      reason: 'The link is larger than Frostsim will decode. Ask for the exported file instead.',
    }
  }
  if (typeof DecompressionStream === 'undefined') {
    return {
      ok: false,
      reason: 'This browser cannot decompress share links. Ask for the exported file instead.',
    }
  }
  try {
    const packed = fromBase64Url(body)
    const raw = await pipe(packed, new DecompressionStream('deflate-raw'))
    return readPortable(new TextDecoder().decode(raw))
  } catch {
    return {
      ok: false,
      reason: 'The link is damaged or incomplete. Links break when chat clients wrap them.',
    }
  }
}

/** Drop fragment before anything leaves page; shared setup must not ride in observable URL (P11.5). */
export function stripFragment(): void {
  if (typeof history === 'undefined' || !location.hash) return
  history.replaceState(null, '', location.pathname + location.search)
}
