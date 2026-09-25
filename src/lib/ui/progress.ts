// Bounded buffer over engine's stdout. Parser is execution track's progress.ts; only buffering policy (display concern) lives here.

import { parseProgressLine, type EngineProgress } from '../simc/progress'

export type { EngineProgress }

export function logTone(line: string): 'error' | 'warning' | 'progress' | 'success' | '' {
  if (/^\s*(error|fatal|severe|abort|exception)\b/i.test(line)) return 'error'
  if (/^\s*(warning|warn|could not|not yet implemented|using unverified)\b/i.test(line)) return 'warning'
  if (/^\s*(finished|completed|success|dps ranking)\b/i.test(line)) return 'success'
  if (/^\s*(simulationcraft|simulating|generating|profileset|analyzing|initializing)\b/i.test(line) || /\d+\s*\/\s*\d+/.test(line)) return 'progress'
  return ''
}

/** 0..1 when the engine has reported an iteration count, otherwise undefined. */
export function fractionOf(p: EngineProgress | null): number | undefined {
  if (!p?.iterationTotal || p.iterations === undefined) return undefined
  return Math.min(1, p.iterations / p.iterationTotal)
}

/** Keeps best estimate seen so far so rising error doesn't drag bar backwards; cosmetic, never reaches 1 (never read as target reached). */
export function highWater(previous: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return previous
  return previous === undefined ? next : Math.max(previous, next)
}

const BAR = /\[[=>.\s]*\]/
const NOTABLE = /\b(warning|error|unsupported|unknown|invalid|failed)\b/i

/** Bounded tail of engine output and latest progress; warnings held separately so truncating lines never loses them (P01.12). */
export class ProgressBuffer {
  readonly maxLines: number
  lines: string[] = []
  warnings: string[] = []
  progress: EngineProgress | null = null

  constructor(maxLines = 200) {
    this.maxLines = maxLines
  }

  push(line: string): void {
    const trimmed = line.replace(/\s+$/, '')
    if (!trimmed) return
    const parsed = parseProgressLine(trimmed)
    if (parsed) {
      this.progress = parsed
      // Engine rewrites progress line in place with \r; keep one copy.
      if (this.lines.length && BAR.test(this.lines[this.lines.length - 1])) {
        this.lines[this.lines.length - 1] = trimmed
        return
      }
    } else if (NOTABLE.test(trimmed) && !this.warnings.includes(trimmed)) {
      this.warnings.push(trimmed)
    }
    this.lines.push(trimmed)
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines)
    }
  }

  reset(): void {
    this.lines = []
    this.warnings = []
    this.progress = null
  }
}
