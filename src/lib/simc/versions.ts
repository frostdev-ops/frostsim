/** Built engine packs only; upstream refs not runnable. */
export interface EngineVersion {
  id: string
  label: string
  channel: 'stable' | 'beta' | 'alpha' | 'nightly' | 'prerelease' | 'bundled'
  baseUrl: string
}

export interface EngineVersions {
  schemaVersion: 1
  defaultId: string
  versions: EngineVersion[]
}

export const VERSION_KEY = 'frostsim.engineVersion'
export const BUNDLED_ENGINE: EngineVersion = {
  id: 'bundled', label: 'Bundled engine', channel: 'bundled', baseUrl: '/engine/',
}

export function validEngineBase(value: string): boolean {
  return value === '/engine/' || /^\/engine\/versions\/[a-z0-9][a-z0-9.-]{0,100}\/$/.test(value)
}

export function parseEngineVersions(value: unknown): EngineVersions {
  const data = value as EngineVersions
  if (data?.schemaVersion !== 1 || !Array.isArray(data.versions) || !data.versions.length
    || typeof data.defaultId !== 'string') throw new Error('Invalid engine version list')
  const ids = new Set<string>()
  for (const v of data.versions) {
    if (!v || typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(v.id)
      || typeof v.label !== 'string' || v.label.length > 160
      || !['stable', 'beta', 'alpha', 'nightly', 'prerelease', 'bundled'].includes(v.channel)
      || typeof v.baseUrl !== 'string' || !validEngineBase(v.baseUrl) || ids.has(v.id)) {
      throw new Error('Invalid engine version entry')
    }
    ids.add(v.id)
  }
  const preferred = data.versions.find(v => v.id === data.defaultId)
  if (!preferred || !['stable', 'nightly', 'bundled'].includes(preferred.channel)) throw new Error('Default engine must be validated stable, nightly or bundled')
  return data
}

let versions: Promise<EngineVersions> | undefined
export function loadEngineVersions(): Promise<EngineVersions> {
  return versions ??= (async () => {
    const response = await fetch('/engine-versions.json', { cache: 'no-cache' })
    if (response.status === 404) return { schemaVersion: 1, defaultId: 'bundled', versions: [BUNDLED_ENGINE] }
    if (!response.ok) throw new Error(`Engine versions unavailable (${response.status})`)
    return parseEngineVersions(await response.json())
  })()
}

export function enginePreference(): string {
  try { return localStorage.getItem(VERSION_KEY) || 'auto' } catch { return 'auto' }
}

// This tab keeps its engine and catalogs paired even if another tab changes localStorage.
const pagePreference = enginePreference()

export async function selectedEngine(): Promise<EngineVersion> {
  const list = await loadEngineVersions()
  const preference = pagePreference
  const id = preference === 'auto' ? list.defaultId : preference
  const version = list.versions.find(v => v.id === id)
  if (!version) throw new Error('The selected engine is unavailable. Choose another SimulationCraft version.')
  return version
}
