// Several characters in one guided run (D2). simc simulates each player in its own batch (single_actor_batch=1), so every
// character gets its own number. A scenario's player-scoped lines (consumables, preset player setup) must sit inside each
// character's block, or they would reach only the last one declared; enemies and the rest go once, after every character.

import { CLASS_LABELS, type ImportedCharacter } from '../import/character'
import { buildProfile, type ProfileOverrides } from '../import/serialize'
import { declaresActor } from './options'
import { applyWeeklyDefaults } from './weekly-defaults'

export interface Member { character: ImportedCharacter; overrides?: ProfileOverrides }

/** First class line of a profile renamed, so two characters with one name stay apart in the report. */
function renamed(profile: string, name: string): string {
  const lines = profile.split('\n')
  const at = lines.findIndex((l) => Object.hasOwn(CLASS_LABELS, l.match(/^\s*(\w+)\s*=/)?.[1] ?? ''))
  if (at >= 0) lines[at] = `${lines[at].slice(0, lines[at].indexOf('='))}=${name}`
  return lines.join('\n')
}

/** The combined profile and the lines that follow it. With one member this is buildProfile plus the lines unchanged. */
export function multiActorParts(members: readonly Member[], extraLines: readonly string[]): { profile: string; extraProfileLines: string[]; names: string[] } {
  if (members.length < 2) {
    const m = members[0]
    return { profile: m ? buildProfile(m.character, m.overrides) : '', extraProfileLines: [...extraLines], names: m ? [m.character.name] : [] }
  }
  const at = extraLines.findIndex(declaresActor)
  const perActor = at === -1 ? [...extraLines] : extraLines.slice(0, at)
  const shared = at === -1 ? [] : extraLines.slice(at)
  const used = new Set<string>()
  const names: string[] = []
  const profiles = members.map(({ character, overrides }) => {
    let name = character.name || 'Character'
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${character.name}_${n}`
    used.add(name.toLowerCase())
    names.push(name)
    const own = applyWeeklyDefaults(buildProfile(character, { ...overrides, append: [...(overrides?.append ?? []), ...perActor] }))
    return name === character.name ? own : renamed(own, name)
  })
  return { profile: profiles.join('\n'), extraProfileLines: shared, names }
}

const CLASS_LINE = /^\s*(\w+)\s*=\s*"?([^"\r\n]*)"?\s*$/

/** Character blocks of a guided profile, each from its class line to the next; lines before the first class line go with it. */
export function characterBlocks(profile: string): { name: string; text: string }[] {
  const blocks: { name: string; lines: string[] }[] = []
  let lead: string[] = []
  for (const line of profile.split('\n')) {
    const m = CLASS_LINE.exec(line)
    if (m && Object.hasOwn(CLASS_LABELS, m[1].toLowerCase())) {
      blocks.push({ name: m[2] || m[1], lines: [...lead, line] })
      lead = []
    } else if (blocks.length) blocks[blocks.length - 1].lines.push(line)
    else lead.push(line)
  }
  return blocks.map((b) => ({ name: b.name, text: b.lines.join('\n') }))
}

type Report = { sim: { players?: unknown[] } & Record<string, unknown> }

/** The first report with the second's characters appended after its own. Each character was its own sim, so nothing is combined. */
export function mergeCharacters(first: ArrayBuffer, second: ArrayBuffer): ArrayBuffer {
  const decode = (b: ArrayBuffer): Report => JSON.parse(new TextDecoder().decode(b))
  const merged = decode(first)
  merged.sim.players = [...(merged.sim.players ?? []), ...(decode(second).sim.players ?? [])]
  return new TextEncoder().encode(JSON.stringify(merged)).buffer as ArrayBuffer
}
