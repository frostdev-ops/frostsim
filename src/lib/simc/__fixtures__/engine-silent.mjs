// Speaks once proving run talks then quiet forever: shape of worker browser killed mid-run.
import { parentPort } from 'node:worker_threads'
import { PROTOCOL } from './protocol.mjs'

parentPort.on('message', (data) => {
  const post = (msg) => parentPort.postMessage({ protocol: PROTOCOL, jobId: data.jobId, ...msg })
  post({ type: 'initializing' })
  post({ type: 'ready' })
  post({ type: 'log', stream: 'out', lines: ['Generating Baseline: 1/1 [=>..................] 5/10000 3.4'] })
})
