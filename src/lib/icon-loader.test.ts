import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('keeps queued and undecoded images hidden until the current image is ready', async () => {
  vi.resetModules()
  let intersect!: IntersectionObserverCallback
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {} unobserve() {}
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })))
  const decoded = deferred<void>()
  const node = { src: '', style: { visibility: '' }, decode: vi.fn(() => decoded.promise),
    removeAttribute: vi.fn(), dispatchEvent: vi.fn() } as unknown as HTMLImageElement
  const { deferredIcon } = await import('./icon-loader')
  deferredIcon(node, '/api/wow/spell-icon/7')
  expect(node.style.visibility).toBe('hidden')
  intersect([{ target: node, isIntersecting: true }] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver)
  await vi.waitFor(() => expect(node.src).toBe('data:image/png;base64,AQID'))
  expect(node.style.visibility).toBe('hidden')
  decoded.resolve()
  await vi.waitFor(() => expect(node.style.visibility).toBe(''))
})

it('keeps a failed decode hidden and ignores an old decode after an update or destroy', async () => {
  vi.resetModules()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })))
  const first = deferred<void>(), second = deferred<void>(), last = deferred<void>()
  const decode = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockImplementationOnce(() => last.promise)
  const node = { src: '', style: { visibility: '' }, decode, removeAttribute: vi.fn(), dispatchEvent: vi.fn() } as unknown as HTMLImageElement
  const { deferredIcon } = await import('./icon-loader')
  const action = deferredIcon(node, '/api/wow/icon/11')
  await vi.waitFor(() => expect(node.src).toBeTruthy())
  action.update('/api/wow/icon/12')
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
  first.resolve()
  await Promise.resolve()
  expect(node.style.visibility).toBe('hidden')
  second.reject(new Error('Invalid image bytes'))
  await vi.waitFor(() => expect(node.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })))
  expect(node.style.visibility).toBe('hidden')
  action.update('/api/wow/icon/13')
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3))
  action.destroy()
  last.resolve()
  await Promise.resolve()
  expect(node.style.visibility).toBe('hidden')
})

it('reuses persistent bytes across reloads, but never extends the response expiry', async () => {
  vi.useFakeTimers(); vi.resetModules()
  const stored = new Map<string, Response>()
  vi.stubGlobal('caches', { open: async () => ({
    match: async (url: string) => stored.get(url)?.clone(),
    put: async (url: string, response: Response) => { stored.set(url, response.clone()) },
    delete: async (url: string) => stored.delete(url),
    keys: async () => [...stored.keys()],
  }) })
  const fetch = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: {
    'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60',
    Date: new Date(Date.now() - 50000).toUTCString(),
  } })))
  vi.stubGlobal('fetch', fetch)
  let loader = await import('./icon-loader')
  const first = loader.loadIcon('/api/wow/icon/123')
  await vi.advanceTimersByTimeAsync(1)
  expect(await first).toBe('data:image/png;base64,AQID')
  vi.resetModules()
  loader = await import('./icon-loader')
  expect(await loader.loadIcon('/api/wow/icon/123')).toBe('data:image/png;base64,AQID')
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(11000)
  const expired = loader.loadIcon('/api/wow/icon/123')
  await vi.advanceTimersByTimeAsync(1)
  expect(await expired).toBe('data:image/png;base64,AQID')
  expect(fetch).toHaveBeenCalledTimes(2)
  fetch.mockImplementationOnce(() => Promise.resolve(Response.json({ score: 2400, progression: [] }, { headers: { 'Cache-Control': 'public, max-age=3600' } })))
  let metadata = await import('./media-cache')
  const url = '/api/wow/raider-profile/us/duskwood/example'
  expect((await (await metadata.fetchCharacterMedia(url)).json()).score).toBe(2400)
  vi.resetModules()
  metadata = await import('./media-cache')
  expect((await (await metadata.fetchCharacterMedia(url)).json()).score).toBe(2400)
  expect(fetch).toHaveBeenCalledTimes(3)
})
it('deduplicates icon loads, backs off on 429, and remembers missing icons', async () => {
  vi.useFakeTimers(); vi.resetModules()
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(new Response(new Uint8Array([1,2,3]), { headers: { 'Content-Type': 'image/png' } })).mockResolvedValue(new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  const { loadIcon } = await import('./icon-loader')
  const a = loadIcon('/api/wow/icon/123'), b = loadIcon('/api/wow/icon/123')
  expect(a).toBe(b)
  await vi.advanceTimersByTimeAsync(1000)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1100)
  expect(await a).toBe('data:image/png;base64,AQID')
  const missing = loadIcon('/api/wow/spell-icon/999?media=2')
  await vi.advanceTimersByTimeAsync(1100)
  expect(await missing).toBeNull()
  expect(await loadIcon('/api/wow/spell-icon/999?media=2')).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(3)
})
it('paints a decoded icon synchronously and keeps it across same-URL updates', async () => {
  vi.resetModules()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' } })))
  const { loadIcon, peekIcon, deferredIcon } = await import('./icon-loader')
  expect(peekIcon('/api/wow/icon/7')).toBeUndefined()
  await loadIcon('/api/wow/icon/7')
  expect(peekIcon('/api/wow/icon/7')).toBe('data:image/png;base64,AQID')
  const node = { src: '', style: { visibility: '' }, decode: vi.fn(async () => {}), removeAttribute: vi.fn(), dispatchEvent: vi.fn() } as unknown as HTMLImageElement
  const action = deferredIcon(node, '/api/wow/icon/7')
  expect(node.src).toBe('data:image/png;base64,AQID')
  action.update('/api/wow/icon/7')
  expect(node.removeAttribute).not.toHaveBeenCalled()
})
