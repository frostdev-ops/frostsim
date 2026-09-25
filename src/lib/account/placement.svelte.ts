// "Run on" preference and the cloud engine registration (CLAUDE.md D14, DESIGN.md C9, C10). Someone with cloud runs uses them by
// default (Avalanche: hybrid); an explicit choice is kept. Without cloud runs, and whenever the cloud refuses, runs stay in this browser.

import { setRemoteEngine, type RemoteEngine } from '../simc/job'
import { createRemoteEngine } from '../simc/remote'
import { createHybridEngine, type RunPlace } from '../simc/hybrid'
import { runPlace } from './run-place.svelte'

const KEY = 'frostsim.placement'
export type Placement = 'browser' | 'cloud' | 'hybrid'

/** The user's own choice, or null when they never made one. */
function read(): Placement | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'cloud' || v === 'browser' || v === 'hybrid' ? v : null
  } catch {
    return null
  }
}

let chosen = read()
/** Cloud threads of a plan with hybrid runs (Avalanche), else 0. */
let hybridThreads = 0

/** `value`: the choice, or the default. `entitled`: signed in and /billing grants compute; the Run on switch shows only then.
 *  `hybrid`: the plan includes hybrid runs. */
export const placement = $state<{ value: Placement; entitled: boolean; hybrid: boolean }>({ value: chosen ?? 'browser', entitled: false, hybrid: false })

/** Registers a cloud engine only for cloud or hybrid AND entitled; a hybrid choice without the plan runs in the cloud. */
export function applyPlacement(entitled = placement.entitled, threads = hybridThreads): void {
  hybridThreads = entitled ? threads : 0
  placement.entitled = entitled
  placement.hybrid = hybridThreads > 0
  const want = chosen ?? (placement.hybrid ? 'hybrid' : entitled ? 'cloud' : 'browser')
  placement.value = want === 'hybrid' && !placement.hybrid ? 'cloud' : want
  runPlace.current = null
  const place = (p: RunPlace) => { runPlace.current = p }
  const engine: RemoteEngine | null = !entitled || placement.value === 'browser' ? null
    : placement.value === 'hybrid' ? createHybridEngine({ cloudThreads: hybridThreads, onplace: place })
      : createRemoteEngine({ onreplay: (reason) => place({ mode: 'browser', note: `Frostsim Cloud: ${reason}. This run moved to this PC.` }) })
  // Each run starts with no place; the engine sets one when the cloud takes part (a run it declines up front stays null).
  setRemoteEngine(engine && ((req, dir) => {
    runPlace.current = null
    const worker = engine(req, dir)
    if (!worker || placement.value === 'hybrid') return worker
    return (variant, d) => (place({ mode: 'cloud' }), worker(variant, d))
  }))
}

export function setPlacement(value: Placement): void {
  chosen = value
  placement.value = value
  try {
    localStorage.setItem(KEY, value)
  } catch { /* Storage blocked: the choice lasts for this page. */ }
  applyPlacement()
}
