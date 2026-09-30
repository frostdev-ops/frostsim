import { compareCandidates, multiplicityFactor } from './statistics';
import type { CandidateMeasurement, OptimizationResult, StagePlan } from './types';
import { VAULT_SOCKET_REWARD_ID, vaultTokenCount } from '../catalog/vaultRewards';

/** Currency advice requires every offered item, a complete search and usable uncertainty. */
export function vaultRecommendation(result: OptimizationResult & { generation?: { capped: boolean }; budgetExhausted?: boolean; comparisonLooks?: number; comparisonCandidates?: number }, plan: StagePlan,
  rewardIds: string[], panes: number, socketRequested: boolean): { title: string; reason: string } {
  const pending = { title: 'Finish comparing your Vault', reason: 'Compare every offered reward and your best owned setup before choosing gear, tokens or a Voidcore.' };
  const measured = result.candidates.filter(s => s.status === 'measured' && s.measurement && Number.isFinite(s.measurement.mean)
    && !result.droppedWhileAlive.includes(s.candidate.id));
  const owned = measured.find(s => !s.candidate.provenance.vaultRewardId)?.measurement;
  const rewards = rewardIds.map(id => measured.find(s => s.candidate.provenance.vaultRewardId === id)?.measurement);
  if (!vaultTokenCount(panes) || !rewardIds.length || rewardIds.length < panes || result.incomplete || result.generation?.capped
    || result.truncated || result.droppedWhileAlive.length || result.budgetExhausted
    || !owned || rewards.some(m => !m)) return pending;
  const factor = plan.retentionFactor * (plan.correctForMultipleComparisons === false ? 1
    : multiplicityFactor((result.comparisonCandidates ?? result.candidates.length) - 1, owned.confidence ?? 0.95, result.comparisonLooks ?? Math.max(1, plan.stages.length - 1)));
  const compare = (a: CandidateMeasurement, b: CandidateMeasurement) => Math.min(a.iterations, b.iterations) >= plan.minIterations
    ? compareCandidates(a, b, factor) : 'unknown';
  const verdicts = rewards.map(m => compare(m!, owned));
  if (verdicts.includes('unknown')) return pending;
  const socket = measured.find(s => s.candidate.provenance.vaultRewardId === VAULT_SOCKET_REWARD_ID)?.measurement;
  if (socket && compare(socket, owned) === 'a_better' && rewards.every(m => compare(socket, m!) === 'a_better')) {
    return { title: 'Take Thalassian Tokens of Merit for a socket', reason: 'The simulated token-bought socket clearly beats every offered item and your best owned setup at this precision.' };
  }
  if (socketRequested && !socket) return { title: 'The token-bought socket was not measured', reason: 'No legal socket setup was measured. Check for unsocketed Season 2 PvE head, wrist or waist gear with a verified upgrade track, and a gem that passes unique-equipped rules.' };
  if (socketRequested && compare(socket!, owned) === 'unknown') return pending;
  if (!verdicts.includes('a_better') && (!socket || compare(socket, owned) !== 'a_better')) {
    return { title: panes >= 3 ? 'Consider a Nebulous Voidcore or tokens' : 'Consider Thalassian Tokens of Merit',
      reason: 'None of the compared items shows a clear DPS gain over your best owned setup. Tokens can fund a socket, crests or crafting. '
        + (panes >= 3 ? 'Prefer the Voidcore if its remaining bonus-roll pool contains useful upgrades; its random reward has not been simulated.' : 'You need three unlocked panes for a Voidcore; save tokens toward a useful purchase.') };
  }
  return { title: 'Compare the guaranteed upgrade with your alternatives', reason: 'A measured item or socket improves DPS. Take tokens for the socket only if it beats the item choices; a Voidcore may be worthwhile for a specific remaining loot target, but its value is unknown here.' };
}
