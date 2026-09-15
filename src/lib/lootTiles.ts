// Loot sources grouped into tiles the Droptimizer shows. Catalog lists per-encounter (run unit), picker needs per-instance (user unit). Pure grouping.
import type { LootSource } from './catalog/types'

export interface InstanceTile {
  key: string
  kind: LootSource['kind']
  name: string
  instanceId?: number
  /** Journal media id when the instance has art; encounters never do. */
  mediaId?: number
  bosses: LootSource[]
  itemCount: number
}

export const KIND_LABELS: Record<LootSource['kind'], string> = {
  raid: 'Raids', dungeon: 'Dungeons', delve: 'Delves', pvp: 'PvP',
  profession: 'Professions', vault: 'Great Vault', other: 'Other',
}

/** One tile per instance; a source with no instance is a tile of its own. */
export function groupInstances(sources: LootSource[]): Map<string, InstanceTile> {
  const m = new Map<string, InstanceTile>()
  for (const s of sources) {
    const key = s.instanceId !== undefined ? `i:${s.instanceId}` : `s:${s.id}`
    const tile = m.get(key) ?? {
      key, kind: s.kind, name: s.instanceName ?? s.name, instanceId: s.instanceId,
      mediaId: s.mediaId, bosses: [], itemCount: 0,
    }
    tile.bosses.push(s)
    tile.itemCount += s.itemIds.length
    tile.mediaId ??= s.mediaId
    m.set(key, tile)
  }
  return m
}

// Tiles by kind, filtered by query on instance/boss names. Newest instance first by journal id. Kinds with more tiles first.
export function tilesByKind(
  tiles: Iterable<InstanceTile>, query = '',
): [LootSource['kind'], InstanceTile[]][] {
  const q = query.trim().toLowerCase()
  const m = new Map<LootSource['kind'], InstanceTile[]>()
  for (const tile of tiles) {
    if (q && !tile.name.toLowerCase().includes(q)
      && !tile.bosses.some((b) => b.name.toLowerCase().includes(q))) continue
    m.set(tile.kind, [...(m.get(tile.kind) ?? []), tile])
  }
  for (const list of m.values()) list.sort((a, b) => (b.instanceId ?? 0) - (a.instanceId ?? 0))
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
}
