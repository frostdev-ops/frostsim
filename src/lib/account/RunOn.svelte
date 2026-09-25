<script lang="ts">
  // Where runs go, beside the character on every tool screen (CLAUDE.md D14). Shown only with cloud runs, which are then the default.
  import { Cloud, Monitor } from '@lucide/svelte'
  import { placement, setPlacement } from './placement.svelte'
  import { account } from './state.svelte'
  import { approxSims } from './plans'

  const left = $derived(account.billing ? approxSims(account.billing.entitlements.coreSeconds - account.billing.usage.usedCoreSeconds) : null)
</script>

{#if placement.entitled}
  <div class="run-on">
    <span class="xs muted label">Run on</span>
    <div class="segmented" role="radiogroup" aria-label="Run on">
      <label title="Runs on Frostsim's servers and uses your plan">
        <input type="radio" name="run-on" value="cloud" checked={placement.value === 'cloud'} onchange={() => setPlacement('cloud')} />
        <Cloud size={14} aria-hidden="true" />Frostsim Cloud{#if left !== null}<span class="left">≈ {left.toLocaleString()} left</span>{/if}
      </label>
      <label title="Runs on this device, free">
        <input type="radio" name="run-on" value="browser" checked={placement.value === 'browser'} onchange={() => setPlacement('browser')} />
        <Monitor size={14} aria-hidden="true" />This browser
      </label>
    </div>
  </div>
{/if}

<style>
  .run-on { display: flex; align-items: center; gap: var(--s2); margin-left: auto; flex-wrap: wrap; }
  .label { text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; }
  .left { margin-left: 6px; font-size: var(--fs-xs); color: var(--text-muted); font-weight: 400; }
</style>
