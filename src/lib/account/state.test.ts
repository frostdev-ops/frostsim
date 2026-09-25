// Account state helpers (CLAUDE.md D15; DESIGN.md C10, P5, P6): the Stripe-only redirect, the guild id a checkout link names,
// and which local record a cloud character download updates.

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoredCharacter } from '../store/records'

vi.mock('../simc/job', () => ({ setRemoteEngine: vi.fn() }))
vi.mock('../simc/remote', () => ({ createRemoteEngine: vi.fn() }))
vi.stubGlobal('localStorage', { getItem: () => null })
const { cloudDownload, currentPlans, go, guildOf } = await import('./state.svelte')
const { parseAddonExport } = await import('../import/character')

const RAW = readFileSync(new URL('../../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8')
const stored = (id: string, raw = RAW): StoredCharacter => ({ id, label: `local ${id}`, character: parseAddonExport(raw), pinned: false, createdAt: 0, updatedAt: 0 })
const token = (payload: unknown) => `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${'m'.repeat(43)}`

afterEach(() => vi.unstubAllGlobals())

describe('currentPlans', () => {
  it('names the plans of live personal subscriptions only', () => {
    const sub = (status: string, lookupKeys: string[], guildId: string | null = null) => ({ id: status, status, lookupKeys, periodEnd: null, guildId })
    const billing = { subscriptions: [sub('active', ['compute_m_yearly']), sub('canceled', ['compute_l_monthly']), sub('active', ['discord_guild_monthly'], '1'.repeat(18))] }
    expect([...currentPlans(billing as never)]).toEqual(['compute_m'])
    expect(currentPlans(null).size).toBe(0)
  })
})

describe('go', () => {
  it('navigates only to https Stripe checkout and billing portal addresses', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    go('https://checkout.stripe.com/c/pay/cs_test_1#frag')
    go('https://billing.stripe.com/p/session/test_1')
    expect(assign.mock.calls.map((c) => c[0])).toEqual(['https://checkout.stripe.com/c/pay/cs_test_1#frag', 'https://billing.stripe.com/p/session/test_1'])
    for (const url of ['http://checkout.stripe.com/c/pay/x', 'https://checkout.stripe.com.evil.test/x', 'https://evil.test/?checkout.stripe.com',
      'javascript:alert(1)', '/relative', undefined, 42]) {
      expect(() => go(url), String(url)).toThrow('no usable address')
    }
    expect(assign).toHaveBeenCalledTimes(2)
  })
})

describe('guildOf', () => {
  it('reads the Discord server id from the signed payload, and nothing else', () => {
    expect(guildOf(token({ kind: 'guild-checkout', guildId: '123456789012345678', discordUserId: '1', exp: 1 }))).toBe('123456789012345678')
    expect(guildOf(token({ kind: 'guild-checkout', guildId: '<b>x</b>' }))).toBeNull()
    expect(guildOf(token({ guildId: 1234 }))).toBeNull()
    expect(guildOf(`${'e'.repeat(150)}.${'m'.repeat(43)}`)).toBeNull()
    expect(guildOf('not-a-token')).toBeNull()
  })
})

describe('cloudDownload', () => {
  it('adds a character nobody has, updates the one matching record, and refuses to guess between several', () => {
    expect(cloudDownload(RAW, []).match).toBeUndefined()
    const other = stored('b', RAW.replace(/^warlock="?Testchar"?/m, 'warlock="Othername"'))
    expect(other.character.name).toBe('Othername')
    const { parsed, match } = cloudDownload(RAW, [other, stored('a')])
    expect(parsed.name).toBe('Testchar')
    expect(match?.id).toBe('a')
    expect(() => cloudDownload(RAW, [stored('a'), stored('c')])).toThrow('Several characters on this device match it')
  })

  it('refuses text that is not a valid export', () => {
    expect(() => cloudDownload('hello', [])).toThrow('not a valid export')
  })
})
