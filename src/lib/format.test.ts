import { describe, expect, it } from 'vitest'
import { fmtBytes, fmtDelta, fmtDeltaPct, fmtInt, fmtPct, fmtSeconds, titleCase, plainGameText } from './format'

describe('format', () => {
  it('removes game-only quality atlases without changing the label', () => {
    expect(plainGameText("|cffa335eeRite of the Hash'ey|r |A:Professions-ChatIcon-Quality-12-Tier2:20:20|a"))
      .toBe("Rite of the Hash'ey")
  })
  it('renders an em dash rather than NaN for non-finite input', () => {
    for (const f of [fmtInt, fmtPct, fmtDelta, fmtSeconds, fmtBytes]) {
      expect(f(NaN)).toBe('—')
      expect(f(Infinity)).toBe('—')
    }
  })

  it('signs deltas with a real minus sign and marks exact zero', () => {
    expect(fmtDelta(1234.6)).toBe('+1,235')
    expect(fmtDelta(-1234.6)).toBe('−1,235')
    expect(fmtDelta(0)).toBe('0')
    expect(fmtDeltaPct(-0.5)).toBe('−0.50%')
  })

  it('formats percentages that are already percentages', () => {
    expect(fmtPct(0.19)).toBe('0.19%')
    expect(fmtPct(0.19, 1)).toBe('0.2%')
  })

  it('formats durations and sizes', () => {
    expect(fmtSeconds(0.7)).toBe('0.7s')
    expect(fmtSeconds(125)).toBe('2m 5s')
    expect(fmtBytes(60_300_000)).toBe('57.5 MB')
  })

  it('title-cases simc tokens', () => {
    expect(titleCase('main_hand')).toBe('Main Hand')
    expect(titleCase('demonology')).toBe('Demonology')
  })
})
