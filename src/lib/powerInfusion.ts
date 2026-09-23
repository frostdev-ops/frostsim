// Power Infusion value per spec from precomputed upstream-profile data (CLAUDE.md D13). Gains and margins only; no sims here.
import { damageBreakdown, parsePlayerDetail, type DamageRow } from './simc/detail'

/** [mean, standard error of the mean], as simc reports them. */
export type Pair = [mean: number, sd: number]
export interface PiVariant { dps: Pair; prio: Pair }
export interface PiRun {
  targets: number
  /** No PI. For funnel specs, funnel toggle off. */
  base: PiVariant
  pi: PiVariant
  /** Funnel toggle on, without and with PI. Only above one target. */
  funnel?: PiVariant
  funnelPi?: PiVariant
}
export interface PiSpec {
  name: string
  profile: string
  /** 'cooldown': the APL has no PI line, so PI was applied at fixed times from pull. */
  piTiming: 'apl' | 'cooldown'
  /** Actor option that switches the APL to priority-target play, if the spec has one. */
  funnel: string | null
  runs: PiRun[]
  /** Independent runs combined by scripts/merge_power_infusion.py; absent for a single run. */
  sources?: number
}
export interface PiData {
  schemaVersion: 1
  engine: { commit: string; simcVersion: string; wowVersion: string }
  profiles: string
  fightStyle: string
  targetError: number
  generatedAt: string
  specs: PiSpec[]
}

/** PI's gain on one measure, with its 95% margin. */
export interface PiGain {
  gain: number
  /** Percent of the no-PI value. */
  pct: number
  margin: number
  marginPct: number
  /** Gain inside its own margin. */
  noise: boolean
}

export interface PiRow {
  id: string
  /** PiSpec.name this row belongs to. */
  spec: string
  label: string
  /** Damage to every target. */
  total: PiGain
  /** Damage to the main target only. */
  main: PiGain
  /** Share of PI's extra damage that lands on the main target. Absent when the total gain is noise. */
  toMain?: number
  /** With PI: main-target damage at this target count as a fraction of single-target. Absent at one target. */
  kept?: number
  spread?: Spread
  cooldown: boolean
  funnel: boolean
}

/**
 * How the rotation treats the main target once more targets exist, read from the sim, not the APL:
 * 'holds' cleaves while the main target keeps its single-target damage (a natural funnel),
 * 'spreads' moves damage off it. Display bands only; the measured fraction is always shown with them.
 */
export type Spread = 'holds' | 'slight' | 'spreads'
export const HOLDS = 0.95
export const SPREADS = 0.85

export function spreadOf(kept: number): Spread {
  return kept >= HOLDS ? 'holds' : kept >= SPREADS ? 'slight' : 'spreads'
}

function gainOf(base: Pair, pi: Pair): PiGain {
  const gain = pi[0] - base[0]
  // Separate runs are independent, so standard errors add in quadrature.
  const margin = 1.96 * Math.hypot(base[1], pi[1])
  return { gain, pct: (gain / base[0]) * 100, margin, marginPct: (margin / base[0]) * 100, noise: Math.abs(gain) < margin }
}

function row(
  id: string, label: string, base: PiVariant, pi: PiVariant, cooldown: boolean, funnel: boolean, single?: number,
): PiRow {
  const total = gainOf(base.dps, pi.dps)
  const main = gainOf(base.prio, pi.prio)
  const kept = single === undefined ? undefined : pi.prio[0] / single
  return {
    id, spec: id.split('/')[0], label, total, main, cooldown, funnel,
    ...(total.noise ? {} : { toMain: main.gain / total.gain }),
    ...(kept === undefined ? {} : { kept, spread: spreadOf(kept) }),
  }
}

/**
 * Every spec at one target count: PI's gain on all targets and on the main target, and the share
 * funneled into the main target. Specs with a funnel option get a second row with it on.
 */
export type PiRank = 'total' | 'main' | 'toMain'

export function piRows(data: PiData, targets: number, rank: PiRank, units: 'dps' | 'pct'): PiRow[] {
  const rows = data.specs.flatMap((s) => {
    const r = s.runs.find((x) => x.targets === targets)
    if (!r) return []
    // Reference for 'kept': the main target with PI, alone.
    const single = targets > 1 ? s.runs.find((x) => x.targets === 1)?.pi.prio[0] : undefined
    const cooldown = s.piTiming === 'cooldown'
    const { funnel, funnelPi } = r
    if (!funnel || !funnelPi) return [row(s.name, s.name, r.base, r.pi, cooldown, false, single)]
    // The baseline row has the option off, stated so it is not read as the default.
    return [
      row(s.name, `${s.name} (funnel option off)`, r.base, r.pi, cooldown, false, single),
      row(`${s.name}/funnel`, `${s.name} (funnel option on)`, funnel, funnelPi, cooldown, true, single),
    ]
  })
  const key = units === 'dps' ? 'gain' : 'pct'
  // No share (noise) sorts last.
  const by = (r: PiRow) => rank === 'toMain' ? r.toMain ?? -Infinity : r[rank][key]
  return rows.sort((a, b) => by(b) - by(a))
}

/** One row of the main-target grid: a spec (and its funnel-on row), main-target DPS with PI by target count. */
export interface MainTargetRow {
  id: string
  label: string
  funnel: boolean
  /** Main-target DPS with PI at one target. */
  single: number
  /** 2 to 10 targets: main-target DPS with PI, and that as a fraction of single target. */
  cells: { targets: number; dps: number; kept: number }[]
}

/**
 * How extra targets change the damage the main target takes, with Power Infusion: above 1, the
 * rotation's cleave feeds its single-target damage; below 1, damage moves to the other targets.
 * Same reference as PiRow.kept (the single-target run with PI), and the same row ids and labels.
 */
export function mainTargetGrid(data: PiData): MainTargetRow[] {
  return data.specs.flatMap((s) => {
    const single = s.runs.find((r) => r.targets === 1)?.pi.prio[0]
    if (!single) return []
    const grid = (variant: 'pi' | 'funnelPi') => s.runs.flatMap((r) => {
      const v = r[variant]
      return r.targets > 1 && v ? [{ targets: r.targets, dps: v.prio[0], kept: v.prio[0] / single }] : []
    })
    if (!s.funnel) return [{ id: s.name, label: s.name, funnel: false, single, cells: grid('pi') }]
    return [
      { id: s.name, label: `${s.name} (funnel option off)`, funnel: false, single, cells: grid('pi') },
      { id: `${s.name}/funnel`, label: `${s.name} (funnel option on)`, funnel: true, single, cells: grid('funnelPi') },
    ]
  })
}

/** One variant's report, trimmed by scripts/generate_power_infusion.py to what detail.ts reads. */
export interface PiReportPlayer {
  name: string
  buffs: { name: string; start_count?: number; uptime?: number; interval?: number; duration?: number; stack_uptime: { data: number[] } }[]
  collected_data: { timeline_dmg: { data: number[] } }
  [key: string]: unknown
}
export interface PiDetailRun {
  targets: number
  base: PiReportPlayer
  pi: PiReportPlayer
  funnel?: PiReportPlayer
  funnelPi?: PiReportPlayer
}
export interface PiDetailFile { profile: string; runs: PiDetailRun[] }

// One lazy chunk per spec (~70 KB gzip), fetched on first open; hashed, so browsers cache it for good.
const DETAILS = import.meta.glob<PiDetailFile>('./catalog/generated/pi-detail/*.json', { import: 'default' })
const loaded = new Map<string, Promise<PiDetailFile>>()

export function loadPiDetail(profile: string): Promise<PiDetailFile> {
  const load = DETAILS[`./catalog/generated/pi-detail/pi-detail-${profile}.json`]
  if (!load) return Promise.reject(new Error(`No detail data for ${profile}. Regenerate with npm run data:power-infusion.`))
  if (!loaded.has(profile)) loaded.set(profile, load().catch((e) => { loaded.delete(profile); throw e }))
  return loaded.get(profile)!
}

export interface PiSecond {
  t: number
  without: number
  with: number
  gain: number
  /** Share of runs with Power Infusion up at this second, 0-1. */
  piUp: number
}
export interface PiAbility {
  key: string
  label: string
  pet: boolean
  id?: number
  without: number
  with: number
  gain: number
  /** A pet's abilities, or an ability's secondary hits (dots, cleaves): already inside the parent's numbers. */
  children?: PiAbility[]
}
export interface PiDetailView {
  timeline: PiSecond[]
  /** Seconds with the buff up in at least half the runs, as [start, end] pairs. */
  piWindows: [number, number][]
  lustWindows: [number, number][]
  /** Mean casts per fight, and the share of the fight PI was up (percent). */
  pi?: { casts: number; uptimePct: number }
  /** Damage sources, character and pets, from the app's own breakdown; DPS over the fight. */
  abilities: PiAbility[]
}

function windows(up: number[] | undefined): [number, number][] {
  const out: [number, number][] = []
  up?.forEach((v, t) => {
    if (v < 0.5) return
    const last = out.at(-1)
    if (last && last[1] === t) last[1] = t + 1
    else out.push([t, t + 1])
  })
  return out
}

const buff = (p: PiReportPlayer, name: string) => p.buffs.find((b) => b.name === name)

interface Source { label: string; pet: boolean; id?: number; dps: number; children: Map<string, Source> }

function tree(rows: DamageRow[], pet: boolean): Map<string, Source> {
  return new Map(rows.map((r) => [r.name, {
    label: r.spellName ?? r.name, pet, id: r.id, dps: r.dpsWithChildren, children: tree(r.children ?? [], false),
  }]))
}

function sources(p: PiReportPlayer): Map<string, Source> {
  const rows = damageBreakdown(parsePlayerDetail({ sim: { players: [p] } }, p.name))
  return new Map(rows.map((r) => [`${r.isPet ? 'pet' : 'own'}:${r.name}`, {
    label: r.spellName ?? r.name, pet: !!r.isPet, id: r.id, dps: r.dpsWithChildren, children: tree(r.children ?? [], false),
  }]))
}

/** Same sources in the no-PI and PI reports, side by side, down to each pet ability. */
function pair(before: Map<string, Source>, after: Map<string, Source>, prefix = ''): PiAbility[] {
  return [...new Set([...before.keys(), ...after.keys()])].map((name) => {
    const b = before.get(name)
    const a = after.get(name)
    const x = (a ?? b)!
    const without = b?.dps ?? 0
    const withPi = a?.dps ?? 0
    const children = pair(b?.children ?? new Map(), a?.children ?? new Map(), `${prefix}${name}/`)
    return {
      key: `${prefix}${name}`, label: x.label, pet: x.pet, id: x.id, without, with: withPi, gain: withPi - without,
      ...(children.length ? { children } : {}),
    }
  }).sort((l, r) => r.with - l.with)
}

/** The drawer's data for one row: the no-PI and PI reports of the same variant (funnel on or off). */
export function piDetailView(run: PiDetailRun, funnel: boolean): PiDetailView {
  const base = funnel ? run.funnel : run.base
  const pi = funnel ? run.funnelPi : run.pi
  if (!base || !pi) throw new Error(`No ${funnel ? 'funnel ' : ''}detail at ${run.targets} targets`)
  const a = base.collected_data.timeline_dmg.data
  const b = pi.collected_data.timeline_dmg.data
  const up = buff(pi, 'power_infusion')
  const piUp = up?.stack_uptime.data ?? []
  const timeline = Array.from({ length: Math.min(a.length, b.length) }, (_, t) => ({
    t, without: a[t], with: b[t], gain: b[t] - a[t], piUp: piUp[t] ?? 0,
  }))
  const abilities = pair(sources(base), sources(pi))
  return {
    timeline,
    piWindows: windows(piUp),
    lustWindows: windows(buff(pi, 'bloodlust')?.stack_uptime.data),
    ...(up?.start_count === undefined ? {} : { pi: { casts: up.start_count, uptimePct: up.uptime ?? 0 } }),
    abilities,
  }
}
