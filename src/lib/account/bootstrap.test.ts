// Account start-up (CLAUDE.md D15; DESIGN.md C10, P4, P5): no request without the marker, landing codes, guild links.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ toast: vi.fn(), navigate: vi.fn(), setRemoteEngine: vi.fn(), syncSlots: vi.fn() }))
vi.mock('../app.svelte', () => ({ toast: mocks.toast }))
vi.mock('./slots.svelte', () => ({ afterLibrary: vi.fn(), syncSlots: mocks.syncSlots }))
vi.mock('../router.svelte', () => ({ navigate: mocks.navigate }))
vi.mock('../simc/job', () => ({ setRemoteEngine: mocks.setRemoteEngine }))
vi.mock('../simc/remote', () => ({ createRemoteEngine: () => 'cloud-engine' }))

const TOKEN = `${'e'.repeat(150)}.${'m'.repeat(43)}`

function storage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init))
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
}

let local: ReturnType<typeof storage>
let session: ReturnType<typeof storage>
let fetchMock: ReturnType<typeof vi.fn>
const replaceState = vi.fn()

function at(url: string, marker = false): void {
  const u = new URL(url)
  local = storage(marker ? { 'frostsim.account': '1' } : {})
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('location', { href: u.href, hash: u.hash, pathname: u.pathname, search: u.search, origin: u.origin })
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ME = { user: { id: 'u1', displayName: 'Ana', role: 'user', createdAt: '2026-09-01T00:00:00Z' }, identities: [], integrations: [] }
const paths = () => fetchMock.mock.calls.map((c) => String(c[0]))

async function boot() {
  vi.resetModules()
  const bootstrap = await import('./bootstrap')
  const state = await import('./state.svelte')
  await bootstrap.bootstrap()
  return state
}

beforeEach(() => {
  vi.clearAllMocks()
  session = storage()
  fetchMock = vi.fn(async (url: string) => (url === '/api/v1/me' ? json(ME) : json({ error: 'feature-off', message: 'off' }, 404)))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('history', { state: null, replaceState })
  vi.stubGlobal('addEventListener', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('account bootstrap', () => {
  it('makes no request at all without the marker', async () => {
    at('https://sim.test/#/quick')
    const state = await boot()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
    expect(state.account.me).toBeNull()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('asks who is signed in when the marker exists, and forgets the marker on 401', async () => {
    at('https://sim.test/#/', true)
    let state = await boot()
    expect(paths()).toEqual(['/api/v1/me', '/api/v1/billing'])
    expect(state.account.me?.user.displayName).toBe('Ana')
    expect(mocks.syncSlots).toHaveBeenCalledOnce()

    mocks.syncSlots.mockClear()
    fetchMock.mockImplementation(async () => json({ error: 'signed-out', message: 'Sign in first.' }, 401))
    at('https://sim.test/#/', true)
    state = await boot()
    expect(state.account.me).toBeNull()
    expect(local.map.has('frostsim.account')).toBe(false)
    expect(mocks.setRemoteEngine).toHaveBeenLastCalledWith(null)
    expect(mocks.syncSlots).not.toHaveBeenCalled()
  })

  it('handles ?account=signed-in: toast, marker, stripped query, then the refresh', async () => {
    at('https://sim.test/?account=signed-in#/quick')
    await boot()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/quick')
    expect(mocks.toast).toHaveBeenCalledWith('good', 'Signed in.')
    expect(local.map.get('frostsim.account')).toBe('1')
    expect(paths()).toEqual(['/api/v1/me', '/api/v1/billing'])
  })

  it('clears the marker for a no-session code only when /me answers 401, keeping the message in the dialog', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'signed-out', message: 'Sign in first.' }, 401))
    at('https://sim.test/?account=error-signed-out#/', true)
    const state = await boot()
    expect(paths()).toEqual(['/api/v1/me'])
    expect(local.map.has('frostsim.account')).toBe(false)
    expect(state.account.notice).toContain('signed out before linking finished')
    expect(state.account.open).toBe(true)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('ignores a crafted no-session code while the session works', async () => {
    at('https://sim.test/?account=error-suspended#/', true)
    const state = await boot()
    expect(state.account.me?.user.displayName).toBe('Ana')
    expect(local.map.get('frostsim.account')).toBe('1')
    expect(state.account.notice).toBe('')
    expect(state.account.open).toBe(false)
  })

  it('claims a sign-in or payment only when /me confirms a session; an unknown code is never shown', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'signed-out', message: 'Sign in first.' }, 401))
    for (const code of ['signed-in', 'billing-success', '%3Cscript%3E']) {
      vi.clearAllMocks()
      at(`https://sim.test/?account=${code}#/`)
      const state = await boot()
      expect(state.account.notice, code).toBe('Sign-in did not finish. Try again.')
      expect(mocks.toast, code).not.toHaveBeenCalled()
      expect(local.map.has('frostsim.account'), code).toBe(false)
      expect(replaceState, code).toHaveBeenCalledWith(null, '', '/#/')
    }
  })

  it('keeps other query parameters when it strips the code', async () => {
    at('https://sim.test/?x=1&account=billing-cancelled#/')
    await boot()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1#/')
    expect(mocks.toast).toHaveBeenCalledWith('info', expect.stringContaining('Nothing was charged'))
  })
})

describe('guild checkout link', () => {
  it('opens the dialog on the checkout and clears the link from the address bar', async () => {
    at(`https://sim.test/#/account/guild/${TOKEN}`)
    const state = await boot()
    expect(state.account.guildToken).toBe(TOKEN)
    expect(state.account.open).toBe(true)
    expect(mocks.navigate).toHaveBeenCalledWith('', true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('opens the dialog for #/account, the sign-in link Discord and Loothing send', async () => {
    at('https://sim.test/#/account')
    const state = await boot()
    expect(state.account.open).toBe(true)
    expect(state.account.guildToken).toBeNull()
    expect(mocks.navigate).toHaveBeenCalledWith('', true)
  })

  it('ignores a malformed token', async () => {
    at('https://sim.test/#/account/guild/not-a-token')
    const state = await boot()
    expect(state.account.guildToken).toBeNull()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('parks the token across sign-in, because the return path cannot hold it', async () => {
    at(`https://sim.test/#/account/guild/${TOKEN}`)
    const state = await boot()
    const url = state.startUrl('discord', 'login', '#/')
    expect(url).toBe('/api/v1/auth/discord/start?mode=login&return=%23%2F')
    expect(session.map.get('frostsim.guild')).toBe(TOKEN)

    // Back from the provider: no guild hash, but the parked token reopens the checkout once.
    at('https://sim.test/?account=signed-in#/')
    const after = await boot()
    expect(after.account.guildToken).toBe(TOKEN)
    expect(after.account.open).toBe(true)
    expect(session.map.has('frostsim.guild')).toBe(false)
  })

  it('sends any return path the server would refuse back to #/', async () => {
    at('https://sim.test/#/')
    const state = await boot()
    expect(state.startUrl('bnet', 'link', '#/quick')).toContain('return=%23%2Fquick')
    expect(state.startUrl('bnet', 'link', `#/r/${'x'.repeat(300)}`)).toContain('return=%23%2F')
    expect(state.startUrl('bnet', 'link', `#/r/${'x'.repeat(300)}`)).not.toContain('xxx')
  })
})
