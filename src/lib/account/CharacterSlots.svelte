<script lang="ts">
  // Character slots on the Character page (CLAUDE.md D15; DESIGN.md C5, C6, C10). Each slot holds one addon export plus its gear and DPS
  // history; a slot can be loaded here, overwritten with the open character or cleared. Characters over the limit after a downgrade
  // stay usable but block adding. The open character's own slot shows its history below the grid.
  import { CloudDownload, CloudUpload, Lock, Plus, Trash2 } from '@lucide/svelte'
  import PremiumPill from './PremiumPill.svelte'
  import { activeCharacter, activeStored, app, saveCharacter, toast } from '../app.svelte'
  import { isSameCharacter, type ImportedCharacter } from '../import/character'
  import { titleCase } from '../format'
  import { api, AccountError } from './api'
  import { account, cloudDownload, computeEntitled, signedOut } from './state.svelte'
  import { UNLIMITED_SLOTS, slotsLabel } from './plans'
  import SlotHistory from './SlotHistory.svelte'

  interface Who { name: string; className: string; spec?: string; server?: string; region?: string }
  interface Slot { id: string; label: string; bytes: number; updatedAt: string; itemLevel?: number; who?: Who }

  let cloud = $state<{ slots: number; characters: Slot[] } | null>(null)
  let busy = $state('')
  let armed = $state('')

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const current = $derived(character ? ((app.draft ? '' : stored?.label) || character.name || 'Character').slice(0, 100) : '')
  const used = $derived(cloud?.characters.length ?? 0)
  const unlimited = $derived((cloud?.slots ?? 0) >= UNLIMITED_SLOTS)
  const over = $derived(cloud && !unlimited ? Math.max(0, used - cloud.slots) : 0)
  const empty = $derived(cloud && !over ? Math.max(0, (unlimited ? used + 1 : cloud.slots) - used) : 0)
  /** The slot holding the open character, matched like a pasted export (name, class, realm, region). */
  const mine = $derived(character && cloud ? cloud.characters.find((s) => s.who && isSameCharacter(s.who as ImportedCharacter, character)) : undefined)
  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  // Signing in or out, or a plan change, reloads the slots. 404: the server has character slots switched off, so this hides.
  $effect(() => {
    void account.billing?.entitlements.slots
    if (account.me) void reload().catch(() => (cloud = null))
    else cloud = null
  })

  async function run(what: string, fn: () => Promise<void>): Promise<void> {
    busy = what
    armed = ''
    try {
      await fn()
    } catch (e) {
      if (e instanceof AccountError && e.status === 401) signedOut()
      toast('bad', e instanceof Error ? e.message : String(e))
    } finally {
      busy = ''
    }
  }
  async function reload(): Promise<void> {
    cloud = await api('/characters')
  }

  /** POST fills an empty slot; `into` overwrites that slot in place (PUT), so re-saving after a gear change needs no free slot. */
  const save = (into?: Slot) => run(into?.id ?? 'new', async () => {
    const c = activeCharacter()
    if (!c) return
    try {
      await api(into ? `/characters/${into.id}` : '/characters', into ? 'PUT' : 'POST', { label: current, raw: c.raw })
    } finally {
      // A 402 no-slots means this list was stale (another device saved, or the plan changed): show the real count.
      await reload()
    }
    toast('good', into ? `Updated ${into.label} in its slot.` : `Saved ${current} to a character slot.`)
  })
  const load = (s: Slot) => run(s.id, async () => {
    const saved = await api<{ label: string; raw: string }>(`/characters/${s.id}`)
    const { parsed, match } = cloudDownload(saved.raw, app.characters)
    await saveCharacter(parsed, match?.label ?? saved.label, match?.id)
    toast('good', `${match ? 'Updated' : 'Added'} ${saved.label} on this device.`)
  })
  const remove = (s: Slot) => run(s.id, async () => {
    await api(`/characters/${s.id}`, 'DELETE')
    await reload()
  })
</script>

{#if !account.me}
  <section class="panel teaser">
    <CloudUpload size={18} aria-hidden="true" />
    <span class="grow small">Keep this character on every device and track its gear and DPS over time.</span>
    <button class="sm" onclick={() => (account.open = true)}>Sign in</button>
  </section>
{:else if cloud}
  <section class="panel stack-sm" aria-labelledby="character-slots">
    <div class="spread">
      <h2 id="character-slots" class="section-title">Character slots</h2>
      <span class="row-tight">
        <span class="small muted">{used} of {slotsLabel(cloud.slots)} used</span>
        {#if !computeEntitled()}<PremiumPill text="More slots" />{/if}
      </span>
    </div>
    {#if over}
      <p class="small warn" role="status">You have {over} more than your plan's {cloud.slots}. They stay, but clear {over + 1} to save a new one.</p>
    {/if}
    <ul class="slots">
      {#each cloud.characters as s (s.id)}
        <li class="slot filled" class:open={s === mine} data-class={s.who?.className}>
          <span class="initial" aria-hidden="true">{s.label.slice(0, 1).toUpperCase()}</span>
          <span class="info">
            <strong class="truncate">{s.label}</strong>
            <span class="xs muted truncate">
              {[s.who?.spec ?? s.who?.className, s.itemLevel?.toFixed(1), date(s.updatedAt)].filter(Boolean).map((t, i) => (i ? t : titleCase(t!))).join(' · ')}
            </span>
          </span>
          <span class="actions">
            {#if armed === s.id}
              <button class="sm danger" disabled={!!busy} onclick={() => remove(s)}>Clear</button>
              <button class="sm ghost" onclick={() => (armed = '')}>Keep</button>
            {:else}
              <button class="sm ghost" disabled={!!busy} onclick={() => load(s)} title="Load onto this device" aria-label="Load {s.label} onto this device"><CloudDownload size={16} /></button>
              <button class="sm ghost" disabled={!!busy || !character} onclick={() => save(s)} title={character ? `Overwrite with ${current}` : 'Open a character to overwrite this slot'} aria-label="Overwrite {s.label} with {current}"><CloudUpload size={16} /></button>
              <button class="sm ghost" disabled={!!busy} onclick={() => (armed = s.id)} title="Clear slot and its history" aria-label="Clear {s.label}"><Trash2 size={16} /></button>
            {/if}
          </span>
        </li>
      {/each}
      {#each { length: empty }, i (i)}
        <li class="slot">
          <button class="fill" disabled={!!busy || !character || !!mine} onclick={() => save()}>
            <Plus size={18} aria-hidden="true" />
            <span class="small">{!character ? 'Empty slot' : mine ? 'Empty slot' : `Save ${current}`}</span>
          </button>
        </li>
      {/each}
      {#if !unlimited}
        <li class="slot locked">
          <a href="#/plans"><Lock size={16} aria-hidden="true" /><span class="small">More slots with a plan</span></a>
        </li>
      {/if}
    </ul>
    {#if mine}
      <SlotHistory slotId={mine.id} label={mine.label} localId={stored?.id ?? null} />
    {:else if character && cloud.characters.length}
      <p class="xs muted">Save {current} to a slot to track its item level and DPS over time.</p>
    {/if}
  </section>
{/if}

<style>
  .teaser { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) var(--s4); color: var(--text-muted); }
  .warn { color: var(--warn); margin: 0; }
  .slots { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: var(--s3); }
  .slot { display: flex; align-items: center; gap: var(--s3); min-height: 4rem; border-radius: var(--r3); min-width: 0; }
  .filled { padding: var(--s2) var(--s3); background: var(--well); border: 1px solid var(--border); border-left: 3px solid var(--class-color, var(--accent)); }
  .filled.open { border-color: var(--accent); border-left-color: var(--class-color, var(--accent)); box-shadow: 0 0 24px -12px var(--accent-glow); }
  .initial {
    flex: none; display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: var(--r2);
    font: 700 16px var(--font-display); background: color-mix(in oklab, var(--class-color, var(--accent)) 22%, transparent);
    color: var(--class-color, var(--accent));
  }
  .info { display: grid; flex: 1; min-width: 0; }
  .actions { display: flex; flex: none; }
  .actions button { padding: 0.15rem 0.4rem; }
  .fill, .locked a {
    all: unset; box-sizing: border-box; flex: 1; align-self: stretch; display: flex; align-items: center; justify-content: center; gap: var(--s2);
    border: 1px dashed var(--border-strong); border-radius: inherit; color: var(--text-muted); cursor: pointer; padding: var(--s2);
    transition: color var(--t-control) var(--ease), border-color var(--t-control) var(--ease), background var(--t-control) var(--ease);
  }
  .fill:hover:not(:disabled), .locked a:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .fill:disabled { cursor: default; opacity: 0.6; }
  .fill:focus-visible, .locked a:focus-visible { box-shadow: var(--focus); }
  .locked a { border-style: dotted; color: var(--text-faint); }
</style>
