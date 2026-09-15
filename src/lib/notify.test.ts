import { beforeEach, describe, expect, it, vi } from 'vitest'

// P06.11: permission never requested without user gesture; UI reports browser's answer, not ask (blocked → no retry).

function storage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

function mockNotification(permission: NotificationPermission, answer = permission) {
  const calls = { requested: 0, shown: [] as { title: string; body?: string }[] }
  class N {
    static permission = permission
    static async requestPermission() {
      calls.requested++
      N.permission = answer
      return answer
    }
    constructor(title: string, opts?: NotificationOptions) {
      calls.shown.push({ title, body: opts?.body })
    }
  }
  vi.stubGlobal('Notification', N)
  return calls
}

describe('completion notifications', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('document', { visibilityState: 'hidden' })
  })

  it('asks only when the user turns it on, and only once', async () => {
    const calls = mockNotification('default', 'granted')
    const m = await import('./notify.svelte')
    // Importing must not ask (whole rule).
    expect(calls.requested).toBe(0)

    expect(await m.setWanted(true)).toBe('granted')
    expect(calls.requested).toBe(1)
    expect(m.notify.wanted).toBe(true)

    // Already granted: no second prompt.
    await m.setWanted(true)
    expect(calls.requested).toBe(1)
  })

  it('stays off when the browser refuses, rather than showing as on', async () => {
    mockNotification('default', 'denied')
    const m = await import('./notify.svelte')
    expect(await m.setWanted(true)).toBe('denied')
    expect(m.notify.wanted).toBe(false)
  })

  it('never asks again once denied', async () => {
    const calls = mockNotification('denied')
    const m = await import('./notify.svelte')
    await m.setWanted(true)
    expect(calls.requested).toBe(0)
    expect(m.support()).toBe('denied')
  })

  it('notifies only when wanted, granted and the tab is hidden', async () => {
    const calls = mockNotification('granted')
    const m = await import('./notify.svelte')

    // Not opted in yet.
    m.notifyFinished('t', 'b')
    expect(calls.shown).toHaveLength(0)

    await m.setWanted(true)
    m.notifyFinished('Frostsim — Top Gear', 'finished')
    expect(calls.shown).toEqual([{ title: 'Frostsim — Top Gear', body: 'finished' }])

    // Visible tab: user already looking at it.
    vi.stubGlobal('document', { visibilityState: 'visible' })
    m.notifyFinished('t2', 'b2')
    expect(calls.shown).toHaveLength(1)
  })

  it('is inert, not broken, where Notification does not exist', async () => {
    vi.stubGlobal('Notification', undefined)
    const m = await import('./notify.svelte')
    expect(m.support()).toBe('unsupported')
    expect(await m.setWanted(true)).toBe('unsupported')
    expect(() => m.notifyFinished('t', 'b')).not.toThrow()
  })
})
