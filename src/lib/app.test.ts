import { describe, expect, it, vi } from 'vitest'

// Build can pass check/build but white-screen on temporal-dead-zone errors not caught; these assert modules evaluate and export correctly.
describe('application modules evaluate', () => {
  it('loads the app state module and its exports', async () => {
    const m = await import('./app.svelte')
    expect(typeof m.activeCharacter).toBe('function')
    expect(typeof m.ensureCatalog).toBe('function')
    expect(m.app.catalogState).toBe('idle')
  })

  it('loads the job controller', async () => {
    const m = await import('./job.svelte')
    expect(typeof m.startRun).toBe('function')
    expect(typeof m.cancelRun).toBe('function')
    expect(m.STATUS_LABELS.running).toBeTruthy()
  })

  it('loads the settings module and every tool instance', async () => {
    const m = await import('./settings.svelte')
    for (const s of [m.quickSettings, m.compareSettings, m.gearSettings, m.dropSettings, m.advancedSettings]) {
      expect(s.accuracy().mode).toBeTruthy()
    }
    // Every selectable preset must be reachable by the id the UI stores.
    expect(m.SELECTABLE_PRESETS.length).toBeGreaterThan(0)
    for (const preset of m.SELECTABLE_PRESETS) {
      m.quickSettings.selectPreset(preset.id)
      expect(m.quickSettings.presetId).toBe(preset.id)
    }
    m.quickSettings.consumables = { potion: 'disabled' }
    m.quickSettings.equipmentOptions = { 'midnight.crucible_of_erratic_energies_violence': '1' }
    expect(m.quickSettings.extraProfileLines()).toContain('potion=disabled')
    m.quickSettings.targetError = 2
    m.quickSettings.raidBuffs.bloodlust = false
    m.quickSettings.loadoutName = 'Other'
    m.quickSettings.restoreDefaults()
    expect(m.quickSettings.snapshot()).toMatchObject({ presetId: 'patchwerk', maxTime: 300, targets: 1,
      targetError: 0.1, maxIterations: 100_000, loadoutName: null, raidBuffs: {}, consumables: {}, equipmentOptions: {} })
    m.gearSettings.restoreDefaults()
    expect(m.gearSettings.targetError).toBe(1)
  })

  it('loads the media, router, theme and shortcut modules', async () => {
    const media = await import('./media.svelte')
    expect(media.media.configured).toBeNull()
    const router = await import('./router.svelte')
    expect(router.ROUTES).toContain('quick')
    const theme = await import('./theme.svelte')
    expect(typeof theme.ms('panel')).toBe('number')
    const shortcuts = await import('./shortcuts.svelte')
    expect(shortcuts.SHORTCUT_HINT.search).toBe('/')
  })

  it('loads the run-batch bridge and the search plan', async () => {
    const bridge = await import('./runBatch')
    expect(typeof bridge.makeRunBatch).toBe('function')
    const plan = await import('./searchPlan')
    expect(plan.PRODUCT_STAGE_PLAN.stages.length).toBeGreaterThan(0)
  })

  it('loads every screen component', async () => {
    const screens = await Promise.all([
      import('../routes/Character.svelte'),
      import('../routes/Talents.svelte'),
      import('../routes/QuickSim.svelte'),
      import('../routes/Compare.svelte'),
      import('../routes/TopGear.svelte'),
      import('../routes/Droptimizer.svelte'),
      import('../routes/Advanced.svelte'),
      import('../routes/Reports.svelte'),
      import('../routes/Help.svelte'),
      import('../App.svelte'),
    ])
    for (const s of screens) expect(s.default).toBeTruthy()
  }, 120_000) // Compiles the complete Svelte graph from a cold transform cache; generous for slow CI runners.

  it('has a screen for every declared route', async () => {
    const { ROUTES, ROUTE_LABELS, ROUTE_BLURBS } = await import('./router.svelte')
    // A route with no screen is a blank page, and the map is written by hand.
    for (const name of ROUTES) {
      expect(ROUTE_LABELS[name], `label for ${name}`).toBeTruthy()
      expect(ROUTE_BLURBS[name], `blurb for ${name}`).toBeTruthy()
    }
    expect(ROUTES).toContain('talents')
    expect(ROUTES).toContain('help')
  })
})

// One engine run exhausts tab memory; runJob refuses second concurrent; UI must gate on engine slot, show stray runs (leaked search).
describe('the engine slot and the run controls', () => {
  it('reports busy from the engine even when this app has no job record', async () => {
    vi.resetModules()
    let busy = false
    let stopping = false
    vi.doMock('./simc/job', () => ({
      engineBusy: () => busy,
      engineStopping: () => stopping,
      engineAvailability: () => ({ available: true }),
    }))
    const m = await import('./app.svelte')

    expect(m.isBusy()).toBe(false)
    expect(m.strayEngine()).toBe(false)

    busy = true
    expect(m.isBusy()).toBe(true)
    expect(m.strayEngine()).toBe(true)

    // Own job record makes same engine state ordinary not stray.
    m.app.job = { id: 'j', tool: 'gear', title: 't', status: 'running', startedAt: 0 }
    expect(m.isBusy()).toBe(true)
    expect(m.strayEngine()).toBe(false)

    // A settled job with the engine still going is the leak we are looking for.
    m.app.job.status = 'complete'
    expect(m.strayEngine()).toBe(true)

    stopping = true
    m.pollEngineSlot()
    m.pollEngineSlot()
    expect(m.app.engineStopping).toBe(true)
    expect(m.app.engineStray).toBe(false)
    expect(m.isBusy()).toBe(true)
    stopping = false

    // Poll makes this reach control; engineBusy() reads worker state, derived doesn't re-evaluate alone; takes TWO consecutive polls (cancelled run transient).
    m.pollEngineSlot()
    expect(m.app.engineStray).toBe(false)
    m.pollEngineSlot()
    expect(m.app.engineStray).toBe(true)

    // Streak resets; later transient starts from zero not old state.
    busy = false
    m.pollEngineSlot()
    expect(m.app.engineStray).toBe(false)
    expect(m.isBusy()).toBe(false)
    busy = true
    m.pollEngineSlot()
    expect(m.app.engineStray).toBe(false)
    vi.doUnmock('./simc/job')
  })
})

// Rime regression: screen teardown stops only its own work; engineBusy() global, gating alone kills other tools' jobs.
describe('teardownCancellation', () => {
  const call = async (o: Parameters<typeof import('./job.svelte').teardownCancellation>[0]) =>
    (await import('./job.svelte')).teardownCancellation(o)

  it('does nothing when this screen has no run of its own', async () => {
    expect(await call({ running: false, ownedJobId: null, activeJobId: 'quicksim', engineBusy: true }))
      .toEqual({ abort: false, forceCancel: false })
    // Engine stays busy with someone else's work, untouched.
    expect(await call({ running: false, ownedJobId: 'old', activeJobId: 'quicksim', engineBusy: true }))
      .toEqual({ abort: false, forceCancel: false })
  })

  it('aborts its own search, and force-cancels only when the engine holds that job', async () => {
    expect(await call({ running: true, ownedJobId: 'mine', activeJobId: 'mine', engineBusy: true }))
      .toEqual({ abort: true, forceCancel: true })
    // Someone else took engine: abort ours, never reach for theirs.
    expect(await call({ running: true, ownedJobId: 'mine', activeJobId: 'theirs', engineBusy: true }))
      .toEqual({ abort: true, forceCancel: false })
    // Nothing running in the engine: the abort alone is enough.
    expect(await call({ running: true, ownedJobId: 'mine', activeJobId: 'mine', engineBusy: false }))
      .toEqual({ abort: true, forceCancel: false })
  })
})

// Unrecoverable state: threaded run unconfirmed shutdown may have pthreads alive; second engine on top is accumulation run slot prevents.
describe('the reload-required state', () => {
  it('blocks every run control and is never debounced or timed out', async () => {
    vi.resetModules()
    let blocked = false
    const unavailable = {
      available: false as const,
      reason: 'reload-required' as const,
      detail: 'A simulation could not be shut down cleanly.',
      jobId: 'j1',
      since: 1_700_000_000_000,
    }
    vi.doMock('./simc/job', () => ({
      engineBusy: () => false,
      engineStopping: () => false,
      engineAvailability: () => (blocked ? unavailable : { available: true }),
    }))
    const m = await import('./app.svelte')

    m.pollEngineSlot()
    expect(m.app.engineBlocked).toBeNull()
    expect(m.isBusy()).toBe(false)

    // One poll unlike stray streak: not a transient to ride out.
    blocked = true
    m.pollEngineSlot()
    expect(m.app.engineBlocked).toEqual(unavailable)
    expect(m.isBusy()).toBe(true)

    // Clears only when engine says available, never on own timer (elapsed time not evidence).
    blocked = false
    m.pollEngineSlot()
    expect(m.app.engineBlocked).toBeNull()
    expect(m.isBusy()).toBe(false)
    vi.doUnmock('./simc/job')
  })
})

// JobState with no STATUS_LABELS entry renders blank; hand-written in two files, drifted when 'queued' added.
describe('every job state has a label', () => {
  it('covers the engine layer\'s JobState exactly', async () => {
    const { STATUS_LABELS } = await import('./job.svelte')
    const { ACTIVE_STATUSES } = await import('./app.svelte')
    const states = [
      'idle', 'validating', 'queued', 'acquiring', 'initializing', 'running',
      'analyzing', 'complete', 'error', 'cancelled',
    ] as const
    for (const s of states) {
      expect(STATUS_LABELS[s], `label for ${s}`).toBeTruthy()
    }
    // Waiting for another tab is active work: cancellable, header says run live.
    expect(ACTIVE_STATUSES).toContain('queued')
    for (const done of ['idle', 'complete', 'error', 'cancelled'] as const) {
      expect(ACTIVE_STATUSES).not.toContain(done)
    }
  })
})

describe('reactive records cross the storage boundary as plain data', () => {
  it('saves report inputs, characters, setups and restored reports without clone errors', async () => {
    const db = await import('./store/db')
    const m = await import('./app.svelte')
    const { parseAddonExport } = await import('./import/character')
    const writes: { store: string; value: unknown }[] = []
    const put = vi.spyOn(db, 'put').mockImplementation(async (store, value) => {
      // IndexedDB clones input; a nested UI proxy must fail this check too.
      writes.push({ store, value: structuredClone(value) })
      return { ok: true, value: (value as { id: string }).id }
    })
    const settings = new Proxy({ threads: 4 }, {})
    const input = { selection: new Proxy({ head: ['one'] }, {}), settings }
    expect(() => structuredClone(input)).toThrow()
    const oldReports = [...m.app.reports]
    const oldCharacters = [...m.app.characters]
    const oldActive = m.app.activeCharacterId
    const oldDraft = m.app.draft
    try {
      const record = await m.saveReport({ tool: 'gear', title: 'Top Gear', completion: 'complete',
        requestSnapshot: input, summary: new Proxy({ dps: 100_000 }, {}) })
      settings.threads = 8
      // IndexedDB clones input; nested proxy must fail this check too.
      expect(writes[0]).toMatchObject({ store: 'reports', value: {
        requestSnapshot: { settings: { threads: 4 } }, summary: { dps: 100_000 },
      } })
      expect(m.app.reports[0].id).toBe(record.id)
      await m.saveCharacter(new Proxy(parseAddonExport('mage=Test\nlevel=90\nhead=,id=1'), {}))
      await m.saveSetup('gear', 'Setup', input)
      await m.restoreReport(new Proxy(record, {}))
      expect(writes.map((write) => write.store)).toEqual(['reports', 'characters', 'setups', 'reports'])
      expect(m.storageMessage(db.classifyStorageError(new DOMException('cannot clone', 'DataCloneError'))))
        .not.toMatch(/clear storage|could not be read/)
    } finally {
      put.mockRestore()
      m.app.reports = oldReports
      m.app.characters = oldCharacters
      m.app.activeCharacterId = oldActive
      m.app.draft = oldDraft
    }
  })
})
