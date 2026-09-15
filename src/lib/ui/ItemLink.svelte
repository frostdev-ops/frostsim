<script lang="ts">
  import { Tooltip } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { ResolvedItem } from '../catalog/types'
  import ItemTooltip from './ItemTooltip.svelte'

  let { itemId, name = `Item ${itemId}`, resolved, children, compact = false, onselect, selected = false }: {
    itemId: number
    name?: string
    resolved?: ResolvedItem | null
    children?: Snippet
    compact?: boolean
    onselect?: () => void
    selected?: boolean
  } = $props()
</script>

<Tooltip.Provider delayDuration={200}>
  <Tooltip.Root>
    <Tooltip.Trigger onclick={onselect}>
      {#snippet child({ props })}
        {#if onselect}
          <button {...props} class="item-choice" class:compact aria-pressed={selected}>
            {#if children}{@render children()}{:else}{name}{/if}
          </button>
        {:else}
        <a {...props} type={undefined} class="item-link" class:compact href="https://www.wowhead.com/item={itemId}" target="_blank" rel="noopener noreferrer" aria-label="{name} on Wowhead (opens in a new tab)">
          {#if children}{@render children()}{:else}{name}{/if}
        </a>
        {/if}
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content sideOffset={6} collisionPadding={8} style="z-index: 1200; max-height: calc(100vh - 16px); overflow-y: auto">
        <ItemTooltip item={resolved ?? { itemId, name }} />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
</Tooltip.Provider>
{#if onselect}<a class="item-link compact" href="https://www.wowhead.com/item={itemId}" target="_blank" rel="noopener noreferrer" title="{name} on Wowhead" aria-label="{name} on Wowhead (opens in a new tab)">↗</a>{/if}

<style>
  .item-link { display: inline-flex; align-items: center; gap: 0.4rem; min-width: 0; color: inherit; text-decoration: none; }
  .item-link:hover { text-decoration: underline; }
  .item-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .compact { flex: none; font-size: var(--fs-xs); }
  .item-choice { flex: 1; min-width: 0; border: 0; border-radius: 0; justify-content: start; text-align: left; padding: 8px; }
  .item-choice[aria-pressed="true"] { background: var(--accent-soft); }
  .item-choice.compact { flex: none; padding: 0; }
</style>
