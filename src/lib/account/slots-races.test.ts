// Actual slot and character mutation modules; only persistence and HTTP are replaced.
import { beforeEach, expect, it, vi } from 'vitest'
import { parseAddonExport } from '../import/character'
import type { StoredCharacter } from '../store/records'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  records: new Map<string, StoredCharacter>(),
  saved: null as null | ((record: StoredCharacter) => void),
  deleted: null as null | ((record: StoredCharacter) => void),
}))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api: mocks.api }))
vi.mock('./state.svelte', () => ({ account: { me: { user: { id: 'u1' } } }, signedOut: vi.fn() }))
vi.mock('../store/db', () => ({
  put: vi.fn(async (_store: string, record: StoredCharacter) => {
    mocks.records.set(record.id, structuredClone(record))
    return { ok: true, value: record.id }
  }),
  del: vi.fn(async (_store: string, id: string) => { mocks.records.delete(id); return { ok: true } }),
  storageUsage: vi.fn(async () => null),
}))
// Capture the account callback as well, so the test covers the account seam in flag-off test runs.
vi.mock('../app.svelte', async (orig) => {
  const actual = await orig<typeof import('../app.svelte')>()
  return { ...actual, setCharacterSync: (sync: Parameters<typeof actual.setCharacterSync>[0]) => {
    mocks.saved = sync?.saved ?? null
    mocks.deleted = sync?.deleted ?? null
    actual.setCharacterSync(sync)
  } }
})

const { app, saveCharacter, deleteCharacter, renameCharacter } = await import('../app.svelte')
const { slots, syncSlots } = await import('./slots.svelte')
const raw = (version: string) => `mage=Ana\nlevel=90\nrace=human\nregion=us\nserver=area-52\nspec=frost\n# ${version}`
const cloudAt = '2026-09-21T00:00:00.000Z'
const remote = { id: 's1', label: 'Ana', bytes: 100, updatedAt: cloudAt, who: { name: 'Ana', className: 'mage', server: 'area-52', region: 'us' } }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
async function save(version: string) {
  const record = await saveCharacter(parseAddonExport(raw(version)), 'Ana', 'l1')
  if (import.meta.env.VITE_FEATURE_ACCOUNTS !== true) mocks.saved!(record)
  return record
}

beforeEach(async () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  mocks.records.clear()
  app.characters = []
  app.toasts = []
  mocks.api.mockReset().mockResolvedValue({ slots: 1, characters: [] })
  await syncSlots()
  const initial = await saveCharacter(parseAddonExport(raw('initial')), 'Ana', 'l1', true)
  localStorage.setItem('frostsim.slots.u1', JSON.stringify({ links: { l1: { id: 's1', at: '2026-09-20T00:00:00.000Z', local: initial.updatedAt } }, gone: [] }))
})

it('preserves a new local export saved while a cloud GET is pending and uploads that export once', async () => {
  slots.on = false // the first account synchronization must retain saves made before slot availability is known
  const started = deferred<void>()
  const pull = deferred<{ label: string; raw: string; updatedAt: string }>()
  const uploaded: string[] = []
  mocks.api.mockImplementation(async (path: string, method = 'GET', body?: { raw: string }) => {
    if (method === 'PUT') { uploaded.push(body!.raw); return { id: 's1', updatedAt: cloudAt } }
    if (path === '/characters/s1') { started.resolve(); return pull.promise }
    return { slots: 1, characters: [remote] }
  })
  const syncing = syncSlots()
  await started.promise
  await save('new local')
  pull.resolve({ label: 'Ana', raw: raw('old cloud'), updatedAt: cloudAt })
  await syncing
  await syncSlots()
  expect(app.characters.map((c) => c.character.raw)).toEqual([raw('new local')])
  expect(mocks.records.get('l1')!.character.raw).toBe(raw('new local'))
  expect(uploaded).toEqual([raw('new local')])
})

it('does not resurrect a character deleted while its cloud GET is pending', async () => {
  const started = deferred<void>()
  const pull = deferred<{ label: string; raw: string; updatedAt: string }>()
  let removed = false
  mocks.api.mockImplementation(async (path: string, method = 'GET') => {
    if (method === 'DELETE') { removed = true; return }
    if (path === '/characters/s1') { started.resolve(); return pull.promise }
    return { slots: 1, characters: removed ? [] : [remote] }
  })
  const syncing = syncSlots()
  await started.promise
  const record = app.characters[0]!
  await deleteCharacter('l1')
  if (import.meta.env.VITE_FEATURE_ACCOUNTS !== true) mocks.deleted!(record)
  pull.resolve({ label: 'Ana', raw: raw('old cloud'), updatedAt: cloudAt })
  await syncing
  await syncSlots()
  expect(app.characters).toEqual([])
  expect(mocks.records.has('l1')).toBe(false)
  expect(removed).toBe(true)
})

it('keeps a rename made during a cloud GET and uploads the renamed snapshot', async () => {
  const started = deferred<void>()
  const pull = deferred<{ label: string; raw: string; updatedAt: string }>()
  const labels: string[] = []
  mocks.api.mockImplementation(async (path: string, method = 'GET', body?: { label: string }) => {
    if (method === 'PUT') { labels.push(body!.label); return { id: 's1', updatedAt: cloudAt } }
    if (path === '/characters/s1') { started.resolve(); return pull.promise }
    return { slots: 1, characters: [remote] }
  })
  const syncing = syncSlots()
  await started.promise
  await renameCharacter('l1', 'New label')
  if (import.meta.env.VITE_FEATURE_ACCOUNTS !== true) mocks.saved!(app.characters[0]!)
  pull.resolve({ label: 'Ana', raw: raw('old cloud'), updatedAt: cloudAt })
  await syncing
  await syncSlots()
  expect(app.characters[0]!.label).toBe('New label')
  expect(labels).toEqual(['New label'])
})

it('follows an in-flight PUT with the newer saved snapshot and keeps one linked slot', async () => {
  const started = deferred<void>()
  const put = deferred<{ id: string; updatedAt: string }>()
  const uploaded: string[] = []
  mocks.api.mockImplementation(async (path: string, method = 'GET', body?: { raw: string }) => {
    if (method === 'PUT') {
      uploaded.push(body!.raw)
      if (uploaded.length === 1) { started.resolve(); return put.promise }
      return { id: 's1', updatedAt: cloudAt }
    }
    if (method === 'POST') throw new Error('A linked character must never create a duplicate slot')
    if (path === '/characters/s1') return { label: 'Ana', raw: raw('initial'), updatedAt: cloudAt }
    return { slots: 1, characters: [remote] }
  })
  await save('first local')
  await started.promise
  await save('second local')
  put.resolve({ id: 's1', updatedAt: cloudAt })
  await syncSlots()
  await syncSlots()
  expect(app.characters).toHaveLength(1)
  expect(app.characters[0]!.character.raw).toBe(raw('second local'))
  expect(uploaded).toEqual([raw('first local'), raw('second local')])
})

it('pairs an import made while an unlinked slot downloads instead of creating a duplicate local character', async () => {
  app.characters = []
  mocks.records.clear()
  localStorage.setItem('frostsim.slots.u1', JSON.stringify({ links: {}, gone: [] }))
  const started = deferred<void>()
  const pull = deferred<{ label: string; raw: string; updatedAt: string }>()
  const uploaded: string[] = []
  mocks.api.mockImplementation(async (path: string, method = 'GET', body?: { raw: string }) => {
    if (method === 'POST') throw new Error('The same character already has a remote slot')
    if (method === 'PUT') { uploaded.push(body!.raw); return { id: 's1', updatedAt: cloudAt } }
    if (path === '/characters/s1') { started.resolve(); return pull.promise }
    return { slots: 1, characters: [remote] }
  })
  const syncing = syncSlots()
  await started.promise
  await save('fresh import')
  pull.resolve({ label: 'Ana', raw: raw('old cloud'), updatedAt: cloudAt })
  await syncing
  await syncSlots()
  expect(app.characters.map((c) => c.id)).toEqual(['l1'])
  expect(uploaded).toEqual([raw('fresh import')])
})

it('frees a slot after deletion while its PUT is in flight, without resurrecting it on later syncs', async () => {
  const started = deferred<void>()
  const put = deferred<{ id: string; updatedAt: string }>()
  let removed = false
  const methods: string[] = []
  mocks.api.mockImplementation(async (_path: string, method = 'GET') => {
    if (method === 'PUT') { methods.push(method); started.resolve(); return put.promise }
    if (method === 'DELETE') { methods.push(method); removed = true; return }
    return { slots: 1, characters: removed ? [] : [remote] }
  })
  await save('first local')
  await started.promise
  const record = app.characters[0]!
  await deleteCharacter('l1')
  if (import.meta.env.VITE_FEATURE_ACCOUNTS !== true) mocks.deleted!(record)
  put.resolve({ id: 's1', updatedAt: cloudAt })
  for (let n = 0; n < 3; n++) await syncSlots()
  expect(app.characters).toEqual([])
  expect(mocks.records.size).toBe(0)
  expect(methods).toEqual(['PUT', 'DELETE'])
})

it('keeps a local save made during a list read even when that read says its old slot was deleted', async () => {
  slots.on = false
  const started = deferred<void>()
  const list = deferred<{ slots: number; characters: typeof remote[] }>()
  let posts = 0
  let lists = 0
  mocks.api.mockImplementation(async (_path: string, method = 'GET', body?: { raw: string }) => {
    if (method === 'POST') { posts++; expect(body!.raw).toBe(raw('new local')); return { id: 's2', updatedAt: cloudAt } }
    if (++lists === 1) { started.resolve(); return list.promise }
    return { slots: 1, characters: posts ? [{ ...remote, id: 's2' }] : [] }
  })
  const syncing = syncSlots()
  await started.promise
  await save('new local')
  list.resolve({ slots: 1, characters: [] })
  await syncing
  for (let n = 0; n < 3; n++) await syncSlots()
  expect(app.characters.map((c) => c.character.raw)).toEqual([raw('new local')])
  expect(posts).toBe(1)
})

it('applies an unchanged cloud download once without generating upload feedback', async () => {
  let downloads = 0
  mocks.api.mockImplementation(async (path: string, method = 'GET') => {
    expect(method).toBe('GET')
    if (path === '/characters/s1') { downloads++; return { label: 'Cloud label', raw: raw('new cloud'), updatedAt: cloudAt } }
    return { slots: 1, characters: [remote] }
  })
  for (let n = 0; n < 3; n++) await syncSlots()
  expect(app.characters).toHaveLength(1)
  expect(app.characters[0]!.label).toBe('Cloud label')
  expect(mocks.records.get('l1')!.character.raw).toBe(raw('new cloud'))
  expect(downloads).toBe(1)
})
