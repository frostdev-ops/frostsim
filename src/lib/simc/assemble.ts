// Pure run assembly shared by the browser job controller and the account server (CLAUDE.md D14): request shape, validation, profile text, engine args. No worker, capability or import.meta.env, so Node can bundle it.

import { applyWeeklyDefaults } from './weekly-defaults'
import { hasFirstPull } from '../dungeonRoute'
import {
  buildArgs,
  clampThreads,
  profilesetLines,
  sanitizeProfile,
  slotProblems,
  validateSlots,
  validateExtraOptions,
  validateExtraProfileLines,
  validateProfile,
  validateProfilesets,
  validateSettings,
  type Accuracy,
  type ProfileSlots,
  type ProfilesetSpec,
  type RunMode,
  type SimSettings,
  type ValidationIssue,
} from './options'
import { profilesetCount, workPlan } from './profileset-workers'

export interface JobLimits {
  /** Worker start through engine module instantiation, which includes wasm download. */
  initTimeoutMs?: number
  /** Whole-run wall clock, enforced on main thread because wasm one is blocked. */
  deadlineMs?: number
  /** Longest silence before treating job as stalled; not proof of death but indicator when unexpected (stallWindow governs armed cases). */
  stallTimeoutMs?: number
}

export interface SimRequest {
  schemaVersion: 1
  /** Identity of this run for the whole of its life. */
  jobId?: string
  /** 'guided' lets UI state fight style/duration/targets/accuracy; 'raw' is Expert Mode where script owns settings. */
  mode?: RunMode
  profile: string
  /** Display-only snapshot, never translated into engine options. */
  characterSnapshot?: import('../import/character').ImportedCharacter
  settings: SimSettings
  accuracy: Accuracy
  profilesets?: ProfilesetSpec[]
  /** Advanced raw option lines, wins over UI settings but never over infrastructure. */
  extraOptions?: string[]
  /** Lines appended to profile text, not passed as arguments (e.g. fight preset profileLines); ORDER affects scope. */
  extraProfileLines?: string[]
  /** Expert Mode injection slots (P10.3) assembled in engine order; scope mistakes reported as warnings. */
  slots?: ProfileSlots
  /** Also produce simc's own HTML report readable through getHtmlReport(); off by default. */
  htmlReport?: boolean
  limits?: JobLimits
}

export function validateRequest(req: SimRequest, maxThreads: number): ValidationIssue[] {
  if (!req || typeof req !== 'object') return [{ field: 'request', message: 'request must be an object' }]
  if (req.schemaVersion !== 1) {
    return [{ field: 'schemaVersion', message: `unsupported request schema ${JSON.stringify(req.schemaVersion)}` }]
  }
  const extras = Array.isArray(req.extraOptions) ? req.extraOptions : []
  const appended = Array.isArray(req.extraProfileLines) ? req.extraProfileLines : []
  const style = [...extras.join('\n').matchAll(/^\s*fight_style\s*=\s*(\w+)/gm)].at(-1)?.[1]
    ?? (req.mode === 'raw' && typeof req.profile === 'string' ? [...req.profile.matchAll(/^\s*fight_style\s*=\s*(\w+)/gm)].at(-1)?.[1] : undefined)
    ?? req.settings?.fightStyle
  return [
    ...(style === 'DungeonRoute' && !hasFirstPull([req.profile, ...appended, ...extras, ...Object.values(req.slots ?? {})].join('\n'))
      ? [{ field: 'fightStyle', message: 'Dungeon Route needs a route with pull=1. Configure it in Advanced, or choose Dungeon Slice.' }] : []),
    ...validateProfile(req.profile),
    ...validateSettings(req.settings, req.accuracy, maxThreads, req.mode ?? 'guided'),
    ...validateProfilesets(req.profilesets),
    ...validateExtraOptions(req.extraOptions),
    ...validateExtraProfileLines(req.extraProfileLines),
    ...validateSlots(req.slots),
  ]
}

export interface AssembledRun {
  /** Exact profile text for PROFILE_PATH. */
  profile: string
  args: string[]
  /** Clamp, then sanitize, then slot warnings: the order runJob emits them in. */
  warnings: string[]
  threads: number
}

/** Profile text and args for a validated request. Pool ceiling comes from the caller, never the request (D11). `engine`: 'wasm'
 *  treats maxThreads as the browser build's fixed pthread pool; 'native' (cloud workers) has none. */
export function assembleRun(req: SimRequest, maxThreads: number, engine: 'wasm' | 'native' = 'wasm'): AssembledRun {
  const mode = req.mode ?? 'guided'
  // A saved 16-thread setting opened against the fallback is clamped, not refused.
  const threads = clampThreads(req.settings.threads, maxThreads)
  const sanitized = sanitizeProfile(req.profile, mode)
  const warnings = [
    ...(threads !== req.settings.threads
      ? [`Running on ${threads} thread${threads === 1 ? '' : 's'} instead of ${req.settings.threads}: this engine build allows at most ${maxThreads}.`]
      : []),
    ...sanitized.warnings,
  ]

  // Engine read order IS the scope (P10.3); app lines go after sanitisation so they are never rewritten, profilesets last.
  const slots = req.slots ?? {}
  warnings.push(...slotProblems(slots))

  const profile =
    [
      slots.header,
      slots.preActor,
      mode === 'guided' ? applyWeeklyDefaults(sanitized.text) : sanitized.text,
      slots.postActor,
      ...(req.extraProfileLines ?? []),
      ...(req.profilesets?.length ? profilesetLines(req.profilesets) : []),
      slots.footer,
    ]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.replace(/\n+$/, ''))
      .join('\n') + '\n'

  // Candidates side by side instead of one after another (profileset-workers.ts). Both options are protected, so these args are the
  // only place they are set; the threads arg is rewritten to what the plan uses, which under a pool can be less than asked.
  const iterations = req.accuracy.mode === 'iterations' ? req.accuracy.iterations : req.accuracy.mode === 'targetError' ? req.accuracy.maxIterations : null
  const plan = workPlan({
    threads,
    candidates: profilesetCount(profile),
    pool: engine === 'wasm' ? maxThreads : undefined,
    // A script decides its own iterations and fight length, so they count as unknown.
    iterations: mode === 'guided' ? iterations : null,
    simSeconds: req.settings.maxTime,
  })
  const args = buildArgs({
    settings: { ...req.settings, threads: plan.threads },
    accuracy: req.accuracy,
    extraOptions: req.extraOptions,
    maxThreads,
    mode,
    htmlReport: req.htmlReport,
  })
  if (plan.workThreads) args.splice(args.findIndex((a) => a.startsWith('threads=')) + 1, 0, `profileset_work_threads=${plan.workThreads}`)
  return { profile, args, warnings, threads: plan.threads }
}
