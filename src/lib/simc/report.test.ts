import { describe, expect, it } from 'vitest'
import { parseEngineNotice, parseReport, profilesetStatus, rankProfilesets, ReportFormatError } from './report'

// Values copied verbatim out of a real `json=...,version=2` report, produced by
// the node relink of this exact engine build:
//   node simc-node.cjs vendor/simc/profiles/MID2/MID2_Mage_Frost.simc \
//        iterations=50 threads=4 target_error=0 json=fixed.json,version=2
// Note iterations=53 for a requested 50: the report carries the ACTUAL merged
// total, which is what makes it usable as "actual iterations".
const realReport = {
  version: '1210-01',
  report_version: '2.0.0',
  ptr_enabled: 0,
  beta_enabled: 0,
  build_date: 'Sep 13 2026',
  build_time: '22:31:04',
  timestamp: 1789099335,
  no_networking: true,
  git_revision: 'c015720',
  git_branch: 'midnight',
  sim: {
    options: {
      iterations: 53,
      target_error: 0,
      threads: 4,
      max_time: 300,
      fight_style: 'Patchwerk',
      desired_targets: 1,
      single_actor_batch: false,
      fixed_time: true,
      confidence: 0.95,
      confidence_estimator: 1.9599639854088815,
      dbc: {
        Live: {
          build_level: 69814,
          wow_version: '12.1.0.69814',
          hotfix_date: '2026-09-12',
          hotfix_build: 69814,
          hotfix_hash: 'dca34b3038a3611b988b81eb90f7dd81e929268ebe05b6ac4a07ccdffb621163',
        },
        version_used: 'Live',
      },
    },
    players: [
      {
        name: 'MID2_Mage_Frost_Spellslinger',
        specialization: 'Frost Mage',
        role: 'spell',
        collected_data: {
          dps: {
            sum: 10974712.66754416,
            count: 49,
            mean: 223973.7279090645,
            min: 207574.4606276156,
            max: 241781.63100204358,
            median: 223416.11013279125,
            variance: 58281843.95884108,
            std_dev: 7634.254643306122,
            mean_variance: 1189425.386915124,
            mean_std_dev: 1090.6078061865887,
          },
        },
      },
    ],
    statistics: {
      elapsed_cpu_seconds: 0,
      elapsed_time_seconds: 0.171585536,
      init_time_seconds: 0.088965376,
      merge_time_seconds: 0.002033664,
      analyze_time_seconds: 0.002061568,
      simulation_length: { sum: 14756.4, count: 49, mean: 300, min: 300, max: 300 },
      total_events_processed: 429781,
      raid_dps: {
        sum: 10974712.66754416,
        count: 49,
        mean: 223973.7279090645,
        min: 207574.4606276156,
        max: 241781.63100204358,
        median: 223416.11013279125,
        variance: 58281843.95884108,
        std_dev: 7634.254643306122,
        mean_variance: 1189425.386915124,
        mean_std_dev: 1090.6078061865887,
      },
    },
  },
  logs: [
    {
      level: 'implementation_not_yet_verified',
      message: 'Rune of Unleashed Fire: Procs are assumed to target the same unit that triggered them.',
    },
  ],
}

// From the same engine, run with three profilesets. Keys differ from the player
// spelling (stddev / mean_stddev), and simc emits them in name order.
const profilesetResults = [
  {
    name: 'c 0003 / weird',
    mean: 223015.79285149855,
    min: 206377.36000175722,
    max: 233240.78741607373,
    stddev: 6683.250655187668,
    mean_stddev: 1241.0484905370774,
    mean_error: 2432.410345598727,
    median: 223730.6588512481,
    first_quartile: 219553.44565469798,
    third_quartile: 227844.77940914486,
    iterations: 30,
  },
  {
    name: 'c-0001',
    mean: 217299.23500104746,
    min: 207492.35249181557,
    max: 226331.79428337494,
    stddev: 5145.423055277106,
    mean_stddev: 955.4810743136816,
    mean_error: 1872.7084943946031,
    median: 217151.31954377415,
    first_quartile: 213009.4872859651,
    third_quartile: 220595.30413520586,
    iterations: 30,
  },
  {
    name: 'c-0002',
    mean: 227039.13652808507,
    min: 209596.98978218698,
    max: 245393.7720885097,
    stddev: 9331.898560895117,
    mean_stddev: 1732.8900590993624,
    mean_error: 3396.4021065078186,
    median: 227005.85234583582,
    first_quartile: 220332.980301621,
    third_quartile: 234037.28631962417,
    iterations: 30,
  },
]

function withProfilesets() {
  return {
    ...realReport,
    sim: {
      ...realReport.sim,
      profilesets: { metric: 'Damage per Second', results: profilesetResults },
    },
  }
}

function withOptions(patch: Record<string, unknown>) {
  return { ...realReport, sim: { ...realReport.sim, options: { ...realReport.sim.options, ...patch } } }
}

describe('parseReport identity', () => {
  it('reads the game version from the dbc block the engine actually used', () => {
    const r = parseReport(realReport)
    expect(r.gameData?.channel).toBe('Live')
    expect(r.gameData?.wowVersion).toBe('12.1.0.69814')
    expect(r.gameData?.hotfixHash).toBe(
      'dca34b3038a3611b988b81eb90f7dd81e929268ebe05b6ac4a07ccdffb621163',
    )
  })

  it('never uses the C++ build date as a game version', () => {
    const noDbc = withOptions({ dbc: undefined })
    const r = parseReport(noDbc)
    expect(r.gameData).toBeUndefined()
    expect(r.engine.buildDate).toBe('Sep 13 2026')
  })

  it('keeps engine revision and networking state separate from the version string', () => {
    const r = parseReport(realReport)
    expect(r.engine.simcVersion).toBe('1210-01')
    expect(r.engine.gitRevision).toBe('c015720')
    expect(r.engine.gitBranch).toBe('midnight')
    expect(r.engine.networkingDisabled).toBe(true)
    expect(r.engine.ptrEnabled).toBe(false)
  })

  it('rejects a report format it cannot read', () => {
    expect(() => parseReport({ ...realReport, report_version: '3.0.0-alpha1' })).toThrow(/unsupported report format/)
  })

  it('rejects anything that is not a simc report', () => {
    expect(() => parseReport(null)).toThrow(ReportFormatError)
    expect(() => parseReport({ report_version: '2.0.0' })).toThrow(/sim:/)
  })
})

describe('parseReport metrics', () => {
  it('reads the player distribution without inventing missing fields', () => {
    const r = parseReport(realReport)
    expect(r.players).toHaveLength(1)
    expect(r.players[0].specialization).toBe('Frost Mage')
    expect(r.players[0].role).toBe('spell')
    expect(r.players[0].dps.mean).toBeCloseTo(223973.73, 2)
    expect(r.players[0].dps.count).toBe(49)
    expect(r.players[0].dps.stdDev).toBeCloseTo(7634.25, 2)
    expect(r.players[0].dps.meanStdDev).toBeCloseTo(1090.61, 2)
    // Present only under single_actor_batch, and this run was not.
    expect(r.players[0].actorIterations).toBeUndefined()
  })

  it('leaves optional sample fields undefined rather than zero when the engine omits them', () => {
    // "simple" sample data carries sum/count/mean/min/max and nothing else.
    const simple = {
      ...realReport,
      sim: {
        ...realReport.sim,
        players: [
          {
            ...realReport.sim.players[0],
            collected_data: { dps: { sum: 100, count: 2, mean: 50, min: 40, max: 60 } },
          },
        ],
      },
    }
    const r = parseReport(simple)
    expect(r.players[0].dps.stdDev).toBeUndefined()
    expect(r.players[0].dps.meanStdDev).toBeUndefined()
    expect(r.players[0].dpsConfidence).toBeUndefined()
    expect(r.worstRelativeErrorPct).toBeUndefined()
  })

  it('rejects a non-finite metric instead of substituting zero', () => {
    const broken = {
      ...realReport,
      sim: {
        ...realReport.sim,
        players: [
          {
            ...realReport.sim.players[0],
            collected_data: { dps: { ...realReport.sim.players[0].collected_data.dps, mean: null } },
          },
        ],
      },
    }
    expect(() => parseReport(broken)).toThrow(/sim\.players\[0\]\.collected_data\.dps\.mean/)
  })

  it('reads raid_dps as the sample-data object it is, not as a number', () => {
    const r = parseReport(realReport)
    expect(r.raidDps?.mean).toBeCloseTo(223973.73, 2)
    expect(r.raidDps?.count).toBe(49)
  })

  it('keeps engine elapsed time separate from init, merge and analyze', () => {
    const t = parseReport(realReport).timings
    expect(t.engineElapsedSeconds).toBeCloseTo(0.1716, 4)
    expect(t.initSeconds).toBeCloseTo(0.08897, 5)
    expect(t.mergeSeconds).toBeCloseTo(0.002034, 6)
  })
})

describe('confidence and iteration semantics', () => {
  it('computes the margin from the report estimator, matching the engine text report', () => {
    // The engine printed "DPS-Error=2137.5520223315034/0.95%" for this run.
    const ci = parseReport(realReport).players[0].dpsConfidence
    expect(ci?.level).toBe(0.95)
    expect(ci?.margin).toBeCloseTo(2137.552, 3)
    expect(ci?.relativePct).toBeCloseTo(0.9544, 3)
  })

  it('keeps the standard error separate from the confidence margin', () => {
    const p = parseReport(realReport).players[0]
    expect(p.dps.meanStdDev).toBeCloseTo(1090.61, 2)
    expect(p.dpsConfidence?.margin).not.toBeCloseTo(p.dps.meanStdDev!, 2)
  })

  it('separates iterations simulated from the samples behind the error bar', () => {
    // 50 requested on 4 threads. The engine simulated 53 and kept 49 samples —
    // each thread's first iteration is discarded from data collection.
    const r = parseReport(realReport)
    expect(r.iterationsSimulated).toBe(53)
    expect(r.actualIterations).toBe(49)
    expect(r.actualIterations).toBe(r.players[0].dps.count)
  })

  it('a fixed-iteration run has no accuracy target to miss', () => {
    const r = parseReport(realReport)
    expect(r.options.targetError).toBe(0)
    expect(r.targetReached).toBe(true)
  })

  it('flags a target-accuracy run that stopped before reaching its target', () => {
    // 0.9544% actual error against a 0.1% target.
    const r = parseReport(withOptions({ target_error: 0.1 }))
    expect(r.worstRelativeErrorPct).toBeCloseTo(0.9544, 3)
    expect(r.targetReached).toBe(false)
  })

  it('accepts a target-accuracy run that reached its target', () => {
    expect(parseReport(withOptions({ target_error: 2 })).targetReached).toBe(true)
  })
})

describe('profilesets', () => {
  it('reads the profileset spellings, which differ from the player ones', () => {
    const r = parseReport(withProfilesets())
    const first = r.profilesets.find((p) => p.name === 'c-0001')!
    expect(first.stdDev).toBeCloseTo(5145.42, 2)
    expect(first.meanStdDev).toBeCloseTo(955.48, 2)
    // mean_error is already a confidence margin: mean_stddev * confidence_estimator.
    expect(first.meanError).toBeCloseTo(955.4810743136816 * 1.9599639854088815, 6)
    expect(first.iterations).toBe(30)
  })

  it('round-trips ids verbatim, including ones with spaces and slashes', () => {
    const names = parseReport(withProfilesets()).profilesets.map((p) => p.name)
    expect(names).toContain('c 0003 / weird')
  })

  it('ranks by mean on request; the engine emits them in name order', () => {
    const r = parseReport(withProfilesets())
    expect(r.profilesets.map((p) => p.name)).toEqual(['c 0003 / weird', 'c-0001', 'c-0002'])
    expect(rankProfilesets(r).map((p) => p.name)).toEqual(['c-0002', 'c 0003 / weird', 'c-0001'])
  })

  it('reports a dropped candidate as missing, since simc omits zero-mean results', () => {
    const status = profilesetStatus(['c-0001', 'c-0002', 'c-0099'], parseReport(withProfilesets()))
    expect(status.completed).toEqual(['c-0001', 'c-0002'])
    expect(status.missing).toEqual(['c-0099'])
  })

  it('survives a report with no profilesets', () => {
    expect(parseReport(realReport).profilesets).toEqual([])
  })
})

describe('scale factors', () => {
  // Real values from a calculate_scale_factors=1 normalize_scale_factors=1 run
  // of the same profile. Int normalises to 1.
  const scaled = {
    ...withOptions({ scaling: { calculate_scale_factors: 1, normalize_scale_factors: 1 } }),
    sim: {
      ...realReport.sim,
      options: {
        ...realReport.sim.options,
        scaling: { calculate_scale_factors: 1, normalize_scale_factors: 1, scale_only: 'crit,haste' },
      },
      players: [
        {
          ...realReport.sim.players[0],
          scale_factors: {
            Int: 1,
            SP: 1.2406340402223148,
            Crit: 0.7411824014367108,
            Haste: 0.3106940663384843,
          },
          scale_factors_all: { dps: { Int: 1, Crit: 0.7411824014367108 }, hps: { Int: 0, Crit: 0 } },
          scale_deltas: { Int: 154, Crit: 154 },
        },
      ],
    },
  }

  it('reads the weights and says whether they are normalised', () => {
    const r = parseReport(scaled)
    expect(r.scaling?.calculateScaleFactors).toBe(true)
    expect(r.scaling?.normalized).toBe(true)
    expect(r.players[0].scaleFactors).toContainEqual({ stat: 'Int', value: 1 })
    expect(r.players[0].scaleFactors).toContainEqual({ stat: 'Haste', value: 0.3106940663384843 })
  })

  it('splits scale_only the way the engine does', () => {
    expect(parseReport(scaled).scaling?.scaleOnly).toEqual(['crit', 'haste'])
    const piped = {
      ...scaled,
      sim: {
        ...scaled.sim,
        options: { ...scaled.sim.options, scaling: { ...scaled.sim.options.scaling, scale_only: 'crit|haste;mast' } },
      },
    }
    expect(parseReport(piped).scaling?.scaleOnly).toEqual(['crit', 'haste', 'mast'])
  })

  it('keeps the per-metric weights and the deltas they were measured over', () => {
    const p = parseReport(scaled).players[0]
    expect(p.scaleFactorsByMetric?.dps).toContainEqual({ stat: 'Crit', value: 0.7411824014367108 })
    expect(p.scaleDeltas).toContainEqual({ stat: 'Int', value: 154 })
  })

  it('carries no per-factor error, because the v2 report emits none', () => {
    const factor = parseReport(scaled).players[0].scaleFactors![0]
    expect(Object.keys(factor).sort()).toEqual(['stat', 'value'])
  })

  it('leaves scaling absent on an ordinary run', () => {
    const r = parseReport(realReport)
    expect(r.scaling).toBeUndefined()
    expect(r.players[0].scaleFactors).toBeUndefined()
  })
})

describe('engine notices', () => {
  it('classifies a log by the engine own level, so callers need not know simc vocabulary', () => {
    const r = parseReport(realReport)
    expect(r.logs[0]).toMatchObject({ level: 'implementation_not_yet_verified', kind: 'unverified' })
    expect(r.problems).toEqual([])
  })

  it('separates a result that may be wrong from one that merely assumed something', () => {
    const mixed = {
      ...realReport,
      logs: [
        { level: 'implementation_notes', message: 'assumed a thing' },
        { level: 'using_unverified_values', message: 'unverified coefficient' },
        { level: 'severe', message: 'does not support fight style X, results are inaccurate' },
        { level: 'moderate', message: 'something is off' },
      ],
    }
    const r = parseReport(mixed)
    expect(r.logs.map((l) => l.kind)).toEqual(['note', 'unverified', 'problem', 'problem'])
    expect(r.problems).toEqual(['does not support fight style X, results are inaccurate', 'something is off'])
  })

  it('keeps a level it does not recognise rather than dropping or guessing at it', () => {
    const r = parseReport({ ...realReport, logs: [{ level: 'brand_new_level', message: 'hello' }] })
    expect(r.logs[0]).toMatchObject({ level: 'brand_new_level', kind: 'unknown' })
    expect(r.problems).toEqual([])
  })
})

describe('timelines', () => {
  it('reads the damage timeline when the engine collected one', () => {
    const withTimeline = {
      ...realReport,
      sim: {
        ...realReport.sim,
        players: [
          {
            ...realReport.sim.players[0],
            collected_data: {
              ...realReport.sim.players[0].collected_data,
              timeline_dmg: { mean: 1000, mean_std_dev: 12, min: 0, max: 5000, data: [0, 100, 250] },
            },
          },
        ],
      },
    }
    const t = parseReport(withTimeline).players[0].damageTimeline
    expect(t?.data).toEqual([0, 100, 250])
    expect(t?.mean).toBe(1000)
    expect(t?.meanStdDev).toBe(12)
  })

  it('is absent rather than empty when the engine collected none', () => {
    // A chart must be drawn from data that exists, not from a synthesised zero.
    expect(parseReport(realReport).players[0].damageTimeline).toBeUndefined()
  })
})

describe('warnings', () => {
  it('keeps engine logs and surfaces the non-trivial ones as warnings', () => {
    const r = parseReport(realReport)
    expect(r.logs).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/Rune of Unleashed Fire/)
  })

  it('drops trivial log lines from warnings but keeps them in logs', () => {
    const r = parseReport({ ...realReport, logs: [{ level: 'trivial', message: 'noise' }] })
    expect(r.logs).toHaveLength(1)
    expect(r.warnings).toEqual([])
  })
})

// Lines copied verbatim from the stderr of a real fallback run of
// tests/fixtures/addon-export-demonology.simc.
describe('parseEngineNotice', () => {
  it('classifies a multi-word level the same way the report does', () => {
    expect(
      parseEngineNotice(
        'Implementation Not Yet Verified: Rune of Unleashed Fire: Procs are assumed to target the same unit.',
      ),
    ).toEqual({
      level: 'implementation_not_yet_verified',
      message: 'Rune of Unleashed Fire: Procs are assumed to target the same unit.',
      kind: 'unverified',
    })
  })

  it('classifies severe as a problem', () => {
    expect(parseEngineNotice('Severe: something is wrong')?.kind).toBe('problem')
  })

  it('raises an ignored option above the trivial level simc gives it', () => {
    // Verbatim from a real run with enemy_fixed_health_percentage passed as an
    // argument. The engine's own level is kept; only the kind is raised,
    // because the engine's result is fine and the user's setting is not.
    const n = parseEngineNotice(
      "Trivial: Warning: Unknown option 'enemy_fixed_health_percentage' with value '20', ignoring",
    )
    expect(n?.level).toBe('trivial')
    expect(n?.kind).toBe('problem')
  })

  it('leaves other trivial notices alone', () => {
    expect(parseEngineNotice('Trivial: noise')?.kind).toBe('note')
  })

  it('ignores ordinary output, including lines that merely contain a colon', () => {
    expect(parseEngineNotice('Generating Baseline: 1/1 [===>] 100/100 3.4')).toBeNull()
    expect(parseEngineNotice('')).toBeNull()
    expect(parseEngineNotice('Severe:')).toBeNull()
  })
})
