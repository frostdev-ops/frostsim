// Real worker runs production parser; boundary tests exercise actual transfer path, not inline call.

import { parentPort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Match the production report worker's bundled imports; Node's TS loader does not resolve extensionless dependencies.
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../report.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { parseReport } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

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
