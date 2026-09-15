// Script tokenizing and diagnostics (P10.1): pure functions, no editor library (simc is line-oriented regexes, not parser).

import { itemLineProblem, PROTECTED_OPTIONS } from './simc/client'

export type TokenKind = 'comment' | 'key' | 'op' | 'value' | 'text'

export interface Token {
  kind: TokenKind
  text: string
}

/** Splits one line into tokens for highlighting. Never drops a character. */
export function tokenizeLine(line: string): Token[] {
  if (!line) return []
  const trimmed = line.trimStart()
  if (trimmed.startsWith('#')) return [{ kind: 'comment', text: line }]

  const eq = line.indexOf('=')
  if (eq < 0) return [{ kind: 'text', text: line }]

  // key+=value: keep + with operator (how simc reads it).
  const opStart = line[eq - 1] === '+' ? eq - 1 : eq
  const key = line.slice(0, opStart)
  const op = line.slice(opStart, eq + 1)
  const value = line.slice(eq + 1)
  const out: Token[] = []
  if (key) out.push({ kind: 'key', text: key })
  if (op) out.push({ kind: 'op', text: op })
  if (value) out.push({ kind: 'value', text: value })
  return out
}

export type DiagnosticLevel = 'error' | 'warning' | 'info'

export interface Diagnostic {
  /** 1-based, so it matches the gutter the user is reading. */
  line: number
  level: DiagnosticLevel
  message: string
}

/** Options always appended (+=): raid_events only (no raid_events= form exists). */
const ALWAYS_APPENDED = new Set(['raid_events'])

const APPEND = /^([A-Za-z_][\w.]*)\+=/
const ASSIGN = /^([A-Za-z_][\w.]*)=/

/** Advisory only: engine knows thousands of options we don't (unknown keys not reported). */
export function diagnose(text: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const lines = text.split('\n')
  const assigned = new Set<string>()
  let sawActor = false

  lines.forEach((raw, i) => {
    const line = i + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    // Unbalanced quotes swallow rest of file in simc's tokenizer (shows as unrelated error later).
    const quotes = (raw.match(/"/g) ?? []).length
    if (quotes % 2 === 1) {
      out.push({ line, level: 'error', message: 'Unbalanced quote. simc reads the rest of the file as part of this value.' })
    }

    // Engine's rule: finger1=id=... reads "id=..." as item NAME (equips nothing, silent DPS loss).
    const itemProblem = itemLineProblem(raw)
    if (itemProblem) out.push({ line, level: 'error', message: itemProblem })

    const append = APPEND.exec(trimmed)
    const assign = !append ? ASSIGN.exec(trimmed) : null

    if (append) {
      const key = append[1]
      // raid_events+= is engine's way (no base); warning on correct input trains people to ignore panel.
      if (ALWAYS_APPENDED.has(key)) {
        assigned.add(key)
      } else if (!assigned.has(key)) {
        out.push({
          line,
          level: 'warning',
          message: `"${key}+=" appends to a value that has not been set in this script. If the base value is not defined, this line starts it.`,
        })
      }
    } else if (assign) {
      const key = assign[1]
      if (assigned.has(key) && !key.startsWith('actions')) {
        out.push({
          line,
          level: 'info',
          message: `"${key}" was already set above. The last assignment wins.`,
        })
      }
      assigned.add(key)
      if ((PROTECTED_OPTIONS as readonly string[]).includes(key)) {
        out.push({
          line,
          level: 'error',
          message: `Frostsim owns "${key}" and will ignore this line. It controls how the run is measured or where output goes.`,
        })
      }
      // class= opens actor; talents/actions before one have no actor (simc drops silently).
      if (isActorOpener(key)) sawActor = true
      else if (!sawActor && ACTOR_SCOPED.has(key)) {
        out.push({
          line,
          level: 'warning',
          message: `"${key}" belongs to an actor, and no actor has been declared yet. simc applies it to nothing.`,
        })
      }
    } else if (!trimmed.includes('=')) {
      out.push({
        line,
        level: 'warning',
        message: 'Not a key=value line and not a comment. simc will try to read it as an option file name.',
      })
    }
  })

  return out
}

/** simc class keys, verified against sim.cpp:3933-3945. */
const CLASSES = new Set([
  'deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk',
  'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior',
])

function isActorOpener(key: string): boolean {
  return CLASSES.has(key) || key === 'enemy' || key === 'pet' || key === 'armory'
}

/** Options simc parses in actor scope; before an actor they land nowhere. */
const ACTOR_SCOPED = new Set([
  'talents', 'spec', 'race', 'level', 'role', 'position', 'professions',
  'actions', 'head', 'neck', 'shoulder', 'shoulders', 'back', 'chest', 'wrist',
  'wrists', 'hands', 'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1',
  'trinket2', 'main_hand', 'off_hand',
])

export interface Match {
  line: number
  /** Index within the whole text, for selecting in a textarea. */
  start: number
  end: number
}

/** Every occurrence of `needle`, with the line it falls on. */
export function findAll(text: string, needle: string, caseSensitive = false): Match[] {
  if (!needle) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const pin = caseSensitive ? needle : needle.toLowerCase()
  const out: Match[] = []
  let from = 0
  for (;;) {
    const at = hay.indexOf(pin, from)
    if (at < 0) break
    out.push({
      // Counting newlines: O(n) per hit (acceptable for typical scripts).
      line: text.slice(0, at).split('\n').length,
      start: at,
      end: at + needle.length,
    })
    from = at + Math.max(1, needle.length)
  }
  return out
}
