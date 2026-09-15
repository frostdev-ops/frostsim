// Item icons and tooltips over BattleNetClient. Thin layer with UI cache + rules: no credentials reach client, no user data, nothing blocks sim, API stats don't reach screen (ItemTooltip has no stats; UI shows catalog resolved level), attribution/expiry held with data.

import { BattleNetClient, type Lookup } from './battlenet/client'
import type { ItemTooltip } from './battlenet/contract'

export type { ItemTooltip }

export interface MediaProvenance {
  attribution: string
  /** ISO instant after which this data must not be used. */
  expiresAt: string
}

export type TooltipState =
  | { status: 'loading' }
  | { status: 'absent' }
  | { status: 'ready'; tooltip: ItemTooltip; provenance: MediaProvenance }
  | { status: 'failed'; reason: string }

export const media = $state({
  /** Null until the health check answers; false means hide item art entirely. */
  configured: null as boolean | null,
  /** The most recent attribution seen. Rendered wherever API data appears. */
  attribution: '',
  /** Set when the deployment has no item data, so the UI can say why once. */
  unavailableReason: '',
})

/** Bumped whenever a cache entry changes, so components can depend on it. */
export const mediaVersion = $state({ n: 0 })

/** Created on first use not import; binds globalThis.fetch so app region config is captured (lazy binding makes module testable). */
let client: BattleNetClient | null = null
let options: { region?: string; locale?: string } = {}

function api(): BattleNetClient {
  client ??= new BattleNetClient(options as never)
  return client
}

const tooltips = new Map<number, TooltipState>()
/** Item ids the browser told us have no icon — collapse rather than retry. */
const iconMissing = new Set<number>()

export function configureMedia(next: { region?: string; locale?: string }): void {
  options = next
  client = null
  tooltips.clear()
  iconMissing.clear()
  media.configured = null
  mediaVersion.n++
}

/** Asks once whether this deployment has item data at all. */
export async function initMedia(): Promise<void> {
  if (media.configured !== null) return
  try {
    media.configured = await api().isConfigured()
  } catch {
    media.configured = false
  }
  if (!media.configured) {
    media.unavailableReason =
      'Item icons and tooltips are not available in this deployment, so items show their catalog data only. Everything else, including simulation, is unaffected.'
  }
  mediaVersion.n++
}

/** Same-origin icon URL or null; safe in src (bytes proxied, no Blizzard host in page). */
export function iconUrl(itemId: number): string | null {
  if (media.configured !== true || iconMissing.has(itemId)) return null
  return api().iconUrl(itemId)
}

/** Instance art for loot-source tile (proxied bytes); only for source with mediaId (encounters have no art). */
export function journalTileUrl(mediaId: number | undefined): string | null {
  if (media.configured !== true || !mediaId) return null
  return `/api/wow/journal-tile/${mediaId}`
}

/** Spell icon bytes, proxied. Spell ids are game data, not user data. */
export function spellIconUrl(spellId: number | undefined): string | null {
  if (media.configured !== true || !spellId) return null
  return `/api/wow/spell-icon/${spellId}?media=2`
}

/** Called when the browser fails to load one icon; stops it being retried. */
export function noteIconMissing(itemId: number): void {
  if (iconMissing.has(itemId)) return
  iconMissing.add(itemId)
  mediaVersion.n++
}

export function tooltipFor(itemId: number): TooltipState | null {
  if (media.configured !== true || !itemId) return null
  const hit = tooltips.get(itemId)
  if (hit) return hit
  tooltips.set(itemId, { status: 'loading' })
  void loadTooltip(itemId)
  return tooltips.get(itemId)!
}

async function loadTooltip(itemId: number): Promise<void> {
  let result: Lookup<ItemTooltip>
  try {
    result = await api().tooltip(itemId)
  } catch (err) {
    tooltips.set(itemId, {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    })
    mediaVersion.n++
    return
  }

  if (result.status === 'ok') {
    // Expiry enforced here and server-side; cached entry must not outlive permission (cache lives for session).
    if (Date.parse(result.expiresAt) <= Date.now()) {
      tooltips.set(itemId, { status: 'failed', reason: 'this item data has expired' })
    } else {
      media.attribution = result.attribution
      tooltips.set(itemId, {
        status: 'ready',
        tooltip: result.value,
        provenance: { attribution: result.attribution, expiresAt: result.expiresAt },
      })
    }
  } else if (result.status === 'absent') {
    tooltips.set(itemId, { status: 'absent' })
  } else {
    tooltips.set(itemId, { status: 'failed', reason: result.message })
    // A configuration failure is permanent for this session; stop asking.
    if (!result.retryable && result.code === 'not_configured') {
      media.configured = false
      media.unavailableReason =
        'Item icons and tooltips are not available in this deployment, so items show their catalog data only.'
    }
  }
  mediaVersion.n++
}

export function resetMedia(): void {
  client = null
  tooltips.clear()
  iconMissing.clear()
  media.configured = null
  media.attribution = ''
  media.unavailableReason = ''
  mediaVersion.n++
}
