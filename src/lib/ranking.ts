// When ranked comparison can name winner; pure claim about statistics, not layout.

export interface RankedPoint {
  /** Absent when the engine returned no result for this candidate. */
  mean?: number
  // True = inside bars, false = separated, undefined = no estimate from either side.
  indistinguishable?: boolean
}

// Two conditions: SEPARATED from baseline AND ABOVE it. Separation alone lets worst loss wear crown.
export function hasWinner(leader: RankedPoint | undefined, baselineMean: number): boolean {
  if (!leader || leader.mean === undefined) return false
  return leader.indistinguishable === false && leader.mean > baselineMean
}
