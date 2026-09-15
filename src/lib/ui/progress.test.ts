import { describe, expect, it } from 'vitest'
import {
  convergenceOf, fractionOf, highWater, MAX_ESTIMATED_PROGRESS, ProgressBuffer, logTone,
} from './progress'

it('colors engine severity and progress without changing log text', () => {
  expect(logTone('Error: Initialization error')).toBe('error')
  expect(logTone('Warning: value unverified')).toBe('warning')
  expect(logTone('Could not set process priority.')).toBe('warning')
  expect(logTone('Generating Baseline: 100/1000')).toBe('progress')
  expect(logTone('Completed simulation')).toBe('success')
  expect(logTone('ordinary output')).toBe('')
})

// Progress line shapes from progress_bar.cpp output() + update_normal().
const LINE = (iters: number) =>
  `Generating Baseline: 0/1 [==>.......] ${iters}/10000 15.234 Mean=223359 Error=0.190%`

describe('ProgressBuffer', () => {
  it('collapses repeated progress redraws into one log line', () => {
    const b = new ProgressBuffer()
    b.push(LINE(100))
    b.push(LINE(2000))
    b.push(LINE(5000))
    expect(b.lines.length).toBe(1)
    expect(b.progress?.iterations).toBe(5000)
  })

  it('keeps warnings even after ordinary lines are truncated (P01.12)', () => {
    const b = new ProgressBuffer(5)
    b.push('WARNING: unsupported option for this spec')
    for (let i = 0; i < 50; i++) b.push(`line ${i}`)
    expect(b.lines.length).toBe(5)
    expect(b.lines.join('\n')).not.toContain('WARNING')
    expect(b.warnings).toEqual(['WARNING: unsupported option for this spec'])
  })

  it('does not record the same warning twice', () => {
    const b = new ProgressBuffer()
    b.push('Error: bad thing')
    b.push('Error: bad thing')
    expect(b.warnings.length).toBe(1)
  })

  it('ignores blank lines and resets cleanly', () => {
    const b = new ProgressBuffer()
    b.push('   ')
    b.push(LINE(10))
    expect(b.lines.length).toBe(1)
    b.reset()
    expect(b.lines).toEqual([])
    expect(b.progress).toBeNull()
  })
})

describe('fractionOf', () => {
  it('is undefined until the engine reports an iteration total', () => {
    expect(fractionOf(null)).toBeUndefined()
    expect(fractionOf({ base: 'x', phaseIndex: 1, phaseTotal: 1, finished: false }))
      .toBeUndefined()
  })

  it('never exceeds 1, even when the engine overshoots its own total', () => {
    const p = { base: 'x', phaseIndex: 1, phaseTotal: 1, finished: false, iterations: 10_050, iterationTotal: 10_000 }
    expect(fractionOf(p)).toBe(1)
  })

  it('reports the real fraction mid-run', () => {
    const b = new ProgressBuffer()
    b.push(LINE(2500))
    expect(fractionOf(b.progress)).toBeCloseTo(0.25)
  })
})

describe('convergenceOf', () => {
  const at = (errorPct?: number) => ({
    base: 'Baseline', phaseIndex: 1, phaseTotal: 1, finished: false, errorPct,
  })

  it('tracks a falling error without ever claiming completion', () => {
    // Real sequence at target_error=0.2, happens to fall monotonically (run property, not value).
    const seen = [0.343, 0.299, 0.268, 0.223, 0.205, 0.193]
      .map((e) => convergenceOf(at(e), 0.343, 0.2)!)
    expect(seen[0]).toBe(0)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
    // Reaching target is engine's terminal report, not ours.
    expect(seen.at(-1)).toBe(MAX_ESTIMATED_PROGRESS)
    expect(seen.at(-1)).toBeLessThan(1)
  })

  it('handles an error that RISES mid-run instead of going negative', () => {
    // Reported error = estimator * stddev / mean; both move as samples accumulate.
    const rising = [0.40, 0.34, 0.52, 0.31, 0.90, 0.24]
      .map((e) => convergenceOf(at(e), 0.40, 0.2)!)
    expect(rising.every((v) => v >= 0 && v <= MAX_ESTIMATED_PROGRESS)).toBe(true)
    // Error worse than start = no progress (never negative).
    expect(rising[4]).toBe(0)
    // And it recovers (not stuck).
    expect(rising[5]).toBeGreaterThan(rising[3])
  })

  it('never reaches 1, so a bar cannot claim the target before the engine does', () => {
    expect(convergenceOf(at(0.0001), 0.5, 0.2)).toBe(MAX_ESTIMATED_PROGRESS)
    expect(convergenceOf(at(0.0001), 0.5, 0.2)).toBeLessThan(1)
  })

  it('treats zero and non-finite errors as no information, not as converged', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, undefined]) {
      expect(convergenceOf(at(bad as number), 0.4, 0.2)).toBeUndefined()
    }
  })

  it('rejects a non-finite or absent baseline or target', () => {
    for (const bad of [0, -1, NaN, Infinity, undefined]) {
      expect(convergenceOf(at(0.3), bad as number, 0.2)).toBeUndefined()
      expect(convergenceOf(at(0.3), 0.4, bad as number)).toBeUndefined()
    }
  })

  it('reports nothing when the run began already inside its target', () => {
    // No distance to travel, so any fraction would be invented.
    expect(convergenceOf(at(0.25), 0.19, 0.2)).toBeUndefined()
    expect(convergenceOf(at(0.18), 0.19, 0.2)).toBeUndefined()
  })

  it('is undefined with no progress at all', () => {
    expect(convergenceOf(null, 0.4, 0.2)).toBeUndefined()
  })
})

describe('highWater', () => {
  it('keeps the best estimate so a rising error does not drag the bar back', () => {
    let best: number | undefined
    for (const v of [0.1, 0.4, 0.2, 0.35, 0]) best = highWater(best, v)
    expect(best).toBe(0.4)
  })

  it('ignores gaps rather than resetting', () => {
    expect(highWater(0.6, undefined)).toBe(0.6)
    expect(highWater(undefined, undefined)).toBeUndefined()
    expect(highWater(undefined, 0.2)).toBe(0.2)
  })

  it('cannot exceed what convergenceOf will produce, so it cannot imply completion', () => {
    let best: number | undefined
    for (const e of [0.9, 0.5, 0.0001]) best = highWater(best, convergenceOf({
      base: 'x', phaseIndex: 1, phaseTotal: 1, finished: false, errorPct: e,
    }, 0.9, 0.2))
    expect(best).toBe(MAX_ESTIMATED_PROGRESS)
    expect(best).toBeLessThan(1)
  })
})
