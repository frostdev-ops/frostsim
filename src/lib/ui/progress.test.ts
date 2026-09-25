import { describe, expect, it } from 'vitest'
import {
  fractionOf, highWater, ProgressBuffer, logTone,
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
})
