// Mirrors sim-worker.js when instantiation fails: confirms its stop, then reports the error.
import { parentPort } from 'node:worker_threads'
import { PROTOCOL } from './protocol.mjs'

parentPort.on('message', (data) => {
  if (data.type === 'cancel') return
  const post = (msg) => parentPort.postMessage({ protocol: PROTOCOL, jobId: data.jobId, ...msg })
  post({ type: 'initializing' })
  post({ type: 'shutdown', reason: 'init-failed', threads: 16 })
  post({ type: 'error', code: 'engine-init', message: 'could not instantiate the engine: CompileError' })
})
