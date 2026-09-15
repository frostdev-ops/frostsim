import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Svelte 5 state_unsafe_mutation: $derived body writes to $state variable (runtime only, not vitest/svelte-check).

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return svelteFiles(path)
    return path.endsWith('.svelte') ? [path] : []
  })
}

/** Offset past balanced ) closing call; skip comments before quotes (apostrophe would eat rest of file). */
function endOfCall(text: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i)
    else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i) + 1
    else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
    if (i < 0) break
  }
  return text.length
}

describe('$derived bodies', () => {
  const files = [...svelteFiles('src/routes'), ...svelteFiles('src/lib/ui'), 'src/App.svelte']

  it('scans the files it means to scan', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('never writes to a $state variable', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const names = [...text.matchAll(/\blet\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\$state\b/g)]
        .map((m) => m[1])
      if (!names.length) continue
      // name = (but not == or =>), plus +=, -=, ++, --.
      const write = new RegExp(
        `\\b(${names.join('|')})\\s*(?:=(?![=>])|[+\\-*/%]=|\\+\\+|--)`,
        'g',
      )
      for (const m of text.matchAll(/\$derived(?:\.by)?\s*\(/g)) {
        const open = m.index + m[0].length - 1
        const body = text.slice(open, endOfCall(text, open))
        for (const w of body.matchAll(write)) {
          const line = text.slice(0, open + w.index).split('\n').length
          offenders.push(`${file}:${line}: ${w[0].trim()} inside ${m[0].trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
