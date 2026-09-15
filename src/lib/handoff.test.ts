import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ItemInstance } from './import/character'

// P09.10: handoff's whole point is EXACT instance travels; rebuilding from id would evaluate different item (different bonus ids, item level, gems) and report confident number for it.

const item = (id: string, over: Partial<ItemInstance> = {}): ItemInstance => ({
  instanceId: id,
  source: 'hypothetical',
  slot: 'trinket1',
  itemId: 271564,
  bonusIds: [10390, 6652, 12040],
  gemIds: [213743],
  enchantId: 7346,
  itemLevel: 668,
  extra: {},
  optionOrder: [],
  line: '',
  lineNumber: 0,
  ...over,
})

describe('item handoff', () => {
  beforeEach(() => vi.resetModules())

  it('preserves a winning setup’s consumables, buffs and fight settings for its character', async () => {
    const m = await import('./handoff.svelte')
    const setup = { characterId: 'c1', label: 'Winner', items: {}, talents: 'active',
      consumables: { flask: 'disabled' }, extraProfileLines: ['override.bloodlust=0'],
      settings: { fightStyle: 'HecticAddCleave' as const, targets: 5, maxTime: 180, loadoutName: null } }
    m.sendSetup(setup)
    expect(m.takeSetup('c2')).toBeNull()
    expect(m.takeSetup('c1')).toEqual(setup)
    expect(m.takeSetup('c1')).toBeNull()
  })

  it('delivers the identical object, not a copy built from the item id', async () => {
    const m = await import('./handoff.svelte')
    const sent = item('inst-1')
    m.sendItems('gear', [{ item: sent, slot: 'trinket1', source: 'Some Raid', characterId: 'c1' }])
    const [got] = m.takeHandoff('gear', 'c1')
    expect(got.item).toBe(sent)
    expect(got.item.bonusIds).toEqual([10390, 6652, 12040])
    expect(got.item.gemIds).toEqual([213743])
    expect(got.item.enchantId).toBe(7346)
    expect(got.item.itemLevel).toBe(668)
    expect(got.item.source).toBe('hypothetical')
    expect(got.source).toBe('Some Raid')
  })

  it('never delivers one character’s item to another', async () => {
    const m = await import('./handoff.svelte')
    m.sendItems('gear', [{ item: item('i'), slot: 'head', source: 'x', characterId: 'c1' }])
    expect(m.takeHandoff('gear', 'c2')).toEqual([])
    // And it is still waiting for the character it was meant for.
    expect(m.takeHandoff('gear', 'c1')).toHaveLength(1)
  })

  it('keeps the two targets separate', async () => {
    const m = await import('./handoff.svelte')
    m.sendItems('gear', [{ item: item('g'), slot: 'head', source: 'x', characterId: 'c1' }])
    m.sendItems('compare', [{ item: item('c'), slot: 'head', source: 'x', characterId: 'c1' }])
    expect(m.takeHandoff('gear', 'c1').map((h) => h.item.instanceId)).toEqual(['g'])
    expect(m.takeHandoff('compare', 'c1').map((h) => h.item.instanceId)).toEqual(['c'])
  })

  it('collapses a repeated send rather than making two candidates', async () => {
    const m = await import('./handoff.svelte')
    const h = { item: item('same'), slot: 'head' as const, source: 'x', characterId: 'c1' }
    m.sendItems('gear', [h])
    m.sendItems('gear', [h])
    expect(m.takeHandoff('gear', 'c1')).toHaveLength(1)
  })

  it('is empty after being taken, so an item cannot arrive twice', async () => {
    const m = await import('./handoff.svelte')
    m.sendItems('gear', [{ item: item('i'), slot: 'head', source: 'x', characterId: 'c1' }])
    expect(m.takeHandoff('gear', 'c1')).toHaveLength(1)
    expect(m.takeHandoff('gear', 'c1')).toEqual([])
  })

  it('leaves the item pending when nobody has taken it yet', async () => {
    const m = await import('./handoff.svelte')
    m.sendItems('gear', [{ item: item('i'), slot: 'head', source: 'x', characterId: 'c1' }])
    // peek must not consume: failed merge on receiving side would discard item silently.
    expect(m.peekHandoff('gear', 'c1')).toHaveLength(1)
    expect(m.peekHandoff('gear', 'c1')).toHaveLength(1)
  })
})
