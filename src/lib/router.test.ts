// Route parsing: `s` (hosted report, CLAUDE.md D15) aliases the reports route only in account builds; `r`, `share` and ROUTES are unchanged.

import { describe, expect, it } from 'vitest'
import { parse, ROUTES } from './router.svelte'

describe('parse', () => {
  it('aliases s to reports only with the accounts flag', () => {
    expect(parse('#/s/AbCdEfGhIjKlMnOpQrStUv', true)).toEqual({ name: 'reports', rest: ['AbCdEfGhIjKlMnOpQrStUv'], raw: 's/AbCdEfGhIjKlMnOpQrStUv' })
    expect(parse('#/s/AbCdEfGhIjKlMnOpQrStUv', false).name).toBe('character')
  })

  it('defaults to the build flag, which is off in tests', () => {
    expect(parse('#/s/x').name).toBe('character')
  })

  it('leaves r, share, routes and unknown heads as they were, flag on or off', () => {
    for (const flag of [true, false]) {
      expect(parse('#/r/payload', flag).name).toBe('reports')
      expect(parse('#/share/payload', flag).name).toBe('character')
      expect(parse('#/account/guild/token', flag).name).toBe('character')
      expect(parse('#/quick', flag)).toEqual({ name: 'quick', rest: [], raw: 'quick' })
      expect(parse('', flag).name).toBe('character')
    }
    expect(ROUTES).not.toContain('s')
  })
})
