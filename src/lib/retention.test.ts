import { describe, expect, it } from 'vitest'
import { mustRefuse, retentionOf, retentionMessage } from './retention'

// Loot catalog derived from Blizzard's API, 30-day retention limit; service worker caches /catalogs/ immutably so offline expiry enforced only by re-fetching is not enforced.

const NOW = Date.parse('2026-09-14T12:00:00Z')
const at = (iso: string) => retentionOf(iso, NOW)

describe('retentionOf', () => {
  it('allows data still well within its limit', () => {
    const s = at('2026-10-01T12:00:00Z')
    expect(s.status).toBe('ok')
    expect(mustRefuse(s)).toBe(false)
  })

  it('treats a null expiry as unrestricted, which is the engine-derived case', () => {
    // Item, spell and talent tables come out of the DBC and carry no
    // obligation. Refusing those would break the app for no reason.
    expect(retentionOf(null, NOW)).toEqual({ status: 'ok', expiresAt: null })
    expect(mustRefuse(retentionOf(null, NOW))).toBe(false)
  })

  it('refuses data past its expiry', () => {
    const s = at('2026-09-14T11:59:59Z')
    expect(s.status).toBe('expired')
    expect(mustRefuse(s)).toBe(true)
    expect(retentionMessage(s)).toContain('will not use it')
  })

  it('refuses exactly at the boundary, not one moment after', () => {
    // The obligation is "must not be used after"; equality is already after.
    expect(at('2026-09-14T12:00:00Z').status).toBe('expired')
    expect(at('2026-09-14T12:00:01Z').status).not.toBe('expired')
  })

  it('warns inside the window rather than failing silently at the edge', () => {
    const s = at('2026-09-16T12:00:00Z') // 48 hours
    expect(s.status).toBe('expiring')
    expect(mustRefuse(s)).toBe(false)
    expect(retentionMessage(s)).toContain('refreshes itself')
    // Just outside window is ordinary.
    expect(at('2026-09-18T13:00:00Z').status).toBe('ok')
  })

  it('refuses an unreadable or missing expiry rather than assuming permission', () => {
    for (const bad of ['', 'soon', undefined]) {
      const s = retentionOf(bad as string, NOW)
      expect(s.status).toBe('unknown')
      // Permission to keep third-party data must be pointable-at not assumed because nobody wrote limit.
      expect(mustRefuse(s)).toBe(true)
    }
  })
})
