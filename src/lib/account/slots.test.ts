// Character slots as the characters (CLAUDE.md D15): the sync rules (planSync) and what a save or delete on this device does to its slot.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedCharacter } from '../import/character'

const mocks = vi.hoisted(() => ({
  sync: null as null | { saved(r: unknown): void; deleted(r: unknown): void },
  api: vi.fn(),
  toast: vi.fn(),
  characters: [] as unknown[],
}))
vi.mock('../app.svelte', () => ({
  app: { get characters() { return mocks.characters } },
  deleteCharacter: vi.fn(),
  saveCharacter: vi.fn(),
  toast: mocks.toast,
  setCharacterSync: (s: typeof mocks.sync) => (mocks.sync = s),
}))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api: mocks.api }))
vi.mock('./state.svelte', () => ({ account: { me: { user: { id: 'u1' } } }, signedOut: vi.fn() }))

const { planSync, slots, syncSlots } = await import('./slots.svelte')
const { AccountError } = await import('./api')

const who = (name: string) => ({ name, className: 'mage', server: 'area-52', region: 'us' })
const char = (name: string) => ({ ...who(name), raw: `mage=${name}` }) as unknown as ImportedCharacter
const slot = (id: string, name: string, updatedAt = '2026-09-20T00:00:00.000Z') => ({ id, label: name, bytes: 1, updatedAt, who: who(name) })
const local = (id: string, name: string, updatedAt = 0) => ({ id, label: name, character: char(name), updatedAt })
const none = { links: {}, gone: [] }

describe('planSync', () => {
  it('brings every slot onto a new device', () => {
    expect(planSync([slot('s1', 'Ana'), slot('s2', 'Bo')], 3, [], none)).toEqual([
      { kind: 'pull', slot: slot('s1', 'Ana') },
      { kind: 'pull', slot: slot('s2', 'Bo') },
    ])
  })

  it('pairs an unlinked character with its slot by who it is, and the newer side wins', () => {
    const at = Date.parse('2026-09-20T00:00:00.000Z')
    expect(planSync([slot('s1', 'Ana')], 1, [local('l1', 'ana', at - 1)], none)).toEqual([{ kind: 'pull', slot: slot('s1', 'Ana'), localId: 'l1' }])
    expect(planSync([slot('s1', 'Ana')], 1, [local('l1', 'Ana', at + 1)], none)).toEqual([{ kind: 'push', localId: 'l1', slotId: 's1' }])
  })

  it('puts unslotted characters into free slots newest first, and leaves the rest on this device', () => {
    const steps = planSync([slot('s1', 'Ana')], 3, [local('l1', 'Ana', 1), local('old', 'Cy', 5), local('new', 'Di', 9), local('x', 'Ed', 7)], {
      links: { l1: { id: 's1', at: '2026-09-20T00:00:00.000Z', local: 1 } }, gone: [],
    })
    expect(steps).toEqual([{ kind: 'push', localId: 'new' }, { kind: 'push', localId: 'x' }])
  })

  it('moves a linked pair the way it changed since the last exchange', () => {
    const saved = { links: { l1: { id: 's1', at: '2026-09-20T00:00:00.000Z', local: 10 } }, gone: [] }
    expect(planSync([slot('s1', 'Ana')], 1, [local('l1', 'Ana', 10)], saved)).toEqual([])
    expect(planSync([slot('s1', 'Ana')], 1, [local('l1', 'Ana', 11)], saved)).toEqual([{ kind: 'push', localId: 'l1', slotId: 's1' }])
    const moved = slot('s1', 'Ana', '2026-09-21T00:00:00.000Z')
    expect(planSync([moved], 1, [local('l1', 'Ana', 11)], saved)).toEqual([{ kind: 'pull', slot: moved, localId: 'l1' }])
  })

  it('deletes here what was deleted on another device, retries frees, and brings back a slot whose character is gone here', () => {
    const saved = {
      links: { l1: { id: 'cleared', at: '', local: 0 }, missing: { id: 's3', at: '', local: 0 } },
      gone: ['s2'],
    }
    expect(planSync([slot('s2', 'Bo'), slot('s3', 'Cy')], 5, [local('l1', 'Ana')], saved)).toEqual([
      { kind: 'free', slotId: 's2' },
      { kind: 'forget', localId: 'l1' },
      { kind: 'pull', slot: slot('s3', 'Cy') },
    ])
  })
})

describe('saves and deletes on this device', () => {
  beforeEach(async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
    mocks.api.mockReset()
    mocks.toast.mockReset()
    mocks.characters = []
    mocks.api.mockResolvedValue({ slots: 1, characters: [] })
    await syncSlots()
    expect(slots.on).toBe(true)
  })

  it('fills a slot on import, rewrites it on update and frees it on delete', async () => {
    const rec = local('l1', 'Ana', 5)
    mocks.characters = [rec]
    mocks.api.mockImplementation(async (path: string, method = 'GET') => {
      if (method === 'POST') return { id: 's1', updatedAt: '2026-09-25T00:00:00.000Z' }
      if (method === 'PUT') return { id: 's1', updatedAt: '2026-09-25T01:00:00.000Z' }
      if (method === 'DELETE') return undefined
      return { slots: 1, characters: path === '/characters' && method === 'GET' ? [slot('s1', 'Ana')] : [] }
    })
    mocks.sync!.saved(rec)
    await syncSlots()
    expect(mocks.api).toHaveBeenCalledWith('/characters', 'POST', { label: 'Ana', raw: 'mage=Ana' })
    expect(slots.links).toEqual({ l1: 's1' })

    mocks.sync!.saved(rec)
    mocks.sync!.deleted(rec)
    await syncSlots()
    expect(mocks.api).toHaveBeenCalledWith('/characters/s1', 'PUT', { label: 'Ana', raw: 'mage=Ana' })
    expect(mocks.api).toHaveBeenCalledWith('/characters/s1', 'DELETE')
  })

  it('keeps a character on this device when every slot is in use, and says so', async () => {
    const rec = local('l1', 'Ana', 5)
    mocks.characters = [rec]
    mocks.api.mockImplementation(async (_path: string, method = 'GET') => {
      if (method === 'POST') throw new AccountError(402, 'no-slots', 'Every cloud character slot is in use.')
      return { slots: 1, characters: [slot('s9', 'Other')] }
    })
    mocks.sync!.saved(rec)
    await syncSlots()
    expect(mocks.toast).toHaveBeenCalledWith('info', expect.stringContaining('Ana is on this device only'))
    expect(slots.links).toEqual({})
  })
})
