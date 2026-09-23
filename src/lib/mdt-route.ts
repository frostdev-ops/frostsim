import { pipe, fromBase64Url } from './store/share'
import { importRouteExport, type ImportedRoute } from './dungeonRoute'
export interface MdtOptions { keyLevel: number; healthPercent: number; delaySeconds: number }
interface Enemy { name: string; health: number; npcId: number; boss: boolean; ignoreFortified: boolean; clones: number[] }
interface Dungeon { index: number; name: string; enemies: Record<number, Enemy> }
export interface MdtCatalog { version: number; commit: string; dungeons: Dungeon[] }
const LIMIT = 256 * 1024

export function decodeAce(text: string): unknown {
  // Stripping the whole C0 range plus space is deliberate: a pasted MDT string carries line
  // breaks and stray control characters from the clipboard, and AceSerializer never encodes
  // one as payload, so none of them can be significant here.
  // oxlint-disable-next-line no-control-regex
  const tokens = [...text.replace(/[\x00-\x20]/g, '').matchAll(/\^([^])([^^]*)/g)];
  if (tokens.length > 30000 || tokens[0]?.[1] !== '1') throw Error('Invalid legacy MDT serialization.')
  let at = 1
  const read = (depth = 0): unknown => {
    if (depth > 32) throw Error('MDT data is too deeply nested.')
    const token = tokens[at++]; if (!token) throw Error('Truncated MDT data.')
    const [, type, data] = token
    if (type === 'S') return data.replace(/~(.)/g, (_, char: string) => { const code = char.charCodeAt(0); if (code < 122) return String.fromCharCode(code - 64); if (code <= 125) return String.fromCharCode([30,127,126,94][code - 122]); throw Error('Invalid MDT string escape.') })
    if (type === 'N' || type === 'F') { let n = Number(data); if (type === 'F') { const exponent = tokens[at++]; if (exponent?.[1] !== 'f') throw Error('Invalid MDT number.'); n *= 2 ** Number(exponent[2]) } if (!Number.isFinite(n)) throw Error('Invalid MDT number.'); return n }
    if (type === 'B') return true
    if (type === 'b') return false
    if (type === 'Z') return null
    if (type === 'T') {
      const entries: [string, unknown][] = []
      while (tokens[at]?.[1] !== 't') { if (entries.length > 10000) throw Error('MDT table is too large.'); const k = read(depth + 1); if (!['string','number'].includes(typeof k)) throw Error('Invalid MDT key.'); entries.push([String(k), read(depth + 1)]) }
      at++; return Object.fromEntries(entries)
    }
    throw Error('Unsupported MDT data.')
  }
  const value = read()
  if (tokens[at]?.[1] !== '^') throw Error('Incomplete MDT export.')
  return value
}

export async function decodeMdt(text: string): Promise<unknown> {
  text = text.trim().replace(/\s/g, '')
  if (text.length > LIMIT) throw Error('MDT export exceeds the 256 KB limit.')
  if (text.startsWith('!~MDT2~')) {
    let raw: Uint8Array
    // Truncated exports are the common failure (chat clients wrap the string), and the
    // decompressor's own message says nothing useful to the person who pasted it.
    try {
      const bytes = fromBase64Url(text.slice(7))
      try { raw = await pipe(bytes, new DecompressionStream('deflate-raw'), LIMIT) }
      catch { raw = await pipe(bytes, new DecompressionStream('deflate'), LIMIT) }
    } catch { throw Error('This MDT string is incomplete or damaged. Copy the whole export from MDT.') }
    const { Decoder, setSizeLimits } = await import('cbor-x')
    setSizeLimits({ maxArraySize: 10000, maxMapSize: 10000, maxObjectSize: 10000 })
    // WoW serializes Lua strings as CBOR byte strings (including keys). Decode to Maps, then normalize.
    let nodes = 0
    const normalize = (value: unknown, depth = 0): unknown => {
      if (depth > 32 || ++nodes > 30000) throw Error('MDT export is too complex.')
      if (value instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: true }).decode(value)
      if (value instanceof Map) return Object.fromEntries([...value].map(([key, v]) => { const k = normalize(key, depth + 1); if (!['number', 'string'].includes(typeof k)) throw Error('Invalid MDT key.'); return [String(k), normalize(v, depth + 1)] }))
      if (Array.isArray(value)) return value.map(v => normalize(v, depth + 1))
      if (value !== null && typeof value === 'object' || typeof value === 'bigint') throw Error('Unsupported MDT value.')
      return value
    }
    return normalize(new Decoder({ mapsAsObjects: false, useRecords: false }).decode(raw))
  }
  if (!text.startsWith('!')) throw Error('Paste an MDT export or its SimulationCraft export. Older pre-Deflate strings must be re-exported from MDT.')
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()'
  let bits = 0, value = 0
  const bytes: number[] = []
  for (const char of text.slice(1)) { const n = alphabet.indexOf(char); if (n < 0) throw Error('Invalid MDT export character.'); value += n * 2 ** bits; bits += 6; while (bits >= 8) { bytes.push(value & 255); value >>>= 8; bits -= 8 } }
  const raw = await pipe(new Uint8Array(bytes), new DecompressionStream('deflate-raw'), LIMIT)
  return decodeAce(new TextDecoder('utf-8', { fatal: true }).decode(raw))
}

const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || v instanceof Map || v instanceof Uint8Array) throw Error('Invalid MDT route structure.'); return v as Record<string, unknown> }
const values = (v: unknown) => Object.entries(record(v)).filter(([k]) => /^\d+$/.test(k)).sort((a,b) => Number(a[0]) - Number(b[0])).map(([,v]) => v)

export function translateMdt(value: unknown, catalog: MdtCatalog, options: MdtOptions): ImportedRoute {
  if (!Number.isInteger(options.keyLevel) || options.keyLevel < 2 || options.keyLevel > 40 || !(options.healthPercent > 0 && options.healthPercent <= 100) || !(options.delaySeconds >= 0 && options.delaySeconds <= 600)) throw Error('Check the MDT key level, health share and pull delay.')
  const root = record(value), data = record(root.value)
  const dungeon = catalog.dungeons.find(d => d.index === Number(data.currentDungeonIdx))
  if (!dungeon) throw Error('This MDT dungeon is not in the bundled Midnight mapping. Use its SimulationCraft export instead.')
  const pulls = values(data.pulls)
  if (!pulls.length || pulls.length > 200) throw Error('MDT routes must contain 1–200 pulls.')
  const lines = [`fight_style=DungeonRoute`, `enemy=${JSON.stringify(typeof root.text === 'string' ? root.text.slice(0, 200) : dungeon.name)}`, `keystone_level=${options.keyLevel}`, 'override.bloodlust=0', 'single_actor_batch=1', 'raid_events=/invulnerable,cooldown=5160,duration=5160,retarget=1']
  for (const raw of pulls) {
    const pull = record(raw), enemies: string[] = []
    for (const [key, clones] of Object.entries(pull).filter(([k]) => /^\d+$/.test(k))) {
      const enemy = dungeon.enemies[Number(key)]
      if (!enemy) throw Error(`MDT enemy ${key} does not match the bundled dungeon data.`)
      // MDT's CalculateEnemyHealth at catalog commit; health pre-adjusted for player share (SimC format).
      const affix = options.keyLevel >= 10 ? enemy.boss ? 1.25 : enemy.ignoreFortified ? 1 : 1.2 : 1
      const multiplier = Math.round(affix * 1.07 ** Math.min(options.keyLevel - 1, 9) * 1.1 ** Math.max(0, options.keyLevel - 10) * 100) / 100
      const health = Math.max(1, Math.round(Math.round(enemy.health * multiplier) * options.healthPercent / 100))
      for (const clone of values(clones)) {
        if (!Number.isInteger(clone) || !enemy.clones.includes(clone as number)) throw Error(`An MDT enemy location no longer matches the dungeon mapping. Re-export the route.`)
        const name = enemy.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_$/, '')
        enemies.push(`${enemy.boss ? 'BOSS_' : ''}${name}_${clone}:${health}`)
      }
    }
    if (!enemies.length) continue
    if (enemies.length > 500) throw Error('An MDT pull contains too many enemies.')
    const number = lines.filter(l => l.startsWith('raid_events+=/pull')).length + 1
    const delay = typeof pull.delay === 'number' && pull.delay >= 0 && pull.delay <= 600 ? pull.delay : options.delaySeconds
    lines.push(`raid_events+=/pull,pull=${number},bloodlust=${pull.bloodlust === true ? 1 : 0},delay=${delay},enemies=${enemies.join('|')}`)
  }
  const result = importRouteExport(lines.join('\n'))
  result.warnings.push(`MDT ${catalog.commit.slice(0, 7)} · ${options.healthPercent}% enemy health · ${options.delaySeconds}s default travel between pulls.`)
  return result
}
