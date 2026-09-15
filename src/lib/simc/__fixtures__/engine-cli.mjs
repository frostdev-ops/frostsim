// Real worker running real wasm engine via node relink (scripts/engine-smoke.sh builds it). Proves controller's profile/args have effect (transport alone cannot). Browser artifact can't run here (identical code, different env); use for numbers not lifecycle claims.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { PROTOCOL, validate } from './protocol.mjs'

const CLI = {
  threaded: 'build/wasm/simc-node.cjs',
  fallback: 'build/wasm-fallback/simc-node.cjs',
}

parentPort.on('message', (data) => {
  const post = (msg) => parentPort.postMessage({ protocol: PROTOCOL, jobId: data?.jobId, ...msg })

  const problem = validate(data)
  if (problem) {
    post({ type: 'error', code: 'protocol', message: problem })
    return
  }

  post({ type: 'assets', loaded: 1, total: 1, cached: true })
  post({ type: 'initializing' })
  post({ type: 'ready' })

  const dir = mkdtempSync(join(tmpdir(), 'frostsim-cli-'))
  const profileFile = join(dir, 'profile.simc')
  const reportFile = join(dir, 'out.json')
  writeFileSync(profileFile, data.profile)

  // Only rewriting: in-MEMFS paths become real ones; every option keeps position/spelling.
  const htmlFile = join(dir, 'out.html')
  const argv = data.args.map((a) => {
    if (a === data.profilePath) return profileFile
    const withReport = a.split(data.reportPath).join(reportFile)
    return data.htmlPath ? withReport.split(data.htmlPath).join(htmlFile) : withReport
  })

  // spawnSync not execFileSync: latter only returns stdout; stderr has all engine notices (option ignored, etc).
  const run = spawnSync(process.execPath, [CLI[workerData?.variant ?? 'fallback'], ...argv], {
    cwd: workerData?.cwd ?? process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  try {
    if (run.error) throw run.error
    const stderr = (run.stderr ?? '').split('\n').filter(Boolean)
    if (stderr.length) post({ type: 'log', stream: 'err', lines: stderr })
    post({ type: 'log', stream: 'out', lines: (run.stdout ?? '').split('\n').filter(Boolean).slice(-20) })

    // Same split as real worker: simc exits 0 with no report (no actor script) vs engine failing.
    if (!existsSync(reportFile)) {
      post({ type: 'error', code: 'report-missing', message: 'simc exited 0 but wrote no report at ' + data.reportPath })
      return
    }

    const bytes = new Uint8Array(readFileSync(reportFile))
    const message = { protocol: PROTOCOL, jobId: data.jobId, type: 'done', report: bytes }
    const transfer = [bytes.buffer]
    if (data.htmlPath) {
      const html = new Uint8Array(readFileSync(htmlFile))
      message.html = html
      transfer.push(html.buffer)
    }
    parentPort.postMessage(message, transfer)
  } catch (err) {
    post({ type: 'error', code: 'engine', message: String(err.stderr ?? err.message ?? err).slice(0, 4000) })
  }
})
