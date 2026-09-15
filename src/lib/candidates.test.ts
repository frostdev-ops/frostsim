import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAddonExport, type GearSlot } from './import/character'
import {
  buildCandidate, canFill, instanceCount, nextCandidateId, rankCandidates,
  type Candidate,
} from './candidates'

const c = parseAddonExport(
  readFileSync(new URL('../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8'),
)
const ring = c.bag.find((i) => i.slot === 'finger1')!
const head = c.bag.find((i) => i.slot === 'head')!

describe('slot interchange', () => {
  it('lets a ring fill either ring slot and a trinket either trinket slot', () => {
    expect(canFill(ring, 'finger2')).toBe(true)
    expect(canFill(ring, 'finger1')).toBe(true)
    expect(canFill(ring, 'neck')).toBe(false)
  })

  it('does not let a head item fill another slot', () => {
    expect(canFill(head, 'chest')).toBe(false)
    expect(canFill(head, 'head')).toBe(true)
  })
})

describe('buildCandidate', () => {
  it('records the change against the equipped baseline', () => {
    const cand = buildCandidate(c, { label: 'New helm', items: { head } }, 'c1')
    expect(cand.issues).toEqual([])
    expect(cand.changes[0].from?.itemId).toBe(271546)
    expect(cand.changes[0].to?.itemId).toBe(head.itemId)
    expect(cand.overrides.items?.head).toBe(head)
  })

  it('refuses an item in a slot it was never recorded for', () => {
    const cand = buildCandidate(c, { label: 'Nonsense', items: { chest: head } }, 'c1')
    expect(cand.issues[0]).toMatch(/cannot go in Chest/)
    expect(cand.overrides.items?.chest).toBeUndefined()
  })

  it('refuses to equip one owned copy in both ring slots', () => {
    expect(instanceCount(c, ring)).toBe(1)
    const cand = buildCandidate(
      c, { label: 'Double ring', items: { finger1: ring, finger2: ring } }, 'c1',
    )
    expect(cand.issues.some((i) => /cannot fill 2 slots/.test(i))).toBe(true)
    // First assignment stands; only impossible second is dropped.
    expect(cand.overrides.items?.finger1).toBe(ring)
    expect(cand.overrides.items?.finger2).toBeUndefined()
  })

  it('says which constraints it could not check rather than implying it did', () => {
    const weapon = c.bag.find((i) => i.slot === 'main_hand')!
    const cand = buildCandidate(c, { label: 'Weapon', items: { main_hand: weapon } }, 'c1')
    expect(cand.issues).toEqual([])
    expect(cand.unchecked.some((u) => /catalog loads/.test(u))).toBe(true)
  })

  it('takes rejections and remaining gaps from the catalog legality hook', () => {
    const weapon = c.bag.find((i) => i.slot === 'main_hand')!
    const rejected = buildCandidate(
      c, { label: 'Weapon', items: { main_hand: weapon } }, 'c1',
      () => ({ issues: ['two-handed weapon cannot be paired with an off hand'], unchecked: [] }),
    )
    expect(rejected.issues).toEqual(['two-handed weapon cannot be paired with an off hand'])
    expect(rejected.overrides.items?.main_hand).toBeUndefined()

    const allowed = buildCandidate(
      c, { label: 'Weapon', items: { main_hand: weapon } }, 'c1',
      () => ({ issues: [], unchecked: ['embellishment limit is advisory'] }),
    )
    expect(allowed.issues).toEqual([])
    expect(allowed.unchecked).toEqual(['embellishment limit is advisory'])
  })

  it('carries a talent loadout as its own change', () => {
    const loadout = c.loadouts[0]
    const cand = buildCandidate(
      c, { label: loadout.name, talents: { name: loadout.name, value: loadout.talents } }, 'c2',
    )
    expect(cand.overrides.talents).toBe(loadout.talents)
    expect(cand.changes[0].talents?.name).toBe(loadout.name)
  })
})

describe('nextCandidateId', () => {
  it('never reuses an id, even after a removal in the middle', () => {
    const list = [{ id: 'c1' }, { id: 'c3' }] as Candidate[]
    const id = nextCandidateId(list)
    expect(['c1', 'c3']).not.toContain(id)
  })

  it('produces ids simc can use as a profileset name', () => {
    expect(nextCandidateId([])).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('rankCandidates', () => {
  const cands = [
    { id: 'c1', label: 'Better', overrides: {}, changes: [], issues: [], unchecked: [] },
    { id: 'c2', label: 'Worse', overrides: {}, changes: [], issues: [], unchecked: [] },
    { id: 'c3', label: 'Dropped', overrides: {}, changes: [], issues: [], unchecked: [] },
    { id: 'c4', label: 'Illegal', overrides: {}, changes: [], issues: ['nope'], unchecked: [] },
  ] as Candidate[]
  const results = new Map([
    ['c1', { mean: 105_000, meanError: 300, iterations: 10_000 }],
    ['c2', { mean: 95_000, meanError: 300, iterations: 10_000 }],
  ])
  const ranked = rankCandidates(cands, results, { mean: 100_000, margin: 300 })

  it('orders by mean and puts missing and blocked candidates last', () => {
    expect(ranked.map((r) => r.candidate.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(ranked[2].status).toBe('missing')
    expect(ranked[3].status).toBe('blocked')
  })

  it('reports delta against the baseline without altering the raw mean', () => {
    expect(ranked[0].mean).toBe(105_000)
    expect(ranked[0].delta).toBe(5_000)
    expect(ranked[0].deltaPct).toBeCloseTo(5)
  })

  it('marks a difference inside the margin on the difference as indistinguishable', () => {
    // Margin on the difference is sqrt(300^2 + 300^2) = 424.3, not 600.
    const close = rankCandidates(
      [cands[0]],
      new Map([['c1', { mean: 100_400, meanError: 300 }]]),
      { mean: 100_000, margin: 300 },
    )
    expect(close[0].indistinguishable).toBe(true)
    expect(close[0].differenceMargin).toBeCloseTo(424.26, 1)

    const separated = rankCandidates(
      [cands[0]],
      new Map([['c1', { mean: 100_500, meanError: 300 }]]),
      { mean: 100_000, margin: 300 },
    )
    expect(separated[0].indistinguishable).toBe(false)
    expect(ranked[0].indistinguishable).toBe(false)
  })

  it('claims no tie when either side reported no error estimate', () => {
    const noError = rankCandidates(
      [cands[0]], new Map([['c1', { mean: 100_400 }]]), { mean: 100_000 },
    )
    expect(noError[0].indistinguishable).toBeUndefined()
  })
})

// Reproducible: second variant silently not added; click handler read picker state not render slot (null behind !).
// Screen fix captures slot at render. Guard: no interpolation of unlabeled slot.
describe('a slot with no label', () => {
  it('says Frostsim failed rather than rendering the word undefined', () => {
    const cand = buildCandidate(
      c,
      { label: 'broken', items: { ['not_a_slot' as GearSlot]: ring } },
      'c1',
    )
    expect(cand.issues).toHaveLength(1)
    expect(cand.issues[0]).not.toContain('undefined')
    expect(cand.issues[0]).toContain('bug in Frostsim')
    // And the variant carries no change, rather than a change to nowhere.
    expect(cand.changes).toHaveLength(0)
  })
})
