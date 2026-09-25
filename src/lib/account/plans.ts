// Frostsim Cloud plans (CLAUDE.md D15, DESIGN.md C6): one table for the server catalog, the account dialog and the Stripe price
// script, so a plan's hours, width and price cannot drift apart. Pure data; the server imports it too.

export type Term = 'monthly' | 'semiannual' | 'yearly'

export interface TermSpec {
  label: string
  /** Stripe recurring interval. */
  interval: 'month' | 'year'
  intervalCount: number
  months: number
}

export const TERMS: Readonly<Record<Term, TermSpec>> = {
  monthly: { label: 'Monthly', interval: 'month', intervalCount: 1, months: 1 },
  semiannual: { label: '6 months', interval: 'month', intervalCount: 6, months: 6 },
  yearly: { label: 'Yearly', interval: 'year', intervalCount: 1, months: 12 },
}

export interface Plan {
  id: string
  title: string
  blurb: string
  kind: 'compute' | 'slots' | 'shares' | 'guild'
  maxThreads?: number
  /** Allowance per month, whatever the term: a yearly plan is metered in monthly slices (entitlements.ts). */
  coreHoursPerMonth?: number
  slotsPerUnit?: number
  hostedShares?: boolean
  /** US dollars per term. Absent: the price is set on Stripe only and shows at checkout. */
  usd?: Partial<Record<Term, number>>
}

export const PLANS: readonly Plan[] = [
  // ponytail: L runs 16 threads while the Hetzner project cannot create 32 dedicated cores; raise it with HCLOUD_SERVER_TYPE.
  { id: 'compute_s', title: 'Compute S', blurb: 'Cloud runs, hosted links included', kind: 'compute', maxThreads: 8, coreHoursPerMonth: 20, hostedShares: true,
    usd: { monthly: 3, semiannual: 16, yearly: 29 } },
  { id: 'compute_m', title: 'Compute M', blurb: 'Cloud runs, hosted links included', kind: 'compute', maxThreads: 16, coreHoursPerMonth: 50, hostedShares: true,
    usd: { monthly: 5, semiannual: 27, yearly: 48 } },
  { id: 'compute_l', title: 'Compute L', blurb: 'Cloud runs, hosted links included', kind: 'compute', maxThreads: 16, coreHoursPerMonth: 120, hostedShares: true,
    usd: { monthly: 10, semiannual: 54, yearly: 96 } },
  { id: 'discord_guild', title: 'Discord server', blurb: 'A shared pool for /sim in one Discord server', kind: 'guild', maxThreads: 8, coreHoursPerMonth: 80,
    usd: { monthly: 10, semiannual: 54, yearly: 96 } },
  { id: 'slots_5', title: 'Character slots', blurb: 'Five cloud character slots', kind: 'slots', slotsPerUnit: 5, usd: {} },
  { id: 'shares_plus', title: 'Hosted links', blurb: 'Full-detail report links without cloud runs', kind: 'shares', hostedShares: true, usd: {} },
]

/** Terms a plan is sold on: every term with a price, and always monthly (priced on Stripe when absent here). */
export function termsOf(plan: Plan): Term[] {
  return (Object.keys(TERMS) as Term[]).filter((t) => t === 'monthly' || plan.usd?.[t] !== undefined)
}

/** Stripe price lookup key: `compute_s_monthly`, `compute_s_semiannual`, `compute_s_yearly`. */
export const lookupKey = (plan: Plan, term: Term) => `${plan.id}_${term}`

/** CPU seconds of one standard sim: 4,000 iterations of MID2_Mage_Frost on Patchwerk took 10.9-11.7 CPU seconds on Hetzner
 *  CPX62 and CCX33 at 1 to 16 threads (Phase 0, 2026-09-25). Heavier specs and fights cost more; this is a guide, not a promise. */
export const STANDARD_SIM_CPU_SECONDS = 11.2

/** "≈ N standard sims" for an allowance or a remainder, rounded to two significant figures. */
export function approxSims(coreSeconds: number): number {
  const n = Math.max(0, coreSeconds) / STANDARD_SIM_CPU_SECONDS
  if (n < 10) return Math.floor(n)
  const step = 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.floor(n / step) * step
}

/** Percent saved against paying monthly for the same months, or 0. */
export function discountPercent(plan: Plan, term: Term): number {
  const monthly = plan.usd?.monthly
  const price = plan.usd?.[term]
  if (!monthly || price === undefined || term === 'monthly') return 0
  return Math.round((1 - price / (monthly * TERMS[term].months)) * 100)
}
