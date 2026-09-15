// Search-stall thresholds for Top Gear; no stage-plan override (v3 plan below old cap; override would be no-op safeguard).
// Stall thresholds protect once engine produces progress line; see TopGear.svelte watchdog (silence doesn't prove nothing).

export { DEFAULT_STAGE_PLAN as PRODUCT_STAGE_PLAN } from './optimization'

/** Timeout if search has no engine output (meaningful once progress line seen; silence alone doesn't mean dead). */
export const STALL_TIMEOUT_MS = 150_000
// When to start warning user, well before timeout.
export const STALL_WARN_MS = 45_000
