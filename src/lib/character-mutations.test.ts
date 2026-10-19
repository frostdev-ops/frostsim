import { beforeEach, expect, it, vi } from 'vitest'
import { parseAddonExport } from './import/character'
import type { StoredCharacter } from './store/records'

const mocks = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }))
vi.mock('./store/db', () => ({ ...mocks, storageUsage: vi.fn(async () => null) }))
const characters = await import('./app.svelte')
const raw = (version: string) => `mage=Ana\nlevel=90\nspec=frost\n# ${version}`
const parsed = (version: string) => parseAddonExport(raw(version))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  characters.app.characters = []
  mocks.put.mockReset().mockResolvedValue({ ok: true })
  mocks.del.mockReset().mockResolvedValue({ ok: true })
})

it('orders persistence and app state for a save followed by a delete while the save is pending', async () => {
  const blocked = deferred()
  const started = deferred()
  const disk = new Map<string, StoredCharacter>()
  mocks.put.mockImplementation(async (_store: string, record: StoredCharacter) => {
    started.resolve()
    await blocked.promise
    disk.set(record.id, record)
    return { ok: true }
  })
  mocks.del.mockImplementation(async (_store: string, id: string) => { disk.delete(id); return { ok: true } })
  const saving = characters.saveCharacter(parsed('old'), 'Ana', 'l1')
  await started.promise
  const deleting = characters.deleteCharacter('l1')
  blocked.resolve()
  await Promise.all([saving, deleting])
  expect(characters.app.characters).toEqual([])
  expect(disk.size).toBe(0)
})

it('rejects an optimistic download after a newer save starts, even in the same clock millisecond', async () => {
  await characters.saveCharacter(parsed('initial'), 'Ana', 'l1')
  const revision = characters.characterRevision('l1')
  const blocked = deferred()
  const started = deferred()
  mocks.put.mockImplementationOnce(async () => { started.resolve(); await blocked.promise; return { ok: true } })
  const saving = characters.saveCharacter(parsed('new'), 'Ana', 'l1')
  await started.promise
  const downloading = characters.saveCharacterIfUnchanged(parsed('cloud'), 'Ana', 'l1', revision)
  blocked.resolve()
  await saving
  expect(await downloading).toBeUndefined()
  expect(characters.app.characters[0]!.character.raw).toBe(raw('new'))
})

it('finishes a delete after a download that already started persistence', async () => {
  await characters.saveCharacter(parsed('initial'), 'Ana', 'l1')
  const revision = characters.characterRevision('l1')
  const blocked = deferred()
  const started = deferred()
  mocks.put.mockImplementationOnce(async () => { started.resolve(); await blocked.promise; return { ok: true } })
  const downloading = characters.saveCharacterIfUnchanged(parsed('cloud'), 'Ana', 'l1', revision)
  await started.promise
  const deleting = characters.deleteCharacter('l1')
  blocked.resolve()
  await Promise.all([downloading, deleting])
  expect(characters.app.characters).toEqual([])
})

it('refuses a stale external delete and keeps monotonically increasing save and rename timestamps', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100)
  const first = await characters.saveCharacter(parsed('initial'), 'Ana', 'l1')
  const revision = characters.characterRevision('l1')
  const second = await characters.saveCharacter(parsed('new'), 'Ana', 'l1')
  const secondAt = second.updatedAt
  await characters.renameCharacter('l1', 'Renamed')
  expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  expect(characters.app.characters[0]!.updatedAt).toBeGreaterThan(secondAt)
  expect(await characters.deleteCharacterIfUnchanged('l1', revision)).toBe(false)
  expect(characters.app.characters[0]!.label).toBe('Renamed')
  vi.restoreAllMocks()
})
