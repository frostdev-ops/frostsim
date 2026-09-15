<script lang="ts">
  import { tick } from 'svelte'
  import type { ItemInstance } from '../import/character'
  import type { ResolvedItem } from '../catalog/types'
  import { itemUpgradeTrack, MAX_ITEM_LEVEL, upgradeTracks, withItemLevel, withUpgradeRank } from '../catalog/upgrades'

  interface Props {
    item: ItemInstance
    original?: ItemInstance
    resolved?: ResolvedItem | null
    onchange: (item: ItemInstance) => void
    disabled?: boolean
    /** Catalog may model different acquisition track. */
    catalogSearch?: boolean
  }
  let { item, original, resolved, onchange, disabled = false, catalogSearch = false }: Props = $props()
  let custom = $state(false)
  let error = $state('')
  const known = $derived(itemUpgradeTrack(item))
  const importedTrack = $derived(original ? itemUpgradeTrack(original) : null)
  const track = $derived(known?.track ?? importedTrack?.track)
  const customLevel = $derived(item.itemLevel !== undefined)
  const name = $derived(resolved?.name ?? item.addonName ?? `Item ${item.itemId}`)
  const changed = $derived(original !== undefined && item.instanceId !== original.instanceId)
  const crafted = $derived(!!(item.craftingQuality || item.craftedStats?.length || resolved?.craftingQuality))

  function update(action: () => ItemInstance): void {
    try { onchange(action()); error = '' }
    catch (err) { error = err instanceof Error ? err.message : String(err) }
  }
</script>

<div class="upgrade-picker stack-sm" role="group" aria-label="Upgrade options for {name}">
  <div class="controls">
    {#if !crafted && (catalogSearch || !importedTrack && (!known || item.upgradeTrackHypothetical))}
      <label class="field">
        <span>Hypothetical track</span>
        <select value={track?.id ?? ''} {disabled} onchange={async (e) => {
          const input = e.currentTarget
          const trackId = Number(input.value)
          if (trackId) { custom = false; update(() => withUpgradeRank(item, trackId, 1)) }
          await tick()
          input.value = String(track?.id ?? '')
        }}>
          <option value="" disabled>Choose a track</option>
          {#each upgradeTracks as choice (choice.id)}
            <option value={choice.id}>{choice.label}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if track && !crafted}
      <label class="field">
        <span>{track.label} upgrade</span>
        <select value={customLevel ? '' : known?.rank.rank ?? ''} {disabled} onchange={async (e) => {
          const input = e.currentTarget
          const rank = Number(input.value)
          if (rank && track) { custom = false; update(() => withUpgradeRank(item, track.id, rank)) }
          await tick()
          input.value = String(customLevel ? '' : known?.rank.rank ?? '')
        }}>
          <option value="" disabled>{customLevel ? 'Custom item level' : 'Choose a rank'}</option>
          {#each track.ranks as rank (rank.rank)}
            <option value={rank.rank} disabled={(rank.extended && ((importedTrack ?? known)?.track.id !== track.id || (importedTrack ?? known)?.rank.rank !== rank.rank)) || (!catalogSearch && importedTrack?.track.id === track.id && rank.rank < importedTrack.rank.rank)}>
              {rank.extended ? `Rank ${rank.rank}` : `${rank.rank}/${track.max}`} · ilvl {rank.itemLevel}{rank.extended ? ' · restricted' : ''}
            </option>
          {/each}
        </select>
      </label>
    {:else if crafted}
      <span class="xs muted">Crafted item; use a custom item level.</span>
    {:else if !catalogSearch}
      <span class="xs muted">Upgrade track unavailable in this item's data.</span>
    {/if}
    <button type="button" class="small" {disabled} aria-expanded={custom || customLevel} onclick={() => {
      if (customLevel) { custom = false; update(() => withItemLevel(item, undefined)) }
      else custom = !custom
    }}>
      {customLevel ? 'Clear custom level' : 'Custom item level'}
    </button>
    {#if changed && original}
      <button type="button" class="small" {disabled} onclick={() => { custom = false; update(() => original!) }}>Reset item</button>
    {/if}
  </div>
  {#if custom || customLevel}
    <label class="field override">
      <span>Hypothetical item level</span>
      <input type="number" min="1" max={MAX_ITEM_LEVEL} step="1" value={item.itemLevel ?? resolved?.itemLevel ?? item.addonItemLevel ?? ''} {disabled}
        onchange={async (e) => {
          const input = e.currentTarget
          if (!input.reportValidity()) return
          update(() => withItemLevel(item, input.value === '' ? undefined : input.valueAsNumber))
          await tick()
          input.value = String(item.itemLevel ?? resolved?.itemLevel ?? item.addonItemLevel ?? '')
        }} />
      <span class="hint">Tests a custom level; this does not guarantee an obtainable upgrade.</span>
    </label>
  {/if}
  {#if item.upgradeTrackHypothetical}<p class="xs muted">Hypothetical track; this item's acquisition track is not verified.</p>{/if}
  {#if known?.rank.extended && !customLevel}<p class="xs muted">Restricted rank read from this item; unlock eligibility cannot be checked.</p>{/if}
  {#if error}<p class="xs warn-text" role="alert">{error}</p>{/if}
</div>

<style>
  .controls { display: flex; flex-wrap: wrap; gap: var(--s2); align-items: end; }
  .controls .field { flex: 1 1 10rem; }
  .controls button { margin-bottom: 1px; }
  .override { max-width: 26rem; }
  .override input { max-width: 10rem; }
  .warn-text { color: var(--warn); }
</style>
