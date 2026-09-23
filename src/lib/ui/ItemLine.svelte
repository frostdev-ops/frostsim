<script lang="ts">
  // One gear row; names, ilvl, quality, stats from catalog when loaded; addon's comment shown unverified (never as resolved data).
  import { SLOT_LABELS, type ItemInstance } from '../import/character'
  import { app } from '../app.svelte'
  import { display } from '../items'
  import { itemUpgradeTrack } from '../catalog/upgrades'
  import ItemIcon from './ItemIcon.svelte'
  import ItemTooltip from './ItemTooltip.svelte'
  import ItemLink from './ItemLink.svelte'
  import { Portal } from 'bits-ui'

  interface Props {
    item: ItemInstance | null
    slot: string
    onclick?: () => void
    selected?: boolean
    /** Shown to the right, e.g. "+2,104 DPS" or a source. */
    trailing?: string
    compact?: boolean
    card?: boolean
    /** Hide the slot label when the surrounding list already names it. */
    showSlot?: boolean
  }
  let {
    item, slot, onclick, selected = false, trailing, compact = false, card = false, showSlot = true,
  }: Props = $props()

  const label = $derived(SLOT_LABELS[slot as keyof typeof SLOT_LABELS] ?? slot)

  // Tooltip is convenience (everything also in row or exact-values table); no information lost if hidden.
  let anchor: HTMLElement | undefined = $state()
  let tipAt = $state<{ x: number; y: number; above: boolean } | null>(null)

  function openTip(): void {
    if (!anchor || !item || !info) return
    const r = anchor.getBoundingClientRect()
    const above = r.bottom + 280 > window.innerHeight && r.top > 280
    tipAt = {
      x: Math.max(8, Math.min(r.left, window.innerWidth - 360)),
      y: above ? r.top - 6 : r.bottom + 6,
      above,
    }
  }
  const closeTip = () => (tipAt = null)
  const info = $derived(item ? display(item, app.resolved, app.catalogState === 'ready') : null)
  const upgrade = $derived(item ? itemUpgradeTrack(item) : null)

  // Quality rim is item-tooltip cue; quality name always shown.
  const qualityVar = $derived(
    info?.quality !== undefined
      ? [
          'var(--q-poor)', 'var(--q-common)', 'var(--q-uncommon)', 'var(--q-rare)',
          'var(--q-epic)', 'var(--q-legendary)', 'var(--q-artifact)', 'var(--q-heirloom)',
        ][info.quality] ?? 'var(--border)'
      : 'var(--border)',
  )

  const meta = $derived(
    info
      ? [
          info.hasEnchant ? 'enchanted' : null,
          info.socketCount ? `${info.socketCount} socket${info.socketCount > 1 ? 's' : ''}` : null,
          item?.craftingQuality ? `crafted Q${item.craftingQuality}` : null,
          upgrade ? `${upgrade.track.label} ${upgrade.rank.extended ? `rank ${upgrade.rank.rank} (restricted)` : `${upgrade.rank.rank}/${upgrade.track.max}`}${item?.upgradeTrackHypothetical ? ' (hypothetical)' : ''}` : null,
          item?.itemLevel !== undefined ? `custom ilvl ${item.itemLevel}` : null,
          ...info.descriptors,
        ].filter(Boolean).join(' · ')
      : '',
  )
</script>

<div class="item-with-link">
<svelte:element
  this={onclick ? 'button' : 'div'}
  class="item"
  class:selected
  class:compact
  class:card
  class:interactive={!!onclick}
  type={onclick ? 'button' : undefined}
  role={onclick ? 'button' : undefined}
  aria-pressed={onclick ? selected : undefined}
  onclick={onclick}
  style:--q={qualityVar}
  bind:this={anchor}
  onmouseenter={openTip}
  onmouseleave={closeTip}
  onfocusin={openTip}
  onfocusout={closeTip}
  onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') closeTip() }}
>
  {#if showSlot}<span class="slot xs muted">{label}</span>{/if}
  {#if item}
    <ItemIcon itemId={item.itemId} quality={info?.quality} size={48} />
  {/if}
  <span class="grow stack-sm min">
    <span class="row-tight top">
      <span class="name truncate q{info?.quality ?? ''}">
        {info?.name ?? 'Empty'}
      </span>
      {#if info?.itemLevel}
        <span class="ilvl xs">{info.itemLevel}</span>
      {/if}
      {#if info?.qualityLabel}
        <span class="sr-only">{info.qualityLabel} quality.</span>
      {/if}
      {#if info?.unverified && item}
        <span class="chip xs" title="The catalog does not carry this item, so this is the addon's own label">
          unverified
        </span>
      {/if}
    </span>
    {#if item && info}
      <span class="xs faint truncate">
        {#if meta}{meta}{:else if !compact && info.stats}{info.stats}{/if}
      </span>

    {:else}
      <span class="xs faint">Nothing equipped in this slot</span>
    {/if}
  </span>
  {#if trailing}<span class="trailing nowrap num">{trailing}</span>{/if}
</svelte:element>
{#if item && info}<ItemLink itemId={item.itemId} name={info.name} resolved={info.resolved} compact>↗<span class="sr-only">Wowhead</span></ItemLink>{/if}
</div>

{#if tipAt && info && item}
  <!-- Portalled: a glass panel ancestor (backdrop-filter) would otherwise
       become the containing block for this fixed layer and misplace it. -->
  <Portal>
  <div
    class="tip-layer"
    style:left="{tipAt.x}px"
    style:top="{tipAt.y}px"
    style:transform={tipAt.above ? 'translateY(-100%)' : undefined}
  >
    <ItemTooltip item={info.resolved ?? { itemId: item.itemId, name: info.name }} note={item?.source === 'hypothetical' ? 'You do not own this item; it is in the search as a hypothetical.' : undefined} />
  </div>
  </Portal>
{/if}

<style>
  .item-with-link { display: flex; align-items: center; gap: var(--s2); min-width: 0; }
  /* Item row reads like tooltip: quality rim, name in quality color, scaled stats; rim not sole signal (quality name announced, ilvl beside name). */
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s3);
    width: 100%;
    padding: var(--s2) var(--s3);
    padding-left: calc(var(--s3) + 3px);
    border: 1px solid var(--border);
    border-radius: var(--r2);
    background:
      radial-gradient(22rem circle at var(--mx, -30rem) var(--my, 50%), color-mix(in oklab, var(--q, var(--accent)) 12%, transparent), transparent 55%),
      linear-gradient(90deg, color-mix(in oklab, var(--q, var(--border)) 9%, transparent), transparent 45%),
      rgb(255 255 255 / 0.025);
    text-align: left;
    transition:
      border-color 0.3s var(--ease),
      background 0.3s var(--ease),
      box-shadow 0.35s var(--ease),
      transform 0.4s var(--spring);
    min-height: 0;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  .item::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: linear-gradient(180deg, color-mix(in oklab, var(--q, var(--border)) 60%, white), var(--q, var(--border)));
    box-shadow: 0 0 10px var(--q, transparent);
    opacity: 0.9;
  }
  .item:hover {
    border-color: color-mix(in oklab, var(--q, var(--border-strong)) 45%, transparent);
    box-shadow: 0 8px 26px -14px var(--q, var(--accent)), inset 0 1px 0 rgb(255 255 255 / 0.04);
  }
  .item:hover .name { text-shadow: 0 0 14px color-mix(in oklab, currentColor 55%, transparent); }
  .item.compact { padding: 0.3rem var(--s2); }
  .item.card { padding: var(--s4); min-height: 6rem; gap: var(--s3); align-items: center; }
  .card .top { flex-wrap: wrap; gap: var(--s1); }
  .card .name { white-space: normal; line-height: 1.35; font-size: var(--fs-md); }
  .card .min { gap: 0.2rem; }
  .card .trailing { position: absolute; right: var(--s2); top: var(--s1); font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
  .card.selected { box-shadow: inset 0 0 0 1px var(--accent-border); }
  .interactive { cursor: pointer; }
  .interactive:hover { transform: translateX(2px); }
  .selected {
    border-color: var(--accent-border);
    background: linear-gradient(90deg, rgb(101 203 229 / 0.18), rgb(101 203 229 / 0.05));
    box-shadow: 0 0 0 1px rgb(101 203 229 / 0.25), 0 10px 30px -16px var(--accent-glow);
  }
  .selected::after { content: '✓'; color: var(--accent); font-weight: 700; flex: none; }
  .slot { flex: none; width: 5.25rem; }
  .min { min-width: 0; gap: 0; }
  /* Every nesting level needs min-width: 0 or longest stat line sets row width and page scrolls sideways. */
  .top { flex-wrap: nowrap; min-width: 0; max-width: 100%; }
  .min > span { min-width: 0; max-width: 100%; }
  .name { font-weight: 580; transition: text-shadow 0.3s var(--ease); }
  .ilvl {
    flex: none;
    padding: 0 0.35rem;
    border-radius: var(--r1);
    border: 1px solid var(--border);
    background: var(--well);
    color: var(--text-muted);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .trailing { flex: none; font-weight: 600; font-size: var(--fs-sm); }
  /* Fixed position so tooltip escapes scrolling or clipped ancestors. */
  .tip-layer { position: fixed; z-index: 40; pointer-events: none; }
  @media (max-width: 30rem) {
    .slot { width: 4rem; }
  }
  @media (prefers-reduced-motion: reduce) { .interactive { transition: none; } .interactive:hover { transform: none; } }
</style>
