<script lang="ts">
  import type { SimOutcome } from '../simc/job'
  import type { ItemInstance } from '../import/character'
  import { titleCase } from '../format'
  import GearStrip from './GearStrip.svelte'
  import Metric from './Metric.svelte'
  import { Swords } from '@lucide/svelte'
  interface Props { outcome: SimOutcome; characterLabel: string; onrerun?: () => void; gear?: ItemInstance[]; compact?: boolean; characterId?: string; region?: string; realm?: string }
  let { outcome, characterLabel, onrerun, gear = [], compact = false }: Props = $props()
  const report = $derived(outcome.report)
  const player = $derived(report.players[0])
</script>
<section class="panel result-header" data-class={outcome.request.characterSnapshot?.className} class:compact>
  <div class="headline"><div class="row"><Swords size={22} /><h1>{compact ? 'Baseline' : outcome.report.profilesets.length ? 'Comparison' : outcome.report.scaling?.calculateScaleFactors ? 'Stat Weights' : 'Quick Sim'}</h1></div><Metric value={player?.dps.mean} confidence={player?.dpsConfidence} /></div>
  <div class="spread"><div><h2>{player?.name ?? characterLabel}</h2><span class="small muted">{titleCase(player?.specialization ?? '')}</span></div>{#if onrerun}<button onclick={onrerun}>Run again</button>{/if}</div>
  {#if gear.length}<GearStrip items={gear} size={40} />{/if}
  {#if player?.validFightStyle === false}<p class="error" role="alert">This specialization does not support {report.options.fightStyle}.</p>
  {:else if outcome.request.accuracy.mode === 'targetError' && !report.targetReached}<p class="small muted">Iteration limit reached · target {report.options.targetError}%</p>{/if}
</section>
<style>
  .result-header { display: flex; flex-direction: column; gap: 14px; }
  .headline { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .headline h1 { font-size: 20px; letter-spacing: .12em; text-transform: uppercase; }
  .headline :global(.metric) { font-size: 36px; }
  h2 { color: var(--class-color, var(--text)); font-size: 20px; }
  .compact { gap: 8px; }
</style>
