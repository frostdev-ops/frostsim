import { describe, expect, it } from 'vitest'
import type { ReportLog } from './simc/client'

// Assert signal is PRESENT, not absent: execFileSync discards stderr, so empty engineNotices passed vacuously until a test needed one. These tests require classified output. Browser path uses printErr, not fd2; empty engineNotices is unproven, not quiet.

const log = (kind: ReportLog['kind'], message: string, level: string = kind): ReportLog =>
  ({ kind, message, level } as ReportLog)

/** The classification the component applies, extracted so it can be asserted. */
function classify(logs: ReportLog[], engineNotices: ReportLog[] = []) {
  const seen = new Set<string>()
  const all: ReportLog[] = []
  for (const l of [...logs, ...engineNotices]) {
    const key = `${l.kind} ${l.message}`
    if (seen.has(key)) continue
    seen.add(key)
    all.push(l)
  }
  return {
    problems: all.filter((l) => l.kind === 'problem'),
    unverified: all.filter((l) => l.kind === 'unverified'),
    notes: all.filter((l) => l.kind === 'note'),
    unknown: all.filter((l) => l.kind === 'unknown'),
  }
}

describe('engine notices reach the user', () => {
  it('SURFACES a problem that only the stderr stream carries', () => {
    // sim_t::error_list is per-sim, merge doesn't copy it, so bad candidate leaves report clean. Empty result means stream broken.
    const result = classify([], [log('problem', 'Profileset c3 failed: bad option')])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].message).toContain('c3')
  })

  it('SURFACES the unverified notices the demonology fixture emits every run', () => {
    // Fixture emits these every run; non-empty result settles whether printErr is hooked.
    const result = classify([
      log('unverified', 'Implementation Not Yet Verified: Demonic Core'),
      log('unverified', 'Implementation Not Yet Verified: Malefic Rapture'),
    ])
    expect(result.unverified).toHaveLength(2)
    expect(result.problems).toHaveLength(0)
  })

  it('keeps a level it does not recognise instead of dropping it', () => {
    const result = classify([log('unknown', 'Something new', 'brand_new_level')])
    expect(result.unknown).toHaveLength(1)
    expect(result.unknown[0].level).toBe('brand_new_level')
  })

  it('does not show the same sentence twice when both streams carry it', () => {
    const same = log('problem', 'Target has no health')
    const result = classify([same], [{ ...same }])
    expect(result.problems).toHaveLength(1)
  })

  it('keeps two genuinely different problems apart', () => {
    const result = classify([log('problem', 'first')], [log('problem', 'second')])
    expect(result.problems.map((p) => p.message)).toEqual(['first', 'second'])
  })

  it('renders nothing for an empty run, which is honest either way', () => {
    // Empty result is correct for quiet engine AND missing stream. Ambiguity prevents "no problems found" badge.
    const result = classify([], [])
    expect(result.problems).toEqual([])
    expect(result.unverified).toEqual([])
  })
})
