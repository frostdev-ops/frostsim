import { describe, expect, it } from 'vitest'
import {
  advancedCapability,
  findPreset,
  FIGHT_PRESETS,
  presetForStyle,
  UNMAPPED_FIGHT_STYLES,
} from './presets'
import { FIGHT_STYLES } from './options'
import type { EngineCapability, EngineManifest } from './capability'

const manifest: EngineManifest = {
  schemaVersion: 1,
  artifact: 'threaded',
  engine: { simcVersion: '1210-01', upstreamCommit: 'c015720' },
  wow: { clientDataVersion: '12.1.0.69814' },
  capabilities: {
    threads: true,
    pthreadPoolSize: 16,
    maxThreads: 16,
    profilesets: true,
    networking: false,
    reportVersions: [2],
  },
}

const threaded: EngineCapability = {
  ok: true,
  artifact: 'threaded',
  engineDir: '/engine/',
  maxThreads: 16,
  profilesets: true,
  manifest,
}

const fallback: EngineCapability = {
  ...threaded,
  artifact: 'fallback',
  engineDir: '/engine/fallback/',
  maxThreads: 1,
  profilesets: false,
}

describe('FIGHT_PRESETS', () => {
  it('carries the literal option lines, so nothing assembles a preset by hand', () => {
    expect(findPreset('patchwerk')?.options).toEqual(['fight_style=Patchwerk'])
    expect(findPreset('hectic-add-cleave')?.options).toEqual(['fight_style=HecticAddCleave'])
  })

  it('only names fight styles the engine actually has', () => {
    for (const preset of FIGHT_PRESETS) {
      if (!preset.fightStyle) continue
      expect(FIGHT_STYLES).toContain(preset.fightStyle)
    }
  })

  it('reaches every upstream fight style', () => {
    expect(UNMAPPED_FIGHT_STYLES).toEqual([])
  })

  it('builds the two synthetic scenarios from a pinned target, scoped to the enemy', () => {
    // enemy_fixed_health_percentage silently ignored as sim argument; must be profile lines under enemy, not options.
    expect(findPreset('target-dummy')?.profileLines).toEqual([
      'enemy=Fluffy_Pillow',
      'enemy_fixed_health_percentage=100',
    ])
    expect(findPreset('execute-patchwerk')?.profileLines).toEqual([
      'enemy=Fluffy_Pillow',
      'enemy_fixed_health_percentage=20',
    ])
    for (const id of ['target-dummy', 'execute-patchwerk']) {
      const preset = findPreset(id)!
      expect(preset.supported.ok).toBe(true)
      expect(preset.options).toEqual(['fight_style=Patchwerk'])
      // Never an option (silently-ignored channel).
      expect(preset.options.some((o) => o.startsWith('enemy'))).toBe(false)
    }
  })

  it('says plainly that the synthetics are not verified Raidbots parity', () => {
    for (const id of ['target-dummy', 'execute-patchwerk']) {
      expect(findPreset(id)?.parityNote).toMatch(/not verified to match Raidbots/)
    }
    // Plain upstream fight styles make no parity claim.
    expect(findPreset('patchwerk')?.parityNote).toBeUndefined()
    expect(findPreset('patchwerk')?.profileLines).toBeUndefined()
  })

  it('marks upstream styles Raidbots does not list as beyond parity', () => {
    expect(findPreset('dungeon-route')?.beyondParity).toBe(true)
    expect(findPreset('ultraxion')?.beyondParity).toBe(true)
    expect(findPreset('patchwerk')?.beyondParity).toBeUndefined()
  })

  it('has unique ids and finds a preset from a fight style', () => {
    expect(new Set(FIGHT_PRESETS.map((p) => p.id)).size).toBe(FIGHT_PRESETS.length)
    expect(presetForStyle('DungeonSlice')?.id).toBe('dungeon-slice')
  })

  it('claims no per-spec support, because that lives in the engine', () => {
    // No hand-maintained spec table; the engine answers per run via players[].validFightStyle.
    for (const preset of FIGHT_PRESETS) {
      expect(typeof preset.supported).toBe('object')
      expect('ok' in preset.supported).toBe(true)
    }
  })
})

describe('advancedCapability', () => {
  it('allows everything on the threaded build', () => {
    expect(advancedCapability(threaded)).toEqual({
      rawScript: true,
      multiActor: true,
      profilesets: true,
      reasons: [],
    })
  })

  it('disables profilesets on the fallback and says why, in both respects', () => {
    const cap = advancedCapability(fallback)
    expect(cap.profilesets).toBe(false)
    expect(cap.rawScript).toBe(true)
    expect(cap.multiActor).toBe(true)
    expect(cap.reasons.some((r) => r.includes('no profileset support'))).toBe(true)
    expect(cap.reasons.some((r) => r.includes('single-threaded'))).toBe(true)
  })

  it('disables everything, with the capability reason, when no engine is available', () => {
    const cap = advancedCapability({ ok: false, reason: 'no-isolation', detail: 'not isolated' })
    expect(cap).toEqual({ rawScript: false, multiActor: false, profilesets: false, reasons: ['not isolated'] })
    expect(advancedCapability(null).reasons).toHaveLength(1)
  })
})
