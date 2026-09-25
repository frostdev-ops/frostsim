// Cloud character slots are the characters (CLAUDE.md D15; DESIGN.md C5). Signed in, each character on this device sits in one of
// the account's slots: an import or update fills or rewrites its slot, a rename relabels it, a delete frees it, and a character saved
// on another device appears here. A character that finds no free slot stays on this device only and moves into one when a slot
// frees up. Signed out, nothing here runs and characters are this device's alone.
//
// The link between a character here and its slot is kept per account in localStorage (`frostsim.slots.<user id>`), with the slot's
// updatedAt and the character's own at the last exchange, so a sync knows which side changed. Without a link, characters pair by
// who they are in the game (isSameCharacter), as the server does. A delete that could not reach the server is kept and retried.

import { api, AccountError } from './api'
import { account, signedOut } from './state.svelte'
import { app, deleteCharacter, saveCharacter, setCharacterSync, toast } from '../app.svelte'
import { isSameCharacter, parseAddonExport, type ImportedCharacter } from '../import/character'
import { newId, type StoredCharacter } from '../store/records'

export interface Who { name: string; className: string; spec?: string; server?: string; region?: string }
export interface Slot { id: string; label: string; bytes: number; updatedAt: string; itemLevel?: number; who?: Who }
/** `at`: the slot's updatedAt, `local`: the character's updatedAt here, both as of the last upload or download. */
export interface Link { id: string; at: string; local: number }
export interface Saved { links: Record<string, Link>; gone: string[] }

export type Step =
  | { kind: 'free'; slotId: string }
  | { kind: 'forget'; localId: string }
  | { kind: 'pull'; slot: Slot; localId?: string }
  | { kind: 'push'; localId: string; slotId?: string }

type Local = Pick<StoredCharacter, 'id' | 'character' | 'updatedAt'>

/** What a sync does, oldest decision first: retry frees, drop characters whose slot was cleared elsewhere, bring each slot and its
 *  character up to date (the side that changed since the last exchange wins, the slot when both did), then put unslotted characters,
 *  newest first, into free slots. Pure, so the rules are testable without a server or IndexedDB. */
export function planSync(cloud: Slot[], total: number, locals: Local[], saved: Saved): Step[] {
  const gone = new Set(saved.gone)
  const steps: Step[] = cloud.filter((s) => gone.has(s.id)).map((s) => ({ kind: 'free', slotId: s.id }))
  const live = cloud.filter((s) => !gone.has(s.id))
  const here = new Map(locals.map((l) => [l.id, l]))
  const paired = new Set<string>()
  const linkOf = new Map(Object.entries(saved.links).filter(([id]) => here.has(id)).map(([id, link]) => [link.id, { id, link }]))

  for (const [id, link] of Object.entries(saved.links)) {
    if (here.has(id) && !gone.has(link.id) && !live.some((s) => s.id === link.id)) {
      steps.push({ kind: 'forget', localId: id })
      paired.add(id)
    }
  }
  for (const slot of live) {
    const linked = linkOf.get(slot.id)
    if (linked) {
      paired.add(linked.id)
      if (slot.updatedAt !== linked.link.at) steps.push({ kind: 'pull', slot, localId: linked.id })
      else if (here.get(linked.id)!.updatedAt > linked.link.local) steps.push({ kind: 'push', localId: linked.id, slotId: slot.id })
      continue
    }
    const same = slot.who && locals.find((l) => !paired.has(l.id) && !saved.links[l.id] && isSameCharacter(slot.who as ImportedCharacter, l.character))
    if (same) {
      paired.add(same.id)
      steps.push(Date.parse(slot.updatedAt) >= same.updatedAt ? { kind: 'pull', slot, localId: same.id } : { kind: 'push', localId: same.id, slotId: slot.id })
    } else {
      steps.push({ kind: 'pull', slot })
    }
  }
  let free = total - live.length
  for (const l of [...locals].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (free <= 0) break
    if (paired.has(l.id)) continue
    steps.push({ kind: 'push', localId: l.id })
    free--
  }
  return steps
}

/** `links`: character id here -> slot id, for the roster. `on`: the server has slots switched on and answered. */
export const slots = $state<{ total: number; list: Slot[]; links: Record<string, string>; on: boolean }>({ total: 0, list: [], links: {}, on: false })

/** The slot holding a character on this device, if it has one. */
export const slotOf = (localId: string): Slot | undefined => slots.list.find((s) => s.id === slots.links[localId])

let library: Promise<unknown> = Promise.resolve()
/** Syncs wait for this device's characters to load, so an empty list while loading is never taken as "none here". */
export function afterLibrary(loaded: Promise<unknown>): void {
  library = loaded
}

// Every exchange runs in order, so a save made during a sync never races it.
let chain: Promise<unknown> = Promise.resolve()
function queued(fn: () => Promise<void>): Promise<void> {
  const next = chain.then(fn)
  chain = next.catch(() => {})
  return next
}

const key = () => `frostsim.slots.${account.me!.user.id}`
function read(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(key()) ?? '')
    if (v && typeof v.links === 'object' && Array.isArray(v.gone)) return v
  } catch { /* none yet, or storage blocked */ }
  return { links: {}, gone: [] }
}
function write(saved: Saved): void {
  try {
    localStorage.setItem(key(), JSON.stringify(saved))
  } catch { /* Storage blocked: the next sync pairs characters by who they are. */ }
  slots.links = Object.fromEntries(Object.entries(saved.links).map(([id, l]) => [id, l.id]))
}

async function reload(): Promise<void> {
  const list = await api<{ slots: number; characters: Slot[] }>('/characters')
  slots.total = list.slots
  slots.list = list.characters
  slots.on = true
}

const labelOf = (c: Pick<StoredCharacter, 'label' | 'character'>) => (c.label.trim() || c.character.name || 'Character').slice(0, 100)

async function apply(step: Step, saved: Saved): Promise<void> {
  if (step.kind === 'free') {
    await api(`/characters/${step.slotId}`, 'DELETE').catch((e) => { if (!(e instanceof AccountError && e.status === 404)) throw e })
    saved.gone = saved.gone.filter((id) => id !== step.slotId)
  } else if (step.kind === 'forget') {
    delete saved.links[step.localId]
    await deleteCharacter(step.localId, true)
  } else if (step.kind === 'pull') {
    const got = await api<{ label: string; raw: string; updatedAt: string }>(`/characters/${step.slot.id}`)
    const parsed = parseAddonExport(got.raw)
    if (parsed.diagnostics.some((d) => d.severity === 'error')) throw new Error(`${got.label} in your cloud slots is not a valid export.`)
    const record = await saveCharacter(parsed, got.label, step.localId ?? newId(), true)
    saved.links[record.id] = { id: step.slot.id, at: got.updatedAt, local: record.updatedAt }
  } else if (step.kind === 'push') {
    const c = app.characters.find((x) => x.id === step.localId)
    if (!c) return
    const body = { label: labelOf(c), raw: c.character.raw }
    const put = step.slotId ? await api<{ id: string; updatedAt: string }>(`/characters/${step.slotId}`, 'PUT', body).catch((e) => {
      if (e instanceof AccountError && e.status === 404) return null
      throw e
    }) : null
    const out = put ?? await api<{ id: string; updatedAt: string }>('/characters', 'POST', body)
    saved.links[c.id] = { id: out.id, at: new Date(out.updatedAt).toISOString(), local: c.updatedAt }
  }
}

/** Brings this device and the account's slots into line (planSync). Quiet on failure: the next visit or save tries again. */
export function syncSlots(): Promise<void> {
  return queued(async () => {
    await library
    if (!account.me) {
      Object.assign(slots, { total: 0, list: [], links: {}, on: false })
      return
    }
    try {
      await reload()
    } catch (e) {
      if (e instanceof AccountError && e.status === 401) signedOut()
      // 404: the server has slots switched off, so the roster shows none.
      if (e instanceof AccountError && e.status === 404) slots.on = false
      return
    }
    const saved = read()
    let failed = 0
    for (const step of planSync(slots.list, slots.total, app.characters, saved)) {
      try {
        await apply(step, saved)
      } catch (e) {
        // 402: another device took the last slot first. 400 and 413: the server refuses this export. Either way the character stays
        // on this device only, and retrying on every visit would only repeat the message.
        if (!(e instanceof AccountError && [400, 402, 413].includes(e.status))) failed++
      }
    }
    write(saved)
    await reload().catch(() => {})
    if (failed) toast('bad', `${failed} character${failed === 1 ? '' : 's'} did not sync with your cloud slots. Frostsim tries again on your next visit.`)
  })
}

/** Runs one exchange for a save or delete made on this device, and reports what happened to its slot. */
function exchange(fn: (saved: Saved) => Promise<void>): void {
  if (!account.me || !slots.on) return
  void queued(async () => {
    const saved = read()
    try {
      await fn(saved)
    } catch (e) {
      if (e instanceof AccountError && e.status === 401) signedOut()
      else toast('bad', e instanceof Error ? e.message : String(e))
    }
    write(saved)
    await reload().catch(() => {})
  })
}

setCharacterSync({
  saved: (record) => exchange(async (saved) => {
    try {
      await apply({ kind: 'push', localId: record.id, slotId: saved.links[record.id]?.id }, saved)
    } catch (e) {
      if (!(e instanceof AccountError && e.status === 402)) throw e
      toast('info', `${labelOf(record)} is on this device only: every character slot is in use. Delete one to make room.`)
    }
  }),
  deleted: (record) => exchange(async (saved) => {
    const link = saved.links[record.id]
    delete saved.links[record.id]
    if (!link) return
    try {
      await apply({ kind: 'free', slotId: link.id }, saved)
    } catch {
      saved.gone.push(link.id)
    }
  }),
})
