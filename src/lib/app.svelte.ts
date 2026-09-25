// App state: current character, engine capability, stored work, active job; stay small (PLAN §3).

import {
  detectEngineCapability, engineIdentity as engineIdentityOf, type EngineCapability,
} from './simc/capability'
import { engineAvailability, engineBusy, engineStopping, type EngineAvailability } from './simc/job'
import { CatalogClient } from './catalog/client'
import type { CompatWarning } from './catalog/load'
import type { CharacterConstraints } from './catalog/legality'
import type { CatalogManifest, ResolvedItem } from './catalog/types'
import { characterConstraints } from './import/constraints'
import { fetchEngineIndex, loadEngineIndex, pickEngine, type EnginePack, type EngineStatus } from './simc/versions'
import { expert, persistDrafts } from './advanced.svelte'
import { forgetCharacterSelections, hasGearDrafts } from './selection.svelte'
import { uniqueLoadoutNames, type ImportedCharacter, type ItemInstance } from './import/character'
import * as db from './store/db'
import {
  makePortable, newId, type EngineIdentity, type RawBlob, type ReportSummary,
  type StoredCharacter, type StoredReport, type StoredSetup, type ToolId,
} from './store/records'

export type JobStatus =
  | 'idle' | 'validating' | 'queued' | 'acquiring' | 'initializing' | 'running' | 'analyzing'
  | 'complete' | 'error' | 'cancelled'

/** Statuses where the engine is doing work the user can cancel. */
export const ACTIVE_STATUSES: JobStatus[] = [
  // `queued` is waiting, not idle: the job exists, it is cancellable, and the header must keep saying so.
  'validating', 'queued', 'acquiring', 'initializing', 'running', 'analyzing',
]

/** Who a run or report is about, fixed when the run starts so switching characters mid-run cannot relabel it. */
export interface RunCharacter {
  id?: string
  label: string
  className?: string
  spec?: string
}

export interface ActiveJob {
  id: string
  tool: ToolId
  title: string
  character?: RunCharacter
  status: JobStatus
  startedAt: number
  /** Optimizer stage, distinct from iteration progress (P01.1). */
  stage?: { index: number; total: number; label: string }
  error?: string
}

export interface Toast {
  id: string
  kind: 'info' | 'good' | 'bad'
  text: string
}

/** The unsaved character (app.draft) as a pick. */
export const DRAFT = 'draft'
/** Screens that keep their own character. */
export const PICK_SCOPES = ['character', 'talents', 'quick', 'compare', 'gear', 'droptimizer', 'crests', 'advanced'] as const
export type PickScope = (typeof PICK_SCOPES)[number]
const PICKS_KEY = 'frostsim.picks'

function readPicks(): { picks: Partial<Record<PickScope, string>>; lastPick: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(PICKS_KEY) ?? '{}')
    const picks = Object.fromEntries(Object.entries(v?.picks ?? {}).filter(([k, id]) => (PICK_SCOPES as readonly string[]).includes(k) && typeof id === 'string' && id !== DRAFT))
    return { picks, lastPick: typeof v?.lastPick === 'string' ? v.lastPick : null }
  } catch {
    return { picks: {}, lastPick: null }
  }
}

export const app = $state({
  /** null until the first capability check settles. */
  capability: null as EngineCapability | null,
  capabilityChecked: false,
  /** The published pack this page runs (fixed for the page lifetime). */
  engine: null as EnginePack | null,
  engineStatus: null as EngineStatus | null,
  /** A newer pack for this app, published after the page loaded. */
  engineUpdate: null as EnginePack | null,
  engineError: '',

  // Catalog in worker; 15 MB items.json would block first paint on main thread. Only UI-rendered data here.
  catalogState: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
  catalogError: '' as string,
  catalogWarnings: [] as CompatWarning[],
  catalogManifest: null as CatalogManifest | null,
  /** Resolved gear for the focused character, keyed by instanceId (a per-character cache makes switching instant). */
  resolved: new Map<string, ResolvedItem>(),
  /** Instance ids the catalog could not resolve, so the UI can label them. */
  unresolvedItems: [] as string[],

  characters: [] as StoredCharacter[],
  /** The focused character: the current screen's pick (pickFor), a stored id or DRAFT. Change it with pickCharacter. */
  activeCharacterId: null as string | null,
  /** The unsaved character (an edited result, a report's snapshot), picked as DRAFT. */
  draft: null as ImportedCharacter | null,
  /** `picks`: each screen's own character; a screen without one uses `lastPick`, the last stored character picked anywhere. */
  ...readPicks(),
  /** The screen whose pick is focused; null on screens without a character (Reports, Help). */
  scope: null as PickScope | null,
  /** Characters Quick Sim runs beside its own pick, in one multi-character sim (stored ids or DRAFT). */
  quickExtras: [] as string[],

  reports: [] as StoredReport[],
  setups: [] as StoredSetup[],

  job: null as ActiveJob | null,
  // Engine running unrecorded work; reactive because engineBusy() is non-derivable; pollEngineSlot() drives it.
  engineStray: false,
  engineStopping: false,

  // Threaded run could not shut down cleanly; pthreads may persist. Only fresh page clears it. Distinct from stray.
  engineBlocked: null as Extract<EngineAvailability, { available: false }> | null,

  storage: {
    available: true as boolean,
    failure: null as db.StorageFailure | null,
    usage: undefined as number | undefined,
    quota: undefined as number | undefined,
    persisted: false,
  },

  toasts: [] as Toast[],
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
})

export function activeCharacter(): ImportedCharacter | null {
  if (app.activeCharacterId === DRAFT) return app.draft
  const stored = app.characters.find((c) => c.id === app.activeCharacterId)
  return stored?.character ?? null
}

// --- picks: which character each screen works on ------------------------------

function savePicks(): void {
  // The draft is not saved, so a pick of it is not either.
  const picks = Object.fromEntries(Object.entries(app.picks).filter(([, id]) => id !== DRAFT))
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify({ picks, lastPick: app.lastPick }))
  } catch { /* Storage blocked: picks last for this page. */ }
}

const pickable = (id: string | null | undefined): id is string =>
  !!id && (id === DRAFT ? !!app.draft : app.characters.some((c) => c.id === id))

/** A screen's character: its own pick, else the last pick anywhere, else the newest character. Stale ids fall through. */
export function pickFor(scope: PickScope | null): string | null {
  const own = scope ? app.picks[scope] : undefined
  if (pickable(own)) return own
  if (pickable(app.lastPick)) return app.lastPick
  return app.characters[0]?.id ?? null
}

/** Navigation: the focused character becomes the new screen's pick. */
export function focusScope(scope: PickScope | null): void {
  app.scope = scope
  const id = pickFor(scope)
  if (app.activeCharacterId !== id) app.activeCharacterId = id
}

/** A picker choice on one screen (the focused one by default). A stored character also becomes the default elsewhere. */
export function pickCharacter(id: string, scope: PickScope | null = app.scope): void {
  if (scope) app.picks[scope] = id
  if (id !== DRAFT) app.lastPick = id
  if (!scope || scope === app.scope) app.activeCharacterId = id
  savePicks()
}

/** Opens an unsaved character on a screen: an edited result, or a saved report's own snapshot. */
export function openDraft(character: ImportedCharacter, scope: PickScope): void {
  app.draft = character
  pickCharacter(DRAFT, scope)
}

/** Who the focused character is, for a run starting now. */
export function runCharacter(): RunCharacter {
  const stored = activeStored()
  const c = activeCharacter()
  return { id: stored?.id, label: stored?.label ?? c?.name ?? 'Unsaved character', className: c?.className, spec: c?.spec }
}

export function activeStored(): StoredCharacter | null {
  return app.characters.find((c) => c.id === app.activeCharacterId) ?? null
}

export function engineIdentity(): EngineIdentity | undefined {
  const cap = app.capability
  if (!cap?.ok) return undefined
  return {
    simcVersion: cap.manifest.engine.simcVersion,
    upstreamCommit: cap.manifest.engine.upstreamCommit,
    wowVersion: cap.manifest.wow.clientDataVersion,
    artifact: cap.manifest.artifact,
  }
}

/** True while this app believes it owns a run. */
function jobBusy(): boolean {
  return !!app.job && ACTIVE_STATUSES.includes(app.job.status)
}

// Engine budget is one run per tab (2 GB each); gates on its own slot and our record of it.
// Engine identity keys optimizer result cache; must match runBatch's ProfilesetOutcome or runner abandons (null = no cache).
export function engineIdentityString(): string | null {
  const cap = app.capability
  return cap?.ok ? engineIdentityOf(cap.manifest) : null
}

// Can a new run start? Every control gates on this; covers three states (stray, blocked, job in flight, busy).
export function isBusy(): boolean {
  return app.engineStopping || app.engineStray || !!app.engineBlocked || jobBusy() || engineBusy()
}

// Drives app.engineStray; called on timer. Two-poll debounce on unowned, non-stopping engine transitions.
let strayPolls = 0

export function pollEngineSlot(): void {
  app.engineStopping = engineStopping()
  strayPolls = strayEngine() ? strayPolls + 1 : 0
  app.engineStray = strayPolls >= 2

  // No debounce on blocked; not transient. Clears on fresh page or confirmed shutdown, not elapsed time.
  const availability = engineAvailability()
  app.engineBlocked = availability.available ? null : availability
}

// Engine running unrecorded work. Impossible unless search abandoned; surfaced in banner, not hidden.
export function strayEngine(): boolean {
  return engineBusy() && !engineStopping() && !jobBusy()
}

export function toast(kind: Toast['kind'], text: string): void {
  const t: Toast = { id: newId(), kind, text }
  app.toasts.push(t)
  setTimeout(() => {
    const i = app.toasts.findIndex((x) => x.id === t.id)
    if (i >= 0) app.toasts.splice(i, 1)
  }, 5200)
}

function noteFailure(failure: db.StorageFailure): void {
  app.storage.failure = failure
  if (failure.kind === 'unavailable' || failure.kind === 'blocked') app.storage.available = false
}

// Load all persisted data; report failure, never throw (P11.9).
export async function loadLibrary(): Promise<void> {
  const [chars, reports, setups] = await Promise.all([
    db.all<StoredCharacter>('characters'),
    db.all<StoredReport>('reports'),
    db.all<StoredSetup>('setups'),
  ])
  // Characters saved before import deduplicated loadout names.
  if (chars.ok) app.characters = chars.value
    .map((c) => ({ ...c, character: { ...c.character, loadouts: uniqueLoadoutNames(c.character.loadouts ?? []) } }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  else noteFailure(chars.failure)
  if (reports.ok) app.reports = reports.value.sort((a, b) => b.createdAt - a.createdAt)
  else noteFailure(reports.failure)
  if (setups.ok) app.setups = setups.value.sort((a, b) => b.updatedAt - a.updatedAt)
  else noteFailure(setups.failure)

  app.activeCharacterId = pickFor(app.scope)
  await refreshUsage()
}

export async function refreshUsage(): Promise<void> {
  const u = await db.storageUsage().catch(() => null)
  if (!u) return
  app.storage.usage = u.usage
  app.storage.quota = u.quota
  app.storage.persisted = u.persisted
}

export async function checkCapability(): Promise<void> {
  try {
    const index = await loadEngineIndex()
    app.engine = pickEngine(index) ?? null
    app.engineStatus = index.status
  } catch (err) { app.engineError = String(err) }
  app.capability = await detectEngineCapability()
  app.capabilityChecked = true
}

/**
 * Re-reads the engine index (normally a 304). A newer pack for this app is offered; with `autoReload`
 * (the tab just came back into view) the page reloads onto it when nothing would be lost.
 */
export async function checkEngineUpdate(autoReload: boolean): Promise<void> {
  if (!app.engine || app.engine.id === 'local') return
  let index
  try { index = await fetchEngineIndex() } catch { return }
  app.engineStatus = index.status
  const newest = pickEngine(index)
  if (!newest || newest.id === app.engine.id) return
  app.engineUpdate = newest
  if (autoReload) await applyEngineUpdate(true)
}

/**
 * Reload onto the newest engine: every screen, catalog and optimizer then uses it. Returns why it
 * could not, or null. Automatic reloads also wait for in-memory gear choices, which a reload drops.
 */
export async function applyEngineUpdate(automatic: boolean): Promise<string | null> {
  if (isBusy()) return 'Finish or cancel the running simulation first.'
  const readiness = await prepareForReload()
  if (!readiness.ok) return `Keep your work first: ${readiness.losses.join('; ')}.`
  if ((automatic && hasGearDrafts()) || isBusy()) return null
  location.reload()
  return null
}

// Catalog directory the engine's data identity points at.
export function catalogBaseUrl(): string | null {
  const cap = app.capability
  if (!cap?.ok) return null
  if (cap.engineDir.startsWith('/engine/versions/')) return `${cap.engineDir.replace(/fallback\/$/, '')}catalog`
  const m = cap.manifest
  const hotfix = (m.wow.hotfixHash ?? '').slice(0, 12)
  return `/catalogs/${m.wow.clientDataVersion}-${hotfix}-${m.engine.upstreamCommit.slice(0, 7)}`
}

// Load catalog once; Quick Sim skips it so first run doesn't block.
let client: CatalogClient | null = null
let loading: Promise<SafeCatalog | null> | null = null

// $state Proxy not cloneable; postMessage throws as unhandled rejection. Snapshot on each call.
function plain<T>(value: T): T {
  return $state.snapshot(value) as T
}

// Catalog client with snapshotted inputs and surfaced failures.
export interface SafeCatalog {
  resolve: CatalogClient['resolve']
  search: CatalogClient['search']
  enchantsFor: CatalogClient['enchantsFor']
  gemsFor: CatalogClient['gemsFor']
  consumables: CatalogClient['consumables']
  setBonuses: CatalogClient['setBonuses']
  talentTree: CatalogClient['talentTree']
  specs: CatalogClient['specs']
  embellishments: CatalogClient['embellishments']
  coverage: CatalogClient['coverage']
  lootSources: CatalogClient['lootSources']
  dropSources: CatalogClient['dropSources']
  estimateWork: CatalogClient['estimateWork']
  planTopGear: CatalogClient['planTopGear']
  planDroptimizer: CatalogClient['planDroptimizer']
}

function guard<A extends unknown[], R>(
  what: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...(args.map(plain) as A))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      app.catalogError = `${what} failed: ${message}`
      toast('bad', `Game data request failed: ${message}`)
      throw err
    }
  }
}

export function catalogClient(): SafeCatalog | null {
  if (app.catalogState !== 'ready' || !client) return null
  const c = client
  return {
    resolve: guard('resolve', c.resolve.bind(c)),
    search: guard('search', c.search.bind(c)),
    enchantsFor: guard('enchantsFor', c.enchantsFor.bind(c)),
    gemsFor: guard('gemsFor', c.gemsFor.bind(c)),
    consumables: guard('consumables', c.consumables.bind(c)),
    setBonuses: guard('setBonuses', c.setBonuses.bind(c)),
    talentTree: guard('talentTree', c.talentTree.bind(c)),
    specs: guard('specs', c.specs.bind(c)),
    embellishments: guard('embellishments', c.embellishments.bind(c)),
    coverage: guard('coverage', c.coverage.bind(c)),
    lootSources: guard('lootSources', c.lootSources.bind(c)),
    dropSources: guard('dropSources', c.dropSources.bind(c)),
    estimateWork: guard('estimateWork', c.estimateWork.bind(c)),
    planTopGear: guard('planTopGear', c.planTopGear.bind(c)),
    planDroptimizer: guard('planDroptimizer', c.planDroptimizer.bind(c)),
  } as SafeCatalog
}

export async function ensureCatalog(): Promise<SafeCatalog | null> {
  if (app.catalogState === 'ready') return catalogClient()
  if (loading) return loading

  const baseUrl = catalogBaseUrl()
  if (!baseUrl) {
    app.catalogState = 'failed'
    app.catalogError = 'The engine build is unknown, so Frostsim cannot tell which catalog matches it.'
    return null
  }
  app.catalogState = 'loading'

  loading = (async (): Promise<SafeCatalog | null> => {
    const c = CatalogClient.create()
    const result = await c.load(
      baseUrl,
      app.capability?.ok
        ? {
            upstreamCommit: app.capability.manifest.engine.upstreamCommit,
            clientDataVersion: app.capability.manifest.wow.clientDataVersion,
            hotfixHash: app.capability.manifest.wow.hotfixHash,
            ptr: app.capability.manifest.wow.ptr,
          }
        : null,
    )
    if (!result.ok) {
      c.dispose()
      app.catalogState = 'failed'
      app.catalogError = result.message
      loading = null
      return null
    }
    client = c
    app.catalogManifest = result.manifest
    app.catalogWarnings = result.warnings
    app.catalogState = 'ready'
    loading = null
    const character = activeCharacter()
    if (character) await resolveCharacter(character)
    return catalogClient()
  })()
  return loading
}

/** Resolutions of the last few characters, so switching between them is instant. Keyed by level and item instances. */
const resolvedCache = new Map<string, { items: Map<string, ResolvedItem>; missing: string[] }>()
const RESOLVED_CACHE_SIZE = 8
let resolving = ''

// Resolve all owned items once into app.resolved; rendering stays synchronous (one round trip, not per-row).
export async function resolveCharacter(character: ImportedCharacter): Promise<void> {
  const c = catalogClient()
  if (!c) return
  const instances: ItemInstance[] = [
    ...character.equipped, ...character.bag, ...(character.vault ?? []),
  ]
  const key = `${character.level ?? 0}|${instances.map((i) => i.instanceId).join(',')}`
  resolving = key
  const hit = resolvedCache.get(key)
  if (hit) {
    app.resolved = hit.items
    app.unresolvedItems = hit.missing
    return
  }
  try {
    const { items, missing } = await c.resolve(instances, character.level ?? 0)
    resolvedCache.set(key, { items, missing })
    if (resolvedCache.size > RESOLVED_CACHE_SIZE) resolvedCache.delete(resolvedCache.keys().next().value!)
    // A newer switch wins: a slow resolve of the previous character must not overwrite it.
    if (resolving !== key) return
    app.resolved = items
    app.unresolvedItems = missing
  } catch {
    // guard already reported it; items fall back to export labels marked "unverified".
    if (resolving === key) app.resolved = new Map()
  }
}

// Constraints for active character, recomputed when catalog lands.
export function constraintsFor(character: ImportedCharacter): {
  constraints: CharacterConstraints
  unknown: string[]
} {
  return characterConstraints(character, app.resolved, character.level ?? 0)
}

// Plan options for catalog worker, shaped for structured clone.
export function planOptions(
  character: ImportedCharacter,
  baselineGear: [string, ItemInstance | null][],
  extra?: { embellishmentLimit?: number },
) {
  return plain({
    character: constraintsFor(character).constraints,
    baselineGear: baselineGear as never,
    playerLevel: character.level ?? 0,
    // Undefined = unchecked; no embellishment limit data in this build.
    embellishmentLimit: extra?.embellishmentLimit,
  })
}

export function maxThreads(): number {
  return app.capability?.ok ? app.capability.maxThreads : 8
}

export function profilesetsSupported(): boolean {
  // No manifest = unknown; false prevents UI building run fallback can't execute (D4).
  return app.capability?.ok ? app.capability.profilesets : false
}

// --- characters --------------------------------------------------------------

export async function saveCharacter(
  character: ImportedCharacter,
  label?: string,
  id = newId(),
): Promise<StoredCharacter> {
  const now = Date.now()
  const existing = app.characters.find((c) => c.id === id)
  const record: StoredCharacter = plain({
    id,
    label: label ?? existing?.label ?? character.name ?? 'Character',
    character,
    pinned: existing?.pinned ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  const out = await db.put('characters', record)
  if (!out.ok) {
    noteFailure(out.failure)
    toast('bad', storageMessage(out.failure))
  }
  const i = app.characters.findIndex((c) => c.id === id)
  if (i >= 0) app.characters[i] = record
  else app.characters.unshift(record)
  // A saved draft replaces the draft wherever it was picked.
  if (app.activeCharacterId === DRAFT || !existing) app.draft = null
  for (const scope of PICK_SCOPES) if (app.picks[scope] === DRAFT) app.picks[scope] = id
  pickCharacter(id)
  resolveCharacter(character).catch(() => { /* reported in app state */ })
  void refreshUsage()
  return record
}

export async function deleteCharacter(id: string): Promise<void> {
  const out = await db.del('characters', id)
  if (!out.ok) noteFailure(out.failure)
  app.characters = app.characters.filter((c) => c.id !== id)
  for (const scope of PICK_SCOPES) if (app.picks[scope] === id) delete app.picks[scope]
  if (app.lastPick === id) app.lastPick = null
  savePicks()
  if (app.activeCharacterId === id) app.activeCharacterId = pickFor(app.scope)
  // Delete selections; else deleted character's gear sits in storage and new char reusing ID inherits it.
  forgetCharacterSelections(id)
  void refreshUsage()
}

export async function renameCharacter(id: string, label: string): Promise<void> {
  const rec = app.characters.find((c) => c.id === id)
  if (!rec) return
  rec.label = label
  rec.updatedAt = Date.now()
  const out = await db.put('characters', $state.snapshot(rec))
  if (!out.ok) noteFailure(out.failure)
}

// --- reports -----------------------------------------------------------------

export interface SaveReportInput {
  tool: ToolId
  title: string
  summary: ReportSummary
  requestSnapshot: unknown
  completion: StoredReport['completion']
  rawJson?: string
  /** Who the run was about, taken when it started (runCharacter). Defaults to the focused character now. */
  character?: RunCharacter
}

export async function saveReport(input: SaveReportInput): Promise<StoredReport> {
  const character = input.character ?? runCharacter()
  const id = newId()
  const record: StoredReport = plain({
    id,
    tool: input.tool,
    title: input.title,
    characterId: character.id,
    characterLabel: character.label,
    requestSnapshot: input.requestSnapshot,
    engine: engineIdentity() ?? {},
    completion: input.completion,
    summary: input.summary,
    hasRaw: !!input.rawJson,
    createdAt: Date.now(),
    pinned: false,
  })
  const out = await db.put('reports', record)
  if (!out.ok) {
    noteFailure(out.failure)
    record.hasRaw = false
    toast('bad', storageMessage(out.failure))
  } else if (input.rawJson) {
    const blob: RawBlob = { id, text: input.rawJson, bytes: input.rawJson.length }
    const b = await db.put('blobs', blob)
    if (!b.ok) {
      // The summary is saved; only the raw report was too large to keep.
      record.hasRaw = false
      await db.put('reports', record)
      noteFailure(b.failure)
      toast('bad', 'Saved the result, but the raw engine report did not fit in storage.')
    }
  }
  app.reports.unshift(record)
  void refreshUsage()
  return record
}

export interface ReloadReadiness {
  /** Safe to reload without losing anything the app knows how to keep. */
  ok: boolean
  /** Plain-language items that a reload WOULD lose. Empty when `ok`. */
  losses: string[]
}

// Prepare for reload; report what would be lost. tab-local items: drafts, expert scripts, in-flight results, selections.
export async function prepareForReload(): Promise<ReloadReadiness> {
  const losses: string[] = []

  if (!persistDrafts()) {
    losses.push(
      'anything typed into Expert Mode or the stat-weight selection, because this browser '
      + 'refused to store it',
    )
  }

  if (app.draft) {
    losses.push(
      `the character you pasted but have not kept${app.draft.name ? ` (${app.draft.name})` : ''}`,
    )
  }

  if (!app.storage.available) {
    losses.push(
      'every character and report, because nothing can be saved on this device at all — '
      + 'the export is the only copy you will have',
    )
  } else {
    // Quota failure = recent results may not persist even though app thinks storage works.
    const usage = await db.storageUsage().catch(() => null)
    if (app.storage.failure?.kind === 'quota') {
      losses.push('any report saved since storage filled up, which this browser rejected')
    }
    if (usage) {
      app.storage.usage = usage.usage
      app.storage.quota = usage.quota
    }
  }

  return { ok: losses.length === 0, losses }
}

// Export all user data (characters, reports, raw). Reports download STARTED, not success.
export type ExportOutcome =
  | { ok: true; bytes: number; reports: number; characters: number }
  | { ok: false; reason: string }

export async function exportEverything(): Promise<ExportOutcome> {
  try {
    const reports = []
    for (const r of app.reports) {
      reports.push({ record: r, rawReport: r.hasRaw ? await loadRaw(r.id) : null })
    }
    // Drafts included; they're the only copy, and omitting them is same lie as incomplete export.
    const file = makePortable(
      'report',
      {
        characters: app.characters,
        reports,
        draftCharacter: app.draft ? $state.snapshot(app.draft) : undefined,
        advancedDraft: { ...expert },
      },
      engineIdentity(),
    )
    const text = JSON.stringify(file, null, 2)
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'frostsim-history.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url))
    // Reports download STARTED, not success; page cannot observe browser writing, user cancel, or destination.
    return { ok: true, bytes: blob.size, reports: app.reports.length, characters: app.characters.length }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function loadRaw(id: string): Promise<string | null> {
  const out = await db.get<RawBlob>('blobs', id)
  if (!out.ok) { noteFailure(out.failure); return null }
  return out.value?.text ?? null
}

export async function deleteReport(id: string): Promise<StoredReport | null> {
  const record = app.reports.find((r) => r.id === id) ?? null
  await db.del('reports', id)
  await db.del('blobs', id)
  app.reports = app.reports.filter((r) => r.id !== id)
  void refreshUsage()
  return record ? $state.snapshot(record) as StoredReport : null
}

/** Puts a deleted report back, for undo (P11.2). */
export async function restoreReport(record: StoredReport): Promise<void> {
  await db.put('reports', plain(record))
  app.reports = [record, ...app.reports].sort((a, b) => b.createdAt - a.createdAt)
  void refreshUsage()
}

export async function updateReport(id: string, patch: Partial<StoredReport>): Promise<void> {
  const rec = app.reports.find((r) => r.id === id)
  if (!rec) return
  Object.assign(rec, patch)
  const out = await db.put('reports', $state.snapshot(rec))
  if (!out.ok) noteFailure(out.failure)
}

// --- setups ------------------------------------------------------------------

export async function saveSetup(tool: ToolId, label: string, settings: unknown): Promise<void> {
  const record: StoredSetup = plain({
    id: newId(),
    tool,
    label,
    characterId: activeStored()?.id,
    settings,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const out = await db.put('setups', record)
  if (!out.ok) { noteFailure(out.failure); toast('bad', storageMessage(out.failure)); return }
  app.setups.unshift(record)
  toast('good', `Saved “${label}”.`)
}

export async function deleteSetup(id: string): Promise<void> {
  await db.del('setups', id)
  app.setups = app.setups.filter((s) => s.id !== id)
}

export function storageMessage(f: db.StorageFailure): string {
  switch (f.kind) {
    case 'quota':
      return 'Browser storage is full. Delete old reports or export them before clearing.'
    case 'unavailable':
      return 'This browser is not letting Frostsim store anything — private mode or blocked site data. Work continues in memory and is lost on refresh.'
    case 'blocked':
      return 'Another Frostsim tab is holding an older database version. Close it and reload.'
    case 'corrupt':
      return 'A stored record could not be read. Export what you can and clear storage.'
    case 'invalid-record':
      return 'Frostsim could not save this record. Existing saved data is unchanged; your current result remains in this tab.'
    default:
      return `Storage failed: ${f.message}`
  }
}
