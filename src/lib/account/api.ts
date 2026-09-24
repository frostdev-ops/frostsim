// Fetch wrapper for the account API under /api/v1 (CLAUDE.md D15, DESIGN.md C10): JSON errors become AccountError, never a raw body.

export class AccountError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** A Uint8Array body is a gzip upload (shares); anything else is sent as JSON. 204 answers undefined. */
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body instanceof Uint8Array) init.headers = { 'content-type': 'application/gzip' }
  else if (body !== undefined) init.headers = { 'content-type': 'application/json' }
  if (body !== undefined) init.body = body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body)
  let res: Response
  try {
    res = await fetch(`/api/v1${path}`, init)
  } catch {
    throw new AccountError(0, 'network', 'The account service could not be reached.')
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  // A 200 that is not JSON is the SPA shell: this host serves no account API.
  if (res.ok && data !== null) return data as T
  const code = typeof data?.error === 'string' ? data.error : 'unavailable'
  // Our server writes its messages and never echoes upstream bodies (DESIGN.md C2); anything else gets a fixed line.
  const message = typeof data?.message === 'string' ? data.message.slice(0, 300) : `The account service is not available (${res.status}).`
  throw new AccountError(res.status, code, message)
}
