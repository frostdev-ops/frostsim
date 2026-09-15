// Answers with protocol number controller doesn't speak.
import { parentPort } from 'node:worker_threads'

parentPort.on('message', (data) => {
  parentPort.postMessage({ protocol: 1, jobId: data.jobId, type: 'ready' })
  // Protocol 99: controller ignores (should not settle on wrong protocol).
  parentPort.postMessage({ protocol: 99, jobId: data.jobId, type: 'done', report: new Uint8Array(0) })
  // ...and this is the message it should act on.
  parentPort.postMessage({ protocol: 1, jobId: data.jobId, type: 'error', code: 'sim-failed', message: 'engine refused the request' })
})
