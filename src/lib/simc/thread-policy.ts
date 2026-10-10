// UI preference only: requests still carry the effective numeric thread count.
export type ThreadPolicy = 'balanced' | 'maximum' | 'manual'

export function effectiveThreads(policy: ThreadPolicy, manual: number, manifestMax: number, hardwareHint = 4): number {
  const ceiling = Number.isInteger(manifestMax) && manifestMax > 0 ? manifestMax : 1
  const hint = Number.isInteger(hardwareHint) && hardwareHint > 0 ? hardwareHint : 4
  const requested = policy === 'manual' ? (Number.isFinite(manual) ? Math.max(1, Math.floor(manual)) : 1)
    : policy === 'maximum' ? hint : Math.min(hint, 8)
  return Math.min(requested, ceiling)
}
