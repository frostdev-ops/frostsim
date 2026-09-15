import { beforeEach, describe, expect, it, vi } from 'vitest'

// P08.15: Selection was component state; these assert three things made restoring it safe.

function fakeStorage(opts: { throwOnWrite?: boolean } = {}) {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.throwOnWrite) throw new DOMException('quota', 'QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k: string) => void map.delete(k),
  }
}

const owned = (...ids: string[]) => new Set(ids)

describe('selection persistence', () => {
  beforeEach(() => vi.resetModules())

  it('survives a reload for the same character and tool', async () => {
    const store = fakeStorage()
    vi.stubGlobal('localStorage', store)
    const first = await import('./selection.svelte')
    first.saveSelection('char-1', 'gear', { trinket1: ['a', 'b'], head: ['h'] })

    vi.resetModules()
    const second = await import('./selection.svelte')
    expect(second.selectionFor('char-1', 'gear', owned('a', 'b', 'h')))
      .toEqual({ trinket1: ['a', 'b'], head: ['h'] })
  })

  it('never restores one character’s items onto another', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await import('./selection.svelte')
    m.saveSelection('char-1', 'gear', { trinket1: ['a'] })
    // Same ID, different char; not that char's item.
    expect(m.selectionFor('char-2', 'gear', owned('a'))).toEqual({})
  })

  it('keeps the two tools independent', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await import('./selection.svelte')
    m.saveSelection('char-1', 'gear', { trinket1: ['a'] })
    m.saveSelection('char-1', 'droptimizer', { head: ['h'] })
    expect(m.selectionFor('char-1', 'gear', owned('a', 'h'))).toEqual({ trinket1: ['a'] })
    expect(m.selectionFor('char-1', 'droptimizer', owned('a', 'h'))).toEqual({ head: ['h'] })
  })

  it('drops ids the character no longer owns, and counts them', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await import('./selection.svelte')
    m.saveSelection('char-1', 'gear', { trinket1: ['a', 'gone'], head: ['also-gone'] })
    // Reparsed export changes IDs; stale ID must not silently ride in search.
    expect(m.selectionFor('char-1', 'gear', owned('a'))).toEqual({ trinket1: ['a'] })
    expect(m.staleCount('char-1', 'gear', owned('a'))).toBe(2)
  })

  it('reports refused storage instead of pretending it saved', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ throwOnWrite: true }))
    const m = await import('./selection.svelte')
    expect(m.selectionStorageWorks()).toBe(true)
    m.saveSelection('char-1', 'gear', { trinket1: ['a'] })
    expect(m.selectionStorageWorks()).toBe(false)
    // In-memory copy still serves tab; navigation still works.
    expect(m.selectionFor('char-1', 'gear', owned('a'))).toEqual({ trinket1: ['a'] })
  })

  it('forgets a deleted character rather than leaking its selection', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await import('./selection.svelte')
    m.saveSelection('char-1', 'gear', { trinket1: ['a'] })
    m.forgetCharacterSelections('char-1')
    expect(m.selectionFor('char-1', 'gear', owned('a'))).toEqual({})
  })
})
