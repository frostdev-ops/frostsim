// Stripe price lookup keys -> what they grant (CLAUDE.md D15, DESIGN.md C6), derived from the shared plan table
// (src/lib/account/plans.ts) so the dialog, this catalog and the Stripe price script agree. `<plan>_<term>` for every term sold.

import { PLANS, lookupKey, termsOf, type Plan, type Term } from '../../src/lib/account/plans';

export interface Product {
  kind: Plan['kind'];
  term: Term;
  maxThreads?: number;
  /** Per month; a Price's `core_hours` metadata overrides it (a promotion), see entitlements.ts. */
  coreHoursPerMonth?: number;
  slotsPerUnit?: number;
  hostedShares?: boolean;
}

export const CATALOG: Readonly<Record<string, Product>> = Object.fromEntries(PLANS.flatMap((plan) => termsOf(plan).map((term) => [
  lookupKey(plan, term),
  { kind: plan.kind, term, maxThreads: plan.maxThreads, coreHoursPerMonth: plan.coreHoursPerMonth, slotsPerUnit: plan.slotsPerUnit, hostedShares: plan.hostedShares },
])));

/** Unknown keys (and prototype names like "toString") grant nothing. */
export function product(lookupKey: string): Product | null {
  return Object.hasOwn(CATALOG, lookupKey) ? CATALOG[lookupKey] : null;
}
