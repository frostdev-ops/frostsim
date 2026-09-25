// Dungeon Route compares by role: route health per role, the split, and the engine that runs the groups one after another.

import { describe, expect, it } from 'vitest'
import { WORKER_PROTOCOL, type SimRequest } from './job'
import { roleGroups, roleNote, roleOf, scaleRouteHealth } from './role-share'
import { SequenceWorker } from './sequence-worker'

const ROUTE = ['enemy=frostsim_route_target', 'raid_events+=/pull,pull=1,delay=0,enemies=Mob_A:1000000|BOSS_Big:2700000:humanoid:2,bloodlust=1']
const request = (profile: string, fightStyle = 'DungeonRoute'): SimRequest => ({
  schemaVersion: 1, profile, extraProfileLines: ROUTE,
  settings: { fightStyle, maxTime: 2700, targets: 1, threads: 4 },
  accuracy: { mode: 'iterations', iterations: 100 },
} as unknown as SimRequest)
const mage = 'mage="Ann"\nspec=frost\nlevel=90'
const rogue = 'rogue="Bo"\nspec=outlaw'
const tank = 'paladin="Cy"\nspec=protection'
const healer = 'priest="Di"\nspec=discipline'

describe('role shares', () => {
  it('reads each role from the class line and spec', () => {
    expect([mage, rogue, tank, healer, 'demonhunter="E"\nspec=vengeance', 'evoker="F"\nspec=augmentation'].map(roleOf))
      .toEqual(['dps', 'dps', 'tank', 'heal', 'tank', 'dps'])
  })

  it('scales every enemy on route lines only, keeping race and count', () => {
    expect(scaleRouteHealth(ROUTE, 14 / 27)).toEqual([
      'enemy=frostsim_route_target',
      'raid_events+=/pull,pull=1,delay=0,enemies=Mob_A:518519|BOSS_Big:1400000:humanoid:2,bloodlust=1',
    ])
  })

  it('leaves an all-damage-dealer compare, a single character and other fights alone', () => {
    expect(roleGroups(request(`${mage}\n${rogue}`))).toBeNull()
    expect(roleGroups(request(tank))).toBeNull()
    expect(roleGroups(request(`${mage}\n${tank}`, 'Patchwerk'))).toBeNull()
  })

  it('splits by role: damage dealers keep full health, tanks and healers face their share', () => {
    const groups = roleGroups(request(`${mage}\n${tank}\n${rogue}\n${healer}`))!
    expect(groups.map((g) => [g.role, g.names])).toEqual([['dps', ['Ann', 'Bo']], ['tank', ['Cy']], ['heal', ['Di']]])
    expect(groups[0].request.extraProfileLines).toEqual(ROUTE)
    expect(groups[0].request.profile).toBe(`${mage}\n${rogue}`)
    expect(groups[1].request.extraProfileLines![1]).toContain('Mob_A:518519')
    expect(groups[2].request.extraProfileLines![1]).toContain('Mob_A:185185')
    expect(roleNote(groups)).toContain('Cy (tank) faced 52%; Di (healer) faced 19%')
  })

  it('scales a compare of only tanks without splitting it', () => {
    const groups = roleGroups(request(`${tank}\nwarrior="G"\nspec=protection`))!
    expect(groups).toHaveLength(1)
    expect(groups[0].request.extraProfileLines![1]).toContain('Mob_A:518519')
  })
})

class FakeEngine {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror = null
  onmessageerror = null
  sent: Record<string, unknown>[] = []
  terminated = false
  constructor(private readonly name: string, private readonly cloud = false) {}
  postMessage(m: Record<string, unknown>): void {
    this.sent.push(m)
    if (m.type === 'cancel') return
    const out = (msg: Record<string, unknown>) => this.onmessage?.({ data: { protocol: WORKER_PROTOCOL, jobId: m.jobId, ...msg } } as MessageEvent)
    queueMicrotask(() => {
      out({ type: 'ready' })
      out({ type: 'log', stream: 'out', lines: [`${this.name} running`] })
      const report = new TextEncoder().encode(JSON.stringify({ sim: { players: [{ name: this.name }] } })).buffer
      out({ type: 'done', report, ...(this.cloud ? { placement: 'cloud', effective: { profile: 'x', args: [] } } : {}) })
      if (!this.cloud) out({ type: 'shutdown', reason: 'complete', threads: 2 })
    })
  }
  terminate(): void { this.terminated = true }
}

describe('SequenceWorker', () => {
  it('runs each group after the one before, and answers as one run with every character', async () => {
    const engines = [new FakeEngine('Ann'), new FakeEngine('Cy', true), new FakeEngine('Di')]
    const w = new SequenceWorker([{ profile: 'a', args: ['x'] }, { profile: 'c', args: ['x'] }, { profile: 'd', args: ['x'] }], (i) => engines[i] as unknown as Worker)
    const got: Record<string, unknown>[] = []
    const finished = new Promise<void>((resolve) => {
      w.onmessage = (e) => {
        got.push(e.data)
        if (e.data.type === 'shutdown') resolve()
      }
    })
    w.postMessage({ protocol: WORKER_PROTOCOL, jobId: 'j1', profile: 'whole', args: ['x'], htmlPath: '/out.html' })
    await finished
    expect(engines.map((e) => e.sent[0].profile)).toEqual(['a', 'c', 'd'])
    expect(engines[0].sent[0].htmlPath).toBeUndefined()
    expect(engines.slice(0, 2).every((e) => e.terminated)).toBe(true)
    expect(got.map((m) => m.type)).toEqual(['ready', 'log', 'heartbeat', 'log', 'heartbeat', 'log', 'done', 'shutdown'])
    const done = got.find((m) => m.type === 'done')!
    expect(JSON.parse(new TextDecoder().decode(done.report as ArrayBuffer)).sim.players.map((p: { name: string }) => p.name)).toEqual(['Ann', 'Cy', 'Di'])
    expect(got.at(-1)).toMatchObject({ threads: 4 })
  })

  it('stops after a cancel without starting the next group', async () => {
    const engines = [new FakeEngine('Ann'), new FakeEngine('Cy')]
    const w = new SequenceWorker([{ profile: 'a', args: [] }, { profile: 'c', args: [] }], (i) => engines[i] as unknown as Worker)
    w.onmessage = () => {}
    w.postMessage({ protocol: WORKER_PROTOCOL, jobId: 'j1' })
    w.postMessage({ type: 'cancel' })
    await new Promise((r) => setTimeout(r, 0))
    expect(engines[1].sent).toEqual([])
  })
})
