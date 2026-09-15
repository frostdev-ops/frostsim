// Real worker speaking engine protocol without wasm engine: boundary tests exercise real structured clone/transfer, not same-realm handoff.
// Report is trimmed real v2; parser is production.

import { parentPort } from 'node:worker_threads'
import { PROTOCOL, report, validate } from './protocol.mjs'

parentPort.on('message', (data) => {
  const post = (msg) => parentPort.postMessage({ protocol: PROTOCOL, jobId: data?.jobId, ...msg })

  const problem = validate(data)
  if (problem) {
    post({ type: 'error', code: 'protocol', message: problem })
    return
  }

  post({ type: 'assets', loaded: 63275426, total: 63275426, cached: true })
  post({ type: 'initializing' })
  post({ type: 'ready' })
  post({ type: 'log', stream: 'out', lines: ['Generating Baseline: 1/1 [===================>] 100/100 3.4'] })

  const bytes = new TextEncoder().encode(JSON.stringify(report))
  const message = { protocol: PROTOCOL, jobId: data.jobId, type: 'done', report: bytes }
  const transfer = [bytes.buffer]

  // Only when asked (like real worker): read HTML report from MEMFS iff controller named path.
  if (data.htmlPath) {
    const html = new TextEncoder().encode('<html><body>report</body></html>')
    message.html = html
    transfer.push(html.buffer)
  }

  parentPort.postMessage(message, transfer)
})
