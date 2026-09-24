import { encodeBinary, decodeBinary, MAX_BINARY } from './report-codec'
import { pipe, toBase64Url, fromBase64Url } from './share'
import { parseAddonExport, GEAR_SLOTS, type ItemInstance } from '../import/character'
import { damageBreakdown, type DamageRow, type PlayerDetail, type BuffRow } from '../simc/detail'
import type { SimRequest } from '../simc/assemble'
import type { ConfidenceInterval, ReportLog, SimReport, Timeline } from '../simc/report'
import type { OptimizationResult } from '../optimization/types'
import { routeSummary } from '../dungeonRoute'

// Immutable public game vocabulary; old dictionaries must remain deployed.
export const DICTIONARY = '8c3d10f8870811f961211bda0cce4b3e'
export const LINK_LIMITS = { compact: 2000, detailed: 8000 } as const
type Damage = [number, string, string, number, number, number | null, number | null, Damage[]]
type Gear = [string, number, number[], number, number[], number[], number, number, number, number, number, number, Record<string, string>]
export interface SharedReport {
  v: 1; n: string; c: string; l: number; d: number; e: [number | null, number | null]
  t?: string; engine: [string, string | null]; game?: unknown
  o: [string, number, number, number, number, number]; elapsed: number
  talents: string; cons?: PlayerDetail['consumables']; raid?: Record<string, boolean>; w: ReportLog[]
  gear: Gear[]; damage?: Damage[]; buffs?: [number, string, number | null, number | null][]
  meta: { route?: { name: string; pulls: number }; className: string; kind: string; samples?: number; valid?: boolean; constant?: number[]; omitted?: string[]; damageCount: number; buffCount: number; inputWarnings: string[]; comparisons?: [string, number, number | null, number][]; weights?: [string, number][]; candidates?: [string, string, string[], boolean][] }
  extra?: { sequence?: [number, string, string | null][]; precombat?: [number, string, string | null][]; timeline?: Timeline; buffDetails?: [number | null, number | null][] }
}
const r1 = (n: number | undefined) => n === undefined ? null : Math.round(n * 10) / 10
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** The part of a SimOutcome reportSnapshot reads. Structural, so the account server can import this file without job.ts (import.meta.env, __ENGINE_COMPAT__). */
interface SnapshotSource {
  report: SimReport
  request: Pick<SimRequest, 'characterSnapshot' | 'profile' | 'extraProfileLines' | 'profilesets'>
  appElapsedSeconds: number
  engineNotices: ReportLog[]
  inputWarnings: string[]
  profilesetStatus: { missing: string[] }
}

export function reportSnapshot(outcome: SnapshotSource, detail: PlayerDetail): SharedReport {
  const report = outcome.report, p = report.players[0]
  if (!p || report.players.length !== 1) throw new Error('Share single-character reports individually. Use the report file for multi-actor simulations.')
  const character = outcome.request.characterSnapshot ?? parseAddonExport(outcome.request.profile)
  const row = (r: DamageRow): Damage => [r.itemId ? -r.itemId : r.id ?? 0, r.spellName ?? r.name, r.school ?? '', r.isPet ? 1 : 0, Math.round(r.totalAmount), r1(r.executeCount), r1(r.dpsWithChildren), (r.children ?? []).map(row)]
  // Signed IDs distinguish item media from spell media without another field.
  const rows = damageBreakdown(detail, p.dps.mean)
  const data: SharedReport = {
    v: 1, n: p.name, c: p.specialization, l: character.level ?? 0, d: p.dps.mean,
    e: [p.dpsConfidence?.margin ?? null, p.dpsConfidence?.level ?? null],
    engine: [report.engine.simcVersion, report.engine.gitRevision ?? null], game: report.gameData,
    o: [report.options.fightStyle, report.options.maxTime, report.options.desiredTargets, report.options.iterations, report.options.targetError, report.options.threads],
    elapsed: outcome.appElapsedSeconds, talents: character.talents ?? '', cons: detail.consumables, raid: detail.raidBuffs,
    w: [...report.logs, ...outcome.engineNotices].filter((v, i, a) => a.findIndex(x => x.kind === v.kind && x.message === v.message) === i),
    gear: character.equipped.map(i => [i.slot, i.itemId, i.bonusIds, i.enchantId ?? 0, i.gemIds, i.craftedStats ?? [], i.craftingQuality ?? 0, i.addonItemLevel ?? 0, i.redirectedBaseStats ?? 0, i.contentTuning ?? 0, i.itemLevel ?? 0, i.dropLevel ?? 0, i.extra]),
    damage: rows.map(row), buffs: detail.buffs.map(b => [b.id ?? 0, b.spellName ?? b.name, r1(b.uptimePct), r1(b.startCount)]),
    meta: { route: report.options.fightStyle === 'DungeonRoute' ? routeSummary([outcome.request.profile, ...(outcome.request.extraProfileLines ?? [])].join('\n').split('\n')) : undefined, className: character.className, kind: report.profilesets.length ? 'Comparison' : report.scaling?.calculateScaleFactors ? 'Stat Weights' : 'Quick Sim', samples: report.actualIterations,
      valid: p.validFightStyle, constant: detail.buffs.flatMap((b, i) => b.constant ? [i] : []), damageCount: rows.length, buffCount: detail.buffs.length, inputWarnings: outcome.inputWarnings,
      comparisons: report.profilesets.map(r => [r.name, r.mean, r.meanError ?? null, r.iterations]), weights: p.scaleFactors?.map(s => [s.stat, s.value]), candidates: outcome.request.profilesets?.map(p => [p.id, outcome.profilesetStatus.missing.includes(p.id) ? 'missing' : 'measured', p.lines, false]) },
    extra: { sequence: detail.sequence.map(s => [r1(s.time)!, s.spellName ?? s.action, s.target ?? null]), precombat: detail.precombat.map(s => [r1(s.time)!, s.spellName ?? s.action, s.target ?? null]),
      timeline: p.damageTimeline ? { ...p.damageTimeline, data: p.damageTimeline.data.map(v => Math.round(v)) } : undefined, buffDetails: detail.buffs.map(b => [r1(b.refreshCount), r1(b.benefitPct)]) },
  }
  if (!data.meta.comparisons?.length) delete data.meta.comparisons
  return clean(data)
}

export function searchSnapshot(snapshot: SharedReport, result: OptimizationResult, kind: string): SharedReport {
  if (!result.baseline) throw new Error('There is no measured baseline to share.')
  const s = clean(snapshot), b = result.baseline
  // Cached stages have different baseline than last batch; never attach that batch's breakdown to different measurement.
  if (s.d !== b.mean) { delete s.damage; delete s.buffs; delete s.extra; s.meta.damageCount = 0; s.meta.buffCount = 0 }
  s.d = b.mean; s.e = [b.margin, b.confidence]; s.meta.samples = b.iterations; s.meta.kind = kind
  s.meta.comparisons = result.candidates.flatMap(c => c.measurement ? [[c.candidate.provenance.label, c.measurement.mean, c.measurement.margin, c.measurement.iterations] as [string, number, number | null, number]] : [])
  s.meta.candidates = result.candidates.map(c => [c.candidate.provenance.label, c.status, c.candidate.lines, result.unresolvedTie.includes(c.candidate.id)])
  s.w.push(...result.warnings.map(message => ({ level: 'warning', kind: 'unverified' as const, message })), ...result.problems.map(message => ({ level: 'severe', kind: 'problem' as const, message })))
  if (result.incomplete) s.w.push({ level: 'warning', kind: 'unverified', message: `Partial search: ${result.incomplete.message}` })
  if (result.truncated) s.w.push({ level: 'warning', kind: 'unverified', message: `${result.droppedWhileAlive.length} candidates were removed by the search budget while still in contention.` })
  return s
}

const dictionaries = new Map<string, Promise<string[]>>()
async function digest(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)) }
async function dictionary(hash: string): Promise<string[]> {
  if (!/^[a-f0-9]{32}$/.test(hash)) throw new Error('Invalid dictionary version.')
  if (!dictionaries.has(hash)) dictionaries.set(hash, (async () => {
    const response = await fetch(`/share/${hash}.json`, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error('The game dictionary could not be loaded. Reconnect and try again.')
    const text = await response.text()
    if (text.length > 1024 * 1024) throw new Error('Invalid dictionary size.')
    const actual = Array.from((await digest(new TextEncoder().encode(text))).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
    if (actual !== hash) throw new Error('The game dictionary does not match this link.')
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value) || value.length > 50000 || !value.every(s => typeof s === 'string')) throw new Error('Invalid dictionary.')
    return value
  })().catch(e => { dictionaries.delete(hash); throw e }))
  return dictionaries.get(hash)!
}

export async function packReport(report: SharedReport, words: string[]): Promise<string> {
  validateReport(report)
  const binary = encodeBinary(report as unknown as Record<string, unknown>, words)
  if (binary.length > MAX_BINARY) throw new Error('This report needs a downloaded file.')
  const compressed = await pipe(binary, new CompressionStream('deflate-raw'), MAX_BINARY)
  const packet = new Uint8Array(21 + compressed.length)
  packet[0] = 1
  packet.set(Uint8Array.from(DICTIONARY.match(/../g)!, s => parseInt(s, 16)), 1)
  packet.set((await digest(binary)).slice(0, 4), 17)
  packet.set(compressed, 21)
  return toBase64Url(packet)
}

export async function decodeReport(payload: string, words?: string[]): Promise<SharedReport> {
  if (payload.length > LINK_LIMITS.detailed || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('This report link is incomplete or too large.')
  const packet = fromBase64Url(payload)
  if (packet.length < 22 || packet[0] !== 1) throw new Error('Unsupported report link version.')
  const hash = Array.from(packet.slice(1, 17), n => n.toString(16).padStart(2, '0')).join('')
  const dict = words ?? await dictionary(hash)
  const binary = await pipe(packet.slice(21), new DecompressionStream('deflate-raw'), MAX_BINARY)
  const checksum = await digest(binary)
  if (!packet.slice(17, 21).every((n, i) => n === checksum[i])) throw new Error('This report link is damaged or incomplete.')
  return validateReport(decodeBinary(binary, dict))
}

export async function createReportLink(snapshot: SharedReport, limit: number, base = location.origin + location.pathname): Promise<{ url: string; report: SharedReport }> {
  const words = await dictionary(DICTIONARY)
  const data = clean(snapshot)
  data.meta.omitted = ['Raw engine report and full simulation script']
  const attempt = async () => { try { const url = `${base}#/r/${await packReport(data, words)}`; return url.length <= limit ? { url, report: clean(data) } : null } catch (e) { if (e instanceof Error && e.message === 'This report needs a downloaded file.') return null; throw e } }
  let result = await attempt(); if (result) return result
  if (data.extra?.sequence?.length) { delete data.extra.sequence; delete data.extra.precombat; data.meta.omitted.push('Sample fight'); result = await attempt(); if (result) return result }
  if (data.extra?.timeline) { delete data.extra.timeline; data.meta.omitted.push('Damage timeline'); result = await attempt(); if (result) return result }
  if (data.extra) { delete data.extra; data.meta.omitted.push('Extended buff metrics'); result = await attempt(); if (result) return result }
  if (data.buffs?.length) { delete data.buffs; delete data.meta.constant; data.meta.omitted.push('Buff uptimes'); result = await attempt(); if (result) return result }
  if (data.damage?.some(r => r[7].length)) { data.damage = data.damage.map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], []]); data.meta.omitted.push('Expanded ability and pet detail'); result = await attempt(); if (result) return result }
  // Keep comparisons, warnings, gear, settings, DPS; never imply omitted candidate lost or buff disabled.
  if (data.damage?.length) {
    data.meta.omitted.push('Some damage contributors')
    let low = 0, high = data.damage.length, best: Awaited<ReturnType<typeof attempt>> = null
    const rows = data.damage
    while (low <= high) { const count = Math.floor((low + high) / 2); data.damage = rows.slice(0, count); const fit = await attempt(); if (fit) { best = fit; low = count + 1 } else high = count - 1 }
    if (best) return best
  }
  throw new Error('This report will not fit. Choose the detailed link or download the report file.')
}

export function sharedConfidence(s: SharedReport): ConfidenceInterval | undefined {
  return s.e[0] !== null && s.e[1] !== null ? { margin: s.e[0], level: s.e[1], relativePct: s.d ? s.e[0] / s.d * 100 : 0 } : undefined
}
export function sharedGear(s: SharedReport): ItemInstance[] {
  return s.gear.map((g, i) => ({ instanceId: `shared-${i}`, source: 'equipped', slot: g[0] as ItemInstance['slot'], itemId: g[1], bonusIds: g[2], enchantId: g[3] || undefined, gemIds: g[4], craftedStats: g[5], craftingQuality: g[6] || undefined, addonItemLevel: g[7] || undefined, redirectedBaseStats: g[8] || undefined, contentTuning: g[9] || undefined, itemLevel: g[10] || undefined, dropLevel: g[11] || undefined, extra: g[12], optionOrder: [], line: '', lineNumber: 0 }))
}
export function sharedDamage(s: SharedReport): DamageRow[] {
  const row = (r: Damage, key: string): DamageRow => ({ key, owner: s.n, name: r[1], id: r[0] > 0 ? r[0] : undefined, itemId: r[0] < 0 ? -r[0] : undefined, school: r[2], isPet: !!r[3], totalAmount: r[4], executeCount: r[5] ?? 0, dpsWithChildren: r[6] ?? 0, dps: 0, rateWhileActive: 0, portionPct: s.d ? (r[6] ?? 0) / s.d * 100 : undefined, children: r[7].map((c, i) => row(c, `${key}/${i}`)) })
  return (s.damage ?? []).map((r, i) => row(r, `shared/${i}`))
}
export function sharedBuffs(s: SharedReport): BuffRow[] { return (s.buffs ?? []).map((b, i) => ({ id: b[0] || undefined, name: b[1], constant: s.meta.constant?.includes(i) ?? false, uptimePct: b[2] ?? undefined, startCount: b[3] ?? undefined, refreshCount: s.extra?.buffDetails?.[i]?.[0] ?? undefined, benefitPct: s.extra?.buffDetails?.[i]?.[1] ?? undefined })) }
export function sharedDetail(s: SharedReport): PlayerDetail {
  const seq = (steps: [number, string, string | null][] = []) => steps.map(r => ({ time: r[0], action: r[1], target: r[2] ?? undefined, buffs: [] }))
  return { player: s.n, totalDps: s.d, abilityShare: 1, abilities: [], pets: [], buffs: sharedBuffs(s), sequence: seq(s.extra?.sequence), precombat: seq(s.extra?.precombat), consumables: s.cons, raidBuffs: s.raid }
}

// Validate every field reaching UI/media requests; no unchecked URL casts. Binary limits bound recursion/allocation.
export function validateReport(value: unknown): SharedReport {
  function check(ok: unknown): asserts ok { if (!ok) throw new Error('Invalid report link data.') }
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  const str = (v: unknown) => typeof v === 'string' && v.length <= 8192
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15
  const id = (v: unknown) => num(v) && Number.isSafeInteger(v) && (v as number) >= 0
  const optional = (v: unknown, fn: (v: unknown) => boolean) => v === undefined || v === null || fn(v)
  const list = (v: unknown, fn: (v: any) => boolean, max = 2000): boolean => Array.isArray(v) && v.length <= max && v.every(x => fn(x))
  check(obj(value)); const s = value
  check(s.v === 1 && str(s.n) && str(s.c) && id(s.l) && num(s.d) && s.d >= 0 && Array.isArray(s.e) && s.e.length === 2 && s.e.every((n: unknown) => n === null || num(n)))
  check((s.e[0] === null || s.e[0] >= 0) && (s.e[1] === null || s.e[1] > 0 && s.e[1] <= 1))
  check(Array.isArray(s.engine) && s.engine.length === 2 && str(s.engine[0]) && optional(s.engine[1], str))
  check(Array.isArray(s.o) && s.o.length === 6 && str(s.o[0]) && s.o.slice(1).every((n: unknown) => num(n) && (n as number) >= 0) && num(s.elapsed) && str(s.talents))
  check(optional(s.t, str) && list(s.w, w => obj(w) && str(w.message) && str(w.level) && ['note', 'problem', 'unverified', 'unknown'].includes(w.kind)))
  check(optional(s.cons, v => obj(v) && Object.entries(v).every(([k, x]) => k === 'potionUsed' ? typeof x === 'boolean' : ['potion', 'flask', 'food', 'augmentation', 'temporaryEnchant'].includes(k) && str(x))))
  check(optional(s.raid, v => obj(v) && Object.keys(v).length < 100 && Object.values(v).every(x => typeof x === 'boolean')))
  check(list(s.gear, g => Array.isArray(g) && g.length === 13 && (GEAR_SLOTS as readonly string[]).includes(g[0]) && id(g[1]) && list(g[2], id, 100) && id(g[3]) && list(g[4], id, 20) && list(g[5], id, 20) && g.slice(6, 12).every(id) && obj(g[12]) && Object.values(g[12]).every(str), 20))
  const damage = (r: any, depth = 0): boolean => depth < 24 && Array.isArray(r) && r.length === 8 && Number.isSafeInteger(r[0]) && num(r[0]) && str(r[1]) && str(r[2]) && [0, 1].includes(r[3]) && id(r[4]) && optional(r[5], num) && optional(r[6], num) && list(r[7], c => damage(c, depth + 1))
  check(optional(s.damage, v => list(v, damage)) && optional(s.buffs, v => list(v, b => Array.isArray(b) && b.length === 4 && id(b[0]) && str(b[1]) && optional(b[2], num) && optional(b[3], num))))
  check(obj(s.meta)); const m = s.meta
  check(optional(m.route, v => obj(v) && str(v.name) && id(v.pulls)))
  check(str(m.className) && str(m.kind) && id(m.damageCount) && id(m.buffCount) && list(m.inputWarnings, str) && optional(m.samples, id) && optional(m.valid, v => typeof v === 'boolean') && optional(m.constant, v => list(v, id)) && optional(m.omitted, v => list(v, str)))
  check(optional(m.comparisons, v => list(v, r => Array.isArray(r) && r.length === 4 && str(r[0]) && num(r[1]) && optional(r[2], num) && id(r[3]))) && optional(m.weights, v => list(v, r => Array.isArray(r) && r.length === 2 && str(r[0]) && num(r[1]))))
  check(optional(m.candidates, v => list(v, r => Array.isArray(r) && r.length === 4 && str(r[0]) && str(r[1]) && list(r[2], str, 100) && typeof r[3] === 'boolean')))
  if (s.extra !== undefined) {
    check(obj(s.extra)); const e = s.extra
    const seq = (v: unknown) => list(v, r => Array.isArray(r) && r.length === 3 && num(r[0]) && str(r[1]) && optional(r[2], str))
    check(optional(e.sequence, seq) && optional(e.precombat, seq) && optional(e.timeline, v => obj(v) && list(v.data, num, 10000) && num(v.mean) && num(v.min) && num(v.max) && optional(v.meanStdDev, num)) && optional(e.buffDetails, v => list(v, r => Array.isArray(r) && r.length === 2 && r.every((n: unknown) => optional(n, num)))))
  }
  return s as SharedReport
}
