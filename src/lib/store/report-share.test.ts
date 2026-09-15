import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeBinary, decodeBinary } from './report-codec'
import { createReportLink, decodeReport, DICTIONARY, packReport, sharedDamage, validateReport, type SharedReport } from './report-share'
import { pipe, fromBase64Url, toBase64Url } from './share'

const dictionaryText = readFileSync(`public/share/${DICTIONARY}.json`, 'utf8')
const words = JSON.parse(dictionaryText) as string[]
const sample: SharedReport = {
  v: 1, n: 'Tést', c: 'Demonology Warlock', l: 90, d: 12345.67890123, e: [12.345678, .95],
  engine: ['1210-01', 'c015720'], o: ['Patchwerk', 300, 1, 1000, .1, 4], elapsed: 3.4321, talents: 'ABC+',
  w: [{ level: 'severe', kind: 'problem', message: 'Keep this warning' }], gear: [['head', 123, [100, 91, 105], 7, [34], [32], 5, 300, 0, 0, 0, 0, { custom: 'x' }]],
  damage: [[-321, 'Pet', '', 1, 10000, 12.3, 333.3, [[456, 'Firebolt', 'fire', 0, 10000, 12.3, 333.3, []]]]],
  buffs: [[34, 'Mark', 100, 1]], raid: { bloodlust: true }, cons: { potion: 'test_potion', potionUsed: true },
  meta: { className: 'warlock', kind: 'Quick Sim', damageCount: 1, buffCount: 1, inputWarnings: [], constant: [0], samples: 996 },
  extra: { sequence: [[0, 'Test action', null]], timeline: { data: [1, 2, 4], mean: 2.3, min: 1, max: 4 }, buffDetails: [[null, 34.5]] },
}
afterEach(() => vi.unstubAllGlobals())
describe('self-contained report links', () => {
  it('opens the frozen version-one link independently of the current encoder', async () => {
    const report = await decodeReport(readFileSync('tests/fixtures/shared-report-v1.txt', 'utf8').trim(), words)
    expect(report.n).toBe('Testchar')
    expect(report.damage).toHaveLength(24)
    expect(report.d).toBe(182055.80404811498)
  })
  it('round trips every field, exact headline precision, negative media IDs and delta lists', async () => {
    const bytes = encodeBinary(sample as unknown as Record<string, unknown>, words)
    expect(decodeBinary(bytes, words)).toEqual(sample)
    const decoded = await decodeReport(await packReport(sample, words), words)
    expect(decoded).toEqual(sample)
    expect(sharedDamage(decoded)[0].dpsWithChildren).toBe(333.3)
    expect(sharedDamage(decoded)[0].children?.[0].dpsWithChildren).toBe(333.3)
    expect(sharedDamage(decoded)[0].itemId).toBe(321)
  })
  it('rejects corrupt, truncated, unsupported, oversized and invalid-schema packets', async () => {
    const token = await packReport(sample, words), bytes = fromBase64Url(token)
    bytes[17] ^= 1
    await expect(decodeReport(toBase64Url(bytes), words)).rejects.toThrow(/damaged/)
    for (const token of ['', 'a'.repeat(8001), '!bad', 'AAAA']) await expect(decodeReport(token, words)).rejects.toThrow()
    const binary = encodeBinary(sample as unknown as Record<string, unknown>, words)
    for (const end of [0, 1, binary.length - 1]) expect(() => decodeBinary(binary.slice(0, end), words)).toThrow()
    for (const change of [{ d: NaN }, { meta: null }, { gear: [['bad']] }, { cons: { flask: {} } }, { damage: [[1, {}, '', 0, 0, 0, 0, []]] }]) expect(() => validateReport({ ...sample, ...change })).toThrow()
  })
  it('bounds decompression before reading JSON or binary', async () => {
    const packed = await pipe(new Uint8Array(200000), new CompressionStream('deflate-raw'))
    await expect(pipe(packed, new DecompressionStream('deflate-raw'), 131072)).rejects.toThrow(/size limit/)
  })
  it('uses the complete URL budget and keeps warnings and metadata when dropping detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(dictionaryText)))
    const huge = structuredClone(sample)
    huge.extra!.sequence = Array.from({ length: 1500 }, (_, i) => [i / 10, `action_${i}_${Math.sin(i)}`, null])
    const result = await createReportLink(huge, 2000, 'https://example.invalid/')
    expect(result.url.length).toBeLessThanOrEqual(2000)
    expect(result.report.w).toEqual(sample.w)
    expect(result.report.gear).toEqual(sample.gear)
    expect(result.report.d).toBe(sample.d)
    expect(result.report.meta.omitted).toContain('Sample fight')
    expect(await decodeReport(result.url.split('#/r/')[1], words)).toEqual(result.report)
  })
})
