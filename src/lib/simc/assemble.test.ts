// Pure run assembly (CLAUDE.md D14): the profile/args/warnings the browser and the account server both hand to the engine.

import { describe, expect, it } from 'vitest'
import { assembleRun, validateRequest, type SimRequest } from './assemble'
import { DEFAULT_SETTINGS } from './options'

function request(over: Partial<SimRequest> = {}): SimRequest {
  return {
    schemaVersion: 1,
    profile: 'warlock=Fixture\nlevel=90\nspec=demonology\n',
    settings: { ...DEFAULT_SETTINGS, fightStyle: 'Patchwerk', maxTime: 300, targets: 1, threads: 4 },
    accuracy: { mode: 'iterations', iterations: 1000 },
    ...over,
  }
}

describe('assembleRun', () => {
  it('guided: weekly defaults on the player, engine args from settings, fixed infrastructure paths', () => {
    const run = assembleRun(request(), 16)
    expect(run.profile).toContain('warlock=Fixture\npotion=potion_of_recklessness_2\nlevel=90')
    expect(run.profile.endsWith('\n')).toBe(true)
    expect(run.args).toEqual([
      '/profile.simc',
      'fight_style=Patchwerk', 'max_time=300', 'desired_targets=1',
      'single_actor_batch=1', 'optimize_expressions=1',
      'iterations=1000', 'target_error=0',
      'threads=4', 'progressbar_type=1', 'json=/out.json,version=2',
    ])
    expect(run.warnings).toEqual([])
    expect(run.threads).toBe(4)
  })

  it('raw: leaves the script alone and adds no guided settings', () => {
    const run = assembleRun(request({ mode: 'raw' }), 16)
    expect(run.profile).not.toContain('potion=')
    expect(run.args).not.toContain('fight_style=Patchwerk')
    expect(run.args.at(-1)).toBe('json=/out.json,version=2')
  })

  it('clamps threads to the caller ceiling and warns before the sanitize warnings', () => {
    const run = assembleRun(request({ profile: 'mage="Bob"\nthreads=64\n', settings: { ...DEFAULT_SETTINGS, threads: 32 } }), 16)
    expect(run.threads).toBe(16)
    expect(run.args).toContain('threads=16')
    expect(run.warnings[0]).toBe('Running on 16 threads instead of 32: this engine build allows at most 16.')
    expect(run.warnings[1]).toContain('"threads="')
    expect(run.profile).not.toMatch(/^threads=64$/m)
  })

  it('assembles slots in engine order and appends slot warnings last', () => {
    const run = assembleRun(request({
      mode: 'raw',
      profile: 'mage="Bob"\nthreads=2\n',
      slots: { header: 'head=,id=1', preActor: '# pre', postActor: 'potion=x', footer: 'enemy=Boss' },
      extraProfileLines: ['enemy=Target'],
      settings: { ...DEFAULT_SETTINGS, threads: 8 },
    }), 4)
    expect(run.profile.split('\n').slice(0, 3)).toEqual(['head=,id=1', '# pre', 'mage="Bob"'])
    expect(run.profile).not.toMatch(/^threads=2$/m)
    expect(run.profile.indexOf('potion=x')).toBeLessThan(run.profile.indexOf('enemy=Target'))
    expect(run.profile.indexOf('enemy=Target')).toBeLessThan(run.profile.indexOf('enemy=Boss'))
    expect(run.warnings.map((w) => w.split(':')[0])).toEqual(['Running on 4 threads instead of 8', 'Line 2', 'header line 1'])
  })

  it('puts profileset lines after preset lines and before the footer', () => {
    const run = assembleRun(request({
      extraProfileLines: ['enemy=Fluffy_Pillow'],
      profilesets: [{ id: 'alt', lines: ['potion=liquid_luster_2'] }],
      slots: { footer: '# end' },
    }), 16)
    const text = run.profile
    expect(text.indexOf('enemy=Fluffy_Pillow')).toBeLessThan(text.indexOf('profileset."alt"+=potion=liquid_luster_2'))
    expect(text.trimEnd().endsWith('# end')).toBe(true)
  })

  it('adds the html report path only when asked', () => {
    expect(assembleRun(request({ htmlReport: true }), 16).args.at(-1)).toBe('html=/out.html')
  })
})

describe('validateRequest', () => {
  it('refuses a wrong schema and a Dungeon Route without a first pull', () => {
    expect(validateRequest({ ...request(), schemaVersion: 2 as 1 }, 16)[0].field).toBe('schemaVersion')
    const route = request({ settings: { ...DEFAULT_SETTINGS, fightStyle: 'DungeonRoute', threads: 4 } })
    expect(validateRequest(route, 16).map((i) => i.field)).toContain('fightStyle')
    expect(validateRequest(request(), 16)).toEqual([])
  })
})
