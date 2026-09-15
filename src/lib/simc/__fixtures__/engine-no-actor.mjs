// Run with no character declared. simc exits 0, writes no report; worker reports report-missing, controller reports no-actor.

import { parentPort } from 'node:worker_threads'
import { PROTOCOL, validate } from './protocol.mjs'

parentPort.on('message', (data) => {
  const post = (msg) => parentPort.postMessage({ protocol: PROTOCOL, jobId: data?.jobId, ...msg })

  const problem = validate(data)
  if (problem) {
    post({ type: 'error', code: 'protocol', message: problem })
    return
  }

  post({ type: 'initializing' })
  post({ type: 'ready' })
  post({
    type: 'log',
    stream: 'out',
    lines: ['Nothing to sim! SimulationCraft 1210-01 for World of Warcraft 12.1.0.69814 Live'],
  })
  post({ type: 'error', code: 'report-missing', message: 'simc exited 0 but wrote no report at /out.json' })
})
