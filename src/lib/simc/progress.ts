// Parse simc's stdout progress line. Pure, no wasm. Engine has no structured progress; this is only live signal.
// THE APP ASKS FOR `progressbar_type=1`: default mode's CR-terminated updates are invisible to browser (Emscripten fires per NEWLINE). Type 1 emits newline-terminated tab-delimited records instead.
// With profileset_work_threads set, engine prints different line instead (profileset.cpp:829). Both handled.

export interface EngineProgress {
  /** "Baseline", "Profileset", "Profilesets", or whatever phase the engine names. */
  base: string
  /** The profileset id, when the engine is on one. */
  phase?: string
  /** 1-based. For a profileset run, phase 1 is the baseline. */
  phaseIndex: number
  phaseTotal: number
  /** Absent on the parallel-profileset line, which reports no iteration counts. */
  iterations?: number
  iterationTotal?: number
  iterationsPerSecond?: number
  /** Running estimates. Present only while a target_error run is converging. */
  mean?: number
  errorPct?: number
  /**
   * The engine's own estimate of time left in this phase. Absent once the phase
   * is finished, because the engine then reuses the same tokens for the total
   * elapsed time and reporting that as "remaining" would be a lie.
   */
  etaSeconds?: number
  /** The bar reached its end. */
  finished: boolean
}

const NORMAL =
  /^Generating\s+([^:]*):\s*(.*?)\s*(\d+)\/(\d+)\s+\[([=>.]*)\]\s+(\d+)\/(\d+)(?:\s+([\d.]+))?/

const WITH_ERROR = /\bMean=([\d.]+)\s+Error=([\d.]+)%/

// ETA: " 12min" / " 34sec" when non-zero; "58msec" has "m" not "sec" so no match.
const ETA_MIN = /\s(\d+)min\b/
const ETA_SEC = /\s(\d+)sec\b/

// Parallel profileset line (profileset.cpp:829, profileset_work_threads > 0).
const PARALLEL = /^Profilesets\s*\(\d+\*\d+\):\s*(\d+)\/(\d+)\s+\[([=>.]*)\]/

function finite(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// progressbar_type=1 record (progress_bar.cpp). Phase and mean/error optional; shape resolved by numeric parsing.
function parseSimpleRecord(text: string): EngineProgress | null {
  const f = text.split('\t')
  if (f.length < 6) return null

  // With phase, everything after base shifts by one; phase name is not numeric, phase index is.
  const offset = finite(f[1]) === undefined ? 1 : 0
  const idx = finite(f[offset + 1])
  const phaseTotal = finite(f[offset + 2])
  const cur = finite(f[offset + 3])
  const total = finite(f[offset + 4])
  const rate = finite(f[offset + 5])
  if (idx === undefined || phaseTotal === undefined || cur === undefined || total === undefined) return null
  if (rate === undefined || total < cur) return null

  // After rate: [remaining] or [mean, error, remaining], optionally with human-readable estimate.
  let rest = f.slice(offset + 6)
  if (rest.length && finite(rest[rest.length - 1]) === undefined) rest = rest.slice(0, -1)
  const converging = rest.length >= 3
  const mean = converging ? finite(rest[0]) : undefined
  const errorPct = converging ? finite(rest[1]) : undefined
  const remaining = finite(rest[rest.length - 1])

  const finished = cur >= total
  return {
    base: f[0].trim(),
    phase: offset ? f[1] : undefined,
    phaseIndex: idx,
    phaseTotal,
    iterations: cur,
    iterationTotal: total,
    iterationsPerSecond: rate,
    mean,
    errorPct,
    etaSeconds: finished ? undefined : remaining,
    finished,
  }
}

/** Return null for non-progress-bar lines (most of them). */
export function parseProgressLine(line: string): EngineProgress | null {
  // Bar rewritten in place; chunk holds several revisions, take the latest that parses. The parallel profileset bar ends in \r
  // only, so a cloud worker hands it over in 4 KiB cuts (cloud/worker/agent.mjs readLines) whose last record can be cut short.
  const records = line.replace(/\r/g, '\n').split('\n').filter(Boolean)
  for (let i = records.length - 1; i >= 0; i--) {
    const parsed = parseRecord(records[i])
    if (parsed) return parsed
  }
  return null
}

function parseRecord(text: string): EngineProgress | null {
  if (text.includes('\t')) {
    const simple = parseSimpleRecord(text)
    if (simple) return simple
  }

  const parallel = PARALLEL.exec(text)
  if (parallel) {
    return {
      base: 'Profilesets',
      phaseIndex: Number(parallel[1]),
      phaseTotal: Number(parallel[2]),
      finished: Number(parallel[1]) >= Number(parallel[2]),
    }
  }

  const m = NORMAL.exec(text)
  if (!m) return null

  const bar = m[5]
  const iterations = Number(m[6])
  const iterationTotal = Number(m[7])
  const error = WITH_ERROR.exec(text)
  const finished = !bar.includes('.') && iterations >= iterationTotal

  let etaSeconds: number | undefined
  if (!finished) {
    const minutes = ETA_MIN.exec(text)
    const seconds = ETA_SEC.exec(text)
    if (minutes || seconds) {
      etaSeconds = (minutes ? Number(minutes[1]) * 60 : 0) + (seconds ? Number(seconds[1]) : 0)
    }
  }

  return {
    base: m[1].trim(),
    phase: m[2] ? m[2] : undefined,
    phaseIndex: Number(m[3]),
    phaseTotal: Number(m[4]),
    iterations,
    iterationTotal,
    iterationsPerSecond: m[8] === undefined ? undefined : Number(m[8]),
    mean: error ? Number(error[1]) : undefined,
    errorPct: error ? Number(error[2]) : undefined,
    etaSeconds,
    // Engine only writes bar with no dots when phase is done.
    finished,
  }
}

/** Newest progress in batch of log lines; newest wins (line is redraw, not history). */
export function latestProgress(lines: readonly string[]): EngineProgress | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseProgressLine(lines[i])
    if (parsed) return parsed
  }
  return null
}

/** Count finished candidates: engine counts baseline as phase 1, so phase N = N-1 candidates done. Parallel line counts directly. */
export function candidatesDone(progress: EngineProgress, candidateCount: number): number {
  // A hybrid run's record names its finished parts: "3 of 10" (hybrid.ts).
  if (progress.base === 'Hybrid') return Math.min(Number(progress.phase?.split(' ')[0]) || 0, candidateCount)
  if (progress.base === 'Profilesets') return Math.min(progress.phaseIndex, candidateCount)
  return Math.max(0, Math.min(progress.phaseIndex - 1, candidateCount))
}
