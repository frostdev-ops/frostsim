// Per-screen character picks (app.svelte.ts): each screen keeps its own character, others follow the last pick, the unsaved draft
// is a pick like any other, and deleting a character sends its screens to the next one.
import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportedCharacter } from './import/character'
import type { StoredCharacter } from './store/records'

const m = await import('./app.svelte')
const { app, DRAFT, activeCharacter, activeStored, focusScope, openDraft, pickCharacter, pickFor, runCharacter } = m
const char = (name: string, className = 'mage') => ({ name, className, spec: 'frost', equipped: [], bag: [], loadouts: [] }) as unknown as ImportedCharacter
const stored = (id: string, name: string): StoredCharacter => ({ id, label: name, character: char(name), pinned: false, createdAt: 0, updatedAt: 0 })

beforeEach(() => {
  app.characters = [stored('a', 'Alpha'), stored('b', 'Beta'), stored('c', 'Gamma')]
  app.picks = {}
  app.lastPick = null
  app.draft = null
  focusScope(null)
})

describe('character picks', () => {
  it('falls back to the newest character, then follows the last pick on screens without their own', () => {
    focusScope('quick')
    expect(activeStored()?.id).toBe('a')
    pickCharacter('b')
    focusScope('gear')
    expect(activeStored()?.id).toBe('b')
  })

  it('keeps each screen on its own character', () => {
    focusScope('quick')
    pickCharacter('b')
    focusScope('gear')
    pickCharacter('c')
    focusScope('quick')
    expect(activeStored()?.id).toBe('b')
    focusScope('gear')
    expect(activeStored()?.id).toBe('c')
  })

  it('opens a draft on one screen without moving the others, and never makes it the default elsewhere', () => {
    focusScope('gear')
    pickCharacter('c')
    openDraft(char('Edited'), 'quick')
    expect(app.activeCharacterId).toBe('c')
    focusScope('quick')
    expect(activeCharacter()?.name).toBe('Edited')
    expect(activeStored()).toBeNull()
    expect(runCharacter()).toMatchObject({ id: undefined, label: 'Edited' })
    focusScope('compare')
    expect(app.activeCharacterId).toBe('c')
    app.draft = null
    expect(pickFor('quick')).toBe('c')
  })

  it('skips a stale pick', () => {
    app.picks = { quick: 'gone' }
    app.lastPick = 'b'
    expect(pickFor('quick')).toBe('b')
    app.lastPick = 'gone'
    expect(pickFor('quick')).toBe('a')
    expect(DRAFT).toBe('draft')
  })
})
