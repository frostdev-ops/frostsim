// "Run on" preference and the cloud engine registration (CLAUDE.md D14, DESIGN.md C9, C10). Someone with cloud runs uses them by
// default; an explicit choice (either way) is kept. Without cloud runs, and whenever the cloud refuses, runs stay in this browser.

import { setRemoteEngine } from '../simc/job'
import { createRemoteEngine } from '../simc/remote'

const KEY = 'frostsim.placement'
export type Placement = 'browser' | 'cloud'

/** The user's own choice, or null when they never made one. */
function read(): Placement | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'cloud' || v === 'browser' ? v : null
  } catch {
    return null
  }
}

let chosen = read()

/** `value`: the choice, or the default (cloud while entitled). `entitled`: signed in and /billing grants compute; the Run on
 *  switch shows only then. */
export const placement = $state<{ value: Placement; entitled: boolean }>({ value: chosen ?? 'browser', entitled: false })

/** Registers the cloud engine only for cloud AND entitled; every other state runs in this browser. */
export function applyPlacement(entitled = placement.entitled): void {
  placement.entitled = entitled
  if (chosen === null) placement.value = entitled ? 'cloud' : 'browser'
  setRemoteEngine(placement.value === 'cloud' && entitled ? createRemoteEngine() : null)
}

export function setPlacement(value: Placement): void {
  chosen = value
  placement.value = value
  try {
    localStorage.setItem(KEY, value)
  } catch { /* Storage blocked: the choice lasts for this page. */ }
  applyPlacement()
}
