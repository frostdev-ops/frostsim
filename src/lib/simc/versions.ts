/** Published engine packs. A tab runs the newest compatible pack in its frozen channel. */
import { ENGINE_CHANNEL_KEY, engineChannelLabel, isEngineChannel, resolveEngineChannel, type EngineChannel } from './channel'
/** What changed in a pack, written by the updater from the upstream commits (scripts/update-engines.mjs releaseNotes). Plain text. */
export interface EngineNotes {
  /** One line, only when players would notice the change. */
  banner: string | null
  changelog: string[]
}

export interface EnginePack {
  id: string
  /** Absent only in the legacy Live-only registry. */
  engineChannel?: EngineChannel
  baseUrl: string
  /** App <-> pack contract (scripts/engine-compat.mjs). */
  compat: string
  upstreamCommit: string
  commitDate: string
  publishedAt: string
  ciUrl?: string | null
  simcVersion?: string
  clientDataVersion?: string
  notes?: EngineNotes
}

export interface EngineStatus {
  checkedAt: string
  upstreamHead: string | null
  upstreamDate?: string | null
  upstreamCiUrl: string | null
  state: 'current' | 'building' | 'blocked' | 'failed'
  reason: string | null
  issueUrl?: string | null
  /** The newest upstream commit changes nothing the binary or the data are built from, so no pack follows it. */
  noRebuild?: boolean
}

export interface EngineIndex {
  schemaVersion: 2 | 3
  packs: EnginePack[]
  status: EngineStatus | null
  statusByChannel?: Record<EngineChannel, EngineStatus | null>
}

export const ENGINE_COMPAT: string = __ENGINE_COMPAT__

/** `npm run dev` without a published index: the engine built into public/engine/. */
const localEngine = (channel: EngineChannel): EnginePack => ({ id: channel === 'live' ? 'local' : 'local-ptr', engineChannel: channel, baseUrl: channel === 'live' ? '/engine/' : '/engine/ptr/', compat: ENGINE_COMPAT, upstreamCommit: '', commitDate: '', publishedAt: '' })

// Manual version selection is gone; nobody stays pinned to an old engine.
try { localStorage.removeItem('frostsim.engineVersion') } catch { /* no storage */ }

// Read once: storage events in another tab cannot change this tab's data or running jobs.
export const activeEngineChannel: EngineChannel = (() => {
  let preference: string | null = null
  try { preference = localStorage.getItem(ENGINE_CHANNEL_KEY) } catch { /* no storage */ }
  const explicit = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('engine')
  return resolveEngineChannel(explicit, preference)
})()

export function rememberEngineChannel(channel: EngineChannel): void {
  try { localStorage.setItem(ENGINE_CHANNEL_KEY, channel) } catch { /* reload URL retains the choice */ }
}

export function validEngineBase(value: string): boolean {
  return value === '/engine/' || value === '/engine/ptr/' || /^\/engine\/versions\/[a-z0-9][a-z0-9.-]{0,100}\/$/.test(value)
}

const STATES = ['current', 'building', 'blocked', 'failed']
const text = (v: unknown, max = 400) => typeof v === 'string' && v.length <= max

/** Notes are decoration: a malformed block is dropped, never an invalid index. */
function cleanNotes(v: unknown): EngineNotes | undefined {
  const n = v as EngineNotes | null
  if (!n || !(n.banner === null || text(n.banner, 200)) || !Array.isArray(n.changelog) || n.changelog.length > 6 || !n.changelog.every(l => text(l, 160))) return undefined
  return { banner: n.banner, changelog: n.changelog }
}

export function parseEngineIndex(value: unknown): EngineIndex {
  const data = value as EngineIndex
  if (![2, 3].includes(data?.schemaVersion) || !Array.isArray(data.packs)) throw new Error('Invalid engine index')
  const ids = new Set<string>()
  for (const p of data.packs) {
    if (!p || !text(p.id, 101) || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(p.id) || ids.has(p.id)
      || !text(p.baseUrl) || !validEngineBase(p.baseUrl) || !text(p.compat, 64)
      || !/^[a-f0-9]{40}$/.test(p.upstreamCommit) || !text(p.commitDate, 40) || !text(p.publishedAt, 40)
      || (data.schemaVersion === 3 ? !isEngineChannel(p.engineChannel) : p.engineChannel != null && p.engineChannel !== 'live')) {
      throw new Error('Invalid engine pack entry')
    }
    ids.add(p.id)
    if (p.notes !== undefined) p.notes = cleanNotes(p.notes)
  }
  const s = data.status
  if (s != null && (!STATES.includes(s.state) || !text(s.checkedAt, 40))) throw new Error('Invalid engine status')
  if (data.schemaVersion === 3) {
    if (!data.statusByChannel || !['live', 'ptr'].every(c => Object.hasOwn(data.statusByChannel!, c))) throw new Error('Invalid channel status')
    for (const channel of ['live', 'ptr'] as const) {
      const status = data.statusByChannel[channel]
      if (status !== null && (!status || !STATES.includes(status.state) || !text(status.checkedAt, 40))) throw new Error('Invalid channel status')
    }
  }
  return data
}

const newestFirst = (a: EnginePack, b: EnginePack) =>
  b.commitDate.localeCompare(a.commitDate) || b.publishedAt.localeCompare(a.publishedAt)

/** Newest pack this app can run. */
export function pickEngine(index: EngineIndex, compat = ENGINE_COMPAT, channel: EngineChannel = activeEngineChannel): EnginePack | undefined {
  return [...index.packs].sort(newestFirst).find(p => p.compat === compat && (p.engineChannel ?? 'live') === channel)
}

export function statusForChannel(index: EngineIndex, channel: EngineChannel = activeEngineChannel): EngineStatus | null {
  return index.schemaVersion === 3 ? index.statusByChannel?.[channel] ?? null : channel === 'live' ? index.status : null
}

export async function fetchEngineIndex(): Promise<EngineIndex> {
  let response = await fetch('/engine-channels.json', { cache: 'no-cache' })
  if (response.status === 404) response = await fetch('/engine-versions.json', { cache: 'no-cache' })
  if (response.status === 404 && import.meta.env.DEV) return { schemaVersion: 3, packs: [localEngine(activeEngineChannel)], status: null, statusByChannel: { live: null, ptr: null } }
  if (!response.ok) throw new Error(`Engine index unavailable (${response.status})`)
  return parseEngineIndex(await response.json())
}

// Fixed for the page lifetime: engine, catalog and talent layouts stay paired. Updates arrive by reload.
let pageIndex: Promise<EngineIndex> | undefined
export function loadEngineIndex(): Promise<EngineIndex> {
  return pageIndex ??= fetchEngineIndex().catch(err => { pageIndex = undefined; throw err })
}

/** No published pack matches this app yet: normal for a few minutes after a deploy. */
export class EngineUnavailable extends Error {}

export async function selectedEngine(channel: EngineChannel = activeEngineChannel): Promise<EnginePack> {
  const pack = pickEngine(await loadEngineIndex(), ENGINE_COMPAT, channel)
  if (!pack) throw new EngineUnavailable(`The ${engineChannelLabel(channel)} SimulationCraft engine for this version of Frostsim is unavailable or still being built. ${channel === 'ptr' ? 'Switch to Live to run a Live simulation.' : 'Reload in a few minutes.'}`)
  return { ...pack, engineChannel: pack.engineChannel ?? 'live' }
}

export interface EngineHealth {
  level: 'ok' | 'info' | 'warn'
  message: string | null
}

const HOUR = 3600_000

/** Plain-language state of the running engine against upstream and the updater. */
export function engineHealth(running: EnginePack, status: EngineStatus | null, now = Date.now()): EngineHealth {
  if (!status) return { level: 'ok', message: null }
  if (status.state === 'blocked') return { level: 'warn', message: 'SimulationCraft changed in a way this version of Frostsim cannot use yet. You are on the newest compatible engine until Frostsim is updated.' }
  if (status.state === 'failed') return { level: 'warn', message: 'The newest SimulationCraft build did not pass validation. You are on the previous engine.' }
  if (now - Date.parse(status.checkedAt) > 12 * HOUR) return { level: 'warn', message: `Engine update checks have not run since ${new Date(status.checkedAt).toLocaleString()}.` }
  const behind = !status.noRebuild && status.upstreamHead && status.upstreamHead !== running.upstreamCommit && status.upstreamDate
    && Date.parse(status.upstreamDate) - Date.parse(running.commitDate) > 12 * HOUR
  if (status.state === 'building') return { level: 'info', message: 'A newer SimulationCraft engine is being built.' }
  if (behind) return { level: 'info', message: 'A newer SimulationCraft engine is on its way.' }
  return { level: 'ok', message: null }
}
