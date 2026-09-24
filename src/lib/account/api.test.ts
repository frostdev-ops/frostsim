// Account API wrapper (CLAUDE.md D15, DESIGN.md C2, C10): request encoding, 204, and every failure becoming an AccountError without a raw body.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, AccountError } from './api'

const reply = (body: string, status: number, type = 'application/json') => vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } }))
const failure = async (p: Promise<unknown>) => p.then(() => { throw new Error('resolved') }, (e: unknown) => e as AccountError)

afterEach(() => vi.unstubAllGlobals())

describe('api', () => {
  it('sends JSON bodies as JSON and gzip uploads as application/gzip under /api/v1', async () => {
    const fetchMock = reply('{"id":"x"}', 200)
    vi.stubGlobal('fetch', fetchMock)
    expect(await api('/characters', 'POST', { label: 'a' })).toEqual({ id: 'x' })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/characters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"label":"a"}' })
    const gz = new Uint8Array([31, 139])
    await api('/shares/x/blob', 'PUT', gz)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/shares/x/blob', { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: gz })
    await api('/me')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/me', { method: 'GET' })
  })

  it('answers undefined for 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    expect(await api('/me', 'DELETE')).toBeUndefined()
  })

  it('treats a 200 that is not JSON as no account service, and never shows the body', async () => {
    vi.stubGlobal('fetch', reply('<!doctype html><script>x</script>', 200, 'text/html'))
    const e = await failure(api('/me'))
    expect(e).toBeInstanceOf(AccountError)
    expect([e.status, e.code, e.message]).toEqual([200, 'unavailable', 'The account service is not available (200).'])
  })

  it('keeps the server error code and caps its message; a body without one gets a fixed line', async () => {
    vi.stubGlobal('fetch', reply(JSON.stringify({ error: 'no-slots', message: 'm'.repeat(500) }), 402))
    const e = await failure(api('/characters', 'POST', {}))
    expect([e.status, e.code, e.message.length]).toEqual([402, 'no-slots', 300])

    vi.stubGlobal('fetch', reply('upstream said <secret>', 502, 'text/plain'))
    const bad = await failure(api('/me'))
    expect([bad.status, bad.code, bad.message]).toEqual([502, 'unavailable', 'The account service is not available (502).'])
  })

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const e = await failure(api('/me'))
    expect([e.status, e.code]).toEqual([0, 'network'])
  })
})
