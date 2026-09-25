<script lang="ts">
  // Shown under a run that has worked in this browser for a while, to someone without cloud runs (CLAUDE.md D14, D15).
  import PremiumPill from './PremiumPill.svelte'
  import { computeEntitled } from './state.svelte'
  let { elapsed }: { elapsed: number } = $props()
</script>

{#if elapsed >= 15 && !computeEntitled()}
  <p class="nudge xs muted">Running on your PC. Long runs can go to our servers instead, so your game keeps its frames. <PremiumPill text="Cloud runs" /></p>
{/if}

<style>
  .nudge { margin: var(--s2) 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
</style>
