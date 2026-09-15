// F21: candidate line must reach profile, not argument list. Defect was silently wrong answer (ignored line, returned baseline for all). Runs real adapter path on FALLBACK artifact with each candidate checked against hand-written script. Deterministic=1 makes comparison exact. Opt-in: FROSTSIM_ENGINE=1 npx vitest run ...

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { Worker as NodeWorker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { applyWeeklyDefaults } from './weekly-defaults'
import { runComparison } from './compare'
import { runJob, __resetEngineRuntimeForTests, type SimRequest } from './job'
import { buildArgs, DEFAULT_SETTINGS, sanitizeProfile, withPlayerScopedLines } from './options'
import type { EngineCapability, EngineManifest } from './capability'

const CLI = 'build/wasm-fallback/simc-node.cjs'
const PROFILE = 'tests/fixtures/addon-export-demonology.simc'
const enabled = process.env.FROSTSIM_ENGINE === '1' && existsSync(CLI)

// Two real candidates from character's own export, one in each scope defect dropped: talent hash (addon "ST" loadout) and gear line (trinket swap). Both meaningless as sim arguments and both change number.
const CANDIDATES = [
  {
    id: 'talent-st',
    lines: [
      'talents=CoQAMrNP5kak+EBqLfUa3dMm+yMzMzwsxwMzYWGAAAAAAAwYGDLwAbDLYYxYMzysMzMjZAgZGzMzMzAYmxMDAAwYmZmZYwMGwA',
    ],
  },
  { id: 'gear-trinket1', lines: ['trinket1=,id=270164'] },
]

const manifest: EngineManifest = {
  schemaVersion: 1,
  artifact: 'fallback',
  engine: { simcVersion: 'local', upstreamCommit: 'local' },
  wow: { clientDataVersion: 'local' },
  capabilities: {
    threads: false,
    pthreadPoolSize: 0,
    maxThreads: 1,
    profilesets: false,
    networking: false,
    reportVersions: [2],
  },
}

const capability: EngineCapability = {
  ok: true,
  artifact: 'fallback',
  engineDir: '/engine/fallback/',
  maxThreads: 1,
  profilesets: false,
  manifest,
}

const settings = { ...DEFAULT_SETTINGS, threads: 1 }
const accuracy = { mode: 'iterations', iterations: 30 } as const
const extraOptions = ['deterministic=1']

const base: SimRequest = {
  schemaVersion: 1,
  profile: readFileSync(PROFILE, 'utf8'),
  settings,
  accuracy,
  extraOptions,
}

const workerPath = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))

class WorkerAdapter {
  private readonly inner: NodeWorker
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null

  constructor(file: string, workerData?: unknown) {
    this.inner = new NodeWorker(workerPath(file), { workerData })
    this.inner.on('message', (data) => this.onmessage?.({ data }))
    this.inner.on('error', (err: Error) => this.onerror?.({ message: err.message }))
    this.inner.unref()
  }
  postMessage(data: unknown, transfer?: Transferable[]): void {
    this.inner.postMessage(data, transfer as never)
  }
  terminate(): void {
    void this.inner.terminate()
  }
}

/**
 * The comparison the user could have run by hand: one profile with `appended`
 * pasted on the end, no adapter involved.
 *
 * The argv comes from `buildArgs` with the same settings because argument
 * construction is not what is under test here — line placement is.
 */
function runDirectWith(appended: readonly string[]): number {
  const dir = mkdtempSync(join(tmpdir(), 'frostsim-direct-'))
  const profileFile = join(dir, 'profile.simc')
  const reportFile = join(dir, 'out.json')
  // Compare the same guided inputs; otherwise this tests different potions.
  const text = applyWeeklyDefaults(sanitizeProfile(base.profile, 'guided').text)
  writeFileSync(profileFile, appended.length ? `${text}\n${appended.join('\n')}\n` : text)

  const built = buildArgs({ settings, accuracy, extraOptions, maxThreads: 1, mode: 'guided' })
  const argv = built.map((a) =>
    a === built[0] ? profileFile : a.startsWith('json=') ? `json=${reportFile},version=2` : a,
  )

  execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(readFileSync(reportFile, 'utf8')).sim.players[0].collected_data.dps.mean
}

const runDirect = (candidateLine: string | null) =>
  runDirectWith(candidateLine ? [candidateLine] : [])

describe.skipIf(!enabled)('fallback comparison against the real engine', () => {
  it('gives every candidate the number its own script gives, and they differ', async () => {
    __resetEngineRuntimeForTests()

    const handle = runComparison(base, CANDIDATES, undefined, {
      capability,
      threadReapGraceMs: 0,
      createEngineWorker: () =>
        new WorkerAdapter('engine-cli.mjs', {
          variant: 'fallback',
          cwd: process.cwd(),
        }) as unknown as Worker,
      createReportWorker: () => new WorkerAdapter('report-stub.mjs') as unknown as Worker,
    })
    const outcome = await handle.result

    // Fallback has no profilesets, so must be sequential path; if profilesets reported here, rest proves nothing.
    expect(outcome.strategy).toBe('sequential')
    expect(outcome.candidates.map((c) => c.status)).toEqual(['complete', 'complete'])

    const byId = new Map(outcome.candidates.map((c) => [c.id, c.mean!]))
    const baseline = runDirect(null)

    for (const candidate of CANDIDATES) {
      const direct = runDirect(candidate.lines[0])
      // Exact: deterministic=1, same iterations, same seed; tolerance would hide defect since broken path also lands "close" (exactly on baseline).
      expect(byId.get(candidate.id)).toBe(direct)
      expect(direct).not.toBe(baseline)
    }

    // Two candidates distinguishable from each other: the claim comparison makes.
    expect(byId.get('talent-st')).not.toBe(byId.get('gear-trinket1'))

    // P06.10: no HTML unless run asked for one.
    expect(outcome.outcomes[0].getHtmlReport()).toBeNull()

    // Negative control showing test can see wrong answer; candidate line as sim ARGUMENT is not ignored (sim_t::parse_option offers to active_player first). An earlier claim that such arguments are dropped was wrong.
    const enemyBase = ['enemy=Fluffy_Pillow', 'enemy_fixed_health_percentage=100']
    for (const candidate of CANDIDATES) {
      // After enemy block: line equips target dummy, player unchanged (preset-based comparison).
      expect(runDirectWith([...enemyBase, ...candidate.lines])).toBe(
        runDirectWith(enemyBase),
      )
      // Ahead of it: where adapter now puts it.
      expect(runDirectWith(withPlayerScopedLines(enemyBase, candidate.lines))).not.toBe(
        runDirectWith(enemyBase),
      )
    }
  }, 600_000)

  // P07.9: character's saved loadouts and real bag replacements, each checked against individual engine run. Talent hashes from addon, trinkets from mid2-raid-gear.json; nothing invented.
  it('matches individual engine runs across four saved loadouts and three bag replacements', async () => {
    __resetEngineRuntimeForTests()

    const set = [
      { id: 'loadout-m+', lines: ['talents=CoQAMrNP5kak+EBqLfUa3dMm+yMMzMmNzMbzMjZZAAAAAAAYbZGzMDLGGmZbYBzYxYmxysNzMjZAgZGjZmZGMzMmxM2AAAjZmZMMsMjBMA'] },
      { id: 'loadout-raiderio', lines: ['talents=CoQAMrNP5kak+EBqLfUa3dMm+yMmZGmNmZbmZMLDAAAAAAAYMjhFYgthFMsYMzYZ2mZmxMAwMjZmxMDwYGzYDAAMmZmxwwyMGwA'] },
      { id: 'loadout-st', lines: ['talents=CoQAMrNP5kak+EBqLfUa3dMm+yMzMzwsxwMzYWGAAAAAAAwYGDLwAbDLYYxYMzysMzMjZAgZGzMzMzAYmxMDAAwYmZmZYwMGwA'] },
      { id: 'loadout-siz', lines: ['talents=CoQAMrNP5kak+EBqLfUa3dMm+yMzMzwsxwMzYWGAAAAAAAwYGDLwAbDLYYxYmxysMzMjZAgZGzMjZGAzMmZAAAGzMzMDDLzYAD'] },
      { id: 'bag-voracious_heart', lines: ['trinket1=voracious_heart_of_ulatek,id=270175,ilevel=344'] },
      { id: 'bag-guillotine', lines: ['trinket1=zuljins_guillotine_technique,id=270173,ilevel=344'] },
      { id: 'bag-font_of_venom', lines: ['trinket1=font_of_venomous_rage,id=270168,ilevel=344'] },
    ]

    const handle = runComparison(base, set, undefined, {
      capability,
      threadReapGraceMs: 0,
      createEngineWorker: () =>
        new WorkerAdapter('engine-cli.mjs', { variant: 'fallback', cwd: process.cwd() }) as unknown as Worker,
      createReportWorker: () => new WorkerAdapter('report-stub.mjs') as unknown as Worker,
    })
    const outcome = await handle.result

    expect(outcome.candidates).toHaveLength(set.length)
    expect(outcome.candidates.every((c) => c.status === 'complete')).toBe(true)

    const byId = new Map(outcome.candidates.map((c) => [c.id, c.mean!]))
    for (const candidate of set) {
      expect(byId.get(candidate.id)).toBe(runDirectWith(candidate.lines))
    }

    // Every candidate produced its own number; identical means across different candidates is signature of unapplied line (F21/F23).
    expect(new Set(byId.values()).size).toBe(set.length)

    // Ranking by mean, highest first; IDs survive it (P07.2: stable independent of labels/order).
    const means = outcome.candidates.map((c) => c.mean!)
    expect([...means].sort((a, b) => b - a)).toEqual(means)
    expect(new Set(outcome.candidates.map((c) => c.id)).size).toBe(set.length)
  }, 900_000)

  // P10.3: slot semantics the UI states, checked against engine. If numbers don't match Expert Mode copy, copy teaches wrong model.
  it('gives each injection slot the scope its name claims', async () => {
    const preset = ['enemy=Fluffy_Pillow', 'enemy_fixed_health_percentage=100']
    const gear = 'trinket1=,id=270164'

    const run = async (slots: Record<string, string>) => {
      __resetEngineRuntimeForTests()
      const handle = runJob({ ...base, extraProfileLines: preset, slots }, undefined, {
        capability,
        threadReapGraceMs: 0,
        createEngineWorker: () =>
          new WorkerAdapter('engine-cli.mjs', { variant: 'fallback', cwd: process.cwd() }) as unknown as Worker,
        createReportWorker: () => new WorkerAdapter('report-stub.mjs') as unknown as Worker,
      })
      return handle.result
    }

    const none = await run({})
    const post = await run({ postActor: gear })
    const foot = await run({ footer: gear })
    const head = await run({ header: gear })

    // postActor only slot that reaches the character.
    expect(post.report.players[0].dps.mean).not.toBe(none.report.players[0].dps.mean)
    // footer after preset's enemy, so gear went on dummy.
    expect(foot.report.players[0].dps.mean).toBe(none.report.players[0].dps.mean)
    // header has no actor, so nothing claims line.
    expect(head.report.players[0].dps.mean).toBe(none.report.players[0].dps.mean)

    // Two mistakes visible not silent; engine says so for header, app before run for both.
    expect(head.engineNotices.some((n) => n.kind === 'problem' && /Unknown option/.test(n.message))).toBe(true)
    expect(foot.inputWarnings.some((w) => w.includes('footer line 1'))).toBe(true)
    expect(head.inputWarnings.some((w) => w.includes('header line 1'))).toBe(true)
    expect(post.inputWarnings.some((w) => w.includes('postActor'))).toBe(false)

    // The effective profile is the real thing, in engine order.
    expect(post.effectiveProfile).toContain(gear)
    expect(post.effectiveProfile.indexOf(gear)).toBeLessThan(
      post.effectiveProfile.indexOf('enemy=Fluffy_Pillow'),
    )
    expect(foot.effectiveProfile.indexOf(gear)).toBeGreaterThan(
      foot.effectiveProfile.indexOf('enemy=Fluffy_Pillow'),
    )
  }, 900_000)

  // P10.11: raw script that declares no character; engine exits 0 with no report, only signal is missing file.
  it('says what is wrong with a script that declares no actor', async () => {
    __resetEngineRuntimeForTests()

    const handle = runJob(
      {
        ...base,
        // Raw: script entirely user's, mode where this reaches person not caught by validation.
        mode: 'raw',
        accuracy: { mode: 'script' },
        profile: 'max_time=60\niterations=10\n',
      },
      undefined,
      {
        capability,
        threadReapGraceMs: 0,
        createEngineWorker: () =>
          new WorkerAdapter('engine-cli.mjs', { variant: 'fallback', cwd: process.cwd() }) as unknown as Worker,
        createReportWorker: () => new WorkerAdapter('report-stub.mjs') as unknown as Worker,
      },
    )

    await expect(handle.result).rejects.toMatchObject({
      name: 'SimEngineError',
      code: 'no-actor',
    })
    await handle.result.catch((err: Error) => {
      expect(err.message).toContain('declared no character')
      // Not raw filesystem complaint, which is true and useless.
      expect(err.message).not.toContain('/out.json')
    })
  }, 600_000)

  // P06.10: against real engine not stub that echoes string.
  it('returns simc’s own HTML report when the run asks for one', async () => {
    __resetEngineRuntimeForTests()

    const handle = runJob({ ...base, htmlReport: true }, undefined, {
      capability,
      threadReapGraceMs: 0,
      createEngineWorker: () =>
        new WorkerAdapter('engine-cli.mjs', { variant: 'fallback', cwd: process.cwd() }) as unknown as Worker,
      createReportWorker: () => new WorkerAdapter('report-stub.mjs') as unknown as Worker,
    })
    const outcome = await handle.result

    const blob = outcome.getHtmlReport()
    expect(blob).not.toBeNull()
    expect(blob!.type).toBe('text/html')
    const text = await blob!.text()
    expect(text.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(text).toContain('Simulationcraft Results')
    // Numbers unaffected by asking for second document.
    expect(outcome.report.players[0].dps.mean).toBe(runDirectWith([]))
  }, 600_000)
})
