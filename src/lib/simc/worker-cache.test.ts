import { webcrypto, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Execute the actual classic worker with importScripts inert. Expose only the
// acquisition function; no engine, worker transport, browser or WASM job runs.
const worker = readFileSync('public/engine/sim-worker.js', 'utf8').replace(
  '  function validate(data)', '  globalThis.acquireBinary = acquireBinary\n  function validate(data)',
)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const url = 'https://fixture.invalid/engine/simc.wasm'

function cache() {
  const entries = new Map<string, { url: string; bytes: ArrayBuffer }>()
  // Cache API request matching ignores fragments, but preserves query strings.
  const keyOf = (value: string | Request) => { const key = new URL(typeof value === 'string' ? value : value.url); key.hash = ''; return key.href }
  return {
    match: vi.fn(async (key: string) => entries.has(keyOf(key)) ? new Response(entries.get(keyOf(key))!.bytes.slice(0)) : undefined),
    put: vi.fn(async (key: string, response: Response) => { entries.set(keyOf(key), { url: new Request(key).url, bytes: await response.arrayBuffer() }) }),
    keys: async () => [...entries.values()].map(entry => new Request(entry.url)),
    delete: vi.fn(async (key: string | Request) => entries.delete(keyOf(key))),
  }
}

function acquisition(store: ReturnType<typeof cache>, fetcher: typeof fetch) {
  const scope = {
    self: { location: { href: 'https://fixture.invalid/engine/sim-worker.js', search: '' } },
    URL, URLSearchParams, WebAssembly, Response, Request, crypto: webcrypto,
    importScripts: () => {}, caches: { open: async () => store }, fetch: fetcher,
    acquireBinary: undefined as unknown as (engine: { wasmUrl: string; sha256: string }, progress: (...args: unknown[]) => void) => Promise<ArrayBuffer>,
  }
  runInNewContext(worker, scope)
  return scope.acquireBinary
}

describe('engine binary cache (audit E5)', () => {
  it('partitions two manifests at the same stable URL by their binary hash', async () => {
    const old = new Uint8Array([1, 2, 3]), fresh = new Uint8Array([4, 5, 6])
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(old)).mockResolvedValueOnce(new Response(fresh))
    const store = cache(), acquire = acquisition(store, fetcher)
    await acquire({ wasmUrl: url, sha256: hash(old) }, () => {})
    const bytes = await acquire({ wasmUrl: url, sha256: hash(fresh) }, () => {})
    expect([...new Uint8Array(bytes)]).toEqual([...fresh])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('discards corrupt cached bytes and downloads a verified replacement', async () => {
    const fresh = new Uint8Array([4, 5, 6]), corrupt = new Uint8Array([9, 9, 9])
    const fetcher = vi.fn().mockResolvedValue(new Response(fresh))
    const store = cache()
    store.match.mockResolvedValueOnce(new Response(corrupt))
    const acquire = acquisition(store, fetcher)
    const bytes = await acquire({ wasmUrl: url, sha256: hash(fresh) }, () => {})
    expect([...new Uint8Array(bytes)]).toEqual([...fresh])
    expect(store.delete).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reuses a verified cached response without fetching', async () => {
    const fresh = new Uint8Array([4, 5, 6]), fetcher = vi.fn().mockResolvedValue(new Response(fresh))
    const store = cache(), acquire = acquisition(store, fetcher)
    const engine = { wasmUrl: url, sha256: hash(fresh) }
    await acquire(engine, () => {})
    const progress = vi.fn()
    const bytes = await acquire(engine, progress)
    expect([...new Uint8Array(bytes)]).toEqual([...fresh])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(3, 3, true)
  })

  it('refuses a mismatched downloaded replacement instead of caching it', async () => {
    const store = cache(), fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([9])))
    const acquire = acquisition(store, fetcher)
    await expect(acquire({ wasmUrl: url, sha256: hash(new Uint8Array([1])) }, () => {})).rejects.toThrow('hashes to')
    expect(store.put).not.toHaveBeenCalled()
  })
})
