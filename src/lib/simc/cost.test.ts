import { describe, expect, it } from 'vitest'
import { canSplitCharacters } from './cost'
import { DEFAULT_SETTINGS } from './options'
import type { SimRequest } from './assemble'

const request = (over: Partial<SimRequest> = {}): SimRequest => ({
  schemaVersion: 1, profile: 'mage=One\npriest=Two', settings: { ...DEFAULT_SETTINGS, threads: 1 },
  accuracy: { mode: 'iterations', iterations: 1000 }, ...over,
})

describe('effective character independence (audit E4)', () => {
  it('requires independent batches after the guided default and final expert arguments', () => {
    expect(canSplitCharacters(request())).toBe(true)
    expect(canSplitCharacters(request({ extraOptions: ['single_actor_batch=0'] }))).toBe(false)
    expect(canSplitCharacters(request({ extraOptions: ['single_actor_batch=0', 'single_actor_batch=1'] }))).toBe(true)
    expect(canSplitCharacters(request({ profile: 'mage=One\nsingle_actor_batch=0\npriest=Two' }))).toBe(true)
  })

  it('uses all assembled raw sources in engine order', () => {
    expect(canSplitCharacters(request({ mode: 'raw' }))).toBe(false)
    expect(canSplitCharacters(request({ mode: 'raw', profile: 'single_actor_batch=1\nmage=One\npriest=Two' }))).toBe(true)
    expect(canSplitCharacters(request({ mode: 'raw', slots: { header: 'single_actor_batch=1', footer: 'single_actor_batch=0' } }))).toBe(false)
    expect(canSplitCharacters(request({ mode: 'raw', extraProfileLines: ['single_actor_batch=1'], slots: { footer: '# single_actor_batch=0' } }))).toBe(true)
    expect(canSplitCharacters(request({ mode: 'raw', extraProfileLines: ['single_actor_batch=1'], extraOptions: ['single_actor_batch=0'] }))).toBe(false)
  })

  it('does not interpret a candidate or a quoted actor name as a global batch setting', () => {
    expect(canSplitCharacters(request({ extraOptions: ['name="single_actor_batch=0"'] }))).toBe(true)
    expect(canSplitCharacters(request({ mode: 'raw', profile: 'mage="single_actor_batch=1"' }))).toBe(false)
    expect(canSplitCharacters(request({ extraOptions: ['single_actor_batch=$(batch)'] }))).toBe(false)
  })
})
