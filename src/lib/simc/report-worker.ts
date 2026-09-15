// Bundled worker: turns raw report bytes to typed results. Engine worker is plain JS (D10), can't import parsers. Buffer transferred in/out.

import { parseReport, type SimReport } from './report'
import { parsePlayerDetail, type PlayerDetail } from './detail'

export type ReportWorkerRequest =
  | { jobId: string; kind?: 'summary'; bytes: ArrayBuffer }
  | { jobId: string; kind: 'detail'; bytes: ArrayBuffer; playerName: string }

export type ReportWorkerResponse =
  | { jobId: string; ok: true; kind: 'summary'; report: SimReport; bytes: ArrayBuffer }
  | { jobId: string; ok: true; kind: 'detail'; detail: PlayerDetail; bytes: ArrayBuffer }
  | { jobId: string; ok: false; kind: 'summary' | 'detail'; message: string; bytes: ArrayBuffer }

self.onmessage = (e: MessageEvent<ReportWorkerRequest>) => {
  const req = e.data
  const kind = req.kind ?? 'summary'
  const { jobId, bytes } = req
  let response: ReportWorkerResponse
  try {
    const raw = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)))
    response =
      kind === 'detail'
        ? { jobId, ok: true, kind, detail: parsePlayerDetail(raw, (req as { playerName: string }).playerName), bytes }
        : { jobId, ok: true, kind: 'summary', report: parseReport(raw), bytes }
  } catch (err) {
    response = { jobId, ok: false, kind, message: err instanceof Error ? err.message : String(err), bytes }
  }
  ;(self as unknown as Worker).postMessage(response, [bytes])
}
