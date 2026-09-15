// simc JSON report (json=<path>,version=2) -> a compact typed result (P01.11). Fields read from vendor/simc report_json.cpp and validated against node relink.

export class ReportFormatError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'ReportFormatError'
    this.path = path
  }
}

/** simc sample data; fields past `max` are absent for "simple" sample data. */
export interface Distribution {
  mean: number
  /** Samples that contributed. The engine discards each thread's first iteration. */
  count: number
  sum: number
  min: number
  max: number
  median?: number
  variance?: number
  stdDev?: number
  meanVariance?: number
  /** Standard error of the mean — this is what target_error is measured against. */
  meanStdDev?: number
}

/** A margin at the report's own confidence level. Never a standard deviation. */
export interface ConfidenceInterval {
  /** e.g. 0.95 */
  level: number
  /** ± this many DPS. */
  margin: number
  /** The same margin as a percentage of the mean, comparable to target_error. */
  relativePct: number
}

/** One stat weight; `stat` is simc's own abbreviation. v2 report has no per-factor error. */
export interface ScaleFactor {
  stat: string
  value: number
}

export interface ScalingOptions {
  calculateScaleFactors: boolean
  /** Whether `scaleFactors` are normalised against the scaling metric (Pawn export requirement). */
  normalized: boolean
  scaleOnly?: string[]
  scaleOver?: string
  deltaMultiplier?: number
  scaleLag?: boolean
}

export interface PlayerResult {
  name: string
  specialization: string
  role?: string
  dps: Distribution
  /** Absent when the engine did not collect variance. */
  dpsConfidence?: ConfidenceInterval
  /** collected_data.total_iterations; present only under single_actor_batch. */
  actorIterations?: number
  /** Damage over fight time, one value per second; collected, never synthesised (P06.8). */
  damageTimeline?: Timeline
  /** Engine's valid_fight_style judgement; false means logged SEVERE warning. */
  validFightStyle?: boolean
  /** Present only when the run asked for scale factors; normalized per report.scaling.normalized. */
  scaleFactors?: ScaleFactor[]
  /** The same weights for every scaling metric the engine computed. */
  scaleFactorsByMetric?: Record<string, ScaleFactor[]>
  /** The stat deltas the weights were measured over. */
  scaleDeltas?: ScaleFactor[]
}

/** One profileset."<id>" variant; name is verbatim caller-supplied id. simc omits zero-mean profilesets (report_json.cpp:991). */
export interface ProfilesetResult {
  name: string
  mean: number
  min: number
  max: number
  iterations: number
  stdDev?: number
  meanStdDev?: number
  /** mean_stddev * confidence_estimator. Already a confidence margin, not a stddev. */
  meanError?: number
  median?: number
  firstQuartile?: number
  thirdQuartile?: number
}

export interface EngineIdentity {
  simcVersion: string
  reportVersion: string
  gitRevision?: string
  gitBranch?: string
  /** The C++ build date; never a game version. */
  buildDate?: string
  ptrEnabled: boolean
  betaEnabled: boolean
  networkingDisabled: boolean
}

export interface GameDataIdentity {
  /** "Live", "PTR", or a beta tag — sim.options.dbc.version_used. */
  channel: string
  wowVersion: string
  buildLevel?: number
  hotfixDate?: string
  hotfixBuild?: number
  hotfixHash?: string
}

/** What the engine actually ran with, read back out of the report. */
export interface EffectiveOptions {
  /** ACTUAL total iterations across all threads, not the requested count. */
  iterations: number
  targetError: number
  threads: number
  maxTime: number
  fightStyle: string
  desiredTargets: number
  singleActorBatch: boolean
  fixedTime: boolean
  /** sim.options.confidence, e.g. 0.95. */
  confidence: number
  /** sim.options.confidence_estimator — the z multiplier for that level. */
  confidenceEstimator: number
}

export interface ReportTimings {
  engineElapsedSeconds: number
  engineCpuSeconds?: number
  initSeconds?: number
  mergeSeconds?: number
  analyzeSeconds?: number
}

/** What a log line means for the result: note=engine's assumption, unverified=unchecked against game, problem=moderate or severe, unknown=unrecognized level. */
export type NoticeKind = 'note' | 'unverified' | 'problem' | 'unknown'

const NOTICE_KINDS: Record<string, NoticeKind> = {
  trivial: 'note',
  implementation_notes: 'note',
  not_yet_implemented: 'unverified',
  using_unverified_values: 'unverified',
  implementation_not_yet_verified: 'unverified',
  moderate: 'problem',
  severe: 'problem',
}

export interface ReportLog {
  /** The engine's own tokenized level, verbatim. */
  level: string
  message: string
  kind: NoticeKind
}

/** Engine notice from stderr: error_list per-sim is not copied on merge, so candidate problems appear here, not in report.logs. */
const STDERR_NOTICE = /^(Trivial|Moderate|Severe|Not Yet Implemented|Using Unverified Values|Implementation Not Yet Verified|Implementation Notes|Unknown):\s+(.+)$/

/** Option the engine did not recognize: raised TRIVIAL by engine, but KIND raised here because the option did not apply. */
const IGNORED_OPTION = /^Warning: Unknown option '/

export function parseEngineNotice(line: string): ReportLog | null {
  const m = STDERR_NOTICE.exec(line.trim())
  if (!m) return null
  const level = m[1].toLowerCase().replace(/ /g, '_')
  const message = m[2]
  const kind = IGNORED_OPTION.test(message) ? 'problem' : (NOTICE_KINDS[level] ?? 'unknown')
  return { level, message, kind }
}

/** One iteration's damage over time, when collected. */
export interface Timeline {
  /** Mean value per second; data[i] is second i. */
  data: number[]
  mean: number
  min: number
  max: number
  meanStdDev?: number
}

export interface SimReport {
  engine: EngineIdentity
  /** Absent only if engine omitted dbc block; never faked from build_date. */
  gameData?: GameDataIdentity
  options: EffectiveOptions
  /** Present only when run computed scale factors. */
  scaling?: ScalingOptions
  players: PlayerResult[]
  profilesets: ProfilesetResult[]
  profilesetMetric?: string
  raidDps?: Distribution
  timings: ReportTimings
  logs: ReportLog[]
  /** Engine logs above trivial level, flattened; survives log truncation. */
  warnings: string[]
  /** Logs classified as moderate or severe (result may be wrong); empty on healthy runs. */
  problems: string[]
  /** N for confidence interval: collected_data.dps.count; lower than iterationsSimulated because engine discards first iteration per thread. */
  actualIterations?: number
  /** Total iterations simulated across threads post-merge (sim.options.iterations); 50-iteration request on 4 threads simulates 53. */
  iterationsSimulated: number
  /** Whether run met stopping criterion: target-accuracy uses engine's test (sim.cpp:2229-2233), fixed-iteration always true. */
  targetReached: boolean
  /** The worst relative error across players, as a percentage. */
  worstRelativeErrorPct?: number
}

const SUPPORTED_REPORT_VERSIONS = ['2.0.0']

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new ReportFormatError(path, `expected an object, got ${v === null ? 'null' : typeof v}`)
  }
  return v as Record<string, unknown>
}

function optObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function reqNum(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ReportFormatError(path, `expected a finite number, got ${v === undefined ? 'nothing' : JSON.stringify(v)}`)
  }
  return v
}

/** Present-but-not-finite is corruption and throws; absent is just absent. */
function optNum(v: unknown, path: string): number | undefined {
  if (v === undefined || v === null) return undefined
  return reqNum(v, path)
}

function reqStr(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new ReportFormatError(path, `expected a non-empty string, got ${JSON.stringify(v)}`)
  }
  return v
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function truthy(v: unknown): boolean {
  // simc emits as 0/1, not booleans.
  return v === true || v === 1
}

function arr(v: unknown, path: string): unknown[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ReportFormatError(path, 'expected an array')
  return v
}

function toDistribution(raw: unknown, path: string): Distribution {
  const d = obj(raw, path)
  return {
    mean: reqNum(d.mean, `${path}.mean`),
    count: reqNum(d.count, `${path}.count`),
    sum: reqNum(d.sum, `${path}.sum`),
    min: reqNum(d.min, `${path}.min`),
    max: reqNum(d.max, `${path}.max`),
    median: optNum(d.median, `${path}.median`),
    variance: optNum(d.variance, `${path}.variance`),
    stdDev: optNum(d.std_dev, `${path}.std_dev`),
    meanVariance: optNum(d.mean_variance, `${path}.mean_variance`),
    meanStdDev: optNum(d.mean_std_dev, `${path}.mean_std_dev`),
  }
}

function confidenceOf(
  mean: number,
  meanStdDev: number | undefined,
  level: number,
  estimator: number,
): ConfidenceInterval | undefined {
  if (meanStdDev === undefined || !(estimator > 0) || !(level > 0)) return undefined
  const margin = meanStdDev * estimator
  return { level, margin, relativePct: mean !== 0 ? (margin / Math.abs(mean)) * 100 : 0 }
}

function parseGameData(options: Record<string, unknown>): GameDataIdentity | undefined {
  const dbc = optObj(options.dbc)
  if (!dbc) return undefined
  const channel = optStr(dbc.version_used)
  if (!channel) return undefined
  const entry = optObj(dbc[channel])
  const wowVersion = entry && optStr(entry.wow_version)
  if (!entry || !wowVersion) return undefined
  return {
    channel,
    wowVersion,
    buildLevel: optNum(entry.build_level, 'sim.options.dbc.build_level'),
    hotfixDate: optStr(entry.hotfix_date),
    hotfixBuild: optNum(entry.hotfix_build, 'sim.options.dbc.hotfix_build'),
    hotfixHash: optStr(entry.hotfix_hash),
  }
}

function parseOptions(raw: unknown): EffectiveOptions {
  const o = obj(raw, 'sim.options')
  return {
    iterations: reqNum(o.iterations, 'sim.options.iterations'),
    targetError: reqNum(o.target_error, 'sim.options.target_error'),
    threads: reqNum(o.threads, 'sim.options.threads'),
    maxTime: reqNum(o.max_time, 'sim.options.max_time'),
    fightStyle: reqStr(o.fight_style, 'sim.options.fight_style'),
    desiredTargets: reqNum(o.desired_targets, 'sim.options.desired_targets'),
    singleActorBatch: truthy(o.single_actor_batch),
    fixedTime: truthy(o.fixed_time),
    confidence: reqNum(o.confidence, 'sim.options.confidence'),
    confidenceEstimator: reqNum(o.confidence_estimator, 'sim.options.confidence_estimator'),
  }
}

function toScaleFactors(raw: unknown, path: string): ScaleFactor[] | undefined {
  const o = optObj(raw)
  if (!o) return undefined
  const factors = Object.entries(o).flatMap(([stat, value]) => {
    const v = optNum(value, `${path}.${stat}`)
    return v === undefined ? [] : [{ stat, value: v }]
  })
  return factors.length ? factors : undefined
}

function parseScaling(options: Record<string, unknown>): ScalingOptions | undefined {
  const s = optObj(options.scaling)
  if (!s) return undefined
  const scaleOnly = optStr(s.scale_only)
  return {
    calculateScaleFactors: truthy(s.calculate_scale_factors),
    normalized: truthy(s.normalize_scale_factors),
    // Engine splits on ",:;/|" (scale_factor_control.cpp:27).
    scaleOnly: scaleOnly ? scaleOnly.split(/[,:;/|]/).map((s) => s.trim()).filter(Boolean) : undefined,
    scaleOver: optStr(s.scale_over),
    deltaMultiplier: optNum(s.scale_delta_multiplier, 'sim.options.scaling.scale_delta_multiplier'),
    scaleLag: truthy(s.scale_lag),
  }
}

function parsePlayers(raw: unknown, options: EffectiveOptions): PlayerResult[] {
  return arr(raw, 'sim.players').map((entry, i) => {
    const path = `sim.players[${i}]`
    const p = obj(entry, path)
    const collected = obj(p.collected_data, `${path}.collected_data`)
    if (collected.dps === undefined) {
      // add_non_zero drops dps object when mean is 0 (report_json.cpp:581); real result but nothing to display.
      throw new ReportFormatError(`${path}.collected_data.dps`, 'missing — the actor produced no damage')
    }
    const dps = toDistribution(collected.dps, `${path}.collected_data.dps`)
    return {
      name: reqStr(p.name, `${path}.name`),
      specialization: reqStr(p.specialization, `${path}.specialization`),
      role: optStr(p.role),
      dps,
      dpsConfidence: confidenceOf(dps.mean, dps.meanStdDev, options.confidence, options.confidenceEstimator),
      actorIterations: optNum(collected.total_iterations, `${path}.collected_data.total_iterations`),
      validFightStyle: typeof p.valid_fight_style === 'boolean' ? p.valid_fight_style : undefined,
      damageTimeline: toTimeline(collected.timeline_dmg, `${path}.collected_data.timeline_dmg`),
      scaleFactors: toScaleFactors(p.scale_factors, `${path}.scale_factors`),
      scaleFactorsByMetric: parseScaleFactorsAll(p.scale_factors_all, `${path}.scale_factors_all`),
      scaleDeltas: toScaleFactors(p.scale_deltas, `${path}.scale_deltas`),
    }
  })
}

function parseScaleFactorsAll(raw: unknown, path: string): Record<string, ScaleFactor[]> | undefined {
  const o = optObj(raw)
  if (!o) return undefined
  const out: Record<string, ScaleFactor[]> = {}
  for (const [metric, value] of Object.entries(o)) {
    const factors = toScaleFactors(value, `${path}.${metric}`)
    if (factors) out[metric] = factors
  }
  return Object.keys(out).length ? out : undefined
}

function parseProfilesets(raw: unknown): ProfilesetResult[] {
  const sets = optObj(raw)
  if (!sets) return []
  return arr(sets.results, 'sim.profilesets.results').map((entry, i) => {
    const path = `sim.profilesets.results[${i}]`
    const r = obj(entry, path)
    return {
      name: reqStr(r.name, `${path}.name`),
      mean: reqNum(r.mean, `${path}.mean`),
      min: reqNum(r.min, `${path}.min`),
      max: reqNum(r.max, `${path}.max`),
      iterations: reqNum(r.iterations, `${path}.iterations`),
      // Profilesets omit underscore that players use.
      stdDev: optNum(r.stddev, `${path}.stddev`),
      meanStdDev: optNum(r.mean_stddev, `${path}.mean_stddev`),
      meanError: optNum(r.mean_error, `${path}.mean_error`),
      median: optNum(r.median, `${path}.median`),
      firstQuartile: optNum(r.first_quartile, `${path}.first_quartile`),
      thirdQuartile: optNum(r.third_quartile, `${path}.third_quartile`),
    }
  })
}

function parseLogs(raw: unknown): ReportLog[] {
  return arr(raw, 'logs').flatMap((entry) => {
    const log = optObj(entry)
    const message = log && optStr(log.message)
    if (!message) return []
    const level = optStr(log.level) ?? 'unknown'
    return [{ level, message, kind: NOTICE_KINDS[level] ?? 'unknown' }]
  })
}

function toTimeline(raw: unknown, path: string): Timeline | undefined {
  const t = optObj(raw)
  if (!t || !Array.isArray(t.data) || t.data.length === 0) return undefined
  const data = t.data.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (data.length !== t.data.length) throw new ReportFormatError(`${path}.data`, 'contains a non-finite value')
  return {
    data,
    mean: reqNum(t.mean, `${path}.mean`),
    min: reqNum(t.min, `${path}.min`),
    max: reqNum(t.max, `${path}.max`),
    meanStdDev: optNum(t.mean_std_dev, `${path}.mean_std_dev`),
  }
}

/** raw is already-parsed JSON; payload under sim; root carries engine and build identity. */
export function parseReport(raw: unknown): SimReport {
  const root = obj(raw, '')
  const reportVersion = reqStr(root.report_version, 'report_version')
  if (!SUPPORTED_REPORT_VERSIONS.includes(reportVersion)) {
    throw new ReportFormatError(
      'report_version',
      `unsupported report format ${reportVersion}; this build reads ${SUPPORTED_REPORT_VERSIONS.join(', ')}`,
    )
  }
  const sim = obj(root.sim, 'sim')
  const options = parseOptions(sim.options)
  const players = parsePlayers(sim.players, options)
  const logs = parseLogs(root.logs)
  const statistics = obj(sim.statistics, 'sim.statistics')

  const relativeErrors = players
    .map((p) => p.dpsConfidence?.relativePct)
    .filter((v): v is number => v !== undefined)
  const worstRelativeErrorPct = relativeErrors.length ? Math.max(...relativeErrors) : undefined

  return {
    engine: {
      simcVersion: reqStr(root.version, 'version'),
      reportVersion,
      gitRevision: optStr(root.git_revision),
      gitBranch: optStr(root.git_branch),
      buildDate: optStr(root.build_date),
      ptrEnabled: truthy(root.ptr_enabled),
      betaEnabled: truthy(root.beta_enabled),
      networkingDisabled: truthy(root.no_networking),
    },
    gameData: parseGameData(obj(sim.options, 'sim.options')),
    options,
    scaling: parseScaling(obj(sim.options, 'sim.options')),
    players,
    profilesets: parseProfilesets(sim.profilesets),
    profilesetMetric: optStr(optObj(sim.profilesets)?.metric),
    raidDps: statistics.raid_dps === undefined ? undefined : toDistribution(statistics.raid_dps, 'sim.statistics.raid_dps'),
    timings: {
      engineElapsedSeconds: reqNum(statistics.elapsed_time_seconds, 'sim.statistics.elapsed_time_seconds'),
      engineCpuSeconds: optNum(statistics.elapsed_cpu_seconds, 'sim.statistics.elapsed_cpu_seconds'),
      initSeconds: optNum(statistics.init_time_seconds, 'sim.statistics.init_time_seconds'),
      mergeSeconds: optNum(statistics.merge_time_seconds, 'sim.statistics.merge_time_seconds'),
      analyzeSeconds: optNum(statistics.analyze_time_seconds, 'sim.statistics.analyze_time_seconds'),
    },
    logs,
    warnings: logs.filter((l) => l.level !== 'trivial').map((l) => l.message),
    problems: logs.filter((l) => l.kind === 'problem').map((l) => l.message),
    actualIterations: players[0]?.dps.count,
    iterationsSimulated: options.iterations,
    targetReached:
      options.targetError <= 0 ||
      (worstRelativeErrorPct !== undefined && worstRelativeErrorPct < options.targetError),
    worstRelativeErrorPct,
  }
}

/** Which candidates came back; simc omits zero-mean profilesets, so diff ids to find unresolved ones (P07.7/P08.12). */
export function profilesetStatus(
  requested: readonly string[],
  report: SimReport,
): { completed: string[]; missing: string[] } {
  const got = new Set(report.profilesets.map((p) => p.name))
  return {
    completed: requested.filter((id) => got.has(id)),
    missing: requested.filter((id) => !got.has(id)),
  }
}

/** Ranked highest mean first; simc emits in name order. */
export function rankProfilesets(report: SimReport): ProfilesetResult[] {
  return [...report.profilesets].sort((a, b) => b.mean - a.mean)
}
