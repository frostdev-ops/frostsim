// Character portraits, opt-in per character, over catalog track's proxy; leaves browser: region/realm/character name only; proxy returns own byte URLs (COEP, CSP).
import { characterMediaPath, type CharacterMedia, type Region } from './battlenet/contract'
import { media } from './media.svelte'
import { fetchCharacterMedia } from './media-cache'

export type PortraitState =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; media: CharacterMedia }
  | { status: 'failed'; reason: string }

const KEY = 'frostsim.portraits'
const REGIONS: Region[] = ['us', 'eu', 'kr', 'tw']

function readOptIns(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

export interface PortraitLookup { realm: string; name: string }
const LOOKUP_KEY = 'frostsim.portrait-lookup'

function readLookups(): Record<string, PortraitLookup> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOKUP_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, PortraitLookup>) : {}
  } catch {
    return {}
  }
}

export const portraits = $state({
  /** Character id -> the user turned the portrait on. Persisted; off by default. */
  optIn: readOptIns(),
  /**
   * Character id -> a realm and name the user typed in place of the export's.
   * A sanitised or renamed export still belongs to someone; they say who.
   */
  lookup: readLookups(),
  /** Bumped when a lookup settles, so readers re-run. Never during a read. */
  version: 0,
})

/** Lookup key -> state; plain Map deliberately since portraitFor read in derived expressions (Svelte 5 state_unsafe_mutation). */
const cache = new Map<string, PortraitState>()

export function portraitOptedIn(characterId: string): boolean {
  // User turned portrait on; off by default.
  return portraits.optIn[characterId] !== false
}

export function setPortraitOptIn(characterId: string, on: boolean): void {
  portraits.optIn = { ...portraits.optIn, [characterId]: on }
  try {
    localStorage.setItem(KEY, JSON.stringify(portraits.optIn))
  } catch {
    // Storage disabled: choice lasts for this page load.
  }
}

export function portraitLookup(characterId: string): PortraitLookup | null {
  return portraits.lookup[characterId] ?? null
}

export function setPortraitLookup(characterId: string, lookup: PortraitLookup | null): void {
  const next = { ...portraits.lookup }
  if (lookup && lookup.realm.trim() && lookup.name.trim()) {
    next[characterId] = { realm: lookup.realm.trim(), name: lookup.name.trim() }
  } else {
    delete next[characterId]
  }
  portraits.lookup = next
  try {
    localStorage.setItem(LOOKUP_KEY, JSON.stringify(next))
  } catch {
    // Storage disabled: choice lasts for this page load.
  }
}

/** The exact identity a lookup sends, so the UI can print it verbatim. */
export function portraitIdentity(
  region: string | undefined, realm: string | undefined, name: string,
): { region: Region; realm: string; name: string } | null {
  const r = (region ?? '').toLowerCase() as Region
  if (!REGIONS.includes(r) || !realm || !name) return null
  // Addon writes parenthetical region after realm; proxy takes realm alone and resolves slug.
  return { region: r, realm: realm.replace(/\s*\(.*\)\s*$/, ''), name }
}

/** Current state for one character, fetching on first use when opted in; reads are reactive. */
export function portraitFor(
  characterId: string, region: string | undefined, realm: string | undefined, name: string,
): PortraitState {
  if (!portraitOptedIn(characterId) || media.configured !== true) return { status: 'off' }
  const override = portraits.lookup[characterId]
  const id = portraitIdentity(region, override?.realm ?? realm, override?.name ?? name)
  if (!id) return { status: 'failed', reason: 'This export names no region or realm to look up.' }
  void portraits.version
  const key = `${id.region}/${id.realm}/${id.name}`.toLowerCase()
  const hit = cache.get(key)
  if (hit && !(hit.status === 'ready' && Date.parse(hit.media.expiresAt) < Date.now())) return hit
  const loading: PortraitState = { status: 'loading' }
  cache.set(key, loading)
  void load(key, id)
  return loading
}

async function load(key: string, id: { region: Region; realm: string; name: string }): Promise<void> {
  try {
    const res = await fetchCharacterMedia(characterMediaPath(id.region, id.realm, id.name))
    if (!res.ok) throw new Error(`the portrait service answered ${res.status}`)
    const body = (await res.json()) as CharacterMedia
    if (typeof body?.status !== 'string' || typeof body?.expiresAt !== 'string') {
      throw new Error('the portrait service answered in an unexpected shape')
    }
    cache.set(key, { status: 'ready', media: body })
  } catch (err) {
    cache.set(key, {
      status: 'failed', reason: err instanceof Error ? err.message : String(err),
    })
  }
  portraits.version++
}

/** Test seam: forget everything fetched. */
export function resetPortraits(): void {
  cache.clear()
  portraits.version++
}
