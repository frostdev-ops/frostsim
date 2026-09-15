import { describe, expect, it } from 'vitest'
import { DEFAULT_STAGE_PLAN } from './optimization'
import { PRODUCT_STAGE_PLAN, STALL_TIMEOUT_MS, STALL_WARN_MS } from './searchPlan'

describe('search plan', () => {
  it('is the optimization track\'s default, with no override of its own', () => {
    // Local override that silently changes nothing is worse than none (reads as safeguard but protects nothing).
    expect(PRODUCT_STAGE_PLAN).toBe(DEFAULT_STAGE_PLAN)
  })

  it('narrows precision monotonically across its stages', () => {
    const targets = PRODUCT_STAGE_PLAN.stages
      .map((s) => (s.accuracy.mode === 'targetError' ? s.accuracy.targetError : null))
      .filter((t): t is number => t !== null)
    expect(targets.length).toBeGreaterThan(1)
    for (let i = 1; i < targets.length; i++) expect(targets[i]).toBeLessThan(targets[i - 1])
  })

  it('narrows the survivor count as it goes, so later stages are cheaper', () => {
    const survivors = PRODUCT_STAGE_PLAN.stages.map((s) => s.maxSurvivors)
    for (let i = 1; i < survivors.length; i++) {
      expect(survivors[i]).toBeLessThanOrEqual(survivors[i - 1])
    }
  })

  it('warns well before it gives up', () => {
    expect(STALL_WARN_MS).toBeLessThan(STALL_TIMEOUT_MS)
  })
})
