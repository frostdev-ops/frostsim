import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

// Execute the real classic worker's successful run path. Only the Emscripten
// module is replaced; no native engine or browser lifecycle is simulated.
it('confirms ordinary local shutdown before the report can make the controller terminate it', async () => {
  const messages: Record<string, unknown>[] = []
  const close = vi.fn()
  const bytes = new Uint8Array([1, 2, 3])
  const html = new Uint8Array([4, 5])
  const scope = {
    self: {
      location: { href: 'https://fixture.invalid/engine/sim-worker.js', search: '' },
      postMessage: (message: Record<string, unknown>) => messages.push(message),
      close,
      onmessage: undefined as unknown as (event: { data: unknown }) => Promise<void>,
    },
    URL, URLSearchParams, WebAssembly, Uint8Array, AbortController,
    importScripts: () => {},
    createSimc: async () => ({
      FS: { writeFile: vi.fn(), readFile: (path: string) => path === '/out.html' ? html : bytes },
      callMain: () => 0,
    }),
  }
  runInNewContext(readFileSync('public/engine/sim-worker.js', 'utf8'), scope)
  await scope.self.onmessage({ data: {
    protocol: 1, jobId: 'ordinary-success', profile: 'mage=Ana',
    profilePath: '/profile.simc', reportPath: '/out.json', htmlPath: '/out.html',
    args: ['ptr=0', '/profile.simc'],
  } })
  expect(messages.filter(message => message.type === 'done' || message.type === 'shutdown').map(message => message.type)).toEqual(['shutdown', 'done'])
  expect(messages.find(message => message.type === 'shutdown')).toMatchObject({ reason: 'complete', jobId: 'ordinary-success' })
  expect(messages.find(message => message.type === 'done')).toMatchObject({ report: bytes, html })
  expect(close).toHaveBeenCalledOnce()
})
