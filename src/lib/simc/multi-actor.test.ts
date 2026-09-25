// Several characters in one run (multi-actor.ts): per-character scenario lines, one copy of the enemies, unique names.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAddonExport } from '../import/character'
import { multiActorParts } from './multi-actor'

const A = parseAddonExport(readFileSync(new URL('../../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8'))
const classLines = (p: string) => p.split('\n').filter((l) => l.startsWith('warlock='))

describe('multiActorParts', () => {
  it('leaves a single character exactly as before', () => {
    const out = multiActorParts([{ character: A }], ['potion=x', 'enemy=Boss'])
    expect(out.extraProfileLines).toEqual(['potion=x', 'enemy=Boss'])
    expect(out.names).toEqual([A.name])
  })

  it('puts player lines in each block, the enemy once after all, and renames a second character of the same name', () => {
    const out = multiActorParts([{ character: A }, { character: A, overrides: { talents: 'ABC' } }], ['potion=x', 'enemy=Boss', 'enemy_health=1'])
    expect(out.extraProfileLines).toEqual(['enemy=Boss', 'enemy_health=1'])
    expect(classLines(out.profile)).toEqual([`warlock=${A.name}`, `warlock=${A.name}_2`])
    expect(out.names).toEqual([A.name, `${A.name}_2`])
    const blocks = out.profile.split(/\n(?=warlock=)/)
    expect(blocks).toHaveLength(2)
    for (const b of blocks) expect(b.split('\n')).toContain('potion=x')
    expect(blocks[1]).toContain('talents=ABC')
  })
})
