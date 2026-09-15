// Static asset serving same URL for all variants; importScripts and pthreads need the same _scriptName.

// Artifact variant from URL query: variant=fallback selects SC_NO_THREADING build.
const VARIANT =
  new URLSearchParams(self.location.search).get('variant') === 'fallback' ? 'fallback' : 'threaded'
const ENGINE_BASE = new URL('.', self.location.href).pathname
const ENGINE_DIR = ENGINE_BASE + (VARIANT === 'fallback' ? 'fallback/' : '')

// Track and reap pthreads before importScripts so allocateUnusedWorker finds the wrapper (measured: orphans consume GBs).
const spawnedThreads = new Set()
if (globalThis.name !== 'em-pthread' && typeof Worker !== 'undefined') {
  const NativeWorker = Worker
  self.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args)
      spawnedThreads.add(this)
    }
    terminate() {
      spawnedThreads.delete(this)
      return super.terminate()
    }
  }
}

importScripts(ENGINE_DIR + 'simc.js')

if (globalThis.name !== 'em-pthread') {
  // Must match WORKER_PROTOCOL in src/lib/simc/job.ts; both sides refuse a mismatch.
  const PROTOCOL = 1

  // Message is a trust boundary (P01.5): validate strictly; nothing outside allowlist.
  const ALLOWED_PATHS = ['/profile.simc', '/out.json', '/out.html']
  const MAX_PROFILE_CHARS = 8 * 1024 * 1024
  const MAX_ARGS = 2000
  const MAX_ARG_CHARS = 4096

  // Bounded log flush inside print callback since callMain blocks the event loop (P01.12).
  const LOG_FLUSH_LINES = 40
  const LOG_FLUSH_MS = 100

  // Cache engine binaries by sha256 hash, not version (two builds of same data differ).
  const CACHE_NAME = 'frostsim-engine-v1'

  // Exception sentinel to unwind cancelled callMain without reporting as engine failure.
  const CANCEL_SENTINEL = 'frostsim:cancelled'
  const ASSET_PROGRESS_MS = 120

  function fail(jobId, code, message) {
    self.postMessage({ protocol: PROTOCOL, jobId: jobId, type: 'error', code: code, message: message })
  }

  let cancelJobId = null
  let cancelFlagRef = null
  let reapedThreads = 0
  let acquisitionAbort = null
  let executing = false

  // Check for cancellation at clock boundaries (safe to unwind from JS during long routes).
  function cancellationImports(imports) {
    for (const namespace of Object.values(imports)) {
      for (const [key, fn] of Object.entries(namespace)) {
        if (typeof fn !== 'function' || !['_clock_time_get', '_emscripten_get_now', '_emscripten_date_now'].includes(fn.name)) continue
        namespace[key] = (...args) => {
          if (executing && stopRequested()) requestStop()
          return fn(...args)
        }
      }
    }
    return imports
  }

  /** True once the page has asked for a stop through shared memory. */
  function stopRequested() {
    return cancelFlagRef !== null && Atomics.load(cancelFlagRef, 0) !== 0
  }

  /** Reap pool on every terminal path; completed run leaves pool allocated. */
  function reapPool() {
    let reaped = 0
    for (const thread of spawnedThreads) {
      try {
        thread.terminate()
        reaped++
      } catch {}
    }
    spawnedThreads.clear()
    reapedThreads += reaped
    return reaped
  }

  /** Cancel from inside print callback (only JS during callMain); signals via SharedArrayBuffer. */
  function requestStop() {
    const reaped = reapPool()
    try {
      self.postMessage({ protocol: PROTOCOL, jobId: cancelJobId, type: 'reaping', threads: reaped })
    } catch {
      // Already closing; the throw below still unwinds the run.
    }
    // Throw to unwind out of callMain since neither close() nor terminate() can interrupt wasm (measured).
    throw new Error(CANCEL_SENTINEL)
  }

  /** Final message sent outside callMain confirming coordinator returned and nothing running. */
  function confirmShutdown(reason) {
    reapPool()
    try {
      self.postMessage({
        protocol: PROTOCOL,
        jobId: cancelJobId,
        type: 'shutdown',
        reason: reason,
        threads: reapedThreads,
      })
    } catch {}
    try {
      self.close()
    } catch {}
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** Download, verify, and cache wasm with progress; return null on failure to fall back (P02.6). */
  async function acquireBinary(engine, onProgress) {
    if (typeof caches === 'undefined' || typeof crypto === 'undefined' || !crypto.subtle) return null

    const cacheKey = engine.wasmUrl + '#' + (engine.sha256 || 'unhashed')
    let cache = null
    try {
      cache = await caches.open(CACHE_NAME)
      const hit = await cache.match(cacheKey)
      if (hit) {
        const bytes = await hit.arrayBuffer()
        onProgress(bytes.byteLength, bytes.byteLength, true)
        return bytes
      }
    } catch {
      // Storage denied or evicted mid-flight. Fall through and download.
    }

    let bytes
    try {
      const response = await fetch(engine.wasmUrl, { credentials: 'same-origin', signal: acquisitionAbort?.signal })
      if (!response.ok) return null

      const declared = Number(response.headers.get('Content-Length'))
      // Content-Length absent under compression; fall back to engine.bytes or stay unknown.
      const total = Number.isFinite(declared) && declared > 0 ? declared : engine.bytes || undefined

      if (!response.body) {
        bytes = await response.arrayBuffer()
        onProgress(bytes.byteLength, total, false)
      } else {
        const reader = response.body.getReader()
        const chunks = []
        let loaded = 0
        let lastPost = 0
        for (;;) {
          const step = await reader.read()
          if (step.done) break
          chunks.push(step.value)
          loaded += step.value.byteLength
          const now = Date.now()
          if (now - lastPost >= ASSET_PROGRESS_MS) {
            lastPost = now
            onProgress(loaded, total, false)
          }
        }
        const joined = new Uint8Array(loaded)
        let offset = 0
        for (const chunk of chunks) {
          joined.set(chunk, offset)
          offset += chunk.byteLength
        }
        bytes = joined.buffer
        onProgress(loaded, loaded, false)
      }
    } catch {
      return null
    }

    if (engine.sha256) {
      try {
        const actual = await sha256Hex(bytes)
        if (actual !== engine.sha256) {
          // The binary is not the one the manifest describes. Refuse it rather
          // than run a build nobody can reproduce.
          throw new Error(
            'engine binary at ' + engine.wasmUrl + ' hashes to ' + actual + ', not the ' + engine.sha256 + ' its manifest claims',
          )
        }
      } catch (err) {
        if (err && err.message && err.message.indexOf('hashes to') !== -1) throw err
        return null // digest unavailable; fall back rather than block the run
      }
    }

    if (cache) {
      try {
        await cache.put(cacheKey, new Response(bytes.slice(0)))
        // Keep only the current engine binary in cache.
        for (const key of await cache.keys()) {
          if (key.url !== new Request(cacheKey).url) await cache.delete(key)
        }
      } catch {}
    }

    return bytes
  }

  function validate(data) {
    if (!data || typeof data !== 'object') return 'message is not an object'
    if (data.protocol !== PROTOCOL) {
      return 'worker protocol ' + data.protocol + ' does not match this worker (' + PROTOCOL + ')'
    }
    if (typeof data.jobId !== 'string' || !data.jobId) return 'jobId must be a non-empty string'
    if (typeof data.profile !== 'string' || !data.profile) return 'profile must be a non-empty string'
    if (data.profile.length > MAX_PROFILE_CHARS) {
      return 'profile is ' + data.profile.length + ' characters, over the ' + MAX_PROFILE_CHARS + ' limit'
    }
    if (ALLOWED_PATHS.indexOf(data.profilePath) === -1) return 'profilePath ' + data.profilePath + ' is not allowed'
    if (ALLOWED_PATHS.indexOf(data.reportPath) === -1) return 'reportPath ' + data.reportPath + ' is not allowed'
    if (data.profilePath === data.reportPath) return 'profilePath and reportPath must differ'
    if (data.htmlPath !== undefined) {
      if (ALLOWED_PATHS.indexOf(data.htmlPath) === -1) return 'htmlPath ' + data.htmlPath + ' is not allowed'
      if (data.htmlPath === data.profilePath || data.htmlPath === data.reportPath) {
        return 'htmlPath must differ from profilePath and reportPath'
      }
    }
    if (!Array.isArray(data.args) || data.args.length === 0) return 'args must be a non-empty array'
    if (data.args.length > MAX_ARGS) return 'args has ' + data.args.length + ' entries, over the ' + MAX_ARGS + ' limit'
    for (let i = 0; i < data.args.length; i++) {
      const arg = data.args[i]
      if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_ARG_CHARS) {
        return 'args[' + i + '] must be a string of 1..' + MAX_ARG_CHARS + ' characters'
      }
      if (/[\0\n\r]/.test(arg)) return 'args[' + i + '] contains a control character'
    }
    if (data.args[0] !== data.profilePath) return 'args[0] must be the profile path'
    if (data.compiledModule !== undefined && !(data.compiledModule instanceof WebAssembly.Module)) {
      return 'compiledModule must be a WebAssembly.Module'
    }
    if (data.engine !== undefined) {
      if (typeof data.engine !== 'object' || data.engine === null) return 'engine must be an object'
      const url = data.engine.wasmUrl
      // Only this variant's own directory, and only a .wasm in it.
      if (typeof url !== 'string' || url.indexOf(ENGINE_DIR) !== 0 || !/^[\w./-]+\.wasm$/.test(url)) {
        return 'engine.wasmUrl must be a .wasm inside ' + ENGINE_DIR
      }
      if (data.engine.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(data.engine.sha256)) {
        return 'engine.sha256 must be a hex sha-256'
      }
    }
    return null
  }

  self.onmessage = async (e) => {
    const data = e.data
    if (data?.type === 'cancel') {
      if (data.protocol === PROTOCOL && data.jobId === cancelJobId) acquisitionAbort?.abort()
      return
    }
    const jobId = data && typeof data.jobId === 'string' ? data.jobId : null

    const problem = validate(data)
    if (problem) {
      fail(jobId, 'protocol', problem)
      return
    }

    const post = (msg) => self.postMessage(Object.assign({ protocol: PROTOCOL, jobId: jobId }, msg))
    cancelJobId = jobId

    // Page signals stop via SharedArrayBuffer since postMessage cannot reach callMain.
    cancelFlagRef =
      data.cancelFlag && typeof SharedArrayBuffer !== 'undefined' && data.cancelFlag instanceof SharedArrayBuffer
        ? new Int32Array(data.cancelFlag)
        : null
    acquisitionAbort = new AbortController()
    if (stopRequested()) { confirmShutdown('cancelled'); return }

    let pending = []
    let pendingStream = 'out'
    let lastFlush = Date.now()

    function flush() {
      if (!pending.length) return
      post({ type: 'log', stream: pendingStream, lines: pending })
      pending = []
      lastFlush = Date.now()
    }

    function record(stream, line) {
      // Check for cancel at every progress message (constant engine output).
      if (stopRequested()) requestStop()

      // Keep stderr separate from stdout; it is worth keeping when output is truncated.
      if (stream !== pendingStream) {
        flush()
        pendingStream = stream
      }
      pending.push(String(line))
      if (pending.length >= LOG_FLUSH_LINES || Date.now() - lastFlush >= LOG_FLUSH_MS) flush()
    }

    let mod
    try {
      if (typeof createSimc === 'undefined') {
        throw new Error(ENGINE_DIR + 'simc.js did not define createSimc — is the build current?')
      }

      // Cache compiled Module, instantiate fresh per run (D5: skips download/compile, the dominant cold-start cost).
      let compiled = data.compiledModule instanceof WebAssembly.Module ? data.compiledModule : null

      // Acquire binary ourselves for real byte progress and Cache Storage; null falls back to emscripten.
      let binary = null
      if (!compiled && data.engine) {
        binary = await acquireBinary(data.engine, (loaded, total, cached) =>
          post({ type: 'assets', loaded: loaded, total: total, cached: !!cached }),
        )
      }
      if (compiled) {
        post({ type: 'assets', loaded: 0, total: 0, cached: true, compiled: true })
      }
      if (stopRequested()) { confirmShutdown('cancelled'); return }

      // Bytes ready or will be fetched; now compile and init (different wait).
      post({ type: 'initializing' })

      const moduleArg = {
        // Tell emscripten where fallback wasm is (one level down from script URL).
        locateFile: (path) => ENGINE_DIR + path,
        print: (line) => record('out', line),
        printErr: (line) => record('err', line),
      }

      if (binary) {
        // Instantiate from binary; pass Module to pthread pool via successCallback.
        moduleArg.instantiateWasm = (imports, successCallback) => {
          WebAssembly.instantiate(binary, cancellationImports(imports)).then(
            (result) => {
              // Return compiled Module for cache (structured-cloneable, costs reference not 60 MB).
              try {
                post({ type: 'compiled', module: result.module })
              } catch {}
              successCallback(result.instance, result.module)
            },
            (err) => fail(jobId, 'engine-init', 'could not instantiate the engine: ' + err),
          )
          return {}
        }
      } else if (compiled) {
        // Instantiate cached Module; fresh instance mandatory but Module immutable (D5).
        moduleArg.instantiateWasm = (imports, successCallback) => {
          WebAssembly.instantiate(compiled, cancellationImports(imports)).then(
            (instance) => successCallback(instance, compiled),
            (err) => fail(jobId, 'engine-init', 'could not instantiate the cached engine: ' + err),
          )
          return {}
        }
      }

      // Fresh instance per run: dbc::init(), hotfixes, effects are global in simc (D5).
      mod = await createSimc(moduleArg)
    } catch (err) {
      flush()
      // A failed init can still have allocated part of the pool.
      confirmShutdown('init-failed')
      fail(jobId, 'engine-init', err && err.message ? err.message : String(err))
      return
    }

    // Check for cancel after init; first chance since print never ran.
    if (stopRequested()) {
      flush()
      confirmShutdown('cancelled')
      return
    }

    post({ type: 'ready' })

    try {
      mod.FS.writeFile(data.profilePath, data.profile)

      let code
      executing = true
      try { code = mod.callMain(data.args) }
      finally { executing = false }
      flush()
      // Reap pool after callMain; completed run must not leave pool resident.
      reapPool()

      // Check for cancel after sim; output might not have carried it.
      if (stopRequested()) {
        confirmShutdown('cancelled')
        return
      }

      var bytes = null
      try {
        // Uint8Array is transferable; no copy or decode needed.
        bytes = mod.FS.readFile(data.reportPath)
      } catch (err) {
        bytes = null
      }

      // Nonzero exit with JSON report is REPORT failure not SIM failure; HTML writer can die after JSON written.
      if (code !== 0) {
        if (!bytes) {
          confirmShutdown('sim-failed')
          fail(jobId, 'sim-failed', 'simc exited ' + code + ' — see the engine log for the reason')
          return
        }
        post({
          type: 'log',
          stream: 'err',
          lines: [
            'Warning: simc exited ' + code + ' while writing its reports. The simulation ' +
            'itself finished and its results are below; an optional output may be missing.',
          ],
        })
      }

      if (!bytes) {
        confirmShutdown('report-missing')
        fail(jobId, 'report-missing', 'simc exited 0 but wrote no report at ' + data.reportPath)
        return
      }

      // HTML report costs engine time and is tens of MB for large search; only write if requested.
      var html = null
      if (data.htmlPath) {
        try {
          html = mod.FS.readFile(data.htmlPath)
        } catch (err) {
          html = null
        }
      }

      var message = { protocol: PROTOCOL, jobId: jobId, type: 'done', report: bytes }
      var transfer = [bytes.buffer]
      if (html) {
        message.html = html
        transfer.push(html.buffer)
      }
      self.postMessage(message, transfer)
      confirmShutdown('complete')
    } catch (err) {
      flush()
      // Cancel unwind reached here: callMain returned, so shutdown confirmation is valid.
      if (err && err.message === CANCEL_SENTINEL) {
        confirmShutdown('cancelled')
        return
      }
      confirmShutdown('engine-error')
      fail(jobId, 'engine', err && err.message ? err.message : String(err))
    }
  }
}
