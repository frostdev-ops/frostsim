// One monetary scope for compute and AI: both reserve against the same plan's usedCostUsd ledger.
// Lock order: AI global ceiling, then this scope. Compute only takes the scope (after worker/job locks), never AI global.
// Keep the existing compute scope namespace so enqueue/claim serialization remains compatible across rolling releases.
export const MONEY_SCOPE_LOCK = 0x636d7075;
export const AI_GLOBAL_BUDGET_LOCK = 0x6169676c;
