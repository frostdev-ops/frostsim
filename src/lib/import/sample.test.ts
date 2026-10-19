import { describe, expect, it } from 'vitest'
import { isBundledSample, SAMPLE_EXPORT } from './sample'
import { parseAddonExport } from './character'

describe('bundled sample provenance', () => {
  it('survives import and a portable JSON copy', () => {
    const imported = parseAddonExport(SAMPLE_EXPORT)
    expect(isBundledSample(imported)).toBe(true)
    expect(isBundledSample(JSON.parse(JSON.stringify(imported)))).toBe(true)
  })

  it('does not classify unrelated imports from placeholder identity alone', () => {
    expect(isBundledSample(parseAddonExport('warlock=Testchar\nregion=us\nserver=Testrealm\nspec=demonology'))).toBe(false)
    expect(isBundledSample({ raw: SAMPLE_EXPORT.replace('Testchar', 'Actualcharacter') })).toBe(false)
  })
})
