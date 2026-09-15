import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAddonExport } from './character'
import {
  buildProfile, inheritedRunOptions, itemOptions, overrideLines, profilesetLines,
} from './serialize'

const FIXTURE = readFileSync(
  new URL('../../../tests/fixtures/addon-export-demonology.simc', import.meta.url),
  'utf8',
)
const c = parseAddonExport(FIXTURE)

describe('buildProfile', () => {
  it('round-trips the executable lines unchanged when nothing is overridden', () => {
    expect(buildProfile(c)).toBe(c.profileLines.join('\n') + '\n')
  })

  it('never emits a comment, so bag items cannot become equipped (P04.10)', () => {
    const text = buildProfile(c)
    expect(text.split('\n').some((l) => l.trim().startsWith('#'))).toBe(false)
    expect(text).not.toContain('Gear from Bags')
  })

  it('rebuilds an equipped item line losslessly', () => {
    const head = c.equipped.find((i) => i.slot === 'head')!
    expect(`head=${itemOptions(head)}`).toBe(head.line)
    const wrist = c.equipped.find((i) => i.slot === 'wrist')!
    expect(`wrist=${itemOptions(wrist)}`).toBe(wrist.line)
  })

  it('swaps one slot in place and leaves every other line alone', () => {
    const replacement = c.bag.find((i) => i.slot === 'head')!
    const text = buildProfile(c, { items: { head: replacement } })
    expect(text).toContain(`head=${itemOptions(replacement)}`)
    expect(text).not.toContain('id=271546')
    expect(text.split('\n').length).toBe(c.profileLines.length + 1)
  })

  it('empties a slot with null rather than dropping the line', () => {
    expect(buildProfile(c, { items: { trinket2: null } })).toContain('\ntrinket2=\n')
  })

  it('adds a slot the original profile never had', () => {
    const gloves = c.bag.find((i) => i.slot === 'hands') ?? c.equipped[0]
    const bare = parseAddonExport('mage=A\nlevel=80')
    expect(buildProfile(bare, { items: { hands: gloves } })).toContain('hands=,id=')
  })

  it('replaces talents in place and appends them when the profile had none', () => {
    const swapped = buildProfile(c, { talents: c.loadouts[0].talents })
    expect(swapped).toContain(`talents=${c.loadouts[0].talents}`)
    expect(swapped).not.toContain(`talents=${c.talents}`)
    expect(buildProfile(parseAddonExport('mage=A'), { talents: 'ABC' })).toContain('talents=ABC')
  })

  it('keeps prepend/append lines outside the character block', () => {
    const text = buildProfile(c, { prepend: ['# header'], append: ['actions+=/fire_blast'] })
    expect(text.startsWith('# header\n')).toBe(true)
    expect(text.trimEnd().endsWith('actions+=/fire_blast')).toBe(true)
  })
})

describe('overrideLines', () => {
  it('emits bare option lines for the engine layer to prefix', () => {
    const lines = overrideLines({
      talents: 'XYZ',
      items: { head: c.bag.find((i) => i.slot === 'head')! },
    })
    expect(lines[0]).toBe('talents=XYZ')
    expect(lines[1].startsWith('head=,id=')).toBe(true)
  })
})

describe('profilesetLines', () => {
  it('quotes the id and appends every line, including the first', () => {
    const lines = profilesetLines('c1', {
      talents: 'XYZ',
      items: { head: c.bag.find((i) => i.slot === 'head')! },
    })
    expect(lines[0]).toBe('profileset."c1"+=talents=XYZ')
    expect(lines[1].startsWith('profileset."c1"+=head=,id=')).toBe(true)
  })

  it('uses ids that survive simc tokenisation — no spaces, quotes or equals', () => {
    for (const line of profilesetLines('c12', { talents: 'A' })) {
      const name = /^profileset\."([^"]+)"/.exec(line)![1]
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe('inheritedRunOptions', () => {
  it('finds stopping options hidden in pasted text', () => {
    const pasted = parseAddonExport('mage=A\ntarget_error=0.2\niterations=50000')
    expect(inheritedRunOptions(pasted).map((o) => o.key).sort())
      .toEqual(['iterations', 'target_error'])
  })

  it('finds none in a plain addon export', () => {
    expect(inheritedRunOptions(c)).toEqual([])
  })
})

describe('item name token', () => {
  // simc item_t::parse_options: everything before FIRST comma is item NAME; missing: silent DPS loss.
  it('always emits a name token, so no slot is silently left empty', () => {
    const lines = [
      ...c.equipped.map((i) => i.line),
      ...c.equipped.map((i) => `${i.slot}=${itemOptions(i)}`),
      ...overrideLines({ items: { head: c.bag.find((i) => i.slot === 'head')! } }),
      ...overrideLines({ items: { trinket1: null } }),
      ...buildProfile(c, { items: { finger1: c.bag.find((i) => i.slot === 'finger1')! } })
        .split('\n')
        .filter((l) => /^(head|neck|finger1|trinket1|main_hand)=/.test(l)),
    ]
    for (const line of lines) {
      const value = line.slice(line.indexOf('=') + 1)
      if (!value) continue // an emptied slot carries no options at all
      const name = value.slice(0, value.indexOf(',') === -1 ? value.length : value.indexOf(','))
      expect(name, `"${line}" would be parsed as the item name "${name}"`).not.toContain('=')
    }
  })
})
