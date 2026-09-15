<script lang="ts">
  // Character gear as dense icon row: visual summary of sim result, in-game slot order, readable at a glance.
  // Icons from same-origin item API; CSP img-src 'self' data: proxies through /api/.
  import { GEAR_SLOTS, type GearSlot, type ItemInstance } from '../import/character'
  import { app } from '../app.svelte'
  import { display } from '../items'
  import type { ResolvedItem } from '../catalog/types'
  import { ms, stagger } from '../theme.svelte'
  import { fly } from 'svelte/transition'
  import ItemIcon from './ItemIcon.svelte'
  import ItemLink from './ItemLink.svelte'

  interface Props {
    items: ItemInstance[]
    /** Exact candidate config may differ from imported item at same ID. */
    resolvedItems?: ReadonlyMap<string, ResolvedItem>
    size?: number
    /** Single line, clipped. Used inside table rows where height must be fixed. */
    inline?: boolean
    /** Slots with item differing from baseline (drawn with accent ring). */
    changed?: GearSlot[]
    /** Average item level (trailing badge). */
    itemLevel?: number
    /** Skip reveal animation for rows already on screen. */
    still?: boolean
    /** When given, cells are buttons; receives clicked slot. */
    onselect?: (slot: GearSlot) => void
    /** Small badge per slot, e.g. how many alternatives the bag holds. */
    badges?: Partial<Record<GearSlot, string>>
  }
  let {
    items, resolvedItems, size = 34, changed = [], itemLevel, still = false, inline = false, onselect, badges = {},
  }: Props = $props()

  const bySlot = $derived(new Map(items.map((i) => [i.slot, i])))
  const ordered = $derived(
    GEAR_SLOTS.map((slot) => ({ slot, item: bySlot.get(slot) })).filter((e) => e.item),
  )
  const changedSet = $derived(new Set(changed))
</script>

<div class="strip" class:inline role="list" aria-label="Equipped gear">
  {#each ordered as entry, i (entry.slot)}
    {@const shown = display(entry.item!, resolvedItems?.has(entry.item!.instanceId) ? resolvedItems : app.resolved)}
    <div
      class="cell"
      class:changed={changedSet.has(entry.slot)}
      class:pickable={!!onselect}
      role="listitem"
      in:fly|global={{ y: still ? 0 : 8, duration: still ? 0 : ms('reveal'), delay: still ? 0 : stagger(i, 14) }}
    >
      <ItemLink itemId={entry.item!.itemId} name={shown.name} resolved={shown.resolved} compact onselect={onselect ? () => onselect?.(entry.slot) : undefined}>
      <ItemIcon
        itemId={entry.item!.itemId}
        quality={shown.resolved?.quality}
        {size}
        alt={shown.name}
      />
      </ItemLink>
      {#if badges[entry.slot]}
        <span class="badge num">{badges[entry.slot]}</span>
      {:else if shown.itemLevel}
        <span class="ilvl num">{shown.itemLevel}</span>
      {/if}
    </div>
  {/each}
  {#if itemLevel}
    <span class="avg num" title="Average item level">{Math.round(itemLevel)}</span>
  {/if}
</div>

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.28rem;
    align-items: center;
  }
  /* Ranked row: no wrap (extra line breaks column scan). */
  .strip.inline {
    flex-wrap: nowrap;
    overflow: hidden;
    max-width: 100%;
  }
  .cell {
    position: relative;
    line-height: 0;
    border-radius: var(--r1);
    transition: transform var(--t-control) var(--ease);
  }
  .cell:hover { filter: brightness(1.12); z-index: 2; }
  .cell.pickable {
    all: unset;
    position: relative;
    line-height: 0;
    border-radius: var(--r1);
    cursor: pointer;
    transition: transform var(--t-control) var(--ease);
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .cell.pickable:focus-visible { box-shadow: var(--focus); }
  .badge {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 1rem;
    padding: 0 0.25rem;
    font-size: 0.6rem;
    line-height: 1.1rem;
    text-align: center;
    border-radius: 999px;
    background: var(--accent);
    color: var(--bg);
    font-weight: 700;
    pointer-events: none;
  }

  /* Changed slot gets ring, not colour swap (quality colour must remain readable). */
  .cell.changed::after {
    content: '';
    position: absolute;
    inset: -2px;
    border: 2px solid var(--accent);
    border-radius: var(--r2);
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent) 40%, transparent),
                0 0 10px color-mix(in oklab, var(--accent) 45%, transparent);
    pointer-events: none;
  }

  .ilvl {
    position: absolute;
    right: -1px;
    bottom: -1px;
    padding: 0 0.15rem;
    font-size: 0.58rem;
    line-height: 1.25;
    border-radius: 3px;
    background: color-mix(in oklab, var(--surface) 82%, transparent);
    color: var(--text-muted);
    pointer-events: none;
  }
  .avg {
    margin-left: 0.3rem;
    padding: 0.1rem 0.4rem;
    font-size: var(--fs-xs);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    color: var(--text);
  }

  /* Name on hover (visual affordance; icon alt text covers assistive tech). */
</style>
