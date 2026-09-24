// Stripe price lookup keys -> what they grant (CLAUDE.md D15, DESIGN.md C6). Core-hour sizes are deliberately absent: they live on the
// Stripe Price (metadata `core_hours`) until the Phase 0 benchmark sizes the tiers.

export interface Product {
  kind: 'compute' | 'slots' | 'shares' | 'guild';
  maxThreads?: number;
  slotsPerUnit?: number;
  hostedShares?: boolean;
}

export const CATALOG: Readonly<Record<string, Product>> = {
  compute_s_monthly: { kind: 'compute', maxThreads: 8, hostedShares: true },
  compute_m_monthly: { kind: 'compute', maxThreads: 16, hostedShares: true },
  compute_l_monthly: { kind: 'compute', maxThreads: 32, hostedShares: true },
  slots_5_monthly: { kind: 'slots', slotsPerUnit: 5 },
  shares_plus_monthly: { kind: 'shares', hostedShares: true },
  // ponytail: guild thread ceiling = the smallest compute tier, a recorded default until pricing decides it.
  discord_guild_monthly: { kind: 'guild', maxThreads: 8 },
};

/** Unknown keys (and prototype names like "toString") grant nothing. */
export function product(lookupKey: string): Product | null {
  return Object.hasOwn(CATALOG, lookupKey) ? CATALOG[lookupKey] : null;
}
