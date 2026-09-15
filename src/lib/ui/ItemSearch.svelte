<script lang="ts">
  // Catalog item search (P08.2): add item character doesn't own (marked hypothetical whole search).
  import { SLOT_LABELS, type GearSlot, type ItemInstance } from '../import/character'
  import type { ResolvedItem } from '../catalog/types'
  import { app, catalogClient } from '../app.svelte'
  import { hypotheticalItem } from '../hypothetical'
  import { fmtInt } from '../format'
  import Dialog from './Dialog.svelte'
  import ItemIcon from './ItemIcon.svelte'
  import ItemLink from './ItemLink.svelte'
  import ItemUpgradePicker from './ItemUpgradePicker.svelte'

  interface Props {
    open: boolean
    slot: GearSlot | null
    classId?: number
    onclose: () => void
    onadd: (item: ItemInstance) => void
  }
  let { open = $bindable(), slot, classId, onclose, onadd }: Props = $props()

  let text = $state('')
  let minItemLevel = $state(0)
  let results = $state<ResolvedItem[]>([])
  let searching = $state(false)
  let picked = $state<ResolvedItem | null>(null)
  let draft = $state<ItemInstance | null>(null)
  let original = $state<ItemInstance | null>(null)
  let draftResolved = $state<ResolvedItem | null>(null)
  let searched = $state(false)

  // Debounced (typing doesn't queue worker call per keystroke).
  $effect(() => {
    const client = catalogClient()
    const query = text.trim()
    const currentSlot = slot
    if (!client || !open) { searching = false; return }
    if (query.length < 3) { results = []; searched = false; searching = false; return }
    let cancelled = false
    searching = true
    const t = setTimeout(() => {
      void client
        .search({
          text: query,
          slot: currentSlot ?? undefined,
          classId,
          minItemLevel: minItemLevel || undefined,
          limit: 60,
        })
        .then((items) => {
          if (cancelled) return
          results = items
          searched = true
        })
        .catch(() => { if (!cancelled) { results = []; searched = true } })
        .finally(() => { if (!cancelled) searching = false })
    }, 220)
    return () => { cancelled = true; clearTimeout(t) }
  })

  $effect(() => {
    const client = catalogClient()
    const current = draft
    if (!client || !current || !open) return
    let cancelled = false
    draftResolved = null
    void client.resolve([current])
      .then(({ items }) => { if (!cancelled) draftResolved = items.get(current.instanceId) ?? null })
      .catch(() => { if (!cancelled) draftResolved = null })
    return () => { cancelled = true }
  })

  function pick(item: ResolvedItem): void {
    if (!slot) return
    picked = item
    original = hypotheticalItem({ itemId: item.itemId, slot, bonusIds: item.bonusIds })
    draft = original
  }

  function add(): void {
    if (!draft || !slot) return
    onadd(draft)
    reset()
  }

  function reset(): void {
    text = ''
    picked = null
    draft = null
    original = null
    draftResolved = null
    results = []
    searched = false
    open = false
    onclose()
  }
</script>

<Dialog
  bind:open
  title={slot ? `Add an item for ${SLOT_LABELS[slot]}` : 'Add an item'}
  width="38rem"
  onclose={reset}
>
  <div class="stack">
    {#if app.catalogState !== 'ready'}
      <p class="small muted">Game data is still loading.</p>
    {:else}
      <div class="fields">
        <label class="field grow">
          <span>Item name</span>
          <input
            type="search"
            bind:value={text}
            placeholder="At least three characters"
            autocomplete="off"
          />
        </label>
        <label class="field">
          <span>Minimum item level</span>
          <input type="number" min="0" max="1000" step="1" bind:value={minItemLevel} />
        </label>
      </div>

      {#if searching}
        <p class="xs muted" aria-live="polite">Searching…</p>
      {:else if searched && !results.length}
        <p class="small muted">
          Nothing in the catalog matches that name for {slot ? SLOT_LABELS[slot] : 'this slot'}.
        </p>
      {/if}

      {#if results.length}
        <ul class="results" aria-label="Search results">
          {#each results as item (item.instanceId)}
            <li>
              <ItemLink itemId={item.itemId} name={item.name} resolved={item} selected={picked?.itemId === item.itemId} onselect={() => pick(item)}>
                <ItemIcon itemId={item.itemId} quality={item.quality} size={24} />
                <span class="grow truncate q{item.quality}">{item.name}</span>
                <span class="xs faint nowrap">{item.qualityLabel} · ilvl {item.itemLevel}</span>
              </ItemLink>
            </li>
          {/each}
        </ul>
        {#if results.length >= 60}
          <p class="xs faint">Showing the first 60 matches. Narrow the name to see more.</p>
        {/if}
      {/if}

      {#if picked && draft && original}
        <div class="panel stack-sm">
          <div class="row-tight">
            <ItemIcon itemId={picked.itemId} quality={picked.quality} size={32} />
            <strong class="small q{picked.quality}"><ItemLink itemId={picked.itemId} name={picked.name} resolved={draftResolved} /></strong>
          </div>
          <p class="xs muted">
            {(draftResolved?.stats ?? [])
              .filter((s) => s.value)
              .slice(0, 4)
              .map((s) => `${fmtInt(s.value ?? 0)} ${s.label ?? `stat ${s.type}`}`)
              .join(' · ') || 'Scaled stats are not available yet.'}
          </p>
          <ItemUpgradePicker item={draft} {original} resolved={draftResolved} catalogSearch onchange={(item) => { draft = item }} />
          {#if draftResolved?.unresolved.length}
            <ul class="xs muted">
              {#each draftResolved.unresolved as u, i (i)}<li>{u}</li>{/each}
            </ul>
          {/if}
          <p class="xs faint">
            This item is hypothetical: you do not own it, Frostsim knows nothing about what it
            would cost to obtain, and every result that includes it is labelled accordingly.
          </p>
        </div>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <button onclick={reset}>Cancel</button>
    <button class="primary" disabled={!draft} onclick={add}>Add to the search</button>
  {/snippet}
</Dialog>

<style>
  .results li { display: flex; align-items: center; gap: var(--s2); padding-right: var(--s2); }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 18rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--r2);
  }
</style>
