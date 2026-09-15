import { describe, expect, it } from 'vitest'
import { canNormalizeWeights } from './advanced.svelte'

describe('canNormalizeWeights', () => {
  it('refuses to normalise when no primary attribute is scaled', () => {
    expect(canNormalizeWeights({ selected: ['crit', 'haste', 'mastery', 'versatility'], normalize: true }))
      .toBe(false)
  })

  it('normalises when a primary attribute is among the scaled stats', () => {
    expect(canNormalizeWeights({ selected: ['intellect', 'crit'], normalize: true })).toBe(true)
    expect(canNormalizeWeights({ selected: ['agility'], normalize: true })).toBe(true)
  })

  it('normalises an empty selection, which scales every relevant stat', () => {
    expect(canNormalizeWeights({ selected: [], normalize: true })).toBe(true)
  })

  it('is off when the user did not ask for it', () => {
    expect(canNormalizeWeights({ selected: ['intellect'], normalize: false })).toBe(false)
  })
})
