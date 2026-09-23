/** Published engine packs (scripts/update-engines.mjs). The app always runs the newest pack built for its own compat. */
export interface EnginePack {
  id: string
  baseUrl: string
  /** App <-> pack contract (scripts/engine-compat.mjs). */
  compat: string
  upstreamCommit: string
  commitDate: string
  publishedAt: string
  ciUrl?: string | null
  simcVersion?: string
  clientDataVersion?: string
}

export interface EngineStatus {
  checkedAt: string
  upstreamHead: string | null
  upstreamDate?: string | null
  upstreamCiUrl: string | null
  state: 'current' | 'building' | 'blocked' | 'failed'
  reason: string | null
  issueUrl?: string | null
}

export interface EngineIndex {
  schemaVersion: 2
  packs: EnginePack[]
  status: EngineStatus | null
}

export const ENGINE_COMPAT: string = __ENGINE_COMPAT__

/** `npm run dev` without a published index: the engine built into public/engine/. */
const LOCAL_ENGINE: EnginePack = { id: 'local', baseUrl: '/engine/', compat: ENGINE_COMPAT, upstreamCommit: '', commitDate: '', publishedAt: '' }

// Manual version selection is gone; nobody stays pinned to an old engine.
try { localStorage.removeItem('frostsim.engineVersion') } catch { /* no storage */ }

export function validEngineBase(value: string): boolean {
  return value === '/engine/' || /^\/engine\/versions\/[a-z0-9][a-z0-9.-]{0,100}\/$/.test(value)
}

const STATES = ['current', 'building', 'blocked', 'failed']
const text = (v: unknown, max = 400) => typeof v === 'string' && v.length <= max

export function parseEngineIndex(value: unknown): EngineIndex {
  const data = value as EngineIndex
  if (data?.schemaVersion !== 2 || !Array.isArray(data.packs)) throw new Error('Invalid engine index')
  const ids = new Set<string>()
  for (const p of data.packs) {
    if (!p || !text(p.id, 101) || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(p.id) || ids.has(p.id)
      || !text(p.baseUrl) || !validEngineBase(p.baseUrl) || !text(p.compat, 64)
      || !/^[a-f0-9]{40}$/.test(p.upstreamCommit) || !text(p.commitDate, 40) || !text(p.publishedAt, 40)) {
      throw new Error('Invalid engine pack entry')
    }
    ids.add(p.id)
  }
  const s = data.status
  if (s != null && (!STATES.includes(s.state) || !text(s.checkedAt, 40))) throw new Error('Invalid engine status')
  return data
}

const newestFirst = (a: EnginePack, b: EnginePack) =>
  b.commitDate.localeCompare(a.commitDate) || b.publishedAt.localeCompare(a.publishedAt)

/** Newest pack this app can run. */
export function pickEngine(index: EngineIndex, compat = ENGINE_COMPAT): EnginePack | undefined {
  return [...index.packs].sort(newestFirst).find(p => p.compat === compat)
}

export async function fetchEngineIndex(): Promise<EngineIndex> {
  const response = await fetch('/engine-versions.json', { cache: 'no-cache' })
  if (response.status === 404 && import.meta.env.DEV) return { schemaVersion: 2, packs: [LOCAL_ENGINE], status: null }
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

export async function selectedEngine(): Promise<EnginePack> {
  const pack = pickEngine(await loadEngineIndex())
  if (!pack) throw new EngineUnavailable('The SimulationCraft engine for this version of Frostsim is still being built. Reload in a few minutes.')
  return pack
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
  const behind = status.upstreamHead && status.upstreamHead !== running.upstreamCommit && status.upstreamDate
    && Date.parse(status.upstreamDate) - Date.parse(running.commitDate) > 12 * HOUR
  if (status.state === 'building') return { level: 'info', message: 'A newer SimulationCraft engine is being built.' }
  if (behind) return { level: 'info', message: 'A newer SimulationCraft engine is on its way.' }
  return { level: 'ok', message: null }
}
