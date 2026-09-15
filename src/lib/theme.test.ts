import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ms, prefs, reducedMotion, setMotion, stagger } from './theme.svelte'

// P12.7: Svelte transitions don't see CSS media query; must ask and cover delay too.

describe('motion preference', () => {
  beforeEach(() => {
    setMotion('system')
    vi.unstubAllGlobals()
  })

  it('follows the OS when the user has not chosen', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(reducedMotion()).toBe(true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(reducedMotion()).toBe(false)
  })

  it('lets an explicit choice win over the OS in both directions', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    setMotion('reduced')
    expect(reducedMotion()).toBe(true)

    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    setMotion('full')
    expect(reducedMotion()).toBe(false)
    expect(prefs.motion).toBe('full')
  })

  it('zeroes durations AND stagger delays together', () => {
    setMotion('full')
    expect(ms('reveal')).toBeGreaterThan(0)
    expect(stagger(3)).toBeGreaterThan(0)

    setMotion('reduced')
    for (const token of ['control', 'nav', 'panel', 'dialog', 'reveal'] as const) {
      expect(ms(token)).toBe(0)
    }
    // Delay suppressed so rows don't appear one-at-a-time despite zero-length transition.
    for (const i of [0, 1, 5, 40]) expect(stagger(i)).toBe(0)
  })

  it('caps the stagger so a long list does not crawl in', () => {
    setMotion('full')
    expect(stagger(200)).toBe(stagger(8))
    expect(stagger(200)).toBeLessThanOrEqual(160)
  })

  it('survives a missing matchMedia rather than throwing', () => {
    vi.stubGlobal('matchMedia', undefined)
    setMotion('system')
    expect(reducedMotion()).toBe(false)
    expect(ms('panel')).toBeGreaterThan(0)
  })
})
