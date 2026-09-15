import { describe, expect, it } from 'vitest'
import { hypotheticalItem, isHypothetical, itemLevelChoices } from './hypothetical'
import { itemOptions } from './import/serialize'

describe('hypotheticalItem', () => {
  it('serialises through the normal path with a name token and an ilevel override', () => {
    const item = hypotheticalItem({ itemId: 251136, slot: 'finger1', itemLevel: 489, bonusIds: [1, 2] })
    const line = `finger1=${itemOptions(item)}`
    // Text before first comma is simc item NAME; option there silently equips nothing (item.cpp:834).
    const name = line.slice(line.indexOf('=') + 1).split(',')[0]
    expect(name).not.toContain('=')
    expect(line).toContain('id=251136')
    expect(line).toContain('bonus_id=1/2')
    expect(line).toContain('ilevel=489')
  })

  it('is always marked so the UI cannot present it as owned', () => {
    expect(isHypothetical(hypotheticalItem({ itemId: 1, slot: 'head' }))).toBe(true)
  })

  it('marks an owned custom-level variant or assumed track as hypothetical', () => {
    const owned = { ...hypotheticalItem({ itemId: 1, slot: 'head' }), source: 'equipped' as const }
    expect(isHypothetical(owned)).toBe(false)
    expect(isHypothetical({ ...owned, originalInstanceId: owned.instanceId, itemLevel: 500 })).toBe(true)
    expect(isHypothetical({ ...owned, upgradeTrackHypothetical: true })).toBe(true)
    expect(isHypothetical({ ...owned, originalInstanceId: owned.instanceId, instanceId: 'upgraded-copy' })).toBe(true)
    expect(isHypothetical({ ...owned, source: 'vault', vaultRewardId: 'weekly-choice' })).toBe(false)
  })

  it('gives two item levels of the same item distinct identities', () => {
    const a = hypotheticalItem({ itemId: 9, slot: 'head', itemLevel: 480 })
    const b = hypotheticalItem({ itemId: 9, slot: 'head', itemLevel: 502 })
    expect(a.instanceId).not.toBe(b.instanceId)
  })

  it('is stable: the same input always yields the same id', () => {
    const input = { itemId: 9, slot: 'head' as const, itemLevel: 480, bonusIds: [3] }
    expect(hypotheticalItem(input).instanceId).toBe(hypotheticalItem(input).instanceId)
  })
})

describe('itemLevelChoices', () => {
  it('brackets the item is own level and stays inside the usable range', () => {
    const choices = itemLevelChoices(320)
    expect(choices).toContain(320)
    expect(Math.min(...choices)).toBe(290)
    expect(Math.max(...choices)).toBe(350)
    expect(choices.every((n) => n >= 1 && n <= 1000)).toBe(true)
  })

  it('returns nothing for an item whose level is unknown', () => {
    expect(itemLevelChoices(0)).toEqual([])
    expect(itemLevelChoices(NaN)).toEqual([])
  })

  it('never offers a level below 1', () => {
    expect(itemLevelChoices(5).every((n) => n >= 1)).toBe(true)
  })
})
