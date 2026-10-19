import type { CandidateMeasurement, CandidateStatus } from '../optimization/types'
import type { SearchLedger } from '../optimization/runner'

export interface SearchCheckpoint {
  version: 1
  /** The caller's frozen settings, including effective engine settings and selected inputs. */
  request: unknown
  ledger: SearchLedger
}

const statuses: CandidateStatus[] = ['pending', 'running', 'measured', 'eliminated', 'missing', 'failed']
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const measurement = (v: unknown): v is CandidateMeasurement => object(v)
  && typeof v.candidateId === 'string' && nonnegative(v.mean) && nonnegative(v.iterations)
  && Number.isSafeInteger(v.stageIndex) && (v.stageIndex as number) >= 0
  && (v.margin === null || nonnegative(v.margin))
  && (v.confidence === null || (nonnegative(v.confidence) && v.confidence <= 1))
const accuracy = (v: unknown): boolean => object(v) && (v.mode === 'iterations'
  ? nonnegative(v.iterations) && v.iterations > 0
  : v.mode === 'targetError' && nonnegative(v.targetError) && v.targetError > 0 && nonnegative(v.maxIterations) && v.maxIterations > 0)

/** Local storage is an input boundary too; malformed checkpoints never reach the search loop. */
export function readSearchCheckpoint(value: unknown): SearchCheckpoint | null {
  try {
    if (!object(value) || value.version !== 1 || !object(value.request) || !object(value.ledger)) return null
    if (JSON.stringify(value).length > 8 * 1024 * 1024) return null
    const l = value.ledger
    if (typeof l.requestIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(l.requestIdentity)
      || !Number.isSafeInteger(l.stageIndex) || (l.stageIndex as number) < 0 || (l.stageIndex as number) > 10000
      || !object(l.completed) || !Object.entries(l.completed).every(([id, m]) => measurement(m) && m.candidateId === id && m.stageIndex <= (l.stageIndex as number))
      || !object(l.eliminated) || !Object.values(l.eliminated).every(v => typeof v === 'string')
      || !nonnegative(l.samplesSpent) || !nonnegative(l.elapsedMs)
      || (l.baseline !== null && (!measurement(l.baseline) || l.baseline.candidateId !== 'baseline' || l.baseline.stageIndex > (l.stageIndex as number)))
      || !Array.isArray(l.stagesRun) || !l.stagesRun.every(s => object(s) && typeof s.label === 'string' && accuracy(s.accuracy) && nonnegative(s.candidates) && nonnegative(s.samples) && (s.targetReached === null || typeof s.targetReached === 'boolean'))
      || !object(l.states) || !Object.entries(l.states).every(([id, s]) => object(s) && statuses.includes(s.status as CandidateStatus)
        && (s.measurement === null || (measurement(s.measurement) && s.measurement.candidateId === id && s.measurement.stageIndex <= (l.stageIndex as number)))
        && (s.status !== 'measured' || s.measurement !== null)
        && Array.isArray(s.history) && s.history.every(m => measurement(m) && m.candidateId === id && m.stageIndex <= (l.stageIndex as number)) && (s.note === undefined || typeof s.note === 'string'))
      || !['activeIds', 'droppedWhileAlive', 'warnings', 'problems'].every(k => Array.isArray(l[k]) && l[k].every(v => typeof v === 'string'))
      || (l.verificationIds !== undefined && (!Array.isArray(l.verificationIds) || !l.verificationIds.every(id => typeof id === 'string' && Object.hasOwn(l.states as object, id))))
      || (l.finished !== undefined && typeof l.finished !== 'boolean')) return null
    if (l.pass !== undefined) {
      if (!object(l.pass) || !object(l.pass.plan) || !object(l.pass.accuracies) || !Object.values(l.pass.accuracies).every(accuracy)) return null
      const p = l.pass.plan
      if (typeof p.label !== 'string' || !accuracy(p.accuracy) || !nonnegative(p.maxSurvivors) || !nonnegative(p.batchSize) || p.batchSize < 1
        || (p.restrictTo !== undefined && (!Array.isArray(p.restrictTo) || !p.restrictTo.every(id => typeof id === 'string')))
        || !['noElimination', 'noCache'].every(k => p[k] === undefined || typeof p[k] === 'boolean')
        || !['stageCount', 'looks', 'estimatedSamplesRemaining'].every(k => p[k] === undefined || nonnegative(p[k]))) return null
    }
    return structuredClone(value) as unknown as SearchCheckpoint
  } catch { return null }
}

export function resumeLedger(value: unknown): SearchLedger {
  const checkpoint = readSearchCheckpoint(value)
  if (!checkpoint) throw new Error('This saved checkpoint is incompatible or damaged. The setup is unchanged; start a new search to continue.')
  return checkpoint.ledger
}
