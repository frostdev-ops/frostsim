import { describe, expect, it } from 'vitest'
import { candidatesDone, latestProgress, parseProgressLine } from './progress'

// Real engine output: bar rewritten in place with \r; chunk can hold several.

describe('parseProgressLine, progressbar_type=1 records', () => {
  // Real run data: 3000 iterations, target_error=0.2, 4 threads (app format, not CR-terminated).
  it('reads a converging run, where mean and error are present', () => {
    const p = parseProgressLine('Baseline\t1\t1\t407\t737\t364.088\t222123.643\t0.270\t0.227')
    expect(p).toMatchObject({
      base: 'Baseline',
      phase: undefined,
      phaseIndex: 1,
      phaseTotal: 1,
      iterations: 407,
      iterationTotal: 737,
      finished: false,
    })
    expect(p?.iterationsPerSecond).toBeCloseTo(364.088, 3)
    expect(p?.mean).toBeCloseTo(222123.643, 3)
    expect(p?.errorPct).toBeCloseTo(0.27, 3)
    expect(p?.etaSeconds).toBeCloseTo(0.227, 3)
  })

  it('reads a fixed-iteration run, where there is no running estimate to read', () => {
    const p = parseProgressLine('Baseline\t1\t1\t500\t1000\t364.088\t1.250')
    expect(p?.iterations).toBe(500)
    expect(p?.mean).toBeUndefined()
    expect(p?.errorPct).toBeUndefined()
    expect(p?.etaSeconds).toBeCloseTo(1.25, 3)
  })

  it('reads a named phase, and does not mistake it for the phase index', () => {
    const p = parseProgressLine('Profileset\tc-0001\t2\t4\t50\t300\t120.5\t3.0')
    expect(p).toMatchObject({
      base: 'Profileset',
      phase: 'c-0001',
      phaseIndex: 2,
      phaseTotal: 4,
      iterations: 50,
      iterationTotal: 300,
    })
  })

  it('ignores a trailing human-readable estimate rather than reading it as a number', () => {
    const p = parseProgressLine('Baseline\t1\t3\t100\t1000\t50.0\t222000.0\t0.9\t12.5\t1m, 4s')
    expect(p?.mean).toBeCloseTo(222000, 1)
    expect(p?.etaSeconds).toBeCloseTo(12.5, 3)
  })

  it('marks a completed phase and stops reporting time remaining', () => {
    const p = parseProgressLine('Baseline\t1\t1\t805\t805\t372.004\t222130.596\t0.192\t0.541')
    expect(p?.finished).toBe(true)
    expect(p?.etaSeconds).toBeUndefined()
  })

  it('discards a tab-bearing line that is not a progress record', () => {
    // The engine leaves base_str set, so other output can pick up the prefix.
    expect(parseProgressLine('Baseline Performance:\tsomething\telse')).toBeNull()
    expect(parseProgressLine('Baseline\t1\t1')).toBeNull()
    expect(parseProgressLine('Baseline\ta\tb\tc\td\te')).toBeNull()
  })

  it('rejects a record whose current exceeds its total', () => {
    expect(parseProgressLine('Baseline\t1\t1\t900\t800\t1.0\t1.0')).toBeNull()
  })
})

describe('parseProgressLine', () => {
  it('reads a plain run', () => {
    const p = parseProgressLine('Generating Baseline: 1/1 [==>.................] 7/50 52.478')
    expect(p).toMatchObject({
      base: 'Baseline',
      phase: undefined,
      phaseIndex: 1,
      phaseTotal: 1,
      iterations: 7,
      iterationTotal: 50,
      finished: false,
    })
    expect(p?.iterationsPerSecond).toBeCloseTo(52.478, 3)
  })

  it('reads a profileset id containing spaces and a slash', () => {
    // Phase name "c 0003 / weird" is ambiguous with counter without bracket anchors.
    const p = parseProgressLine(
      'Generating Profileset: c 0003 / weird 2/4 [=====>..............] 9/30 249.399 (0s)',
    )
    expect(p).toMatchObject({
      base: 'Profileset',
      phase: 'c 0003 / weird',
      phaseIndex: 2,
      phaseTotal: 4,
      iterations: 9,
      iterationTotal: 30,
    })
  })

  it('reads the running mean and error only when the engine emits them', () => {
    const converging = parseProgressLine(
      'Generating Baseline: 1/1 [===>................] 9/50 60.239 Mean=223974 Error=0.912% 12sec',
    )
    expect(converging?.mean).toBe(223974)
    expect(converging?.errorPct).toBeCloseTo(0.912, 3)

    // Fixed-iteration run has no running estimate; don't invent one.
    const fixed = parseProgressLine('Generating Baseline: 1/1 [===>................] 9/50 60.239')
    expect(fixed?.mean).toBeUndefined()
    expect(fixed?.errorPct).toBeUndefined()
  })

  it('reads the time remaining the engine prints, and only while it means that', () => {
    expect(
      parseProgressLine('Generating Baseline: 1/1 [===>................] 9/50 60.239 Mean=223974 Error=0.912% 12sec')
        ?.etaSeconds,
    ).toBe(12)
    expect(parseProgressLine('Generating Baseline: 1/1 [=>..................] 3/50 10.0 2min 5sec')?.etaSeconds).toBe(125)
    // On a finished line the engine reuses those tokens for elapsed time, so
    // there is no remaining time to report.
    expect(
      parseProgressLine('Generating Baseline: 1/3 [===================>] 30/30 128.931 58msec')?.etaSeconds,
    ).toBeUndefined()
    // "58msec" must never be read as 58 seconds.
    expect(parseProgressLine('Generating Baseline: 1/3 [======>.............] 11/30 60.8 58msec')?.etaSeconds).toBeUndefined()
    expect(parseProgressLine('Generating Baseline: 1/1 [=>..................] 3/50 10.0')?.etaSeconds).toBeUndefined()
  })

  it('marks a completed phase', () => {
    const done = parseProgressLine('Generating Baseline: 1/3 [===================>] 30/30 129.010')
    expect(done?.finished).toBe(true)
    const running = parseProgressLine('Generating Baseline: 1/3 [==============>.....] 22/30 102.509')
    expect(running?.finished).toBe(false)
  })

  it('reads the parallel profileset line, which reports no iterations', () => {
    const p = parseProgressLine(
      'Profilesets (2*4): 7/32 [====>...............] avg=1s done=8s left=25s',
    )
    expect(p).toMatchObject({ base: 'Profilesets', phaseIndex: 7, phaseTotal: 32, finished: false })
    expect(p?.iterations).toBeUndefined()
  })

  it('takes the newest revision when a chunk holds several redraws', () => {
    const chunk =
      'Generating Baseline: 1/1 [=>..................] 3/50 10.0\rGenerating Baseline: 1/1 [====>...............] 13/50 80.080'
    expect(parseProgressLine(chunk)?.iterations).toBe(13)
  })

  it('returns null for everything that is not a progress bar', () => {
    expect(parseProgressLine('Generating reports...')).toBeNull()
    expect(parseProgressLine('  DPS=223973.7 DPS-Error=2137.5/0.95%')).toBeNull()
    expect(parseProgressLine('')).toBeNull()
    expect(parseProgressLine('Simulating... ( iterations=40, threads=4 )')).toBeNull()
  })
})

describe('latestProgress', () => {
  it('picks the last progress line in a batch and ignores the rest', () => {
    const lines = [
      'Generating Baseline: 1/1 [=>..................] 3/50 10.0',
      'some other engine chatter',
      'Generating Baseline: 1/1 [====>...............] 13/50 80.080',
      'more chatter',
    ]
    expect(latestProgress(lines)?.iterations).toBe(13)
  })

  it('is null when a batch holds no progress at all', () => {
    expect(latestProgress(['hello', 'world'])).toBeNull()
  })
})

describe('candidatesDone', () => {
  it('discounts the baseline phase, which is not a candidate', () => {
    const p = parseProgressLine('Generating Profileset: c-2 3/4 [==>.................] 5/30 1.0')!
    expect(candidatesDone(p, 3)).toBe(2)
  })

  it('counts nothing done while the baseline is still running', () => {
    const p = parseProgressLine('Generating Baseline: 1/4 [==>.................] 5/30 1.0')!
    expect(candidatesDone(p, 3)).toBe(0)
  })

  it('does not shift the parallel line, which already counts candidates', () => {
    const p = parseProgressLine('Profilesets (2*4): 7/32 [====>...] avg=1s done=8s left=25s')!
    expect(candidatesDone(p, 32)).toBe(7)
  })

  it('never reports more done than were requested', () => {
    const p = parseProgressLine('Generating Profileset: c-9 99/99 [==>...] 5/30 1.0')!
    expect(candidatesDone(p, 3)).toBe(3)
  })
})
