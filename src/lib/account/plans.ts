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
  /** Tier name. Every compute tier is shown with its cores and hours, so the name can be flavour. */
  title: string
  blurb: string
  kind: 'compute' | 'guild'
  maxThreads?: number
  /** Allowance per month, whatever the term: a yearly plan is metered in monthly slices (entitlements.ts). */
  coreHoursPerMonth?: number
  /** Cloud character slots on top of FREE_SLOTS; UNLIMITED_SLOTS means unlimited (a fair-use ceiling). */
  extraSlots?: number
  hostedShares?: boolean
  /** US dollars per term. Absent: the price is set on Stripe only and shows at checkout. */
  usd?: Partial<Record<Term, number>>
}

/** Cloud character slots every signed-in account has, paid or not. */
export const FREE_SLOTS = 1

/** "Unlimited" slots: a fair-use ceiling, because each save stores up to 64 KiB and a truly unlimited count lets one account fill
 *  the database. Shown as unlimited (slotsLabel). */
export const UNLIMITED_SLOTS = 100

export const slotsLabel = (slots: number) => (slots >= UNLIMITED_SLOTS ? 'Unlimited' : String(slots))

/** Whether another character fits, and what to tell the user when it does not. Characters over the limit (after a downgrade)
 *  stay; they can be downloaded, replaced or deleted, and adding waits for a free slot. */
export function slotStatus(used: number, slots: number): { canAdd: boolean; note: string } {
  if (used < slots) return { canAdd: true, note: slots >= UNLIMITED_SLOTS ? '' : `${slots - used} of ${slots} slot${slots === 1 ? '' : 's'} free.` }
  const more = slots >= UNLIMITED_SLOTS ? '' : ' or choose a plan with more slots'
  if (used === slots) return { canAdd: false, note: `All ${slots} slot${slots === 1 ? ' is' : 's are'} in use. Replace or delete a character to save another${more}.` }
  return { canAdd: false, note: `You have ${used} characters and ${slots} slot${slots === 1 ? '' : 's'}. They stay, and you can download, replace or delete them; delete ${used - slots + 1} to save a new one${more}.` }
}

export const PLANS: readonly Plan[] = [
  { id: 'compute_s', title: 'Frostbite', blurb: 'For your main', kind: 'compute', maxThreads: 8, coreHoursPerMonth: 20, extraSlots: 1, hostedShares: true,
    usd: { monthly: 3, semiannual: 16, yearly: 29 } },
  { id: 'compute_m', title: 'Glacier', blurb: 'For your main and alts', kind: 'compute', maxThreads: 16, coreHoursPerMonth: 50, extraSlots: 2, hostedShares: true,
    usd: { monthly: 5, semiannual: 27, yearly: 48 } },
  { id: 'compute_l', title: 'Avalanche', blurb: 'For the whole roster', kind: 'compute', maxThreads: 64, coreHoursPerMonth: 120, extraSlots: UNLIMITED_SLOTS, hostedShares: true,
    usd: { monthly: 10, semiannual: 54, yearly: 96 } },
  { id: 'discord_guild', title: 'Guild Cloud', blurb: '/sim for everyone in your Discord server', kind: 'guild', maxThreads: 8, coreHoursPerMonth: 80,
    usd: { monthly: 10, semiannual: 54, yearly: 96 } },
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

/** What a term costs per month, for comparing terms: $29 a year is $2.42 a month. */
export function perMonth(plan: Plan, term: Term): number | undefined {
  const price = plan.usd?.[term]
  return price === undefined ? undefined : Math.round((price / TERMS[term].months) * 100) / 100
}

/** Percent saved against paying monthly for the same months, or 0. */
export function discountPercent(plan: Plan, term: Term): number {
  const monthly = plan.usd?.monthly
  const price = plan.usd?.[term]
  if (!monthly || price === undefined || term === 'monthly') return 0
  return Math.round((1 - price / (monthly * TERMS[term].months)) * 100)
}
