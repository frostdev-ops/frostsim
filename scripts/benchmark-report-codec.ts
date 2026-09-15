// Research harness; no app changes, uploads, or private report dictionary.
// npx esbuild scripts/benchmark-report-codec.ts --bundle --platform=node --format=esm --outfile=build/report-codec.mjs
// node build/report-codec.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
import { deflateRawSync, inflateRawSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { parseReport } from '../src/lib/simc/report'
import { parsePlayerDetail, damageBreakdown } from '../src/lib/simc/detail'
import { parseAddonExport, GEAR_SLOTS } from '../src/lib/import/character'
import { FIGHT_STYLES } from '../src/lib/simc/options'

const catalog = 'public/catalogs/12.1.0.69814-dca34b3038a3-c015720/'
const presentation = JSON.parse(readFileSync('public/presentation.json', 'utf8'))
const fields = ['v', 'n', 'c', 'l', 'd', 'e', 't', 'engine', 'game', 'o', 'elapsed', 'talents', 'cons', 'raid', 'w', 'gear', 'damage', 'buffs']
const vocabulary = new Set<string>([...fields, ...GEAR_SLOTS, ...FIGHT_STYLES, ...Object.keys(presentation.names)])
function collect(value: unknown): void {
  if (typeof value === 'string') { vocabulary.add(value); vocabulary.add(value.toLowerCase()); return }
  if (Array.isArray(value)) { value.forEach(collect); return }
  if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) { vocabulary.add(key); collect(v) }
}
// Public versioned game tables only; never train on measured reports.
collect(presentation.augmentation); collect(presentation.weapon)
for (const name of ['specs', 'consumables']) collect(JSON.parse(readFileSync(catalog + name + '.json', 'utf8')))
const dictionary = [...vocabulary].sort()
const dictionaryJson = JSON.stringify(dictionary)
const dictionaryHash = createHash('sha256').update(dictionaryJson).digest().subarray(0, 16)
const dictionaryIds = new Map(dictionary.map((v, i) => [v, i]))
const prefix = 'https://example.invalid/#/r/'
const zig = (n: number) => n < 0 ? -n * 2 - 1 : n * 2
const unzig = (n: number) => n % 2 ? -(n + 1) / 2 : n / 2
const width = (n: number) => n ? Math.floor(Math.log2(n) / 7) + 1 : 1

function encode(value: Record<string, unknown>, useDictionary: boolean): Buffer {
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
    const b = Buffer.from(v); uint(b.length); append(b)
  }
  const numbers = (values: number[]) => { uint(values.length); let prev = 0; for (const n of values) { uint(zig(n - prev)); prev = n } }
  const decimal = (v: number | null) => uint(v === null ? 0 : zig(Math.round(v * 10)) + 1)
  const damage = (rows: any[]) => {
    uint(rows.length)
    for (const [id, name, school, pet, amount, count, dps, children] of rows) {
      uint((id ? 1 : 0) + (pet ? 2 : 0) + (school ? 4 : 0))
      if (id) uint(id)
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
      uint(31); const b = Buffer.alloc(8); b.writeDoubleLE(v); append(b); return
    }
    if (typeof v === 'string') {
      const index = (useDictionary ? dictionaryIds.get(v) : undefined) ?? local.get(v)
      if (index !== undefined) { uint(index * 8 + 3); return }
      local.set(v, dictionary.length + local.size)
      if (/^[a-f0-9]{12,80}$/.test(v) && v.length % 2 === 0) { uint(39); uint(v.length / 2); append(Buffer.from(v, 'hex')); return }
      if (v.length > 60 && /^[A-Za-z0-9+/]+$/.test(v)) {
        const b = Buffer.from(v, 'base64')
        if (b.toString('base64').replace(/=+$/, '') === v) { uint(47); uint(b.length); append(b); return }
      }
      const b = Buffer.from(v); uint(b.length * 8 + 2); append(b); return
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
  return Buffer.from(bytes)
}

function decode(bytes: Buffer, useDictionary: boolean): Record<string, unknown> {
  assert(bytes.length <= 128 * 1024)
  let offset = 0, nodes = 0
  const local: string[] = []
  const take = (n: number) => { assert(n >= 0 && offset + n <= bytes.length); const b = bytes.subarray(offset, offset + n); offset += n; return b }
  const uint = () => { let value = 0, scale = 1; for (let i = 0; i < 8; i++) { const b = take(1)[0]; value += (b % 128) * scale; if (b < 128) { assert(Number.isSafeInteger(value)); return value }; scale *= 128 }; throw Error('Invalid integer') }
  const repeat = <T>(fn: () => T): T[] => { const n = uint(); assert(n < 100000); return Array.from({ length: n }, fn) }
  const text = () => {
    const ref = uint()
    if (!ref) { const value = new TextDecoder('utf-8', { fatal: true }).decode(take(uint())); local.push(value); return value }
    const index = ref - 1, value = index < dictionary.length ? (useDictionary ? dictionary[index] : undefined) : local[index - dictionary.length]
    assert(value !== undefined); return value
  }
  const numbers = () => { let prev = 0; return repeat(() => prev += unzig(uint())) }
  const decimal = () => { const n = uint(); return n ? unzig(n - 1) / 10 : null }
  const damage = (depth = 0): any[] => { assert(depth < 64); return repeat(() => { const flags = uint(); assert(flags < 8); const id = flags % 2 ? uint() : 0, name = text(), school = flags & 4 ? text() : '', pet = flags & 2 ? 1 : 0; return [id, name, school, pet, uint(), decimal(), decimal(), damage(depth + 1)] }) }
  function read(depth = 0): any {
    assert(depth < 64 && ++nodes < 100000)
    const head = uint(), kind = head % 8, n = Math.floor(head / 8)
    if (kind === 0) return n
    if (kind === 1) return -n
    if (kind === 2) { const text = new TextDecoder('utf-8', { fatal: true }).decode(take(n)); local.push(text); return text }
    if (kind === 3) { const text = n < dictionary.length ? (useDictionary ? dictionary[n] : undefined) : local[n - dictionary.length]; assert(text !== undefined); return text }
    if (kind === 4) { assert(n < 100000); return Array.from({ length: n }, () => read(depth + 1)) }
    if (kind === 5) { assert(n < 100000); const pairs = Array.from({ length: n }, () => { const key = read(depth + 1); assert(typeof key === 'string'); return [key, read(depth + 1)] }); return Object.fromEntries(pairs) }
    if (kind === 6) { assert(n >= 1 && n <= 3); return unzig(uint()) / 10 ** n }
    if (n < 3) return [null, false, true][n]
    if (n === 3) { const value = take(8).readDoubleLE(); assert(Number.isFinite(value)); return value }
    if (n === 4 || n === 5) { const b = take(uint()), text = n === 4 ? b.toString('hex') : b.toString('base64').replace(/=+$/, ''); local.push(text); return text }
    if (n === 6) { const len = uint(); assert(len < 100000); let prev = 0; return Array.from({ length: len }, () => prev += unzig(uint())) }
    throw Error('Invalid tag')
  }
  const mask = uint(); assert(mask < 2 ** fields.length)
  const field = (key: string): unknown => {
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
  assert.equal(offset, bytes.length)
  return result
}

const r1 = (n: number | undefined) => n === undefined ? null : Math.round(n * 10) / 10
function snapshots(path: string) {
  const raw = JSON.parse(readFileSync(path, 'utf8')), report = parseReport(raw), actor = raw.sim.players[0], p = report.players[0]
  const detail = parsePlayerDetail(raw, p.name), rows = damageBreakdown(detail, p.dps.mean)
  const entries = Object.entries(actor.gear) as [string, any][]
  const char = parseAddonExport(`warlock=${actor.name}\nlevel=${actor.level}\ntalents=${actor.talents}\n` + entries.map(([s, g]) => `${s}=${g.encoded_item}`).join('\n'))
  const core = { v: 1, n: p.name, c: p.specialization, l: actor.level, d: p.dps.mean, e: [p.dpsConfidence?.margin, p.dpsConfidence?.level], t: raw.timestamp,
    engine: [report.engine.simcVersion, report.engine.gitRevision], game: report.gameData,
    o: [report.options.fightStyle, report.options.maxTime, report.options.desiredTargets, report.options.iterations, report.options.targetError, report.options.threads], elapsed: report.timings?.engineElapsedSeconds,
    talents: actor.talents, cons: detail.consumables, raid: detail.raidBuffs, w: report.logs,
    gear: char.equipped.map((i, n) => [i.slot, i.itemId, i.bonusIds, i.enchantId ?? 0, i.gemIds ?? [], i.craftedStats ?? [], i.craftingQuality ?? 0, entries[n][1].ilevel, i.redirectedBaseStats ?? 0, i.contentTuning ?? 0, i.itemLevel ?? 0, i.dropLevel ?? 0, i.extra]) }
  const row = (r: any, children: boolean): any => [r.id ?? 0, r.name, r.school ?? '', r.isPet ? 1 : 0, Math.round(r.totalAmount), r1(r.executeCount), r1(r.dpsWithChildren), children ? (r.children ?? []).map((c: any) => row(c, true)) : []]
  return { core, top10: { ...core, damage: rows.slice(0, 10).map(r => row(r, false)) }, allTopLevel: { ...core, damage: rows.map(r => row(r, false)) }, expandedDamage: { ...core, damage: rows.map(r => row(r, true)) }, expandedAndBuffs: { ...core, damage: rows.map(r => row(r, true)), buffs: detail.buffs.map(b => [b.id ?? 0, b.name, r1(b.uptimePct), r1(b.startCount)]) } }
}

const output: unknown[] = []
function openPacket(packet: Buffer): Record<string, unknown> {
  assert(packet.length >= 7 && packet.length <= 128 * 1024 && packet[0] === 1 && packet[1] <= 1 && packet[2] <= 2)
  const dict = packet[1] === 1, offset = dict ? 19 : 3
  if (dict) assert(packet.subarray(3, 19).equals(dictionaryHash))
  const packed = packet.subarray(offset + 4)
  const binary = packet[2] === 1 ? inflateRawSync(packed, { maxOutputLength: 128 * 1024 }) : packet[2] === 2 ? brotliDecompressSync(packed, { maxOutputLength: 128 * 1024 }) : packed
  assert(createHash('sha256').update(binary).digest().subarray(0, 4).equals(packet.subarray(offset, offset + 4)))
  return decode(binary, dict)
}
for (const path of process.argv.slice(2).length ? process.argv.slice(2) : ['build/damage-attribution-check.json', 'build/weekly-potion-check.json']) {
  for (const [name, snapshot] of Object.entries(snapshots(path))) {
    const value = JSON.parse(JSON.stringify(snapshot)), json = Buffer.from(JSON.stringify(value))
    const result: any = { file: path, name, originalUrl: prefix.length + deflateRawSync(json).toString('base64url').length }
    for (const dict of [false, true]) {
      const binary = encode(value, dict)
      assert.deepEqual(decode(binary, dict), value)
      for (const compression of ['none', 'deflate', 'brotli']) {
        const packed = compression === 'deflate' ? deflateRawSync(binary) : compression === 'brotli' ? brotliCompressSync(binary, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : binary
        // Format/compression flags, vocabulary hash, integrity check.
        const header = Buffer.concat([Buffer.from([1, dict ? 1 : 0, ['none', 'deflate', 'brotli'].indexOf(compression)]), dict ? dictionaryHash : Buffer.alloc(0), createHash('sha256').update(binary).digest().subarray(0, 4)])
        const decoded = compression === 'deflate' ? inflateRawSync(packed, { maxOutputLength: 128 * 1024 }) : compression === 'brotli' ? brotliDecompressSync(packed, { maxOutputLength: 128 * 1024 }) : packed
        assert.deepEqual(decode(decoded, dict), value)
        const packet = Buffer.concat([header, packed])
        assert.deepEqual(openPacket(Buffer.from(packet.toString('base64url'), 'base64url')), value)
        const damaged = Buffer.from(packet); damaged[header.length - 1] ^= 1
        assert.throws(() => openPacket(damaged))
        result[`${dict ? 'dictionary' : 'binary'}_${compression}`] = prefix.length + packet.toString('base64url').length
        if (dict && compression === 'brotli' && name === 'expandedAndBuffs' && path.endsWith('damage-attribution-check.json')) writeFileSync('build/report-codec-expanded.bin', packet)
      }
      for (const cut of [0, 1, Math.floor(binary.length / 2), binary.length - 1]) assert.throws(() => decode(binary.subarray(0, cut), dict))
    }
    output.push(result); console.log(JSON.stringify(result))
  }
}
console.log(JSON.stringify({ dictionaryStrings: dictionary.length, dictionaryBytes: Buffer.byteLength(dictionaryJson), dictionaryGzipEquivalent: deflateRawSync(dictionaryJson).length, roundTrips: 'passed', truncationChecks: 'passed' }))
writeFileSync('build/report-codec-results.json', JSON.stringify(output, null, 2))
