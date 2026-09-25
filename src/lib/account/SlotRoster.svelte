<script lang="ts">
  // The Character page's roster in the cloud app (CLAUDE.md D15): signed in, every card is a character slot (slots.svelte.ts), with
  // the free ones after it as places to import into. Signed out it is the plain roster, with one line on what signing in adds.
  import { Cloud, CloudUpload, HardDrive, Lock, Plus } from '@lucide/svelte'
  import Roster from '../ui/Roster.svelte'
  import PremiumPill from './PremiumPill.svelte'
  import { app } from '../app.svelte'
  import { account, computeEntitled } from './state.svelte'
  import { UNLIMITED_SLOTS, slotsLabel } from './plans'
  import { slotOf, slots, syncSlots } from './slots.svelte'

  let { onimport }: { onimport: () => void } = $props()

  const on = $derived(!!account.me && slots.on)
  const used = $derived(slots.list.length)
  const unlimited = $derived(slots.total >= UNLIMITED_SLOTS)
  const empty = $derived(unlimited ? 1 : Math.max(0, slots.total - used))
  const deviceOnly = $derived(app.characters.filter((c) => !slotOf(c.id)).length)

  // Opening the page, signing in or out, and a plan change each sync: a new slot takes a character that had none.
  $effect(() => {
    void account.me
    void account.billing?.entitlements.slots
    void syncSlots()
  })
</script>

{#snippet badge(id: string)}
  {#if slotOf(id)}<span class="xs tag"><Cloud size={12} aria-hidden="true" /> Cloud slot</span>
  {:else}<span class="xs tag muted"><HardDrive size={12} aria-hidden="true" /> This device only</span>{/if}
{/snippet}

{#snippet tail()}
  {#each { length: empty }, i (i)}
    <button class="slot" onclick={onimport}><Plus size={18} aria-hidden="true" /><span class="small">{unlimited ? 'Import a character' : 'Empty slot: import a character'}</span></button>
  {/each}
  {#if !unlimited}<a class="slot locked" href="#/plans"><Lock size={16} aria-hidden="true" /><span class="small">More slots with a plan</span></a>{/if}
{/snippet}

{#if on}
  <div class="spread">
    <h2 class="section-title">Characters</h2>
    <span class="row-tight">
      <span class="small muted">{unlimited ? `${used} character${used === 1 ? '' : 's'} · unlimited slots` : `${used} of ${slotsLabel(slots.total)} slot${slots.total === 1 ? '' : 's'} used`}</span>
      {#if !computeEntitled()}<PremiumPill text="More slots" />{/if}
    </span>
  </div>
  {#if used > slots.total}
    <p class="small warn" role="status">You have {used - slots.total} more than your plan's {slots.total}. They stay, and importing a new character waits until you delete {used - slots.total + 1}.</p>
  {:else if deviceOnly}
    <p class="small muted" role="status">{deviceOnly} character{deviceOnly === 1 ? ' is' : 's are'} on this device only because every slot is in use. Delete one to make room.</p>
  {/if}
{/if}
<Roster {onimport} badge={on ? badge : undefined} tail={on ? tail : undefined} />
{#if !account.me}
  <p class="teaser small muted">
    <CloudUpload size={16} aria-hidden="true" />
    <span class="grow">Sign in to keep your characters on every device and track their gear and DPS over time.</span>
    <button class="sm" onclick={() => (account.open = true)}>Sign in</button>
  </p>
{/if}

<style>
  .warn { color: var(--warn); margin: 0; }
  p { margin: 0; }
  .tag { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); }
  .tag.muted { color: var(--text-muted); }
  .teaser { display: flex; align-items: center; gap: var(--s3); }
  .slot {
    all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: var(--s2); min-height: 4.25rem;
    padding: var(--s2); border-radius: var(--r3); border: 1px dashed var(--border-strong); color: var(--text-muted); cursor: pointer;
    transition: color var(--t-control) var(--ease), border-color var(--t-control) var(--ease), background var(--t-control) var(--ease);
  }
  .slot:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .slot:focus-visible { box-shadow: var(--focus); }
  .locked { border-style: dotted; color: var(--text-faint); }
</style>
