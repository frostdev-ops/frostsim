// Hosted report links #/s/<id> (CLAUDE.md D15, DESIGN.md C10): the untrimmed snapshot plus the raw engine report, gzipped, stored by the
// account server and read back through this origin. Viewing needs no account. Decoding bounds the inflated size explicitly: hosted
// reports may exceed readPortable's 8 MB file limit, which stays as it is for file imports.

import { pipe } from '../store/share'
import { makePortable, PORTABLE_FORMAT, PORTABLE_VERSION, type EngineIdentity } from '../store/records'
import { validateReport, type SharedReport } from '../store/report-share'
import { api } from './api'

/** Compressed upload cap, the server's too. */
export const MAX_UPLOAD = 16 << 20
/** Inflated cap, the server's too. Real reports measure about 0.7 MB. */
export const MAX_JSON = 32 << 20
const ID = /^[0-9A-Za-z]{22}$/

export interface Hosted {
  shared: SharedReport
  /** simc's JSON report of the last run (a search's last batch), for download only; the viewer renders `shared`. */
  rawReport: string | null
}

export function packHosted(hosted: Hosted, engine?: EngineIdentity): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(makePortable('report', hosted, engine)))
  return pipe(json, new CompressionStream('gzip'), MAX_UPLOAD)
}

export async function readHosted(gz: Uint8Array, limit = MAX_JSON): Promise<Hosted> {
  const text = new TextDecoder().decode(await pipe(gz, new DecompressionStream('gzip'), limit))
  let file: { format?: unknown; version?: unknown; kind?: unknown; payload?: { shared?: unknown; rawReport?: unknown } } | null
  try {
    file = JSON.parse(text)
  } catch {
    file = null
  }
  if (file?.format !== PORTABLE_FORMAT || file.version !== PORTABLE_VERSION || file.kind !== 'report' || typeof file.payload !== 'object' || !file.payload) {
    throw new Error('This is not a Frostsim hosted report.')
  }
  return { shared: validateReport(file.payload.shared), rawReport: typeof file.payload.rawReport === 'string' ? file.payload.rawReport : null }
}

/** Create, then upload. A failed upload deletes its empty share; the server also drops shares never uploaded within a day. */
export async function createHostedShare(hosted: Hosted, engine?: EngineIdentity): Promise<string> {
  const gz = await packHosted(hosted, engine)
  const title = `${hosted.shared.n} · ${hosted.shared.meta.kind}`.slice(0, 200)
  const { id } = await api<{ id: string }>('/shares', 'POST', { title })
  if (!ID.test(id)) throw new Error('The share service returned an unexpected id.')
  try {
    await api(`/shares/${id}/blob`, 'PUT', gz)
  } catch (e) {
    void api(`/shares/${id}`, 'DELETE').catch(() => {})
    throw e
  }
  return `${location.origin}${location.pathname}#/s/${id}`
}

export async function openHostedShare(id: string): Promise<Hosted> {
  if (!ID.test(id)) throw new Error('This hosted report link is malformed.')
  const res = await fetch(`/api/v1/shares/${id}/blob`).catch(() => null)
  if (res?.status === 404) throw new Error('This hosted report does not exist, was revoked or has expired.')
  if (!res?.ok) throw new Error('The hosted report could not be downloaded. Try again.')
  const gz = new Uint8Array(await res.arrayBuffer())
  if (gz.byteLength > MAX_UPLOAD) throw new Error('Shared data exceeds the size limit.')
  return readHosted(gz)
}
