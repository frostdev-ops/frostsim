import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Keyed each where key IS the item throws each_key_duplicate when two entries equal: {#each result.warnings as w (w)} crashed Top Gear after 48s when optimizer pushed same string three times across stages (three identical entries). Keying buys reconciliation identity; immutable string lists don't need it, cannot safely have it. Scans for the shape.

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return svelteFiles(path)
    return path.endsWith('.svelte') ? [path] : []
  })
}

// {#each things as thing (thing)}: key expression is item binding itself, no property access to make distinct.
const SELF_KEYED = /\{#each\s+[^}]*?\s+as\s+([A-Za-z_$][\w$]*)\s*\(\s*\1\s*\)\s*\}/g

describe('keyed each blocks', () => {
  const files = [...svelteFiles('src/routes'), ...svelteFiles('src/lib/ui'), 'src/App.svelte']

  it('scans the files it means to scan', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('never keys a list by the item itself', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(SELF_KEYED)) {
        // Safe by construction and clearer keyed than indexed: literals, ROUTES, GEAR_SLOTS, Object.entries (compile-time), levels (strictly increasing).
        if (/\{#each\s*(\[|ROUTES|GEAR_SLOTS|Object\.|levels\s)/.test(m[0])) continue
        offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
