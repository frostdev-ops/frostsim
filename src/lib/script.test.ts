import { describe, expect, it } from 'vitest'
import { diagnose, findAll, tokenizeLine } from './script'

describe('tokenizeLine', () => {
  it('never drops a character, so an overlay stays aligned with the textarea', () => {
    // The highlight layer sits behind a transparent textarea. One lost space and
    // every line below it is offset.
    for (const line of [
      'talents=CEUAkgAAAA',
      'actions+=/frostbolt,if=buff.icy_veins.up',
      '# a comment',
      '  indented=value',
      'no equals here',
      '',
      'trailing=',
      '=leading',
    ]) {
      expect(tokenizeLine(line).map((t) => t.text).join('')).toBe(line)
    }
  })

  it('keeps the + with the operator, as simc reads it', () => {
    expect(tokenizeLine('actions+=/x')).toEqual([
      { kind: 'key', text: 'actions' },
      { kind: 'op', text: '+=' },
      { kind: 'value', text: '/x' },
    ])
  })

  it('treats a whole comment line as a comment even when it contains =', () => {
    expect(tokenizeLine('# gear=head')).toEqual([{ kind: 'comment', text: '# gear=head' }])
  })
})

describe('diagnose', () => {
  it('catches an unbalanced quote, which swallows the rest of the file', () => {
    const d = diagnose('mage=Test\nname="Unclosed\ntalents=AAA')
    expect(d).toContainEqual(expect.objectContaining({ line: 2, level: 'error' }))
  })

  it('flags options Frostsim will ignore, with the reason', () => {
    const d = diagnose('mage=T\nthreads=32')
    const hit = d.find((x) => x.line === 2)
    expect(hit?.level).toBe('error')
    expect(hit?.message).toContain('threads')
  })

  it('warns when actor-scoped options appear before any actor', () => {
    const d = diagnose('talents=AAA\nmage=Test')
    expect(d[0]).toMatchObject({ line: 1, level: 'warning' })
    expect(d[0].message).toContain('no actor')
    // Once actor exists same line is fine.
    expect(diagnose('mage=Test\ntalents=AAA')).toEqual([])
  })

  it('warns on += with no base assignment, and not when there is one', () => {
    expect(diagnose('mage=T\nactions+=/frostbolt')[0]).toMatchObject({ level: 'warning' })
    expect(diagnose('mage=T\nactions=/x\nactions+=/y')).toEqual([])
  })

  it('does not flag options that are only ever appended', () => {
    // raid_events+= never has base assignment; warning flagged every valid dungeon route line so diagnostic fires on correct input.
    expect(diagnose('mage=T\nraid_events+=/pull,enemies=Mob:100,delay=5')).toEqual([])
    expect(diagnose('mage=T\nraid_events+=/adds,count=3\nraid_events+=/movement,cooldown=30')).toEqual([])
    // actions still warned: profile normally opens with actions= so appending with no base unusual even though engine accepts.
    expect(diagnose('mage=T\nactions+=/frostbolt')[0].level).toBe('warning')
  })

  it('notes a repeated assignment, since the last one wins', () => {
    const d = diagnose('mage=T\nlevel=80\nlevel=70')
    expect(d).toContainEqual(expect.objectContaining({ line: 3, level: 'info' }))
  })

  it('catches the item line that silently equips nothing', () => {
    // `finger1=id=251136,...` makes simc read everything before the first comma
    // as the item NAME. The slot equips nothing and the result is quietly low.
    // Uses the engine layer's own `itemLineProblem`, so the editor and the
    // run-time boundary cannot disagree about what is wrong.
    const d = diagnose('mage=T\nfinger1=id=251136,bonus_id=10390')
    expect(d.some((x) => x.line === 2 && x.level === 'error')).toBe(true)
  })

  it('does NOT flag options it does not recognise', () => {
    // simc knows thousands this app does not; flagging would train users to ignore panel.
    expect(diagnose('mage=T\nsome_future_option=7')).toEqual([])
  })

  it('ignores comments and blank lines entirely', () => {
    expect(diagnose('# threads=32\n\n   \n# talents=AAA')).toEqual([])
  })
})

describe('findAll', () => {
  it('reports every hit with its line and offsets', () => {
    const text = 'frostbolt\nice_lance\nfrostbolt'
    const hits = findAll(text, 'frostbolt')
    expect(hits.map((h) => h.line)).toEqual([1, 3])
    expect(text.slice(hits[1].start, hits[1].end)).toBe('frostbolt')
  })

  it('is case-insensitive by default and exact when asked', () => {
    expect(findAll('Frostbolt', 'frostbolt')).toHaveLength(1)
    expect(findAll('Frostbolt', 'frostbolt', true)).toHaveLength(0)
  })

  it('terminates on an empty or repeating needle', () => {
    expect(findAll('aaa', '')).toEqual([])
    expect(findAll('aaaa', 'aa').length).toBe(2)
  })
})
