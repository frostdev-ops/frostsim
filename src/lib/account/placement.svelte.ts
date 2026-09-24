// "Run on" preference and the cloud engine registration (CLAUDE.md D14, DESIGN.md C9, C10). This browser is the default and the fallback.

import { setRemoteEngine } from '../simc/job'
import { createRemoteEngine } from '../simc/remote'

const KEY = 'frostsim.placement'
export type Placement = 'browser' | 'cloud'

function read(): Placement {
  try {
    return localStorage.getItem(KEY) === 'cloud' ? 'cloud' : 'browser'
  } catch {
    return 'browser'
  }
}

/** `entitled`: signed in and /billing grants compute. The Settings choice is shown only then. */
export const placement = $state<{ value: Placement; entitled: boolean }>({ value: read(), entitled: false })

/** Registers the cloud engine only while the user chose it and is entitled; every other state runs in this browser. */
export function applyPlacement(entitled = placement.entitled): void {
  placement.entitled = entitled
  setRemoteEngine(placement.value === 'cloud' && entitled ? createRemoteEngine() : null)
}

export function setPlacement(value: Placement): void {
  placement.value = value
  try {
    localStorage.setItem(KEY, value)
  } catch { /* Storage blocked: the choice lasts for this page. */ }
  applyPlacement()
}
