<script lang="ts">
  // Item tooltip: name in quality color, level, bind, unique, stats, sockets, effects, set bonuses, flavor.
  // Stats are ALWAYS engine-resolved instance stats, never API generic copy; not the only way to see data.
  import type { ResolvedItem } from '../catalog/types'
  import { mediaVersion, tooltipFor } from '../media.svelte'
  import { fmtInt } from '../format'
  import { itemUpgradeTrack } from '../catalog/upgrades'

  interface Props {
    /** The engine-resolved instance. Authoritative for stats and item level. */
    item: Pick<ResolvedItem, 'itemId' | 'name'> & Partial<ResolvedItem>
    /** Extra note rendered at the bottom, e.g. "you do not own this". */
    note?: string
  }
  let { item, note }: Props = $props()

  const extra = $derived.by(() => {
    void mediaVersion.n
    return tooltipFor(item.itemId)
  })
  const rich = $derived(extra?.status === 'ready' ? extra.tooltip : null)
  const provenance = $derived(extra?.status === 'ready' ? extra.provenance : null)
  const upgrade = $derived(item.instance ? itemUpgradeTrack(item.instance) : null)

  const stats = $derived(
    (item.stats ?? [])
      .filter((s) => s.value !== null && s.value !== 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
  )
</script>

<div class="tip" role="tooltip">
  <p class="name q{item.quality ?? ''}">{item.name}</p>
  {#if item.itemLevel !== undefined}
  <p class="xs muted">
    Item level {item.itemLevel}
    {#if item.computedItemLevel !== item.itemLevel}
      <span class="faint">(computed {item.computedItemLevel}, overridden)</span>
    {/if}
    · {item.qualityLabel}
    {#if upgrade}· {upgrade.track.label} {upgrade.rank.extended ? `rank ${upgrade.rank.rank} (restricted)` : `${upgrade.rank.rank}/${upgrade.track.max}`}
    {:else if item.track?.label}· {item.track.label}{/if}
  </p>
  {:else}<p class="xs muted">Item {item.itemId} · Instance stats unavailable</p>{/if}
  {#if item.instance?.upgradeTrackHypothetical}<p class="xs muted">Hypothetical upgrade track</p>{/if}

  {#if rich?.bindingText || rich?.isUniqueEquipped || rich?.requiredLevel}
    <p class="xs muted">
      {#if rich.bindingText}{rich.bindingText}{/if}
      {#if rich.isUniqueEquipped}{rich.bindingText ? ' · ' : ''}Unique-Equipped{/if}
      {#if rich.requiredLevel}{rich.bindingText || rich.isUniqueEquipped ? ' · ' : ''}Requires level {rich.requiredLevel}{/if}
    </p>
  {/if}

  {#if stats.length}
    <ul class="stats">
      {#each stats as s}
        <li>
          <span class="v">{(s.value ?? 0) > 0 ? '+' : ''}{fmtInt(s.value ?? 0)}</span>
          {s.label ?? `stat ${s.type}`}
        </li>
      {/each}
    </ul>
  {/if}

  {#if item.sockets?.length}
    <p class="xs muted">
      {item.sockets.length} socket{item.sockets.length > 1 ? 's' : ''}
      {#if item.gemIds?.filter(Boolean).length}
        · {item.gemIds.filter(Boolean).length} filled
      {:else}· empty{/if}
    </p>
  {/if}

  {#if item.descriptors?.length}
    <p class="xs accent-text">{item.descriptors.join(' · ')}</p>
  {/if}

  {#if rich?.spells?.length}
    <ul class="effects">
      {#each rich.spells as e, i (i)}
        <li class:use={e.trigger === 'USE'}>
          {#if e.trigger}<strong>{e.trigger === 'USE' ? 'Use:' : 'Equip:'}</strong>{/if}
          {e.description}
        </li>
      {/each}
    </ul>
    <p class="xs faint">
      The numbers in those lines are for a base copy of the item, not this one.
    </p>
  {/if}

  {#if rich?.set?.name}
    <div class="set">
      <p class="xs"><strong>{rich.set.name}</strong></p>
      {#each rich.set.bonuses as b, i (i)}
        <p class="xs muted">
          {#if b.requiredCount}<span class="pieces">({b.requiredCount})</span>{/if}
          {b.text}
        </p>
      {/each}
    </div>
  {/if}

  {#if rich?.description}<p class="flavor xs">“{rich.description}”</p>{/if}
  {#if rich?.sourceLine}<p class="xs faint">Source: {rich.sourceLine}</p>{/if}

  {#if item.unresolved?.length}
    <p class="xs warn-text">
      Not derivable from the catalog: {item.unresolved.join('; ')}.
    </p>
  {/if}

  {#if note}<p class="xs faint">{note}</p>{/if}

  {#if extra?.status === 'loading'}
    <p class="xs faint">Loading item details…</p>
  {:else if extra?.status === 'failed'}
    <p class="xs faint">Item details unavailable; everything above is local data.</p>
  {/if}

  {#if rich && provenance}
    <!-- Blizzard attribution required where their data appears, read from same object. -->
    <p class="xs faint attribution">{provenance.attribution}</p>
  {/if}
</div>

<style>
  .tip {
    width: min(22rem, calc(100vw - 2rem));
    padding: var(--s3);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: linear-gradient(180deg, var(--glass-hi), transparent 35%), var(--glass-strong);
    -webkit-backdrop-filter: blur(24px) saturate(1.6);
    backdrop-filter: blur(24px) saturate(1.6);
    box-shadow: var(--shadow-3), inset 0 1px 0 var(--rim);
    animation: tip-in 0.35s var(--ease);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: var(--fs-sm);
    text-align: left;
  }
  .name { font-weight: 650; font-size: var(--fs-md); }
  .stats { list-style: none; margin: 0.15rem 0; padding: 0; display: grid; gap: 0.05rem; }
  .stats .v { font-variant-numeric: tabular-nums; }
  .effects {
    list-style: none;
    margin: 0.15rem 0;
    padding: 0;
    display: grid;
    gap: 0.15rem;
    font-size: var(--fs-xs);
    color: var(--good);
  }
  .effects .use { color: var(--accent); }
  .set { margin-top: 0.2rem; }
  .pieces { font-variant-numeric: tabular-nums; color: var(--text); }
  .flavor { color: var(--q-legendary); font-style: italic; }
  .accent-text { color: var(--accent); }
  .warn-text { color: var(--warn); }
  @keyframes tip-in { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
  @media (prefers-reduced-motion: reduce) { :global(:root:not([data-motion='full'])) .tip { animation: none; } }
  :global(:root[data-motion='reduced']) .tip { animation: none; }
  .attribution { border-top: 1px solid var(--border); padding-top: 0.25rem; margin-top: 0.15rem; }
</style>
