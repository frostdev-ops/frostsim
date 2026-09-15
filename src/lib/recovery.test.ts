import { beforeEach, describe, expect, it, vi } from 'vitest'

// Test recovery states: old banner claim "nothing discarded either way" is false; assert real states.

function fakeStorage(opts: { throwOnWrite?: boolean } = {}) {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.throwOnWrite) throw new DOMException('quota', 'QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  }
}

describe('Expert Mode drafts survive a reload', () => {
  beforeEach(() => vi.resetModules())

  it('keeps a script per specialization and never carries one across', async () => {
    // Rotation for Frost is wrong for Fire; old shape silently carried previous spec's APL (P10.4).
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await import('./advanced.svelte')
    m.useSpec('frost')
    m.expert.raw = 'actions=frostbolt'
    m.persistDrafts()

    m.useSpec('fire')
    expect(m.expert.raw).toBe('')
    m.expert.raw = 'actions=fireball'
    m.persistDrafts()

    // Back to Frost: its own script, untouched by the Fire edit.
    m.useSpec('frost')
    expect(m.expert.raw).toBe('actions=frostbolt')
    expect(m.activeSpec()).toBe('frost')
    expect(m.specsWithDrafts().sort()).toEqual(['fire', 'frost'])

    // Copying is explicit and reports whether there was anything to copy.
    expect(m.copyFromSpec('fire')).toBe(true)
    expect(m.expert.raw).toBe('actions=fireball')
    expect(m.copyFromSpec('arcane')).toBe(false)
  })

  it('adopts a pre-P10.4 script rather than discarding it', async () => {
    const store = fakeStorage()
    // The old shape: one global `expert`, no spec buckets.
    store.setItem('frostsim.advanced', JSON.stringify({ expert: { raw: 'actions=old' } }))
    vi.stubGlobal('localStorage', store)
    const m = await import('./advanced.svelte')
    expect(m.expert.raw).toBe('actions=old')
  })

  it('restores a script written before the reload', async () => {
    const store = fakeStorage()
    vi.stubGlobal('localStorage', store)

    const first = await import('./advanced.svelte')
    first.expert.raw = 'actions=frostbolt\nactions+=/ice_lance'
    first.expert.mode = 'raw'
    expect(first.persistDrafts()).toBe(true)
    expect(first.hasUnsavedDrafts()).toBe(true)

    // Reload is fresh module graph against same storage.
    vi.resetModules()
    const second = await import('./advanced.svelte')
    expect(second.expert.raw).toBe('actions=frostbolt\nactions+=/ice_lance')
    expect(second.expert.mode).toBe('raw')
  })

  it('reports failure rather than silently losing the script', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ throwOnWrite: true }))
    const m = await import('./advanced.svelte')
    m.expert.raw = 'actions=frostbolt'
    // The whole point: the caller must be able to tell the user the truth.
    expect(m.persistDrafts()).toBe(false)
  })

  it('ignores storage holding the wrong shapes instead of throwing', async () => {
    const store = fakeStorage()
    store.setItem('frostsim.advanced', JSON.stringify({
      expert: { raw: 42, mode: 'nonsense', header: 'kept' },
      statWeights: { selected: [1, 2], normalize: 'yes' },
    }))
    vi.stubGlobal('localStorage', store)
    const m = await import('./advanced.svelte')
    expect(m.expert.raw).toBe('')
    expect(m.expert.mode).toBe('character')
    expect(m.expert.header).toBe('kept')
    expect(m.statWeights.selected).toEqual(['crit', 'haste', 'mastery', 'versatility'])
    // Default is OFF: normalisation by primary attribute's scale factor would give 0.00 without it.
    expect(m.statWeights.normalize).toBe(false)
  })

  it('survives storage that is missing entirely', async () => {
    vi.stubGlobal('localStorage', undefined)
    const m = await import('./advanced.svelte')
    expect(m.expert.raw).toBe('')
    expect(m.persistDrafts()).toBe(false)
  })
})

describe('prepareForReload tells the truth about what a reload costs', () => {
  beforeEach(() => vi.resetModules())

  const load = async () => {
    vi.doMock('./simc/job', () => ({
      engineBusy: () => false,
      engineAvailability: () => ({ available: true }),
    }))
    return import('./app.svelte')
  }

  it('is clean when there is nothing unsaved', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await load()
    const check = await m.prepareForReload()
    expect(check).toEqual({ ok: true, losses: [] })
  })

  it('names an unkept pasted character', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await load()
    m.app.draft = { name: 'Frostmage' } as never
    const check = await m.prepareForReload()
    expect(check.ok).toBe(false)
    expect(check.losses.join(' ')).toContain('Frostmage')
  })

  it('says outright that NOTHING is saved when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const m = await load()
    m.app.storage.available = false
    const check = await m.prepareForReload()
    expect(check.ok).toBe(false)
    // This is the exact case the old copy got wrong.
    expect(check.losses.join(' ')).toContain('every character and report')
  })

  it('names the script when the browser refuses to store it', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ throwOnWrite: true }))
    const m = await load()
    const check = await m.prepareForReload()
    expect(check.ok).toBe(false)
    expect(check.losses.join(' ')).toContain('Expert Mode')
  })
})

describe('exportEverything reports what it did, not what it hopes', () => {
  beforeEach(() => vi.resetModules())

  it('never claims a download succeeded, only that it started', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    vi.doMock('./simc/job', () => ({
      engineBusy: () => false,
      engineAvailability: () => ({ available: true }),
    }))
    const clicked: string[] = []
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
    })
    vi.stubGlobal('document', {
      createElement: () => ({ set download(v: string) { clicked.push(v) }, href: '', click() {} }),
    })
    const m = await import('./app.svelte')
    const result = await m.exportEverything()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes).toBeGreaterThan(0)
    expect(clicked).toEqual(['frostsim-history.json'])
  })

  it('returns a reason instead of throwing when serialisation fails', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    vi.doMock('./simc/job', () => ({
      engineBusy: () => false,
      engineAvailability: () => ({ available: true }),
    }))
    vi.stubGlobal('URL', {
      createObjectURL: () => { throw new Error('blob refused') },
      revokeObjectURL: () => {},
    })
    const m = await import('./app.svelte')
    const result = await m.exportEverything()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('blob refused')
  })
})
