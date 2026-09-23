import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_COMPAT, engineHealth, parseEngineIndex, pickEngine, type EnginePack, type EngineStatus } from './versions'

const sha = (c: string) => c.repeat(40)
const pack = (id: string, compat: string, commitDate: string, publishedAt = commitDate): EnginePack => ({
  id, baseUrl: `/engine/versions/${id}/`, compat, upstreamCommit: sha(id[0]), commitDate, publishedAt,
})
const index = (packs: EnginePack[], status: EngineStatus | null = null) => ({ schemaVersion: 2 as const, packs, status })

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('pickEngine', () => {
  it('runs the newest pack built for this app and ignores other contracts', () => {
    const packs = [pack('a1', 'mine', '2026-09-20T00:00:00Z'), pack('b2', 'other', '2026-09-23T00:00:00Z'), pack('c3', 'mine', '2026-09-22T00:00:00Z')]
    expect(pickEngine(index(packs), 'mine')?.id).toBe('c3')
    expect(pickEngine(index(packs), 'none')).toBeUndefined()
  })
  it('breaks a same-commit tie by publish time', () => {
    const packs = [pack('a1', 'x', '2026-09-20T00:00:00Z', '2026-09-20T01:00:00Z'), pack('a2', 'x', '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z')]
    expect(pickEngine(index(packs), 'x')?.id).toBe('a2')
  })
})

describe('parseEngineIndex', () => {
  const ok = index([pack('a1', 'x', '2026-09-20T00:00:00Z')])
  it('accepts v2 and rejects v1, foreign or escaping paths, duplicates and bad status', () => {
    expect(parseEngineIndex(ok).packs).toHaveLength(1)
    expect(() => parseEngineIndex({ schemaVersion: 1, defaultId: 'a', versions: [] })).toThrow()
    expect(() => parseEngineIndex(index([{ ...ok.packs[0], baseUrl: 'https://example.com/' }]))).toThrow()
    expect(() => parseEngineIndex(index([{ ...ok.packs[0], baseUrl: '/engine/versions/../../' }]))).toThrow()
    expect(() => parseEngineIndex(index([ok.packs[0], ok.packs[0]]))).toThrow()
    expect(() => parseEngineIndex(index([{ ...ok.packs[0], upstreamCommit: 'main' }]))).toThrow()
    expect(() => parseEngineIndex({ ...ok, status: { state: 'maybe', checkedAt: 'x' } })).toThrow()
  })
})

describe('selectedEngine', () => {
  it('picks by the compiled-in compat and removes the legacy manual pin', async () => {
    const removeItem = vi.fn()
    vi.stubGlobal('localStorage', { removeItem })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(index([pack('a1', ENGINE_COMPAT, '2026-09-20T00:00:00Z'), pack('b2', 'other', '2026-09-23T00:00:00Z')])))))
    const { selectedEngine } = await import('./versions')
    expect((await selectedEngine()).id).toBe('a1')
    expect(removeItem).toHaveBeenCalledWith('frostsim.engineVersion')
  })
  it('says the engine is being built when no pack matches, and retries next time', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(index([pack('b2', 'other', '2026-09-23T00:00:00Z')]))))
    vi.stubGlobal('fetch', fetchMock)
    const { selectedEngine } = await import('./versions')
    await expect(selectedEngine()).rejects.toThrow(/still being built/)
  })
})

describe('engineHealth', () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  const running = pack('a1', 'x', '2026-09-23T00:00:00Z')
  const status = (over: Partial<EngineStatus>): EngineStatus => ({ checkedAt: '2026-09-23T11:00:00Z', upstreamHead: running.upstreamCommit,
    upstreamDate: running.commitDate, upstreamCiUrl: null, state: 'current', reason: null, ...over })
  it('is quiet when current', () => expect(engineHealth(running, status({}), now).message).toBeNull())
  it('warns when blocked, failed or when checks stopped', () => {
    expect(engineHealth(running, status({ state: 'blocked' }), now).level).toBe('warn')
    expect(engineHealth(running, status({ state: 'failed' }), now).level).toBe('warn')
    expect(engineHealth(running, status({ checkedAt: '2026-09-22T00:00:00Z' }), now).level).toBe('warn')
  })
  it('informs when building, or when upstream is more than 12 h ahead', () => {
    expect(engineHealth(running, status({ state: 'building' }), now).level).toBe('info')
    expect(engineHealth(running, status({ upstreamHead: sha('f'), upstreamDate: '2026-09-23T13:00:00Z' }), now).level).toBe('info')
    expect(engineHealth(running, status({ upstreamHead: sha('f'), upstreamDate: '2026-09-23T06:00:00Z' }), now).level).toBe('ok')
  })
})
