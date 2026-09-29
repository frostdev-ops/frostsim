// The explain request (CLAUDE.md D17): what leaves the page, and the limits it keeps under the server's caps.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { pipe } from '../store/share'
import type { ComparisonRow } from '../ui/ComparisonBars.svelte'
import { characterNames, explain, fitContext, trimRows } from './explain'

afterEach(() => vi.unstubAllGlobals())

const inflate = async (gz: BodyInit) => JSON.parse(new TextDecoder().decode(await pipe(gz as Uint8Array, new DecompressionStream('gzip'), 32 << 20)))
const stub = (body: unknown = { text: 'ok', model: 'm', costUsd: 0.002, remaining: 2 }) => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('characterNames', () => {
  it('reads every actor line of a profile, whatever the class, and nothing else', () => {
    const profile = '# Bob - Frost - 2026\nmage="Bob"\nlevel=80\nrace=orc\nwarlock=Mia-Area\ndeath_knight="Ren Ren"\nspec=frost'
    expect(characterNames(profile)).toEqual(['Bob', 'Mia-Area', 'Ren Ren'])
    expect(characterNames('level=80\nrace=orc')).toEqual([])
    expect(characterNames(Array.from({ length: 12 }, (_, i) => `mage="Name${i}"`).join('\n'))).toHaveLength(8)
  })
})

describe('trimRows', () => {
  it('keeps the numbers and the changes and drops item objects, rounding means and margins', () => {
    const row = { id: 'a', label: 'Belt', mean: 300123.6, margin: 812.4, iterations: 4000, indistinguishable: true, status: 'measured', detail: 'Best measured combination',
      item: { big: 'object' }, icons: [{ itemId: 1 }], changes: [{ slot: 'waist', name: 'Belt of Frost', replaces: 'Old Belt' }] } as unknown as ComparisonRow
    const [out] = trimRows([row])
    expect(out).toEqual({ label: 'Belt', changes: [{ slot: 'waist', name: 'Belt of Frost', replaces: 'Old Belt' }], mean: 300124, margin: 812, iterations: 4000,
      indistinguishableFromBaseline: true, status: 'measured', note: 'Best measured combination' })
    expect(JSON.stringify(out)).not.toContain('object')
    expect(trimRows(Array.from({ length: 90 }, (_, i) => ({ id: String(i), label: 'x' })))).toHaveLength(40)
  })
})

describe('fitContext', () => {
  it('leaves a small context alone and trims the oldest log lines of a large one', () => {
    const small = { message: 'm', log: ['a', 'b'] }
    expect(fitContext(small)).toBe(small)
    const big = { message: 'm', log: Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(200)}`) }
    const fitted = fitContext(big, 20_000) as typeof big
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(20_000)
    expect(fitted.log.at(-1)).toBe(big.log.at(-1))
    expect(fitted.log.length).toBeLessThan(big.log.length)
    // The default cap sits under the server's 32 KiB.
    expect(JSON.stringify(fitContext(big)).length).toBeLessThanOrEqual(30_000)
    expect(fitContext(undefined)).toEqual({})
  })
})

describe('explain', () => {
  it('posts one gzip envelope with the report, the character and every name the page knows', async () => {
    const fetchMock = stub()
    const out = await explain({ kind: 'report', context: { a: 1 }, report: '{"sim":{}}', character: { name: 'Bob', server: 'Area 52', region: 'us' },
      profile: 'mage="Bob"\nwarlock="Mia"', build: '12.1.0.69933' })
    expect(out).toEqual({ text: 'ok', model: 'm', costUsd: 0.002, remaining: 2 })
    const [url, init] = fetchMock.mock.calls[0]
    expect([url, init.method, (init.headers as Record<string, string>)['content-type']]).toEqual(['/api/v1/ai/explain', 'POST', 'application/gzip'])
    expect(await inflate(init.body!)).toEqual({ kind: 'report', context: { a: 1 }, report: '{"sim":{}}', character: { name: 'Bob', realm: 'Area 52', region: 'us' },
      names: ['Bob', 'Mia'], build: '12.1.0.69933' })
  })

  it('omits the character and build when there are none, and sends a context of {} for a result without one', async () => {
    const fetchMock = stub()
    await explain({ kind: 'weights' })
    expect(await inflate(fetchMock.mock.calls[0][1].body!)).toEqual({ kind: 'weights', context: {}, names: [] })
  })

  it('sends a report that will not fit without it, and gives up when the rest is still too large', async () => {
    const fetchMock = stub()
    // Random text does not compress: 1.2 MB of it is over the 900 KB limit, gzipped.
    const noise = Array.from({ length: 1_200_000 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join('')
    await explain({ kind: 'report', report: noise })
    expect(await inflate(fetchMock.mock.calls[0][1].body!)).not.toHaveProperty('report')
    await expect(explain({ kind: 'error', context: { message: noise } })).rejects.toThrow('too large')
  })
})
