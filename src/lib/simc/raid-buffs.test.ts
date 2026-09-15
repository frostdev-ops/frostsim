import { expect, it } from 'vitest'
import { raidBuffLines } from './raid-buffs'

it('preserves profile defaults and emits only explicit supported boolean overrides', () => {
  expect(raidBuffLines({})).toEqual([])
  expect(raidBuffLines({ bloodlust: false, skyfury: true })).toEqual(['override.bloodlust=0', 'override.skyfury=1'])
  expect(raidBuffLines({ skyfury: 'yes', unknown: true } as never)).toEqual([])
})
