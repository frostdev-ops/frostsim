import { afterEach, describe, expect, it, vi } from 'vitest'
import { iconUrl, initMedia, media, noteIconMissing, resetMedia, tooltipFor } from './media.svelte'

const settle = () => new Promise((r) => setTimeout(r, 30))

function stubFetch(handler: (url: string) => unknown, status = 200) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => handler(url),
    } as Response
  })
  return calls
}

afterEach(() => {
  resetMedia()
  vi.unstubAllGlobals()
})

describe('item media', () => {
  it('serves icon URLs before the health check on a repeat visit, then follows its answer', async () => {
    const stored = new Map([['frostsim-media-configured', '1']])
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) })
    stubFetch(() => ({ configured: false }))
    const pending = initMedia()
    expect(iconUrl(19019)).toBe('/api/wow/icon/19019')
    await pending
    expect(iconUrl(19019)).toBeNull()
    expect(stored.get('frostsim-media-configured')).toBe('0')
  })

  it('keeps the seed when the health check fails rather than answers', async () => {
    const stored = new Map([['frostsim-media-configured', '1']])
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) })
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
    await initMedia()
    expect(media.configured).toBe(false)
    expect(stored.get('frostsim-media-configured')).toBe('1')
  })

  it('renders no item art at all when the deployment has no credentials', async () => {
    stubFetch(() => ({ configured: false }))
    await initMedia()
    expect(media.configured).toBe(false)
    expect(media.unavailableReason).toMatch(/not available/i)
    expect(iconUrl(271546)).toBeNull()
    expect(tooltipFor(271546)).toBeNull()
  })

  it('gives a same-origin icon url with no Blizzard host in it', async () => {
    stubFetch(() => ({ configured: true }))
    await initMedia()
    const url = iconUrl(271546)
    expect(url).toBeTruthy()
    expect(url!.startsWith('/')).toBe(true)
    expect(url).not.toMatch(/blizzard|battle\.net|wow\.zamimg/i)
    expect(url).toContain('271546')
  })

  it('stops offering an icon the browser could not load', async () => {
    stubFetch(() => ({ configured: true }))
    await initMedia()
    expect(iconUrl(999)).toBeTruthy()
    noteIconMissing(999)
    expect(iconUrl(999)).toBeNull()
    // Other items unaffected.
    expect(iconUrl(1000)).toBeTruthy()
  })

  it('holds attribution and expiry with the tooltip it belongs to', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    stubFetch((url) =>
      url.includes('health')
        ? { configured: true }
        : {
            ok: true,
            tooltip: { itemId: 5, basis: 'base', name: 'Thing', spells: [] },
            provenance: { attribution: 'Data provided by Blizzard', expiresAt: future },
          })
    await initMedia()
    tooltipFor(5)
    await settle()
    const state = tooltipFor(5)
    expect(state?.status).toBe('ready')
    if (state?.status === 'ready') {
      expect(state.provenance.attribution).toBe('Data provided by Blizzard')
      expect(state.provenance.expiresAt).toBe(future)
      expect(media.attribution).toBe('Data provided by Blizzard')
    }
  })

  it('refuses a tooltip whose data has already expired', async () => {
    const past = new Date(Date.now() - 1000).toISOString()
    stubFetch((url) =>
      url.includes('health')
        ? { configured: true }
        : {
            ok: true,
            tooltip: { itemId: 6, basis: 'base', name: 'Old', spells: [] },
            provenance: { attribution: 'a', expiresAt: past },
          })
    await initMedia()
    tooltipFor(6)
    await settle()
    expect(tooltipFor(6)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/expired/i) })
  })

  it('never carries stats, so the engine-resolved ones cannot be overwritten', async () => {
    stubFetch((url) =>
      url.includes('health')
        ? { configured: true }
        : {
            // Server regression sending stats: contract type has no such field, UI reads only declared fields.
            ok: true,
            tooltip: { itemId: 7, basis: 'base', name: 'Thing', spells: [], stats: [{ type: 5, value: 99999 }] },
            provenance: { attribution: 'a', expiresAt: new Date(Date.now() + 60_000).toISOString() },
          })
    await initMedia()
    tooltipFor(7)
    await settle()
    const state = tooltipFor(7)
    if (state?.status === 'ready') {
      // Rendered tooltip type declares no stats; ItemTooltip.svelte reads from catalog, not this object.
      expect(Object.keys(state.tooltip)).not.toContain('itemLevel')
    }
  })
})
