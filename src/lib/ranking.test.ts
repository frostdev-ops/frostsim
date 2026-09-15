import { describe, expect, it } from 'vitest'
import { hasWinner } from './ranking'

describe('hasWinner', () => {
  it('crowns a leader that is separated from the baseline AND above it', () => {
    expect(hasWinner({ mean: 183_000, indistinguishable: false }, 181_891)).toBe(true)
  })

  it('refuses to crown the best of several losses', () => {
    // The real case: separated from the baseline, but 1,350 DPS below it.
    expect(hasWinner({ mean: 180_541, indistinguishable: false }, 181_891)).toBe(false)
  })

  it('refuses to crown a gain that is inside the error bars', () => {
    expect(hasWinner({ mean: 182_000, indistinguishable: true }, 181_891)).toBe(false)
  })

  it('refuses to crown when significance was never tested', () => {
    expect(hasWinner({ mean: 183_000 }, 181_891)).toBe(false)
  })

  it('refuses to crown an empty ranking or a candidate with no result', () => {
    expect(hasWinner(undefined, 181_891)).toBe(false)
    expect(hasWinner({ indistinguishable: false }, 181_891)).toBe(false)
  })
})
