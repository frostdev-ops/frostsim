// The linear NAMED_ITEM_COMMENT and looksLikeProfile regexes (CLAUDE.md D15: the account server parses uploaded exports, so crafted input must stay cheap) against copies of the quadratic
// originals: identical results on the fixtures and on crafted input, and a time bound on the crafted input.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { looksLikeProfile, NAMED_ITEM_COMMENT } from './character'

const OLD_NAMED = /^(.+?)\s+\((\d+)\)$/
const CLASS_KEYS = ['deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk', 'priest', 'paladin', 'rogue', 'shaman', 'warlock', 'warrior']
function oldLooksLikeProfile(text: string): boolean {
  const head = text.replace(/^﻿/, '').slice(0, 4000).toLowerCase()
  return CLASS_KEYS.some((k) => new RegExp(`(^|\\n)\\s*${k}\\s*=`, 'm').test(head))
}

const FIXTURES = ['addon-export-demonology.simc', 'addon-export-vengeance-import.simc']
  .map((name) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), 'utf8'))
const fixtureLines = FIXTURES.flatMap((text) => text.replace(/\r\n?/g, '\n').split('\n'))

/** What parseAddonExport hands the regex: a comment line without its #s, trimmed. */
const body = (line: string) => line.replace(/^#+\s*/, '').trim()
const named = (re: RegExp, s: string) => re.exec(s)?.slice() ?? null

const N = 4096 // the account server's line cap
const craftedNames = [
  'a' + ' '.repeat(N) + 'b', 'a' + ' '.repeat(N) + '(1', 'a' + ' '.repeat(N) + '(1)x', 'a' + ' \t '.repeat(N / 4) + '(42)',
  'a' + ' '.repeat(N) + '  (7)', 'a b' + ' '.repeat(N) + '(7)', 'a (' + '1'.repeat(N) + 'x', 'x (1'.repeat(N / 4),
  'a b'.repeat(N / 3) + ' (5)', 'Item (5) (6)', 'Item\t(05)', '(5)', 'x(5)', 'x (5)', 'x (5) ', '  (5)', ' ', 'x ()', 'x (5a)',
]
const craftedProfiles = [
  '\n'.repeat(3990) + 'warlock=x', '\n'.repeat(4000) + 'warlock=x', '\r\n'.repeat(1995) + 'mage=x', ' \n'.repeat(1995) + 'mage =x',
  '\n \t'.repeat(1300) + 'warrior', 'x' + ' '.repeat(3990) + 'warlock=', ' '.repeat(3990) + 'warlock=', 'x   warlock=',
  'x warlock=', 'warlock' + ' '.repeat(3990) + 'x', 'warlock' + '\n'.repeat(3990) + '=', '\nwarlock \n'.repeat(400),
  'xdemonhunter=', 'demonhunter=x', '﻿warlock=x', '\n﻿ warlock=', '\n' + ' '.repeat(3990) + 'priest=', 'x\rpriest=',
  'hello world', 'warlock=X', '',
]

describe('NAMED_ITEM_COMMENT', () => {
  it('matches the original on every fixture line and every crafted comment body', () => {
    const bodies = [...fixtureLines, ...craftedNames].map(body)
    for (const b of bodies) expect(named(NAMED_ITEM_COMMENT, b)).toEqual(named(OLD_NAMED, b))
    expect(bodies.filter((b) => NAMED_ITEM_COMMENT.test(b)).length).toBeGreaterThan(10)
  })

  it('stays linear on crafted bodies far past the line cap', () => {
    const big = ['a' + ' '.repeat(200_000) + 'b', 'a' + ' \t'.repeat(100_000) + '(1', 'a (' + '1'.repeat(200_000) + 'x', 'a b'.repeat(70_000)]
    const start = performance.now()
    for (const b of big) NAMED_ITEM_COMMENT.exec(body(b))
    // The original takes about 150 ms on the first one at 20,000 characters, and grows with the square.
    expect(performance.now() - start).toBeLessThan(100)
  })
})

describe('looksLikeProfile', () => {
  it('matches the original on the fixtures, their lines and every crafted head', () => {
    const inputs = [...FIXTURES, ...FIXTURES.map((f) => '\n\n  \n' + f), ...fixtureLines, ...craftedProfiles]
    for (const text of inputs) expect([text.slice(0, 40), looksLikeProfile(text)]).toEqual([text.slice(0, 40), oldLooksLikeProfile(text)])
    expect(craftedProfiles.filter(looksLikeProfile).length).toBeGreaterThan(5)
  })

  it('stays linear on crafted heads', () => {
    const start = performance.now()
    for (let i = 0; i < 10; i++) for (const text of craftedProfiles) looksLikeProfile(text)
    // The original takes about 180 ms for the 3,990 blank lines alone; this is 10 passes over all of them.
    expect(performance.now() - start).toBeLessThan(100)
  })
})
