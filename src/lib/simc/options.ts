// Sim settings -> simc option args, execution boundary validation (P01.5, P01.6, P01.10), option names verified vs vendor/simc @ c015720.

import { ACTOR_OPTION_NAMES, ACTOR_OPTION_PREFIXES } from './actor-options.generated'

export const FIGHT_STYLES = [
  'Patchwerk',
  'CastingPatchwerk',
  'HecticAddCleave',
  'DungeonSlice',
  'DungeonRoute',
  'CleaveAdd',
  'LightMovement',
  'HeavyMovement',
  'Beastlord',
  'HelterSkelter',
  'Ultraxion',
] as const

export type FightStyle = (typeof FIGHT_STYLES)[number]

export interface SimSettings {
  fightStyle: FightStyle
  /** Fight length in seconds. */
  maxTime: number
  targets: number
  threads: number
}

/** Fixed iterations and target accuracy are distinct modes, never both (P01.10); targetError is a percentage of the mean (sim.cpp:2229). */
export type Accuracy =
  | { mode: 'iterations'; iterations: number }
  | { mode: 'targetError'; targetError: number; maxIterations: number }
  /**
   * Raw mode only: whatever the script says, including nothing. The app states
   * no iteration count and no target error, so the engine's defaults or the
   * script's own lines decide when the run stops.
   */
  | { mode: 'script' }

export const DEFAULT_ACCURACY: Accuracy = { mode: 'targetError', targetError: 0.1, maxIterations: 100_000 }

/** guided: UI owns fight style, duration, targets, accuracy; raw: script is authoritative for every simulation setting (P10), infrastructure still protected. */
export type RunMode = 'guided' | 'raw'

/** Fallback ceiling; real ceiling is capabilities.maxThreads (D11: exceeding the pool deadlocks in callMain). */
export const FALLBACK_MAX_THREADS = 8

export const DEFAULT_SETTINGS: SimSettings = {
  fightStyle: 'Patchwerk',
  maxTime: 300,
  targets: 1,
  threads: Math.min(globalThis.navigator?.hardwareConcurrency || 4, FALLBACK_MAX_THREADS),
}

export const REPORT_PATH = '/out.json'
export const PROFILE_PATH = '/profile.simc'
/** Written only when run asks (P06.10); application owns path, html is protected so pasted profile cannot choose destination. */
export const HTML_REPORT_PATH = '/out.html'

/** The only filesystem paths the worker will accept. Anything else is rejected. */
export const ALLOWED_PATHS = [PROFILE_PATH, REPORT_PATH, HTML_REPORT_PATH] as const

export const LIMITS = {
  profileBytes: 4 * 1024 * 1024,
  optionLineChars: 4096,
  profilesets: 5000,
  /** simc's own ceiling when iterations are left unbounded (sim.cpp:4412). */
  iterations: 1_000_000,
  targets: 50,
  maxTimeSeconds: 3600,
  extraOptions: 500,
  /** Absolute sanity ceiling on threads, separate from artifact pool ceiling. */
  threads: 64,
} as const

/** Options application owns: decide pthread budget, report destination, network behaviour (P01.6); simc accumulates report destinations. */
export const PROTECTED_OPTIONS = [
  'threads',
  'profileset_init_threads',
  'profileset_work_threads',
  'json',
  'json2',
  // Observability: turning off blinds progress bar and stall watchdog.
  'progressbar_type',
  'html',
  'xml',
  'output',
  'input',
  'apikey',
  'armory',
  'wowhead',
  'local_json',
  'ptr',
  'debug_seed',
  'cleanup_threads',
  'process_priority',
] as const

/** Options that decide when run stops; neutralised so fixed-iteration cannot be cut short by inherited target_error (P01.10). */
export const STOPPING_OPTIONS = ['iterations', 'target_error', 'max_time', 'fixed_time'] as const

const PROTECTED_SET: ReadonlySet<string> = new Set<string>(PROTECTED_OPTIONS)
const STOPPING_SET: ReadonlySet<string> = new Set<string>(STOPPING_OPTIONS)

export interface SanitizedProfile {
  text: string
  /** One entry per neutralised or overridden line, in file order. Never swallowed. */
  warnings: string[]
}

const OPTION_LINE = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(\+?=)/

/** Comments out application-owned assignments; in raw mode script's stopping options survive; when run settings state accuracy, app arguments come last. */
export function sanitizeProfile(profile: string, mode: RunMode = 'guided'): SanitizedProfile {
  const warnings: string[] = []
  const lines = profile.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.trimStart().startsWith('#')) continue
    const m = OPTION_LINE.exec(line)
    if (!m) continue
    const name = m[1].toLowerCase()

    const item = itemLineProblem(line)
    if (item) {
      // Warn never rewrite: line is user's intent, no correct name to invent; most likely silent-equip-nothing failure place.
      warnings.push(`Line ${i + 1}: ${item}`)
    }

    if (PROTECTED_SET.has(name)) {
      lines[i] = `# frostsim removed (application-owned): ${line.trim()}`
      warnings.push(`Line ${i + 1}: ignored "${name}=" — the application controls that option.`)
    } else if (STOPPING_SET.has(name)) {
      if (mode === 'raw') {
        warnings.push(`Line ${i + 1}: kept "${name}=" from your script.`)
      } else {
        lines[i] = `# frostsim removed (set by the run settings): ${line.trim()}`
        warnings.push(`Line ${i + 1}: ignored "${name}=" — the run settings decide that.`)
      }
    }
  }

  return { text: lines.join('\n'), warnings }
}

/** Profileset id must survive unquoted-parser round-tripping. */
export const PROFILESET_ID = /^[A-Za-z0-9._:+-]{1,128}$/

export interface ProfilesetSpec {
  /** Opaque, stable, caller-owned. Round-trips verbatim into the report's `name`. */
  id: string
  /** Raw simc option lines applied on top of the base profile. */
  lines: string[]
}

export function profilesetLines(sets: readonly ProfilesetSpec[]): string[] {
  const out: string[] = []
  for (const set of sets) {
    for (const line of set.lines) {
      out.push(`profileset."${set.id}"+=${line}`)
    }
  }
  return out
}

export interface BuildArgsInput {
  settings: SimSettings
  accuracy: Accuracy
  /** Advanced raw option lines. They win over the UI settings, never over the protected ones. */
  extraOptions?: readonly string[]
  maxThreads: number
  mode?: RunMode
  /** Write HTML report (off by default); costs engine time and is tens of MB for large search. */
  htmlReport?: boolean
}

/** simc applies options in order, last assignment wins; layering is precedence rule made literal (P01.6, P10). */
export function buildArgs(input: BuildArgsInput): string[] {
  const { settings: s, accuracy, extraOptions = [], maxThreads, mode = 'guided', htmlReport = false } = input

  const args = [PROFILE_PATH]

  if (mode === 'guided') {
    args.push(`fight_style=${s.fightStyle}`, `max_time=${s.maxTime}`, `desired_targets=${s.targets}`)
    // Match observed Raidbots guided defaults.
    args.push('single_actor_batch=1', 'optimize_expressions=1')
  }

  args.push(...extraOptions)

  if (accuracy.mode === 'iterations') {
    args.push(`iterations=${accuracy.iterations}`)
    // Explicit: target_error survives in sim object; only value <= 0 turns convergence check off (sim.cpp:2135).
    args.push('target_error=0')
  } else if (accuracy.mode === 'targetError') {
    args.push(`iterations=${accuracy.maxIterations}`)
    args.push(`target_error=${accuracy.targetError}`)
  }
  // accuracy.mode === 'script': say nothing so script decides.

  args.push(`threads=${clampThreads(s.threads, maxThreads)}`)
  // Machine-readable newline-terminated progress records; infrastructure not simulation setting.
  args.push('progressbar_type=1')
  // version=2 is current stable format; version=3 rejected (only accepts unreleased "3.0.0-alpha1").
  args.push(`json=${REPORT_PATH},version=2`)
  // After JSON, numbers before optional document so failing HTML writer cannot cost finished simulation result.
  if (htmlReport) args.push(`html=${HTML_REPORT_PATH}`)

  return args
}

export function clampThreads(threads: number, maxThreads: number): number {
  const ceiling = Number.isInteger(maxThreads) && maxThreads > 0 ? maxThreads : FALLBACK_MAX_THREADS
  if (!Number.isFinite(threads)) return 1
  return Math.min(Math.max(1, Math.floor(threads)), ceiling)
}

export interface ValidationIssue {
  field: string
  message: string
}

function integerIssue(field: string, value: unknown, min: number, max: number): ValidationIssue | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { field, message: `${field} must be a finite number, got ${describe(value)}` }
  }
  if (!Number.isInteger(value)) {
    return { field, message: `${field} must be a whole number, got ${value}` }
  }
  if (value < min || value > max) {
    return { field, message: `${field} must be between ${min} and ${max}, got ${value}` }
  }
  return null
}

function describe(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  return typeof value
}

/**
 * Every workload control that reaches the engine passes through here. The HTML
 * `min`/`max` attributes validate nothing about a programmatic call or an
 * imported setting (PLAN §2 finding 6).
 */
export function validateSettings(
  settings: SimSettings,
  accuracy: Accuracy,
  maxThreads: number,
  mode: RunMode = 'guided',
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // In raw mode the app states none of these, so they cannot make a run wrong.
  // Only the infrastructure control, threads, still has to be sane.
  if (mode === 'guided') {
    if (!FIGHT_STYLES.includes(settings?.fightStyle as FightStyle)) {
      issues.push({
        field: 'fightStyle',
        message: `unsupported fight style ${JSON.stringify(settings?.fightStyle)}`,
      })
    }

    if (typeof settings?.maxTime !== 'number' || !Number.isFinite(settings.maxTime)) {
      issues.push({ field: 'maxTime', message: `maxTime must be a finite number, got ${describe(settings?.maxTime)}` })
    } else if (settings.maxTime <= 0 || settings.maxTime > LIMITS.maxTimeSeconds) {
      issues.push({
        field: 'maxTime',
        message: `maxTime must be above 0 and at most ${LIMITS.maxTimeSeconds} seconds, got ${settings.maxTime}`,
      })
    }

    const targets = integerIssue('targets', settings?.targets, 1, LIMITS.targets)
    if (targets) issues.push(targets)
  }

  const threads = integerIssue('threads', settings?.threads, 1, LIMITS.threads)
  if (threads) issues.push(threads)

  if (accuracy?.mode === 'script') {
    if (mode !== 'raw') {
      issues.push({
        field: 'accuracy',
        message: 'accuracy mode "script" only applies to a raw script run',
      })
    }
  } else if (accuracy?.mode === 'iterations') {
    const it = integerIssue('accuracy.iterations', accuracy.iterations, 1, LIMITS.iterations)
    if (it) issues.push(it)
  } else if (accuracy?.mode === 'targetError') {
    if (typeof accuracy.targetError !== 'number' || !Number.isFinite(accuracy.targetError)) {
      issues.push({
        field: 'accuracy.targetError',
        message: `targetError must be a finite number, got ${describe(accuracy.targetError)}`,
      })
    } else if (accuracy.targetError <= 0 || accuracy.targetError >= 100) {
      issues.push({
        field: 'accuracy.targetError',
        message: `targetError is a percentage above 0 and below 100, got ${accuracy.targetError}`,
      })
    }
    const max = integerIssue('accuracy.maxIterations', accuracy.maxIterations, 1, LIMITS.iterations)
    if (max) issues.push(max)
  } else {
    issues.push({ field: 'accuracy', message: `unknown accuracy mode ${JSON.stringify((accuracy as Accuracy)?.mode)}` })
  }

  // Engine discards each thread's first iteration from data collection (sim.cpp analyze_error); request whose iteration count <= thread count collects nothing.
  const ceiling = iterationCeiling(accuracy)
  if (ceiling !== undefined && Number.isInteger(settings?.threads) && settings.threads > 0) {
    const effective = clampThreads(settings.threads, maxThreads)
    if (ceiling <= effective) {
      issues.push({
        field: 'accuracy',
        message: `${ceiling} iterations across ${effective} threads collects no samples — the engine discards each thread's first iteration. Use more iterations or fewer threads.`,
      })
    }
  }

  return issues
}

function iterationCeiling(accuracy: Accuracy): number | undefined {
  if (accuracy?.mode === 'iterations') return Number.isInteger(accuracy.iterations) ? accuracy.iterations : undefined
  if (accuracy?.mode === 'targetError') {
    return Number.isInteger(accuracy.maxIterations) ? accuracy.maxIterations : undefined
  }
  return undefined
}

/** Most threads worth using for iteration budget; bound is iterations - 1, deliberately conservative; offered for slider clamping, boundary still refuses bad combination. */
export function maxUsefulThreads(iterations: number, maxThreads: number): number {
  if (!Number.isInteger(iterations) || iterations < 2) return 1
  return Math.max(1, Math.min(maxThreads, iterations - 1))
}

export function validateProfile(profile: unknown): ValidationIssue[] {
  if (typeof profile !== 'string') {
    return [{ field: 'profile', message: `profile must be a string, got ${describe(profile)}` }]
  }
  if (!profile.trim()) {
    return [{ field: 'profile', message: 'profile is empty' }]
  }
  const bytes = new TextEncoder().encode(profile).length
  if (bytes > LIMITS.profileBytes) {
    return [
      {
        field: 'profile',
        message: `profile is ${bytes} bytes, over the ${LIMITS.profileBytes} byte limit`,
      },
    ]
  }
  return []
}

export function validateProfilesets(sets: readonly ProfilesetSpec[] | undefined): ValidationIssue[] {
  if (sets === undefined) return []
  if (!Array.isArray(sets)) {
    return [{ field: 'profilesets', message: 'profilesets must be an array' }]
  }
  if (sets.length > LIMITS.profilesets) {
    return [{ field: 'profilesets', message: `at most ${LIMITS.profilesets} profilesets per run, got ${sets.length}` }]
  }

  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i]
    const field = `profilesets[${i}]`
    if (!set || typeof set.id !== 'string' || !PROFILESET_ID.test(set.id)) {
      issues.push({ field: `${field}.id`, message: `id must match ${PROFILESET_ID.source}` })
      continue
    }
    if (seen.has(set.id)) {
      // simc keys profilesets in a std::map, so duplicates silently merge.
      issues.push({ field: `${field}.id`, message: `duplicate profileset id "${set.id}"` })
      continue
    }
    seen.add(set.id)
    if (!Array.isArray(set.lines) || set.lines.length === 0) {
      // Lineless profileset creates no profileset; unmodified baseline is players[0], not a candidate.
      issues.push({
        field: `${field}.lines`,
        message:
          'lines must be a non-empty array — a profileset with no option lines is never created, and the unmodified baseline is players[0], not a candidate',
      })
      continue
    }
    for (const line of set.lines) {
      if (typeof line !== 'string' || !line.trim() || line.length > LIMITS.optionLineChars || /[\n\r]/.test(line)) {
        issues.push({ field: `${field}.lines`, message: `invalid option line ${JSON.stringify(line)?.slice(0, 80)}` })
        break
      }
      const item = itemLineProblem(line)
      if (item) {
        issues.push({ field: `${field}.lines`, message: item })
        break
      }
    }
  }
  return issues
}

/** Equipment slot names from util.cpp:1157-1181; shoulders and wrists are plural upstream. */
export const ITEM_SLOTS = [
  'head',
  'neck',
  'shoulders',
  'shirt',
  'chest',
  'waist',
  'legs',
  'feet',
  'wrists',
  'hands',
  'finger1',
  'finger2',
  'trinket1',
  'trinket2',
  'back',
  'main_hand',
  'off_hand',
  'tabard',
] as const

const ITEM_SLOT_SET: ReadonlySet<string> = new Set<string>(ITEM_SLOTS)

/** item_t::parse_options takes everything before first comma as item name (item.cpp:831-837); missing name means slot equips nothing silently (7-9% DPS loss). */
export function itemLineProblem(line: string): string | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\+?=(.*)$/.exec(line)
  if (!m || !ITEM_SLOT_SET.has(m[1].toLowerCase())) return null
  const first = m[2].split(',')[0]
  if (!first.includes('=')) return null
  return `"${m[1]}=" starts with "${first.trim()}", which the engine reads as the item's NAME, not as an option — the slot would silently equip nothing. Put a name token first, even a placeholder.`
}

/** Option names that make a different actor current; scope in simc profile is positional (sim.cpp:3933-3951, 4266). */
export const ACTOR_DECLARING_OPTIONS = [
  'deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk',
  'priest', 'paladin', 'rogue', 'shaman', 'warlock', 'warrior',
  'player_simplified', 'enemy', 'tank_dummy', 'pet', 'guardian', 'copy',
] as const

const ACTOR_DECLARING_SET: ReadonlySet<string> = new Set<string>(ACTOR_DECLARING_OPTIONS)

/** Whether this line hands actor scope to somebody else. */
export function declaresActor(line: string): boolean {
  const name = OPTION_LINE.exec(line)?.[1]?.toLowerCase()
  return name !== undefined && ACTOR_DECLARING_SET.has(name)
}

/** Expert Mode injection slots (P10.3): header/preActor (before any actor), postActor (after character, only slot reaching player), footer (after fight setup). */
export interface ProfileSlots {
  header?: string
  preActor?: string
  postActor?: string
  footer?: string
}

export type SlotName = keyof ProfileSlots

/** The slots whose contents the engine reads before any actor exists. */
const SIM_SCOPE_SLOTS: ReadonlySet<SlotName> = new Set<SlotName>(['header', 'preActor'])

/** Whether line sets actor-scoped option; answered from actor-options.generated.ts, incomplete by construction so false means "not known", used to warn never to move. */
export function isActorScoped(line: string): boolean {
  const name = OPTION_LINE.exec(line)?.[1]?.toLowerCase()
  if (!name) return false
  if (ITEM_SLOT_SET.has(name) || ACTOR_OPTION_NAMES.has(name)) return true
  return ACTOR_OPTION_PREFIXES.some((p) => name.startsWith(p))
}

/** What is wrong with putting line in slot, or null; reported never corrected, user knows intent not us. */
export function slotScopeProblem(slot: SlotName, line: string): string | null {
  if (!line.trim() || line.trim().startsWith('#')) return null
  if (SIM_SCOPE_SLOTS.has(slot) && isActorScoped(line)) {
    return `"${OPTION_LINE.exec(line)?.[1]}" configures a character, but nothing in "${slot}" has one yet — the engine will accept this line and ignore it. Move it to "postActor".`
  }
  if (slot === 'footer' && isActorScoped(line)) {
    return `"${OPTION_LINE.exec(line)?.[1]}" configures a character, and "footer" comes after the fight setup — if the fight style declares an enemy, this line configures the ENEMY instead. Move it to "postActor".`
  }
  return null
}

/** Every scope problem in a slot's text, with 1-based line numbers. */
export function slotProblems(slots: ProfileSlots): string[] {
  const out: string[] = []
  for (const slot of ['header', 'preActor', 'postActor', 'footer'] as const) {
    const text = slots[slot]
    if (!text) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const problem = slotScopeProblem(slot, lines[i])
      if (problem) out.push(`${slot} line ${i + 1}: ${problem}`)
    }
  }
  return out
}

/** Splices player-scoped lines into base before first actor-declaring line; makes candidate's gear/talents apply to player not enemy (7.9% DPS difference). */
export function withPlayerScopedLines(
  base: readonly string[],
  playerScoped: readonly string[],
): string[] {
  if (!playerScoped.length) return [...base]
  const at = base.findIndex(declaresActor)
  if (at === -1) return [...base, ...playerScoped]
  return [...base.slice(0, at), ...playerScoped, ...base.slice(at)]
}

/** Profile lines application appends after user's profile (e.g. fight preset's actor-scoped setup); actor declarations legitimate here. */
export function validateExtraProfileLines(lines: readonly string[] | undefined): ValidationIssue[] {
  if (lines === undefined) return []
  if (!Array.isArray(lines)) return [{ field: 'extraProfileLines', message: 'extraProfileLines must be an array' }]
  if (lines.length > LIMITS.extraOptions) {
    return [{ field: 'extraProfileLines', message: `at most ${LIMITS.extraOptions} lines, got ${lines.length}` }]
  }
  const issues: ValidationIssue[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (typeof line !== 'string' || !line.trim() || line.length > LIMITS.optionLineChars || /[\n\r\0]/.test(line)) {
      issues.push({ field: `extraProfileLines[${i}]`, message: 'must be a single-line non-empty option under the length limit' })
      continue
    }
    const name = OPTION_LINE.exec(line)?.[1]?.toLowerCase()
    if (name && PROTECTED_SET.has(name)) {
      issues.push({ field: `extraProfileLines[${i}]`, message: `"${name}" is application-owned and cannot be set here` })
      continue
    }
    const item = itemLineProblem(line)
    if (item) issues.push({ field: `extraProfileLines[${i}]`, message: item })
  }
  return issues
}

/** Validates Expert Mode slots; refuses only what cannot run (non-string, protected option, over budget), not scope mistakes. */
export function validateSlots(slots: unknown): ValidationIssue[] {
  if (slots === undefined) return []
  if (typeof slots !== 'object' || slots === null || Array.isArray(slots)) {
    return [{ field: 'slots', message: 'slots must be an object' }]
  }
  const issues: ValidationIssue[] = []
  let total = 0
  for (const slot of ['header', 'preActor', 'postActor', 'footer'] as const) {
    const text = (slots as Record<string, unknown>)[slot]
    if (text === undefined) continue
    if (typeof text !== 'string') {
      issues.push({ field: `slots.${slot}`, message: 'must be a string' })
      continue
    }
    if (text.includes('\0')) {
      issues.push({ field: `slots.${slot}`, message: 'must not contain a null character' })
      continue
    }
    total += text.length
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const name = OPTION_LINE.exec(lines[i])?.[1]?.toLowerCase()
      if (name && PROTECTED_SET.has(name)) {
        issues.push({
          field: `slots.${slot}`,
          message: `line ${i + 1}: "${name}" is application-owned and cannot be set here`,
        })
      }
    }
  }
  if (total > LIMITS.profileBytes) {
    issues.push({ field: 'slots', message: `slots total ${total} characters, over the ${LIMITS.profileBytes} limit` })
  }
  return issues
}

export function validateExtraOptions(options: readonly string[] | undefined): ValidationIssue[] {
  if (options === undefined) return []
  if (!Array.isArray(options)) return [{ field: 'extraOptions', message: 'extraOptions must be an array' }]
  if (options.length > LIMITS.extraOptions) {
    return [{ field: 'extraOptions', message: `at most ${LIMITS.extraOptions} extra options, got ${options.length}` }]
  }
  const issues: ValidationIssue[] = []
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    if (typeof opt !== 'string' || !opt.trim() || opt.length > LIMITS.optionLineChars || /[\n\r\0]/.test(opt)) {
      issues.push({ field: `extraOptions[${i}]`, message: 'must be a single-line non-empty option under the length limit' })
      continue
    }
    const name = OPTION_LINE.exec(opt)?.[1]?.toLowerCase()
    if (name && PROTECTED_SET.has(name)) {
      issues.push({ field: `extraOptions[${i}]`, message: `"${name}" is application-owned and cannot be set here` })
      continue
    }
    const item = itemLineProblem(opt)
    if (item) issues.push({ field: `extraOptions[${i}]`, message: item })
  }
  return issues
}
