import { expect, it } from 'vitest'
import { readSearchCheckpoint } from './search-checkpoint'

const saved = () => ({
  version: 1, request: {}, ledger: {
    requestIdentity: 'a'.repeat(64), stageIndex: 1, completed: {}, eliminated: {},
    samplesSpent: 0, elapsedMs: 0, baseline: null, stagesRun: [],
    states: { a: { status: 'missing', measurement: null, history: [] } },
    activeIds: [], droppedWhileAlive: [], warnings: [], problems: [], finished: true,
  },
})

it('accepts legacy checkpoints and preserves selected verification IDs', () => {
  expect(readSearchCheckpoint(saved())).not.toBeNull()
  const value = { ...saved(), ledger: { ...saved().ledger, verificationIds: ['a'] } }
  expect(readSearchCheckpoint(value)?.ledger).toMatchObject({ verificationIds: ['a'] })
})

it.each(['a', [42], ['unknown']])('refuses malformed or unknown selected verification IDs: %j', verificationIds => {
  const value = { ...saved(), ledger: { ...saved().ledger, verificationIds } }
  expect(readSearchCheckpoint(value)).toBeNull()
})
