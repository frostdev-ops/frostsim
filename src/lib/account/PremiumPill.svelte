<script lang="ts">
  // The one way into #/plans from elsewhere in the app (CLAUDE.md D15): a small gradient pill. Account builds only.
  import { Sparkles } from '@lucide/svelte'
  import { account } from './state.svelte'
  let { text = 'Cloud', title, onclick }: { text?: string; title?: string; onclick?: () => void } = $props()
</script>

<a class="premium" href="#/plans" {title} onclick={() => { account.open = false; onclick?.() }}><Sparkles size={12} aria-hidden="true" />{text}</a>

<style>
  .premium {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 99px; text-decoration: none; white-space: nowrap;
    font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.02em; background: var(--grad); color: #04121f; vertical-align: middle;
    box-shadow: 0 4px 14px -6px var(--accent-glow);
  }
  .premium:hover { filter: brightness(1.1); }
  .premium:focus-visible { box-shadow: var(--focus); }
</style>
