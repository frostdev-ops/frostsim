import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Encoder } from 'cbor-x'
import { importRouteExport, hasFirstPull } from './dungeonRoute'
import { decodeMdt, translateMdt, decodeAce, type MdtCatalog } from './mdt-route'
import { pipe, toBase64Url } from './store/share'
import { validateExtraProfileLines } from './simc/options'
const index = JSON.parse(readFileSync('public/routes/index.json', 'utf8'))
describe('route imports', () => {
  it('translates every supplied default without changing enemy health or dropping pulls', () => {
    expect(index.routes).toHaveLength(7)
    for (const entry of index.routes) {
      const text = readFileSync('public' + entry.path, 'utf8'), route = importRouteExport(text)
      expect(route.issues, entry.id).toEqual([])
      expect(route.pulls).toBe(entry.pulls)
      expect(hasFirstPull(route.lines.join('\n'))).toBe(true)
      expect(route.lines.map(l => Number(l.match(/,pull=(\d+)/)![1]))).toEqual(Array.from({ length: route.pulls }, (_, i) => i + 1))
      const health = (source: string) => [...source.matchAll(/:(\d+)(?=\||\r?$)/gm)].map(m => Number(m[1]))
      expect(health(route.lines.join('\n'))).toEqual(health(text))
      expect(validateExtraProfileLines(route.profileLines)).toEqual([])
      // SimC profileset initializer requires selected actor; generated enemy provides (clearing crashed).
      expect(route.profileLines).toContain('enemy=frostsim_route_target')
      expect(route.profileLines.some(line => /^active=(?:0|none)$/.test(line))).toBe(false)
    }
  })
  it('rejects non-route options and malformed pulls', () => {
    for (const text of ['input=secret.simc', 'raid_events+=/pull,enemies=bad', 'raid_events+=/pull,enemies=X:-1', 'fight_style=Patchwerk']) expect(importRouteExport(text).issues.length).toBeGreaterThan(0)
  })
  it('decodes current MDT CBOR exports and translates against real pinned enemy data', async () => {
    const catalog = JSON.parse(readFileSync('public/routes/mdt-catalog.json', 'utf8')) as MdtCatalog
    const dungeon = catalog.dungeons.find(d => d.name === 'Voidscar Arena')!
    const source = { text: 'Route check', value: { currentDungeonIdx: dungeon.index, pulls: [{ 1: [1, 2], bloodlust: true }] } }
    const asLua = (value: any): any => typeof value === 'string' ? new TextEncoder().encode(value) : Array.isArray(value) ? value.map(asLua) : value && typeof value === 'object' ? new Map(Object.entries(value).map(([k,v]) => [asLua(k), asLua(v)])) : value
    const raw = new Encoder({ useRecords: false, mapsAsObjects: false }).encode(asLua(source))
    const compressed = await pipe(raw, new CompressionStream('deflate'))
    const encoded = '!~MDT2~' + toBase64Url(compressed).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = await decodeMdt(encoded)
    const route = translateMdt(decoded, catalog, { keyLevel: 14, healthPercent: 20, delaySeconds: 10 })
    expect(route.issues).toEqual([])
    expect(route.enemies).toBe(2)
    expect(route.lines[0]).toContain('bloodlust=1')
    expect(route.lines[0]).toContain('delay=10')
    // A real MDT export is raw-deflate in padded standard base64, not the zlib/base64url shape above.
    const rawDeflated = '!~MDT2~' + btoa(String.fromCharCode(...await pipe(raw, new CompressionStream('deflate-raw'))))
    expect(translateMdt(await decodeMdt(rawDeflated), catalog, { keyLevel: 14, healthPercent: 20, delaySeconds: 10 }).enemies).toBe(2)
    expect(() => translateMdt({ value: { currentDungeonIdx: -1 } }, catalog, { keyLevel: 14, healthPercent: 20, delaySeconds: 10 })).toThrow(/mapping/)
    expect(decodeAce('^1^T^Svalue^T^ScurrentDungeonIdx^N163^t^t^^')).toEqual({ value: { currentDungeonIdx: 163 } })
    expect(() => decodeAce('^1^T^Svalue')).toThrow()
  })
})
