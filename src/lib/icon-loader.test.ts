import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
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
