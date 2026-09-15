// Invokes reap then never unwinds — worker browser killed between messages. Page must not call that clean teardown.
import { parentPort } from 'node:worker_threads'
import { PROTOCOL } from './protocol.mjs'

parentPort.on('message', (data) => {
  if (data.type === 'cancel') return
  const post = (msg) => parentPort.postMessage({ protocol: PROTOCOL, jobId: data.jobId, ...msg })
  const flag = data.cancelFlag ? new Int32Array(data.cancelFlag) : null
  post({ type: 'ready' })
  post({ type: 'log', stream: 'out', lines: ['Baseline\t1\t1\t5\t10000\t3.4\t1.0'] })

  const watch = setInterval(() => {
    if (!flag || Atomics.load(flag, 0) === 0) return
    clearInterval(watch)
    post({ type: 'reaping', threads: 16 })
  }, 10)
})
