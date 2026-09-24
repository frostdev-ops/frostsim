// "Run on" persistence and cloud engine registration (CLAUDE.md D14, DESIGN.md C9, C10): the cloud engine is registered only while the
// user chose it AND is entitled; sign-out, lost entitlement or a browser choice always put runs back in this browser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ setRemoteEngine: vi.fn(), createRemoteEngine: vi.fn(() => 'cloud-engine') }))
vi.mock('../simc/job', () => ({ setRemoteEngine: mocks.setRemoteEngine }))
vi.mock('../simc/remote', () => ({ createRemoteEngine: mocks.createRemoteEngine }))

let stored: Map<string, string>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ME = { user: { id: 'u1', displayName: 'Ana', role: 'user', createdAt: '' }, identities: [], integrations: [] }
const billing = (maxThreads: number) => ({
  entitlements: { coreSeconds: 36_000, maxThreads, slots: 0, hostedShares: maxThreads > 0, periodStart: '', periodEnd: '' },
  usage: { usedCoreSeconds: 0, periodStart: '', periodEnd: '' },
  subscriptions: [],
})

async function load(init: Record<string, string> = {}) {
  stored = new Map(Object.entries(init))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  })
  vi.resetModules()
  return { ...(await import('./placement.svelte')), state: await import('./state.svelte') }
}
const last = () => mocks.setRemoteEngine.mock.calls.at(-1)?.[0]

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('placement', () => {
  it('defaults to this browser and reads a saved cloud choice', async () => {
    expect((await load()).placement.value).toBe('browser')
    expect((await load({ 'frostsim.placement': 'cloud' })).placement.value).toBe('cloud')
    expect((await load({ 'frostsim.placement': 'server' })).placement.value).toBe('browser')
  })

  it('survives blocked storage', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    vi.resetModules()
    const p = await import('./placement.svelte')
    expect(p.placement.value).toBe('browser')
    p.setPlacement('cloud')
    expect(p.placement.value).toBe('cloud')
  })

  it('registers the cloud engine only for cloud AND entitled, and persists the choice', async () => {
    const p = await load()
    p.applyPlacement(true)
    expect(last()).toBeNull()
    p.setPlacement('cloud')
    expect(stored.get('frostsim.placement')).toBe('cloud')
    expect(last()).toBe('cloud-engine')
    p.applyPlacement(false)
    expect(last()).toBeNull()
    p.applyPlacement(true)
    expect(last()).toBe('cloud-engine')
    p.setPlacement('browser')
    expect(stored.get('frostsim.placement')).toBe('browser')
    expect(last()).toBeNull()
  })

  it('re-evaluates on sign-in, entitlement changes and sign-out', async () => {
    const { placement, state } = await load({ 'frostsim.placement': 'cloud', 'frostsim.account': '1' })
    let plan = billing(16)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/v1/me' ? ME : plan)))

    await state.refresh()
    expect(placement.entitled).toBe(true)
    expect(last()).toBe('cloud-engine')

    plan = billing(0)
    await state.refresh()
    expect(placement.entitled).toBe(false)
    expect(last()).toBeNull()

    plan = billing(8)
    await state.refresh()
    expect(last()).toBe('cloud-engine')
    state.signedOut()
    expect(last()).toBeNull()
    expect(stored.has('frostsim.account')).toBe(false)
    // The choice itself is kept for the next sign-in.
    expect(stored.get('frostsim.placement')).toBe('cloud')
  })

  it('treats a server without billing as not entitled', async () => {
    const { placement, state } = await load({ 'frostsim.placement': 'cloud' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/v1/me' ? json(ME) : json({ error: 'feature-off', message: 'Off.' }, 404))))
    await state.refresh()
    expect(state.account.me).not.toBeNull()
    expect(placement.entitled).toBe(false)
    expect(last()).toBeNull()
  })
})
