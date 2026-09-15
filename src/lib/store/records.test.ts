import { describe, expect, it } from 'vitest'
import { parseAddonExport } from '../import/character'
import {
  engineCompatibility, makePortable, MAX_PORTABLE_BYTES, readPortable, redactCharacter,
} from './records'
import { classifyStorageError } from './db'
import { fromBase64Url, toBase64Url } from './share'

const SAMPLE = 'warlock=Realname\nserver=realmname\nregion=eu\nlevel=90\nhead=,id=1,bonus_id=2'

describe('portable files', () => {
  it('round-trips a valid export', () => {
    const file = makePortable('setup', { a: 1 })
    const check = readPortable(JSON.stringify(file))
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.file.payload).toEqual({ a: 1 })
  })

  it('rejects foreign, damaged, oversized and future files with an actionable reason', () => {
    expect(readPortable('not json')).toMatchObject({ ok: false })
    expect(readPortable('{"format":"other"}')).toMatchObject({ ok: false })
    expect(readPortable('{"format":"frostsim","version":99,"kind":"setup","payload":{}}'))
      .toMatchObject({ ok: false, reason: expect.stringContaining('v99') })
    expect(readPortable('{"format":"frostsim","version":1,"kind":"setup"}'))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no contents') })
    expect(readPortable('x'.repeat(MAX_PORTABLE_BYTES + 1)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('import limit') })
  })
})

describe('redactCharacter', () => {
  const redacted = redactCharacter(parseAddonExport(SAMPLE))

  it('removes name, realm and region everywhere including the raw export', () => {
    expect(redacted.name).toBe('Shared')
    expect(redacted.server).toBe('realm')
    expect(redacted.region).toBe('xx')
    expect(redacted.raw).not.toContain('Realname')
    expect(redacted.raw).not.toContain('realmname')
    expect(redacted.profileLines.join('\n')).not.toContain('Realname')
  })

  it('keeps the gear, which is what makes the share useful', () => {
    expect(redacted.equipped[0].itemId).toBe(1)
    expect(redacted.level).toBe(90)
  })
})

describe('engineCompatibility', () => {
  const a = { upstreamCommit: 'aaa', simcVersion: '1210-01', wowVersion: '12.1.0' }

  it('accepts the same engine and game data', () => {
    expect(engineCompatibility(a, { ...a })).toEqual({ compatible: true })
  })

  it('refuses a different engine or different game data, and says which', () => {
    expect(engineCompatibility(a, { ...a, upstreamCommit: 'bbb', simcVersion: '1211-01' }))
      .toMatchObject({ compatible: false, reason: expect.stringContaining('1211-01') })
    expect(engineCompatibility(a, { ...a, wowVersion: '12.2.0' }))
      .toMatchObject({ compatible: false, reason: expect.stringContaining('12.2.0') })
  })

  it('refuses rather than guesses when the build is unrecorded', () => {
    expect(engineCompatibility(undefined, a).compatible).toBe(false)
    expect(engineCompatibility(a, undefined).compatible).toBe(false)
  })
})

describe('classifyStorageError', () => {
  it('separates quota exhaustion from a denied store', () => {
    expect(classifyStorageError(new DOMException('x', 'QuotaExceededError')).kind).toBe('quota')
    expect(classifyStorageError(new DOMException('x', 'SecurityError')).kind).toBe('unavailable')
    expect(classifyStorageError(new DOMException('x', 'DataError')).kind).toBe('invalid-record')
    expect(classifyStorageError(new DOMException('x', 'DataCloneError')).kind).toBe('invalid-record')
    expect(classifyStorageError(new Error('boom')).kind).toBe('error')
  })
})

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding or url-unsafe characters', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256)
    const encoded = toBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect([...fromBase64Url(encoded)]).toEqual([...bytes])
  })
})
