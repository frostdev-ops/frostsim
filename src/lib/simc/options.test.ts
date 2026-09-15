import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { artifactGate } from '../../../tests/artifact-gate.js'
import {
  ACTOR_DECLARING_OPTIONS,
  declaresActor,
  withPlayerScopedLines,
  HTML_REPORT_PATH,
  isActorScoped,
  slotProblems,
  slotScopeProblem,
  validateSlots,
  buildArgs,
  clampThreads,
  DEFAULT_SETTINGS,
  DEFAULT_ACCURACY,
  ITEM_SLOTS,
  itemLineProblem,
  LIMITS,
  maxUsefulThreads,
  profilesetLines,
  sanitizeProfile,
  validateExtraOptions,
  validateProfile,
  validateProfilesets,
  validateSettings,
  type Accuracy,
} from './options'

// The upstream checkout is gitignored, so the drift check only runs where it was fetched.
const playerCppGate = artifactGate('vendor/simc/engine/player/player.cpp', 'npm run engine:bootstrap')

const settings = { ...DEFAULT_SETTINGS, threads: 4 }
const fixed: Accuracy = { mode: 'iterations', iterations: 1000 }
const accurate: Accuracy = { mode: 'targetError', targetError: 0.5, maxIterations: 100_000 }

function args(accuracy: Accuracy, extraOptions?: string[]) {
  return buildArgs({ settings, accuracy, extraOptions, maxThreads: 16 })
}

describe('buildArgs', () => {
  it('matches observed guided defaults without imposing them on raw scripts', () => {
    expect(args(DEFAULT_ACCURACY)).toEqual(expect.arrayContaining([
      'target_error=0.1', 'iterations=100000', 'max_time=300', 'desired_targets=1',
      'single_actor_batch=1', 'optimize_expressions=1',
    ]))
    const raw = buildArgs({ settings, accuracy: { mode: 'script' }, maxThreads: 16, mode: 'raw' })
    expect(raw).not.toContain('single_actor_batch=1')
    expect(raw).not.toContain('optimize_expressions=1')
  })
  // Stable v2 format.
  it('requests the stable v2 report format', () => {
    expect(args(fixed)).toContain('json=/out.json,version=2')
  })

  it('turns target_error off explicitly for a fixed-iteration run', () => {
    // Omit alone insufficient: inherited target_error stops early; only <=0 disables.
    expect(args(fixed)).toContain('iterations=1000')
    expect(args(fixed)).toContain('target_error=0')
  })

  it('passes the iteration ceiling as the budget in target-accuracy mode', () => {
    expect(args(accurate)).toContain('target_error=0.5')
    expect(args(accurate)).toContain('iterations=100000')
  })

  it('puts accuracy and infrastructure after the advanced options, so they win', () => {
    const a = args(fixed, ['iterations=7', 'threads=999'])
    expect(a.lastIndexOf('iterations=1000')).toBeGreaterThan(a.indexOf('iterations=7'))
    expect(a.lastIndexOf('threads=4')).toBeGreaterThan(a.indexOf('threads=999'))
    expect(a.at(-1)).toBe('json=/out.json,version=2')
  })

  it('always asks for the machine-readable progress format', () => {
    // Default bar ends in carriage return; emscripten fires per newline; needed for browser not-silent.
    expect(args(fixed)).toContain('progressbar_type=1')
    // Raw script mode: infrastructure not simulation setting.
    expect(buildArgs({ settings, accuracy: fixed, maxThreads: 16, mode: 'raw' })).toContain('progressbar_type=1')
  })

  it('refuses to let a script turn the progress format off', () => {
    expect(validateExtraOptions(['progressbar_type=0'])).toHaveLength(1)
    const { text, warnings } = sanitizeProfile('mage="Bob"\nprogressbar_type=0\n')
    expect(text).not.toMatch(/^progressbar_type=/m)
    expect(warnings).toHaveLength(1)
  })

  it('puts the advanced options after the UI settings, so the user wins there', () => {
    const a = args(fixed, ['max_time=120'])
    expect(a.indexOf('max_time=120')).toBeGreaterThan(a.indexOf('max_time=300'))
  })
})

describe('thread clamping', () => {
  it('never asks for more threads than the engine pool allows', () => {
    expect(buildArgs({ settings: { ...settings, threads: 999 }, accuracy: fixed, maxThreads: 8 })).toContain(
      'threads=8',
    )
  })

  it('never asks for zero or fractional threads', () => {
    expect(clampThreads(0, 16)).toBe(1)
    expect(clampThreads(4.9, 16)).toBe(4)
    expect(clampThreads(Number.NaN, 16)).toBe(1)
  })
})

describe('raw script mode', () => {
  const raw = (accuracy: Accuracy, extraOptions?: string[]) =>
    buildArgs({ settings, accuracy, extraOptions, maxThreads: 16, mode: 'raw' })

  it('states no simulation settings, so the script owns them', () => {
    const a = raw(fixed)
    expect(a.some((x) => x.startsWith('fight_style='))).toBe(false)
    expect(a.some((x) => x.startsWith('max_time='))).toBe(false)
    expect(a.some((x) => x.startsWith('desired_targets='))).toBe(false)
  })

  it('still protects the infrastructure options', () => {
    const a = raw({ mode: 'script' })
    expect(a).toContain('threads=4')
    expect(a.at(-1)).toBe('json=/out.json,version=2')
  })

  it('says nothing about stopping when the script decides', () => {
    const a = raw({ mode: 'script' })
    expect(a.some((x) => x.startsWith('iterations='))).toBe(false)
    expect(a.some((x) => x.startsWith('target_error='))).toBe(false)
  })

  it('still lets the run settings override the script when one is chosen', () => {
    expect(raw(fixed)).toContain('iterations=1000')
    expect(raw(fixed)).toContain('target_error=0')
  })

  it('keeps the script own stopping options in place rather than rewriting them', () => {
    const script = 'mage="Bob"\ntarget_error=0.05\niterations=50\nthreads=64\n'
    const { text, warnings } = sanitizeProfile(script, 'raw')
    expect(text).toMatch(/^target_error=0.05$/m)
    expect(text).toMatch(/^iterations=50$/m)
    // Infrastructure is protected in both modes.
    expect(text).not.toMatch(/^threads=64$/m)
    expect(warnings.filter((w) => w.includes('kept'))).toHaveLength(2)
    expect(warnings.some((w) => w.includes('application controls'))).toBe(true)
  })

  it('rejects the script accuracy mode outside a raw run', () => {
    expect(validateSettings(settings, { mode: 'script' }, 16, 'guided')).toHaveLength(1)
    expect(validateSettings(settings, { mode: 'script' }, 16, 'raw')).toEqual([])
  })

  it('does not police settings it no longer states', () => {
    const nonsense = { ...settings, fightStyle: 'Nonsense' as never, maxTime: -1, targets: 0 }
    expect(validateSettings(nonsense, { mode: 'script' }, 16, 'raw')).toEqual([])
    // ...but the thread count is infrastructure and still has to be sane.
    expect(validateSettings({ ...nonsense, threads: 0 }, { mode: 'script' }, 16, 'raw')).toHaveLength(1)
  })
})

describe('sanitizeProfile', () => {
  it('neutralises options the application owns and says which', () => {
    const { text, warnings } = sanitizeProfile('mage="Bob"\nthreads=64\nhtml=/evil.html\nlevel=80')
    expect(text).not.toMatch(/^threads=64$/m)
    expect(text).not.toMatch(/^html=/m)
    expect(text).toMatch(/^mage="Bob"$/m)
    expect(text).toMatch(/^level=80$/m)
    expect(warnings).toHaveLength(2)
    // Warnings report which line.
    expect(warnings[0]).toMatch(/Line 2.*threads/)
  })

  it('neutralises inherited stopping options so a fixed run stays fixed', () => {
    const { text, warnings } = sanitizeProfile('target_error=0.05\niterations=50\n')
    expect(text).not.toMatch(/^target_error=/m)
    expect(text).not.toMatch(/^iterations=/m)
    expect(warnings).toHaveLength(2)
  })

  it('leaves comments and APL lines alone', () => {
    const apl = '# threads=8 in a comment\nactions+=/frostbolt\nactions.aoe=/blizzard'
    expect(sanitizeProfile(apl).warnings).toEqual([])
    expect(sanitizeProfile(apl).text).toBe(apl)
  })

  it('warns about an item line that would silently equip nothing', () => {
    // Hand-edited export or Advanced script; unguarded route (neither through profileset/extraOptions).
    const { text, warnings } = sanitizeProfile('mage="Bob"\nfinger1=id=251136,bonus_id=1\n')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^Line 2: .*reads as the item's NAME/)
    // Warned never rewritten: no correct name to invent.
    expect(text).toMatch(/^finger1=id=251136,bonus_id=1$/m)
  })

  it('warns in raw mode too, where the script owns everything else', () => {
    expect(sanitizeProfile('trinket2=id=270168\n', 'raw').warnings).toHaveLength(1)
  })

  it('says nothing about a well-formed item line', () => {
    expect(sanitizeProfile('finger1=signet,id=251136\noff_hand=\n').warnings).toEqual([])
  })

  it('keeps line numbers usable by preserving line count', () => {
    const input = 'a=1\njson=/x.json\nb=2'
    expect(sanitizeProfile(input).text.split('\n')).toHaveLength(3)
  })
})

describe('profilesetLines', () => {
  it('emits one appending assignment per option line, quoting the id', () => {
    expect(profilesetLines([{ id: 'c-0001', lines: ['talents=AB', 'gear_crit_rating=100'] }])).toEqual([
      'profileset."c-0001"+=talents=AB',
      'profileset."c-0001"+=gear_crit_rating=100',
    ])
  })
})

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(settings, fixed, 16)).toEqual([])
  })

  it('rejects NaN, infinity and fractions where integers are required', () => {
    const bad = validateSettings({ ...settings, targets: 1.5, maxTime: Number.NaN }, fixed, 16)
    expect(bad.map((i) => i.field).sort()).toEqual(['maxTime', 'targets'])
    expect(validateSettings({ ...settings, maxTime: Infinity }, fixed, 16)).toHaveLength(1)
  })

  it('rejects nonsense thread counts but not ones merely above this artifact ceiling', () => {
    // Pool ceiling belongs to binary: saved 16-thread on fallback clamped/reported not refused.
    expect(validateSettings({ ...settings, threads: 32 }, fixed, 16)).toEqual([])
    expect(validateSettings({ ...settings, threads: 4 }, fixed, 1)).toEqual([])
    expect(validateSettings({ ...settings, threads: 0 }, fixed, 16)).toHaveLength(1)
    expect(validateSettings({ ...settings, threads: 2.5 }, fixed, 16)).toHaveLength(1)
    expect(validateSettings({ ...settings, threads: LIMITS.threads + 1 }, fixed, 16)).toHaveLength(1)
  })

  it('rejects an unsupported fight style', () => {
    expect(validateSettings({ ...settings, fightStyle: 'Nonsense' as never }, fixed, 16)).toHaveLength(1)
  })

  it('bounds the workload controls', () => {
    expect(validateSettings({ ...settings, maxTime: 0 }, fixed, 16)).toHaveLength(1)
    expect(validateSettings(settings, { mode: 'iterations', iterations: LIMITS.iterations + 1 }, 16)).toHaveLength(1)
    expect(validateSettings(settings, { mode: 'targetError', targetError: 0, maxIterations: 10 }, 16)).toHaveLength(1)
    expect(validateSettings(settings, { mode: 'targetError', targetError: 100, maxIterations: 10 }, 16)).toHaveLength(1)
  })

  it('rejects an unknown accuracy mode', () => {
    expect(validateSettings(settings, { mode: 'guess' } as never, 16)).toHaveLength(1)
  })

  it('refuses an iteration budget that cannot outrun the discarded first iterations', () => {
    // samples = iterations - threads; 10 on 16 threads collects nothing.
    const bad = validateSettings({ ...settings, threads: 16 }, { mode: 'iterations', iterations: 10 }, 16)
    expect(bad).toHaveLength(1)
    expect(bad[0].message).toMatch(/collects no samples/)

    expect(validateSettings({ ...settings, threads: 4 }, { mode: 'iterations', iterations: 4 }, 16)).toHaveLength(1)
    expect(validateSettings({ ...settings, threads: 4 }, { mode: 'iterations', iterations: 5 }, 16)).toEqual([])
  })

  it('measures that rule against the clamped thread count, not the requested one', () => {
    // 4 requested on single-threaded runs 1: 2 iterations fine; not on threaded build.
    expect(validateSettings({ ...settings, threads: 4 }, { mode: 'iterations', iterations: 2 }, 1)).toEqual([])
    expect(validateSettings({ ...settings, threads: 4 }, { mode: 'iterations', iterations: 2 }, 16)).toHaveLength(1)
  })

  it('applies the same rule to the ceiling of a target-accuracy run', () => {
    expect(
      validateSettings({ ...settings, threads: 8 }, { mode: 'targetError', targetError: 0.5, maxIterations: 8 }, 16),
    ).toHaveLength(1)
  })
})

describe('maxUsefulThreads', () => {
  it('leaves at least one collected sample', () => {
    expect(maxUsefulThreads(10, 16)).toBe(9)
    expect(maxUsefulThreads(10000, 16)).toBe(16)
    expect(maxUsefulThreads(1, 16)).toBe(1)
    expect(maxUsefulThreads(0, 16)).toBe(1)
  })
})

describe('validateProfile', () => {
  it('rejects empty, non-string and oversized profiles', () => {
    expect(validateProfile('')).toHaveLength(1)
    expect(validateProfile('   \n ')).toHaveLength(1)
    expect(validateProfile(42 as never)).toHaveLength(1)
    expect(validateProfile('x'.repeat(LIMITS.profileBytes + 1))).toHaveLength(1)
    expect(validateProfile('mage="Bob"')).toEqual([])
  })
})

describe('validateProfilesets', () => {
  it('accepts opaque ids and rejects ones that would break the option parser', () => {
    expect(validateProfilesets([{ id: 'c-0001', lines: ['talents=AB'] }])).toEqual([])
    expect(validateProfilesets([{ id: 'a"b', lines: ['x=1'] }])).toHaveLength(1)
    expect(validateProfilesets([{ id: 'a=b', lines: ['x=1'] }])).toHaveLength(1)
    expect(validateProfilesets([{ id: 'a b', lines: ['x=1'] }])).toHaveLength(1)
  })

  it('rejects duplicate ids, which simc would silently merge', () => {
    const dup = validateProfilesets([
      { id: 'c-1', lines: ['x=1'] },
      { id: 'c-1', lines: ['x=2'] },
    ])
    expect(dup).toHaveLength(1)
    expect(dup[0].message).toMatch(/duplicate/)
  })

  it('rejects empty and multi-line option lines', () => {
    expect(validateProfilesets([{ id: 'c-1', lines: [] }])).toHaveLength(1)
    expect(validateProfilesets([{ id: 'c-1', lines: ['a=1\nb=2'] }])).toHaveLength(1)
  })

  it('treats absent profilesets as fine', () => {
    expect(validateProfilesets(undefined)).toEqual([])
  })
})

describe('item lines missing their name token', () => {
  // item.cpp:831-837 takes everything before the first comma as the item NAME,
  // so a line that starts with an option silently equips nothing. Measured at
  // 7-9% DPS on a real profile, with no error and no warning from the engine.
  it('catches a slot line whose first field is an option', () => {
    expect(itemLineProblem('finger1=id=251136,bonus_id=1,ilevel=680')).toMatch(/reads as the item's NAME/)
    expect(itemLineProblem('trinket2=id=270168')).toMatch(/NAME/)
  })

  it('accepts a line with any name token, because the value does not matter', () => {
    expect(itemLineProblem('finger1=signet_of_snarling_servitude,id=251136,bonus_id=1')).toBeNull()
    expect(itemLineProblem('finger1=item_251136,id=251136')).toBeNull()
    // Emptying slot is valid.
    expect(itemLineProblem('off_hand=')).toBeNull()
  })

  it('leaves non-slot options alone', () => {
    expect(itemLineProblem('talents=ABC,DEF')).toBeNull()
    expect(itemLineProblem('actions+=/frostbolt,if=x=1')).toBeNull()
    expect(itemLineProblem('max_time=300')).toBeNull()
  })

  it('uses the plural upstream slot names', () => {
    // Plural forms upstream (shoulders not shoulder).
    expect(ITEM_SLOTS).toContain('shoulders')
    expect(ITEM_SLOTS).toContain('wrists')
    expect(ITEM_SLOTS).not.toContain('shoulder')
    expect(itemLineProblem('shoulders=id=1,x=2')).toMatch(/NAME/)
  })

  it('rejects such a line at the boundary in both places it can arrive', () => {
    expect(validateExtraOptions(['finger1=id=251136,bonus_id=1'])).toHaveLength(1)
    expect(validateProfilesets([{ id: 'c-1', lines: ['trinket1=id=1,ilevel=2'] }])).toHaveLength(1)
    expect(validateProfilesets([{ id: 'c-1', lines: ['trinket1=some_name,id=1'] }])).toEqual([])
  })

  it('explains why a lineless candidate is refused', () => {
    const issues = validateProfilesets([{ id: 'baseline', lines: [] }])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/never created/)
  })
})

describe('validateExtraOptions', () => {
  it('refuses application-owned options in advanced text', () => {
    expect(validateExtraOptions(['threads=8'])).toHaveLength(1)
    expect(validateExtraOptions(['json=/out.json'])).toHaveLength(1)
    expect(validateExtraOptions(['max_time=120'])).toEqual([])
  })

  it('refuses multi-line and oversized entries', () => {
    expect(validateExtraOptions(['a=1\nb=2'])).toHaveLength(1)
    expect(validateExtraOptions(['x'.repeat(LIMITS.optionLineChars + 1)])).toHaveLength(1)
  })
})

describe('expert mode slots', () => {
  // The generated list is the whole point: a hand-written copy would go stale
  // the first time upstream adds an option, and a stale scope list produces a
  // silently ignored line rather than an error. Skipped when the upstream
  // checkout is absent, since the source is gitignored.
  it.skipIf(playerCppGate)(
    'has a generated actor-option list that still matches upstream' + playerCppGate,
    () => {
      const run = spawnSync(process.execPath, ['scripts/gen-actor-options.mjs', '--check'], {
        encoding: 'utf8',
      })
      expect(run.stderr + run.stdout).toContain('up to date')
      expect(run.status).toBe(0)
    },
  )

  it('knows an actor-scoped option from the generated upstream list', () => {
    expect(isActorScoped('talents=ABC')).toBe(true)
    expect(isActorScoped('trinket1=,id=1')).toBe(true)
    expect(isActorScoped('race=orc')).toBe(true)
    expect(isActorScoped('actions.precombat=/flask')).toBe(true)
    // Sim scope and dual-scope options never flagged.
    expect(isActorScoped('max_time=300')).toBe(false)
    expect(isActorScoped('fight_style=Patchwerk')).toBe(false)
    expect(isActorScoped('# a comment')).toBe(false)
  })

  it('flags an actor line in a slot that has no actor yet', () => {
    expect(slotScopeProblem('header', 'trinket1=,id=1')).toContain('ignore')
    expect(slotScopeProblem('preActor', 'talents=ABC')).toContain('postActor')
    expect(slotScopeProblem('postActor', 'talents=ABC')).toBeNull()
  })

  it('flags an actor line in the footer, where the enemy may be current', () => {
    expect(slotScopeProblem('footer', 'trinket1=,id=1')).toContain('ENEMY')
    expect(slotScopeProblem('footer', 'max_time=120')).toBeNull()
  })

  it('reports every problem with its slot and line number, and corrects nothing', () => {
    const slots = { header: 'max_time=120\ntalents=ABC', postActor: 'race=orc' }
    expect(slotProblems(slots)).toEqual([
      expect.stringContaining('header line 2'),
    ])
    // The input is untouched: reporting is not relocating.
    expect(slots.header).toBe('max_time=120\ntalents=ABC')
  })

  it('refuses a protected option in a slot but never a scope mistake', () => {
    expect(validateSlots({ header: 'threads=32' })).toHaveLength(1)
    expect(validateSlots({ header: 'talents=ABC' })).toEqual([])
    expect(validateSlots({ header: 42 })).toHaveLength(1)
    expect(validateSlots(undefined)).toEqual([])
  })
})

describe('html report option', () => {
  const input = {
    settings: DEFAULT_SETTINGS,
    accuracy: { mode: 'iterations', iterations: 100 } as const,
    maxThreads: 16,
  }

  it('is off unless asked for', () => {
    expect(buildArgs(input).some((a) => a.startsWith('html='))).toBe(false)
  })

  it('writes to the application-owned path, after the json report', () => {
    const args = buildArgs({ ...input, htmlReport: true })
    expect(args).toContain(`html=${HTML_REPORT_PATH}`)
    // print_suite writes JSON before HTML so failing HTML doesn't cost run numbers; keep order readable.
    expect(args.indexOf(`html=${HTML_REPORT_PATH}`)).toBeGreaterThan(
      args.findIndex((a) => a.startsWith('json=')),
    )
  })

  it('never lets user input choose where the engine writes', () => {
    expect(validateExtraOptions(['html=/anywhere.html'])).toHaveLength(1)
  })
})

describe('withPlayerScopedLines', () => {
  // The engine's own behaviour is covered by fallback-compare.engine.test.ts;
  // this covers the ordering rule that behaviour forced.
  const preset = ['enemy=Fluffy_Pillow', 'enemy_fixed_health_percentage=100']

  it('puts candidate lines ahead of an enemy declaration', () => {
    expect(withPlayerScopedLines(preset, ['trinket1=,id=270164'])).toEqual([
      'trinket1=,id=270164',
      ...preset,
    ])
  })

  it('appends when nothing changes actor scope', () => {
    expect(withPlayerScopedLines(['max_time=300'], ['talents=AAA'])).toEqual([
      'max_time=300',
      'talents=AAA',
    ])
  })

  it('keeps base lines before the break ahead of the candidate, so the candidate wins a collision', () => {
    expect(withPlayerScopedLines(['trinket1=,id=1', ...preset], ['trinket1=,id=2'])).toEqual([
      'trinket1=,id=1',
      'trinket1=,id=2',
      ...preset,
    ])
  })

  it('recognises every actor-declaring option and nothing else', () => {
    for (const name of ACTOR_DECLARING_OPTIONS) expect(declaresActor(`${name}=X`)).toBe(true)
    expect(declaresActor('trinket1=,id=1')).toBe(false)
    expect(declaresActor('enemy_fixed_health_percentage=100')).toBe(false)
  })

  it('leaves the base alone when there is nothing to splice', () => {
    expect(withPlayerScopedLines(preset, [])).toEqual(preset)
  })
})
