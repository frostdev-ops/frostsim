// Runs long enough to be cancelled mid-flight, staying talkative so stall watchdog doesn't end it.
import { parentPort } from 'node:worker_threads'
import { PROTOCOL } from './protocol.mjs'

parentPort.on('message', (data) => {
  if (data.type === 'cancel') return
  const post = (msg) => parentPort.postMessage({ protocol: PROTOCOL, jobId: data.jobId, ...msg })
  post({ type: 'initializing' })
  post({ type: 'ready' })
  let i = 0
  setInterval(() => {
    i += 100
    post({ type: 'log', stream: 'out', lines: [`Generating Baseline: 1/1 [=>..................] ${i}/1000000 3.4`] })
  }, 50)
})
