// V1 wire format: keep field and slot order stable for existing links.
import { GEAR_SLOTS } from '../import/character'
import { fromBase64Url, toBase64Url } from './share'
export const MAX_BINARY = 128 * 1024
const fields = ['v', 'n', 'c', 'l', 'd', 'e', 't', 'engine', 'game', 'o', 'elapsed', 'talents', 'cons', 'raid', 'w', 'gear', 'damage', 'buffs', 'meta', 'extra']
const metaFields = ['className', 'kind', 'samples', 'valid', 'constant', 'omitted', 'damageCount', 'buffCount', 'inputWarnings', 'comparisons', 'weights', 'candidates', 'route']
const omissions = ['Raw engine report and full simulation script', 'Sample fight', 'Damage timeline', 'Extended buff metrics', 'Buff uptimes', 'Expanded ability and pet detail', 'Some damage contributors']
const kinds = ['Quick Sim', 'Comparison', 'Stat Weights', 'Top Gear', 'Droptimizer']
const encoder = new TextEncoder()
function assert(value: unknown): asserts value { if (!value) throw new Error('Invalid shared report data.') }
const float = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true)
const zig = (n: number) => n < 0 ? -n * 2 - 1 : n * 2
const unzig = (n: number) => n % 2 ? -(n + 1) / 2 : n / 2
const width = (n: number) => n ? Math.floor(Math.log2(n) / 7) + 1 : 1

export function encodeBinary(value: Record<string, unknown>, dictionary: string[]): Uint8Array {
  const useDictionary = true
  const dictionaryIds = new Map(dictionary.map((v, i) => [v, i]))
  const bytes: number[] = []
  const local = new Map<string, number>()
  const uint = (n: number) => {
    assert(Number.isSafeInteger(n) && n >= 0)
    do { const b = n % 128; n = Math.floor(n / 128); bytes.push(b + (n ? 128 : 0)) } while (n)
  }
  const append = (b: Uint8Array) => { for (const v of b) bytes.push(v) }
  const text = (v: string) => {
    const index = (useDictionary ? dictionaryIds.get(v) : undefined) ?? local.get(v)
    if (index !== undefined) { uint(index + 1); return }
    uint(0); local.set(v, dictionary.length + local.size)
    const b = encoder.encode(v); uint(b.length); append(b)
  }
  const numbers = (values: number[]) => { uint(values.length); let prev = 0; for (const n of values) { uint(zig(n - prev)); prev = n } }
  const decimal = (v: number | null) => uint(v === null ? 0 : zig(Math.round(v * 10)) + 1)
  const damage = (rows: any[]) => {
    uint(rows.length)
    for (const [id, name, school, pet, amount, count, dps, children] of rows) {
      uint((id ? 1 : 0) + (pet ? 2 : 0) + (school ? 4 : 0))
      if (id) uint(zig(id))
      text(name); if (school) text(school)
      uint(amount); decimal(count); decimal(dps); damage(children)
    }
  }
  function write(v: any): void {
    if (v === null) { uint(7); return }
    if (typeof v === 'boolean') { uint(v ? 23 : 15); return }
    if (typeof v === 'number') {
      assert(Number.isFinite(v))
      if (Number.isSafeInteger(v) && Math.abs(v) < 2 ** 48) { uint(Math.abs(v) * 8 + (v < 0 ? 1 : 0)); return }
      for (let scale = 1; scale <= 3; scale++) {
        const n = Math.round(v * 10 ** scale)
        if (Math.abs(n) < 2 ** 48 && n / 10 ** scale === v) { uint(scale * 8 + 6); uint(zig(n)); return }
      }
      uint(31); const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); append(b); return
    }
    if (typeof v === 'string') {
      const index = (useDictionary ? dictionaryIds.get(v) : undefined) ?? local.get(v)
      if (index !== undefined) { uint(index * 8 + 3); return }
      local.set(v, dictionary.length + local.size)
      if (/^[a-f0-9]{12,80}$/.test(v) && v.length % 2 === 0) { uint(39); uint(v.length / 2); append(Uint8Array.from(v.match(/../g)!, s => parseInt(s, 16))); return }
      if (v.length > 60 && /^[A-Za-z0-9+/]+$/.test(v)) {
        const b = fromBase64Url(v)
        if (toBase64Url(b).replace(/-/g, '+').replace(/_/g, '/') === v) { uint(47); uint(b.length); append(b); return }
      }
      const b = encoder.encode(v); uint(b.length * 8 + 2); append(b); return
    }
    if (Array.isArray(v)) {
      if (v.length > 1 && v.every(n => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 48)) {
        const deltas = v.map((n, i) => zig(n - (v[i - 1] ?? 0)))
        if (1 + width(v.length) + deltas.reduce((s, n) => s + width(n), 0) < width(v.length * 8 + 4) + v.reduce((s, n) => s + width(n * 8), 0)) {
          uint(55); uint(v.length); deltas.forEach(uint); return
        }
      }
      uint(v.length * 8 + 4); v.forEach(write); return
    }
    const entries = Object.entries(v); uint(entries.length * 8 + 5)
    for (const [key, value] of entries) { write(key); write(value) }
  }
  let mask = 0
  fields.forEach((key, i) => { if (Object.hasOwn(value, key)) mask += 2 ** i })
  assert(Object.keys(value).every(k => fields.includes(k)))
  uint(mask)
  for (const key of fields) if (Object.hasOwn(value, key)) {
    if (key === 'meta') {
      const meta = value[key] as Record<string, unknown>
      assert(Object.keys(meta).every(k => metaFields.includes(k)))
      uint(metaFields.reduce((m, k, i) => m + (Object.hasOwn(meta, k) ? 2 ** i : 0), 0))
      for (const k of metaFields) if (Object.hasOwn(meta, k)) {
        if (k === 'omitted') write((meta[k] as string[]).map(s => { const i = omissions.indexOf(s); assert(i >= 0); return i }))
        else if (k === 'kind') write(kinds.includes(meta[k] as string) ? kinds.indexOf(meta[k] as string) : meta[k])
        else write(meta[k])
      }
      continue
    }
    if (key === 'damage') { damage(value[key] as any[]); continue }
    if (key === 'buffs') {
      const buffs = value[key] as any[]; uint(buffs.length)
      for (const [id, name, uptime, starts] of buffs) { uint(id); text(name); decimal(uptime); decimal(starts) }
      continue
    }
    if (key === 'gear') {
      const gear = value[key] as any[]; uint(gear.length)
      for (const item of gear) {
        uint(GEAR_SLOTS.indexOf(item[0])); uint(item[1]); numbers(item[2])
        let flags = 0
        for (let i = 3; i < 13; i++) if (Array.isArray(item[i]) ? item[i].length : typeof item[i] === 'object' ? Object.keys(item[i]).length : item[i]) flags += 2 ** (i - 3)
        uint(flags)
        for (let i = 3; i < 13; i++) if (Math.floor(flags / 2 ** (i - 3)) % 2) {
          if (i === 4 || i === 5) numbers(item[i])
          else if (i === 12) write(item[i])
          else uint(item[i])
        }
      }
      continue
    }
    write(value[key])
  }
  return new Uint8Array(bytes)
}

export function decodeBinary(bytes: Uint8Array, dictionary: string[]): Record<string, unknown> {
  const useDictionary = true
  assert(bytes.length <= MAX_BINARY)
  let offset = 0, nodes = 0
  const local: string[] = []
  const take = (n: number) => { assert(n >= 0 && offset + n <= bytes.length); const b = bytes.subarray(offset, offset + n); offset += n; return b }
  const uint = () => { let value = 0, scale = 1; for (let i = 0; i < 8; i++) { const b = take(1)[0]; value += (b % 128) * scale; if (b < 128) { assert(Number.isSafeInteger(value)); return value }; scale *= 128 }; throw Error('Invalid integer') }
  const repeat = <T>(fn: () => T): T[] => { const n = uint(); nodes += n; assert(n <= bytes.length && nodes < 20000); return Array.from({ length: n }, fn) }
  const text = () => {
    const ref = uint()
    if (!ref) { const value = new TextDecoder('utf-8', { fatal: true }).decode(take(uint())); local.push(value); return value }
    const index = ref - 1, value = index < dictionary.length ? (useDictionary ? dictionary[index] : undefined) : local[index - dictionary.length]
    assert(value !== undefined); return value
  }
  const numbers = () => { let prev = 0; return repeat(() => prev += unzig(uint())) }
  const decimal = () => { const n = uint(); return n ? unzig(n - 1) / 10 : null }
  const damage = (depth = 0): any[] => { assert(depth < 24); return repeat(() => { const flags = uint(); assert(flags < 8); const id = flags % 2 ? unzig(uint()) : 0, name = text(), school = flags & 4 ? text() : '', pet = flags & 2 ? 1 : 0; return [id, name, school, pet, uint(), decimal(), decimal(), damage(depth + 1)] }) }
  function read(depth = 0): any {
    assert(depth < 24 && ++nodes < 20000)
    const head = uint(), kind = head % 8, n = Math.floor(head / 8)
    if (kind === 0) return n
    if (kind === 1) return -n
    if (kind === 2) { const text = new TextDecoder('utf-8', { fatal: true }).decode(take(n)); local.push(text); return text }
    if (kind === 3) { const text = n < dictionary.length ? (useDictionary ? dictionary[n] : undefined) : local[n - dictionary.length]; assert(text !== undefined); return text }
    if (kind === 4) { assert(n <= bytes.length && n < 20000); return Array.from({ length: n }, () => read(depth + 1)) }
    if (kind === 5) { assert(n <= bytes.length && n < 20000); const pairs = Array.from({ length: n }, () => { const key = read(depth + 1); assert(typeof key === 'string'); return [key, read(depth + 1)] }); return Object.fromEntries(pairs) }
    if (kind === 6) { assert(n >= 1 && n <= 3); return unzig(uint()) / 10 ** n }
    if (n < 3) return [null, false, true][n]
    if (n === 3) { const value = float(take(8)); assert(Number.isFinite(value)); return value }
    if (n === 4 || n === 5) { const b = take(uint()), text = n === 4 ? Array.from(b, n => n.toString(16).padStart(2, '0')).join('') : toBase64Url(b).replace(/-/g, '+').replace(/_/g, '/'); local.push(text); return text }
    if (n === 6) { const len = uint(); assert(len <= bytes.length && len < 20000); let prev = 0; return Array.from({ length: len }, () => prev += unzig(uint())) }
    throw Error('Invalid tag')
  }
  const mask = uint(); assert(mask < 2 ** fields.length)
  const field = (key: string): unknown => {
    if (key === 'meta') {
      const mask = uint(); assert(mask < 2 ** metaFields.length)
      return Object.fromEntries(metaFields.flatMap((k, i) => {
        if (!(Math.floor(mask / 2 ** i) % 2)) return []
        const v = read()
        if (k === 'kind' && typeof v === 'number') { assert(Number.isInteger(v) && v >= 0 && v < kinds.length); return [[k, kinds[v]]] }
        if (k === 'omitted') { assert(Array.isArray(v) && v.every(n => Number.isInteger(n) && n >= 0 && n < omissions.length)); return [[k, v.map(n => omissions[n])]] }
        return [[k, v]]
      }))
    }
    if (key === 'damage') return damage()
    if (key === 'buffs') return repeat(() => [uint(), text(), decimal(), decimal()])
    if (key === 'gear') return repeat(() => {
      const slot = uint(); assert(slot < GEAR_SLOTS.length)
      const item: any[] = [GEAR_SLOTS[slot], uint(), numbers(), 0, [], [], 0, 0, 0, 0, 0, 0, {}]
      const flags = uint(); assert(flags < 1024)
      for (let i = 3; i < 13; i++) if (Math.floor(flags / 2 ** (i - 3)) % 2) item[i] = i === 4 || i === 5 ? numbers() : i === 12 ? read() : uint()
      return item
    })
    return read()
  }
  const result = Object.fromEntries(fields.flatMap((key, i) => Math.floor(mask / 2 ** i) % 2 ? [[key, field(key)]] : []))
  assert(offset === bytes.length)
  return result
}
