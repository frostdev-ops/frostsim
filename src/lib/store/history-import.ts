// Validate portable contents before one atomic local import; existing records are never overwritten.
import { newId, portableSetup, readPortableCharacter, TOOL_LABELS, type PortableFile, type RawBlob, type StoredCharacter, type StoredReport, type StoredSetup } from './records'

export interface LibraryImport {
  characters: StoredCharacter[]
  reports: StoredReport[]
  blobs: RawBlob[]
  setups: StoredSetup[]
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown): value is string => typeof value === 'string'
const tool = (value: unknown): value is StoredReport['tool'] => text(value) && Object.hasOwn(TOOL_LABELS, value)
const strings = (value: unknown) => Array.isArray(value) && value.every(text)
const invalid = () => { throw Error('The export contains invalid or incomplete library data. Nothing was imported.') }

export function readLibraryImport(file: PortableFile): LibraryImport {
  if (file.version !== 1 || !finite(file.exportedAt) || !object(file.payload)) invalid()
  const payload = file.payload as Record<string, unknown>
  const result: LibraryImport = { characters: [], reports: [], blobs: [], setups: [] }
  const characterIds = new Map<string, string>()

  const addCharacter = (value: unknown, label?: string, oldId?: string, metadata?: Record<string, unknown>) => {
    if (!object(value) || !text(value.raw)) invalid()
    const character = readPortableCharacter(value)
    const id = newId()
    if (oldId) {
      if (characterIds.has(oldId)) invalid()
      characterIds.set(oldId, id)
    }
    const now = Date.now()
    if (metadata && (typeof metadata.pinned !== 'boolean' || !finite(metadata.createdAt) || metadata.createdAt < 0 || !finite(metadata.updatedAt) || metadata.updatedAt < 0)) invalid()
    result.characters.push({ id, label: label ?? character.name, character, pinned: metadata?.pinned as boolean ?? false, createdAt: metadata?.createdAt as number ?? now, updatedAt: metadata?.updatedAt as number ?? now })
  }

  const addSetup = (value: unknown) => {
    if (!object(value) || !tool(value.tool) || !text(value.label) || !object(value.settings)) invalid()
    const setup = value as unknown as StoredSetup
    result.setups.push(portableSetup({ ...setup, id: newId(), characterId: characterIds.get(setup.characterId ?? ''), createdAt: Date.now(), updatedAt: Date.now() }))
  }

  if (file.kind === 'character') addCharacter(payload)
  else if (file.kind === 'setup') {
    addSetup(payload)
  } else {
    if (payload.characters !== undefined) {
      if (!Array.isArray(payload.characters)) invalid()
      for (const row of payload.characters as unknown[]) {
        if (!object(row) || !text(row.id) || !row.id.length || !text(row.label)) invalid()
        const c = row as Record<string, unknown>
        addCharacter(c.character, c.label as string, c.id as string, c)
      }
    }
    if (payload.draftCharacter !== undefined) addCharacter(payload.draftCharacter, 'Recovered character draft')
    if (payload.setups !== undefined) {
      if (!Array.isArray(payload.setups)) invalid()
      for (const setup of payload.setups as unknown[]) addSetup(setup)
    }
    if (payload.advancedDraft !== undefined) {
      if (!object(payload.advancedDraft)) invalid()
      result.setups.push({ id: newId(), tool: 'advanced', label: 'Recovered Advanced draft', settings: payload.advancedDraft, createdAt: Date.now(), updatedAt: Date.now() })
    }
    const rows = payload.record ? [payload] : payload.reports
    if (!Array.isArray(rows)) invalid()
    for (const row of rows as unknown[]) {
      if (!object(row) || !object(row.record)) invalid()
      const r = (row as Record<string, unknown>).record as Record<string, unknown>
      if (!text(r.id) || !tool(r.tool) || !text(r.title) || !text(r.characterLabel)
        || !finite(r.createdAt) || r.createdAt < 0 || typeof r.pinned !== 'boolean'
        || !['complete', 'partial', 'cancelled', 'failed'].includes(r.completion as string)
        || !object(r.engine) || !object(r.summary) || !Object.hasOwn(r, 'requestSnapshot')
        || r.note !== undefined && !text(r.note)) invalid()
      const engine = r.engine as Record<string, unknown>, summary = r.summary as Record<string, unknown>
      if (engine.engineChannel !== undefined && !['live', 'ptr'].includes(engine.engineChannel as string)) invalid()
      for (const key of ['simcVersion', 'upstreamCommit', 'wowVersion', 'artifact']) if (engine[key] !== undefined && !text(engine[key])) invalid()
      for (const key of ['dps', 'confidenceMargin', 'confidenceLevel', 'standardError', 'actualIterations', 'elapsedSeconds', 'candidateCount']) {
        if (summary[key] !== undefined && (!finite(summary[key]) || (summary[key] as number) < 0)) invalid()
      }
      if (summary.confidenceLevel !== undefined && (summary.confidenceLevel as number) > 1) invalid()
      for (const key of ['playerName', 'specialization']) if (summary[key] !== undefined && !text(summary[key])) invalid()
      if (summary.targetReached !== undefined && typeof summary.targetReached !== 'boolean') invalid()
      if (summary.warnings !== undefined && !strings(summary.warnings)) invalid()
      if (summary.topCandidates !== undefined && (!Array.isArray(summary.topCandidates) || !summary.topCandidates.every(c => object(c) && text(c.id) && text(c.label) && finite(c.mean) && finite(c.delta)))) invalid()
      if (Array.isArray(summary.topCandidates) && new Set(summary.topCandidates.map(c => c.id)).size !== summary.topCandidates.length) invalid()
      if (summary.searchTiming !== undefined && (!object(summary.searchTiming) || !finite(summary.searchTiming.iterationsPerSecond) || summary.searchTiming.iterationsPerSecond < 0
        || !finite(summary.searchTiming.iterations) || summary.searchTiming.iterations < 0
        || summary.searchTiming.errorPct !== null && (!finite(summary.searchTiming.errorPct) || summary.searchTiming.errorPct < 0))) invalid()
      const raw = (row as Record<string, unknown>).rawReport
      if (raw !== undefined && raw !== null && !text(raw)) invalid()
      if (text(raw)) {
        try { if (!object(JSON.parse(raw))) invalid() } catch { invalid() }
      }
      const id = newId()
      const record = { ...r, id, characterId: characterIds.get(r.characterId as string), hasRaw: text(raw) } as unknown as StoredReport
      result.reports.push(record)
      if (text(raw)) result.blobs.push({ id, text: raw, bytes: new TextEncoder().encode(raw).byteLength })
    }
  }
  if (!result.characters.length && !result.reports.length && !result.setups.length) invalid()
  return result
}
