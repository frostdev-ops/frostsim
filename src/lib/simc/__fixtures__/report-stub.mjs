// Real worker runs production parser; boundary tests exercise actual transfer path, not inline call.

import { parentPort } from 'node:worker_threads'
import { parseReport } from '../report.ts'

parentPort.on('message', ({ jobId, kind = 'summary', bytes }) => {
  let response
  try {
    const raw = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)))
    response = { jobId, ok: true, kind: 'summary', report: parseReport(raw), bytes }
  } catch (err) {
    response = { jobId, ok: false, kind, message: err instanceof Error ? err.message : String(err), bytes }
  }
  parentPort.postMessage(response, [response.bytes])
})
