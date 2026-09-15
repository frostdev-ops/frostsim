// Never reaches "ready": cancel during asset acquisition/module instantiation (print never ran).
import { parentPort } from 'node:worker_threads'
import { PROTOCOL } from './protocol.mjs'

parentPort.on('message', (data) => {
  parentPort.postMessage({ protocol: PROTOCOL, jobId: data.jobId, type: 'initializing' })
  // Then nothing (real worker would be in await createSimc(...)).
})
