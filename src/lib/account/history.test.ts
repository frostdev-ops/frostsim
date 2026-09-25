// Character history helpers (src/lib/account/history.ts): the game's average item level, gear changes between saves, and which
// local reports become DPS points.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAddonExport } from '../import/character'
import type { StoredReport } from '../store/records'
import { averageItemLevel, gearChanges, gearSnapshot, simPoint, type GearItem } from './history'

const RAW = readFileSync(new URL('../../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8')
const item = (slot: GearItem['slot'], ilvl?: number, itemId = 1): GearItem => ({ slot, itemId, ilvl })
const SIXTEEN: GearItem['slot'][] = ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'finger1',
  'finger2', 'trinket1', 'trinket2', 'main_hand', 'off_hand']

describe('averageItemLevel', () => {
  it('averages 16 slots, counts a lone main hand twice and an empty slot as 0, and gives null for an unknown level', () => {
    expect(averageItemLevel(SIXTEEN.map((s) => item(s, 600)))).toBe(600)
    expect(averageItemLevel(SIXTEEN.filter((s) => s !== 'off_hand').map((s) => item(s, s === 'main_hand' ? 616 : 600)))).toBe(602)
    expect(averageItemLevel(SIXTEEN.filter((s) => s !== 'head').map((s) => item(s, 640)))).toBe(600)
    expect(averageItemLevel([item('head', 600), item('neck')])).toBeNull()
  })

  it('reads the addon item levels of a real export', () => {
    const snap = gearSnapshot(parseAddonExport(RAW))
    expect(snap.gear.every((g) => g.slot !== 'shirt' && g.slot !== 'tabard')).toBe(true)
    expect(snap.itemLevel).toBeGreaterThan(100)
  })
})

describe('gearChanges', () => {
  it('lists slots whose item or item level changed, including ones emptied or filled', () => {
    const before = [item('head', 600, 1), item('trinket1', 610, 2), item('back', 600, 3)]
    const after = [item('head', 600, 1), item('trinket1', 636, 2), item('neck', 620, 4)]
    expect(gearChanges(before, after).map((c) => [c.slot, c.from?.ilvl, c.to?.ilvl])).toEqual([
      ['neck', undefined, 620], ['back', 600, undefined], ['trinket1', 610, 636],
    ])
    expect(gearChanges(before, before)).toEqual([])
  })
})

describe('simPoint', () => {
  const report = (over: Partial<StoredReport>): StoredReport => ({
    id: 'r1', tool: 'quick', title: 't', characterLabel: 'c', requestSnapshot: { settings: { fightStyle: 'Patchwerk', targets: 1 } },
    engine: { wowVersion: '12.1.0' }, completion: 'complete', summary: { dps: 1000, confidenceMargin: 5 }, hasRaw: false, createdAt: 0, pinned: false, ...over,
  })
  it('takes finished Quick Sims with a DPS and nothing else', () => {
    expect(simPoint(report({}))).toEqual({ reportId: 'r1', createdAt: '1970-01-01T00:00:00.000Z', dps: 1000, dpsError: 5, fightStyle: 'Patchwerk', targets: 1, gameBuild: '12.1.0' })
    expect(simPoint(report({ tool: 'gear' }))).toBeNull()
    expect(simPoint(report({ completion: 'partial' }))).toBeNull()
    expect(simPoint(report({ summary: {} }))).toBeNull()
  })
})
