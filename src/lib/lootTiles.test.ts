import { describe, expect, it } from 'vitest'
import type { LootSource } from './catalog/types'
import { groupInstances, tilesByKind } from './lootTiles'

const src = (over: Partial<LootSource> & Pick<LootSource, 'id' | 'name'>): LootSource => ({
  kind: 'dungeon', itemIds: [1, 2], provider: 'test', ...over,
})

const sources: LootSource[] = [
  src({ id: 'b1', name: 'Boss One', instanceId: 64, instanceName: 'Old Keep', mediaId: 64, itemIds: [1, 2, 3] }),
  src({ id: 'b2', name: 'Boss Two', instanceId: 64, instanceName: 'Old Keep', mediaId: 64 }),
  src({ id: 'b3', name: 'New Boss', instanceId: 1322, instanceName: 'New Vault', mediaId: 1322 }),
  src({ id: 'r1', name: 'Raid Boss', kind: 'raid', instanceId: 1300, instanceName: 'Big Raid' }),
  src({ id: 'p1', name: 'Tailoring', kind: 'profession' }),
]

describe('groupInstances', () => {
  it('makes one tile per instance and carries the bosses and item count', () => {
    const tiles = groupInstances(sources)
    const keep = tiles.get('i:64')!
    expect(keep.name).toBe('Old Keep')
    expect(keep.bosses.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(keep.itemCount).toBe(5)
    expect(keep.mediaId).toBe(64)
  })

  it('gives a source without an instance its own tile, with no art', () => {
    const tile = groupInstances(sources).get('s:p1')!
    expect(tile.name).toBe('Tailoring')
    expect(tile.mediaId).toBeUndefined()
    expect(tile.bosses).toHaveLength(1)
  })

  it('takes art from any boss of the instance that carries it', () => {
    const tiles = groupInstances([
      src({ id: 'a', name: 'A', instanceId: 9, instanceName: 'X' }),
      src({ id: 'b', name: 'B', instanceId: 9, instanceName: 'X', mediaId: 9 }),
    ])
    expect(tiles.get('i:9')!.mediaId).toBe(9)
  })
})

describe('tilesByKind', () => {
  it('orders kinds by tile count and instances newest first', () => {
    const grouped = tilesByKind(groupInstances(sources).values())
    expect(grouped.map(([kind]) => kind)).toEqual(['dungeon', 'raid', 'profession'])
    expect(grouped[0][1].map((t) => t.name)).toEqual(['New Vault', 'Old Keep'])
  })

  it('filters on instance name or boss name, case-insensitively', () => {
    const byBoss = tilesByKind(groupInstances(sources).values(), 'boss two')
    expect(byBoss.flatMap(([, t]) => t.map((x) => x.name))).toEqual(['Old Keep'])
    const byInstance = tilesByKind(groupInstances(sources).values(), 'BIG')
    expect(byInstance.flatMap(([, t]) => t.map((x) => x.name))).toEqual(['Big Raid'])
  })
})
