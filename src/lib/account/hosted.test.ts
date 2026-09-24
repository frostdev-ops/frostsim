// Hosted report payload (CLAUDE.md D15, DESIGN.md C10): gzip round trip, the explicit inflated-size cap, envelope and snapshot checks,
// and the create/upload/view calls against a mocked fetch.

import { readFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHostedShare, openHostedShare, packHosted, readHosted } from './hosted'
import { makePortable } from '../store/records'
import { DICTIONARY, decodeReport } from '../store/report-share'

/** A real snapshot: the frozen version-one report link, decoded by the viewer's own codec. */
const SHARED = await decodeReport(
  readFileSync(new URL('../../../tests/fixtures/shared-report-v1.txt', import.meta.url), 'utf8').trim(),
  JSON.parse(readFileSync(new URL(`../../../public/share/${DICTIONARY}.json`, import.meta.url), 'utf8')) as string[],
)
const ID = 'AbCdEfGhIjKlMnOpQrStUv'
const gz = (value: unknown) => new Uint8Array(gzipSync(JSON.stringify(value)))

afterEach(() => vi.unstubAllGlobals())

describe('hosted payload', () => {
  it('round-trips the snapshot and the raw report through gzip', async () => {
    const bytes = await packHosted({ shared: SHARED, rawReport: '{"sim":{}}' }, { simcVersion: '1210-01' })
    const file = JSON.parse(gunzipSync(bytes).toString('utf8'))
    expect(file).toMatchObject({ format: 'frostsim', version: 1, kind: 'report', engine: { simcVersion: '1210-01' } })
    expect(await readHosted(bytes)).toEqual({ shared: SHARED, rawReport: '{"sim":{}}' })
  })

  it('refuses output past the inflated-size cap, however small the upload', async () => {
    const bomb = gz(makePortable('report', { shared: SHARED, rawReport: 'x'.repeat(200_000) }))
    expect(bomb.byteLength).toBeLessThan(10_000)
    await expect(readHosted(bomb, 100_000)).rejects.toThrow('exceeds the size limit')
    await expect(readHosted(bomb, 300_000)).resolves.toMatchObject({ rawReport: 'x'.repeat(200_000) })
  })

  it('rejects a snapshot validateReport refuses', async () => {
    const bad = { ...SHARED, gear: [['nowhere', 1, [], 0, [], [], 0, 0, 0, 0, 0, 0, {}]] }
    await expect(readHosted(gz(makePortable('report', { shared: bad, rawReport: null })))).rejects.toThrow('Invalid report link data.')
  })

  it('rejects anything that is not a portable report', async () => {
    for (const file of [
      { ...makePortable('report', { shared: SHARED }), format: 'other' },
      { ...makePortable('report', { shared: SHARED }), version: 2 },
      makePortable('character', { shared: SHARED }),
      { ...makePortable('report', null) },
    ]) await expect(readHosted(gz(file))).rejects.toThrow('not a Frostsim hosted report')
    await expect(readHosted(new Uint8Array(gzipSync('not json')))).rejects.toThrow('not a Frostsim hosted report')
    // A raw report of the wrong type is dropped, not trusted.
    expect((await readHosted(gz(makePortable('report', { shared: SHARED, rawReport: 5 })))).rawReport).toBeNull()
  })
})

describe('hosted share requests', () => {
  it('creates, then uploads gzip, and returns a #/s/ link', async () => {
    vi.stubGlobal('location', { origin: 'https://sim.test', pathname: '/' })
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url === '/api/v1/shares'
      ? new Response(JSON.stringify({ id: ID }), { status: 201 })
      : new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await createHostedShare({ shared: SHARED, rawReport: null })).toBe(`https://sim.test/#/s/${ID}`)
    const [create, upload] = fetchMock.mock.calls
    expect(create[1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(String(create[1]?.body)).title).toBe(`${SHARED.n} · ${SHARED.meta.kind}`)
    expect(upload[0]).toBe(`/api/v1/shares/${ID}/blob`)
    expect(upload[1]).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/gzip' } })
    expect((await readHosted(upload[1]?.body as Uint8Array)).shared).toEqual(SHARED)
  })

  it('deletes the empty share when the upload fails, and reports the server message', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (url === '/api/v1/shares'
      ? new Response(JSON.stringify({ id: ID }), { status: 201 })
      : init?.method === 'PUT' ? new Response(JSON.stringify({ error: 'not-entitled', message: 'Hosted links need a plan that includes them.' }), { status: 402 })
      : new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHostedShare({ shared: SHARED, rawReport: null })).rejects.toMatchObject({ status: 402, code: 'not-entitled' })
    expect(fetchMock.mock.calls.at(-1)).toEqual([`/api/v1/shares/${ID}`, { method: 'DELETE' }])
  })

  it('opens a hosted share, and refuses malformed ids before any request', async () => {
    const fetchMock = vi.fn(async () => new Response(gz(makePortable('report', { shared: SHARED, rawReport: '{}' }))))
    vi.stubGlobal('fetch', fetchMock)
    expect(await openHostedShare(ID)).toEqual({ shared: SHARED, rawReport: '{}' })
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/shares/${ID}/blob`)
    for (const id of ['short', `${ID}x`, '../../me/export', `${ID.slice(1)}/`]) {
      await expect(openHostedShare(id)).rejects.toThrow('malformed')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not-found' }), { status: 404 }))
    await expect(openHostedShare(ID)).rejects.toThrow('does not exist, was revoked or has expired')
  })
})
