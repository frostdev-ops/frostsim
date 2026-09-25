// This device's speed and DPS spread (speed-store.ts), against an in-memory store.
import { describe, expect, it } from 'vitest'
import { localCv, localSpeed, recordRun, recordSample } from './speed-store'
import type { SimRequest } from './assemble'
import type { SimReport } from './report'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('speed store', () => {
  it('fits a fight style from its own runs, and from every run before its first', () => {
    const store = memory()
    recordSample('Patchwerk', { units: 1000, threads: 1, wall: 10 }, [], store)
    expect(localSpeed('DungeonRoute', store)).toEqual({ overheadS: 0, secondsPerUnit: 0.01 })
    recordSample('DungeonRoute', { units: 1000, threads: 1, wall: 40 }, [], store)
    recordSample('DungeonRoute', { units: 1000, threads: 1, wall: 40 }, [], store)
    expect(localSpeed('DungeonRoute', store)!.secondsPerUnit).toBe(0.04)
    expect(localSpeed('Patchwerk', store)!.secondsPerUnit).toBe(0.01)
  })

  it('averages the squared spread, so the iterations it predicts match the mix', () => {
    const store = memory()
    expect(localCv('Patchwerk', store)).toBeNull()
    recordSample('Patchwerk', { units: 0, threads: 1, wall: 0 }, [0.03, 0.04], store)
    expect(localCv('Patchwerk', store)).toBeCloseTo(Math.sqrt((0.0009 + 0.0016) / 2))
  })

  it('learns from a finished report, and never throws on one it cannot read', () => {
    const store = memory()
    const req = { schemaVersion: 1, profile: 'mage="Ann"', settings: { fightStyle: 'Patchwerk', maxTime: 300, targets: 1, threads: 8 },
      accuracy: { mode: 'iterations', iterations: 1000 } } as SimRequest
    const report = { players: [{ dps: { mean: 1000, stdDev: 50, count: 1000 } }], profilesets: [], options: { threads: 8 },
      timings: { engineElapsedSeconds: 30 } } as unknown as SimReport
    recordRun(req, report, undefined, store)
    expect(localSpeed('Patchwerk', store)!.secondsPerUnit).toBeCloseTo((30 * 8) / 300_000)
    expect(localCv('Patchwerk', store)).toBeCloseTo(0.05)
    expect(() => recordRun(req, {} as SimReport, undefined, store)).not.toThrow()
  })
})
