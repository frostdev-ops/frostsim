import { expect, it, vi } from 'vitest'
import { clearTrace, readTrace, trace } from './trace'

it('records diagnostics only with consent, deletes them on withdrawal, and tolerates blocked storage', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    trace('before-consent')
    expect(readTrace()).toEqual([])
    expect(log).not.toHaveBeenCalled()
    values.set('frostsim.storage-choice.v1', 'diagnostics')
    trace('accepted')
    expect(readTrace()).toHaveLength(1)
    values.set('frostsim.storage-choice.v1', 'necessary')
    clearTrace()
    trace('rejected')
    expect(readTrace()).toEqual([])
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked') } })
    expect(() => trace('blocked')).not.toThrow()
  } finally {
    log.mockRestore()
    vi.unstubAllGlobals()
  }
})
