<script lang="ts">
  // Where runs go, beside the character on every tool screen (CLAUDE.md D14). Shown only with cloud runs, which are then the default.
  import { Cloud, Monitor, Zap } from '@lucide/svelte'
  import { placement, setPlacement } from './placement.svelte'
  import { account } from './state.svelte'
  import { approxSims } from './plans'
  import PremiumPill from './PremiumPill.svelte'

  const left = $derived(account.billing ? approxSims(account.billing.entitlements.coreSeconds - account.billing.usage.usedCoreSeconds) : null)
</script>

{#if placement.entitled}
  <div class="run-on">
    <span class="xs muted label">Run on</span>
    <div class="segmented" role="radiogroup" aria-label="Run on">
      {#if placement.hybrid}
        <label title="Splits multi-candidate runs (Top Gear, Droptimizer, compares) between this device and Frostsim's servers at once, for the fastest result. Uses your plan for the cloud share.">
          <input type="radio" name="run-on" value="hybrid" checked={placement.value === 'hybrid'} onchange={() => setPlacement('hybrid')} />
          <Zap size={14} aria-hidden="true" />Hybrid
        </label>
      {/if}
      <label title="Runs on Frostsim's servers and uses your plan">
        <input type="radio" name="run-on" value="cloud" checked={placement.value === 'cloud'} onchange={() => setPlacement('cloud')} />
        <Cloud size={14} aria-hidden="true" />Frostsim Cloud{#if left !== null}<span class="left">≈ {left.toLocaleString()} left</span>{/if}
      </label>
      <label title="Runs on this device, free">
        <input type="radio" name="run-on" value="browser" checked={placement.value === 'browser'} onchange={() => setPlacement('browser')} />
        <Monitor size={14} aria-hidden="true" />This browser
      </label>
    </div>
    {#if !placement.hybrid}<PremiumPill text="Hybrid" title="Avalanche splits big runs between this device and the cloud at once" />{/if}
  </div>
{/if}

<style>
  .run-on { display: flex; align-items: center; gap: var(--s2); margin-left: auto; flex-wrap: wrap; }
  .label { text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; }
  .left { margin-left: 6px; font-size: var(--fs-xs); color: var(--text-muted); font-weight: 400; }
</style>
