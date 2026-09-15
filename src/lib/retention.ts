// Retention limits on derived third-party data; loot catalog from Blizzard game-data API carries 30-day obligation; offline service worker caches /catalogs/ immutably forever unless app refuses expired data (D); rule applies to derived data only not engine DBC tables.

export type RetentionState =
  | { status: 'ok'; expiresAt: string | null }
  | { status: 'expiring'; expiresAt: string; hoursLeft: number }
  | { status: 'expired'; expiresAt: string }
  | { status: 'unknown'; reason: string }

/** Warn inside this window, so a user offline for a while is not surprised. */
export const EXPIRY_WARNING_HOURS = 72

/** Whether derived data may still be used; null expiry means unrestricted (engine-derived case); malformed/missing is unknown not ok. */
export function retentionOf(expiresAt: string | null | undefined, now = Date.now()): RetentionState {
  if (expiresAt === null) return { status: 'ok', expiresAt: null }
  if (typeof expiresAt !== 'string' || !expiresAt) {
    return { status: 'unknown', reason: 'this data records no expiry, so how long it may be kept is not known' }
  }
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) {
    return { status: 'unknown', reason: `this data records its expiry as "${expiresAt}", which cannot be read as a date` }
  }
  if (now >= at) return { status: 'expired', expiresAt }
  const hoursLeft = (at - now) / 3_600_000
  return hoursLeft <= EXPIRY_WARNING_HOURS
    ? { status: 'expiring', expiresAt, hoursLeft }
    : { status: 'ok', expiresAt }
}

/** True when data must not be shown or used at all. */
export function mustRefuse(state: RetentionState): boolean {
  // unknown is refused alongside expired; permission to keep third-party data must be pointable-at not assumed.
  return state.status === 'expired' || state.status === 'unknown'
}

/** What to tell user in their terms not the obligation's. */
export function retentionMessage(state: RetentionState): string {
  switch (state.status) {
    case 'expired':
      return 'This game data has passed the limit on how long it may be kept, so Frostsim will not use it. '
        + 'Reconnect and let the catalog update — offline, the copy on this device cannot be refreshed.'
    case 'expiring':
      return `This game data may only be kept until ${new Date(state.expiresAt).toLocaleString()}, `
        + `which is under ${Math.ceil(state.hoursLeft)} hours away. Reconnect before then and it refreshes itself.`
    case 'unknown':
      return `Frostsim will not use this data: ${state.reason}.`
    case 'ok':
      return ''
  }
}
