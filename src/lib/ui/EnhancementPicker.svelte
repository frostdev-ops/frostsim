<script lang="ts">
  import { GEAR_SLOTS, SLOT_LABELS, type GearSlot, type ItemInstance } from '../import/character'
  import type { Consumable, EnchantOption } from '../catalog/types'
  import type { GemOption } from '../catalog/catalog'
  import { app, catalogClient } from '../app.svelte'
  import { resolveItem } from '../items'
  import ItemIcon from './ItemIcon.svelte'
  import ItemLink from './ItemLink.svelte'
  import ChoiceSelect from './ChoiceSelect.svelte'
  import { plainGameText } from '../format'

  interface Props {
    character: { equipped: ItemInstance[]; level?: number }
    items?: ItemInstance[]
    gems: Partial<Record<GearSlot, number[][]>>
    enchants: Partial<Record<GearSlot, number[]>>
    consumables: Record<string, string[]>
  }
  let { character, items = [], gems = $bindable(), enchants = $bindable(), consumables = $bindable() }: Props = $props()
  const KINDS: { key: string; kind: Consumable['kind']; label: string; description: string }[] = [
    { key: 'flask', kind: 'flask', label: 'Flasks & phials', description: 'Long-lasting stat and combat bonuses' },
    { key: 'potion', kind: 'potion', label: 'Potions', description: 'Combat potions used by your action list' },
    { key: 'food', kind: 'food', label: 'Food', description: 'Meals and feasts for your character' },
  ]
  let gemOptions = $state(new Map<GearSlot, GemOption[]>())
  let enchantOptions = $state(new Map<GearSlot, EnchantOption[]>())
  let consumableOptions = $state(new Map<string, Consumable[]>())
  let loaded = $state(false)
  let error = $state('')
  let retry = $state(0)
  let searches = $state<Record<string, string>>({})
  let drafts = $state<Record<string, number[]>>({})
  let activeGemSlot = $state<GearSlot>('head')
  let activeEnchantSlot = $state<GearSlot>('main_hand')

  const slotItems = $derived.by(() => {
    const slots = new Map<GearSlot, ItemInstance[]>()
    for (const item of new Map([...character.equipped, ...items].map((i) => [i.instanceId, i])).values()) {
      const resolved = resolveItem(item, app.resolved)
      if (!resolved) continue
      for (const slot of resolved.eligibleSlots) slots.set(slot, [...(slots.get(slot) ?? []), item])
    }
    return slots
  })
  const socketLayouts = $derived.by(() => {
    const slots = new Map<GearSlot, number[][]>()
    for (const [slot, candidates] of slotItems) {
      const layouts = new Map<string, number[]>()
      for (const item of candidates) {
        const sockets = resolveItem(item, app.resolved)?.sockets ?? []
        if (sockets.length) layouts.set(sockets.join('/'), sockets)
      }
      if (layouts.size) slots.set(slot, [...layouts.values()])
    }
    return slots
  })
  const gemSlot = $derived(socketLayouts.has(activeGemSlot) ? activeGemSlot : [...socketLayouts.keys()][0])
  const enchantSlot = $derived(enchantOptions.has(activeEnchantSlot) ? activeEnchantSlot : [...enchantOptions.keys()][0])

  // Capture dependencies before awaiting; changed inventory invalidates old responses.
  $effect(() => {
    const ready = app.catalogState === 'ready'
    const selected = slotItems
    const layouts = socketLayouts
    const level = character.level ?? 0
    retry
    const client = catalogClient()
    if (!ready || !client) return
    let cancelled = false
    loaded = false
    error = ''
    void Promise.all([
      Promise.all([...layouts].map(async ([slot, variants]) =>
        [slot, (await client.gemsFor([...new Set(variants.flat())])).filter(gem => !level || (gem.reqLevel ?? 0) <= level).sort((a, b) => (b.itemLevel ?? 0) - (a.itemLevel ?? 0) || (b.craftingQuality ?? 0) - (a.craftingQuality ?? 0))] as const)),
      Promise.all([...selected].map(async ([slot, candidates]) => {
        const rows = (await Promise.all(candidates.map((item) => client.enchantsFor(item, level)))).flat()
        return [slot, [...new Map(rows.map((e) => [e.enchantId, { ...e, name: plainGameText(e.name ?? e.option) }])).values()].sort((a, b) => b.enchantId - a.enchantId)] as const
      })),
      Promise.all(KINDS.map(async (c) => [c.key, (await client.consumables(c.kind))
        .filter((v) => !level || v.reqLevel <= level)
        .sort((a, b) => b.level - a.level || b.craftingQuality - a.craftingQuality || a.name.localeCompare(b.name))] as const)),
    ]).then(([gemRows, enchantRows, consumableRows]) => {
      if (cancelled) return
      gemOptions = new Map(gemRows)
      enchantOptions = new Map(enchantRows.filter(([, rows]) => rows.length))
      consumableOptions = new Map(consumableRows)
      loaded = true
    }).catch((e) => {
      if (!cancelled) error = e instanceof Error ? e.message : 'Could not load enhancement options.'
    })
    return () => { cancelled = true }
  })

  function matches(key: string, text: string): boolean {
    return text.toLocaleLowerCase().includes((searches[key] ?? '').trim().toLocaleLowerCase())
  }
  function toggleEnchant(slot: GearSlot, id: number): void {
    const list = enchants[slot] ?? []
    enchants = { ...enchants, [slot]: list.includes(id) ? list.filter((v) => v !== id) : [...list, id] }
  }
  function toggleConsumable(key: string, option: string): void {
    const list = consumables[key] ?? []
    consumables = { ...consumables, [key]: list.includes(option) ? list.filter((v) => v !== option) : [...list, option] }
  }
  function draftKey(slot: GearSlot, layout: number[]): string { return `${slot}:${layout.join('/')}` }
  function setDraft(key: string, socket: number, id: number, count: number): void {
    const value = drafts[key] ?? Array<number>(count).fill(0)
    drafts = { ...drafts, [key]: value.map((v, i) => i === socket ? id : v) }
  }
  function addGems(slot: GearSlot, layout: number[]): void {
    const value = drafts[draftKey(slot, layout)] ?? Array<number>(layout.length).fill(0)
    if (!(gems[slot] ?? []).some((g) => g.join('/') === value.join('/'))) {
      gems = { ...gems, [slot]: [...(gems[slot] ?? []), [...value]] }
    }
  }
  function duplicateUnique(slot: GearSlot, layout: number[]): boolean {
    const ids = drafts[draftKey(slot, layout)] ?? []
    return (gemOptions.get(slot) ?? []).some((gem) => gem.uniqueEquipped && ids.filter((id) => id === gem.itemId).length > 1)
  }
  function gemName(slot: GearSlot, id: number): string {
    return id ? gemOptions.get(slot)?.find((g) => g.itemId === id)?.name ?? `Gem ${id}` : 'Empty socket'
  }
</script>

<section id="gear-enhancements" class="enhancement-section" aria-labelledby="enhancements-title">
  <header class="section-heading"><h2 id="enhancements-title">Gems & enchants</h2></header>
  {#if app.catalogState !== 'ready'}
    <p class="muted" role="status">Waiting for game data…</p>
  {:else if error}
    <p role="alert">{error} <button type="button" onclick={() => retry++}>Retry</button></p>
  {:else if !loaded}
    <p class="muted" role="status">Loading gems, enchants and consumables…</p>
  {:else}
    <div class="category-heading"><div><h3>Gems</h3></div><span class="chip">{Object.values(gems).reduce((sum, values) => sum + (values?.length ?? 0), 0)} sets selected</span></div>
    {#if gemSlot}
      <div class="slot-tabs" aria-label="Gem slots">
        {#each GEAR_SLOTS.filter((slot) => socketLayouts.has(slot)) as slot (slot)}<button type="button" class:active={gemSlot === slot} aria-pressed={gemSlot === slot} onclick={() => activeGemSlot = slot}>{SLOT_LABELS[slot]}{#if gems[slot]?.length}<span>{gems[slot]!.length}</span>{/if}</button>{/each}
      </div>
      <div class="gem-editor">
        <label class="search-label">Find gems<input type="search" placeholder="Search all compatible gems" bind:value={searches[`gem:${gemSlot}`]} /></label>
        <div class="gem-layouts">
          {#each socketLayouts.get(gemSlot) ?? [] as layout (layout.join('/'))}
            {@const key = draftKey(gemSlot, layout)}
            <div class="gem-composer">
              <h4>{layout.length}-socket items</h4>
              {#each layout as color, i (`${key}:${i}`)}
                <ChoiceSelect label={`Socket ${i + 1}`} value={String(drafts[key]?.[i] ?? 0)} onchange={value => setDraft(key, i, Number(value), layout.length)} options={[
                  { value: '0', label: 'Empty socket' },
                  ...(gemOptions.get(gemSlot) ?? []).filter(g => ((color & g.color) !== 0 || color === 0) && (g.itemId === drafts[key]?.[i] || matches(`gem:${gemSlot}`, g.name))).map(gem => ({ value: String(gem.itemId), label: gem.name + (gem.craftingQuality ? ' · Quality ' + gem.craftingQuality : '') + (gem.uniqueEquipped ? ' · Unique' : ''), itemId: gem.itemId }))
                ]} />
              {/each}
              <button type="button" disabled={duplicateUnique(gemSlot, layout)} onclick={() => addGems(gemSlot, layout)}>+ Add gem set</button>
              {#if duplicateUnique(gemSlot, layout)}<p class="help">A unique gem can only fill one socket.</p>{/if}
            </div>
          {/each}
        </div>
        {#each gems[gemSlot] ?? [] as loadout, i (loadout.join('/'))}<div class="chosen-set"><span>{#each loadout as id, socket (socket)}{#if socket} + {/if}{#if id}<ItemLink itemId={id} name={gemName(gemSlot, id)} />{:else}Empty socket{/if}{/each}</span><button type="button" aria-label={`Remove gem set ${i + 1} from ${SLOT_LABELS[gemSlot]}`} onclick={() => gems = { ...gems, [gemSlot]: gems[gemSlot]!.filter((_, n) => n !== i) }}>Remove</button></div>{/each}

      </div>
    {:else}<p class="empty-state">Your selected gear has no known sockets. Select a socketed item to compare gems.</p>{/if}

    <div class="category-heading"><div><h3>Enchants</h3></div><span class="chip">{Object.values(enchants).reduce((sum, values) => sum + (values?.length ?? 0), 0)} selected</span></div>
    {#if enchantSlot}
      <div class="slot-tabs" aria-label="Enchant slots">{#each GEAR_SLOTS.filter((slot) => enchantOptions.has(slot)) as slot (slot)}<button type="button" class:active={enchantSlot === slot} aria-pressed={enchantSlot === slot} onclick={() => activeEnchantSlot = slot}>{SLOT_LABELS[slot]}{#if enchants[slot]?.length}<span>{enchants[slot]!.length}</span>{/if}</button>{/each}</div>
      <label class="search-label">Find enchants for {SLOT_LABELS[enchantSlot]}<input type="search" placeholder="Search by name or rank" bind:value={searches[`enchant:${enchantSlot}`]} /></label>
      <div class="option-grid enchant-options">
        <div class="option-card unchanged"><span class="checkmark" aria-hidden="true">✓</span><span>Existing enchant<small>Always included</small></span></div>
        <label class="option-card" class:selected={(enchants[enchantSlot] ?? []).includes(0)}><input type="checkbox" checked={(enchants[enchantSlot] ?? []).includes(0)} onchange={() => toggleEnchant(enchantSlot, 0)} /><span>No enchant<small>Compare without an enchant</small></span></label>
        {#each (enchantOptions.get(enchantSlot) ?? []).filter((e) => matches(`enchant:${enchantSlot}`, `${e.name ?? e.option} ${e.rank ? `Rank ${e.rank}` : ''}`)) as enchant (enchant.enchantId)}
          <label class="option-card" class:selected={(enchants[enchantSlot] ?? []).includes(enchant.enchantId)}><input type="checkbox" checked={(enchants[enchantSlot] ?? []).includes(enchant.enchantId)} onchange={() => toggleEnchant(enchantSlot, enchant.enchantId)} /><span>{enchant.name ?? enchant.option}{#if enchant.rank}<small class="quality">Rank {enchant.rank}</small>{/if}</span></label>
        {:else}<p class="help">No enchants match your search.</p>{/each}
      </div>
      {#if enchants[enchantSlot]?.length}<button type="button" class="clear-selection" onclick={() => enchants = { ...enchants, [enchantSlot]: [] }}>Clear {SLOT_LABELS[enchantSlot]} alternatives</button>{/if}
    {:else}<p class="empty-state">No compatible enchants are available for your selected gear.</p>{/if}
  {/if}
</section>

<section id="gear-consumables" class="enhancement-section" aria-labelledby="consumables-title">
  <header class="section-heading"><h2 id="consumables-title">Consumables</h2></header>
  {#if loaded}
    <div class="consumable-grid">
      {#each KINDS as kind (kind.key)}
        <div class="consumable-category">
          <header><h3>{kind.label}</h3><span class="chip">{consumables[kind.key]?.length ? `${consumables[kind.key].length} selected` : 'Unchanged'}</span></header>

          <label class="search-label">Find {kind.label.toLowerCase()}<input type="search" placeholder="Search by name or quality" bind:value={searches[kind.key]} /></label>
          <div class="consumable-options">
            <div class="option-card unchanged"><span class="checkmark" aria-hidden="true">✓</span><span>Profile defaults<small>Always included</small></span></div>
            <!-- Pinned engine/player/consumable.cpp accepts "disabled" for every type. -->
            <label class="option-card" class:selected={(consumables[kind.key] ?? []).includes('disabled')}><input type="checkbox" checked={(consumables[kind.key] ?? []).includes('disabled')} onchange={() => toggleConsumable(kind.key, 'disabled')} /><span>None<small>Disable this consumable</small></span></label>
            {#each (consumableOptions.get(kind.key) ?? []).filter((v) => matches(kind.key, `${v.name} Quality ${v.craftingQuality} Q${v.craftingQuality}`)) as item (item.itemId)}
              <label class="option-card" class:selected={(consumables[kind.key] ?? []).includes(item.option)}><input type="checkbox" checked={(consumables[kind.key] ?? []).includes(item.option)} onchange={() => toggleConsumable(kind.key, item.option)} /><ItemIcon itemId={item.itemId} size={30} /><span><ItemLink itemId={item.itemId} name={item.name} /><small>{#if item.craftingQuality}<span class="quality">Quality {item.craftingQuality}</span> · {/if}Item level {item.level}</small></span></label>
            {:else}<p class="help">No consumables match your search.</p>{/each}
          </div>
          {#if consumables[kind.key]?.length}<button type="button" class="clear-selection" onclick={() => consumables = { ...consumables, [kind.key]: [] }}>Clear alternatives</button>{/if}
        </div>
      {/each}
    </div>
  {:else}<p class="muted">Consumable options will appear when game data is ready.</p>{/if}
</section>

<style>
  .enhancement-section { scroll-margin-top: 9rem; padding: var(--s5); border: 1px solid var(--border); border-radius: var(--r4); background: var(--surface); }
  .section-heading { margin-bottom: var(--s5); max-width: 48rem; }
  .section-heading h2 { font-size: 1.4rem; margin: var(--s2) 0; }
  .help { color: var(--text-muted); font-size: var(--fs-md); line-height: 1.6; }
  .category-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); margin: var(--s6) 0 var(--s4); }
  h3 { font-size: 1.1rem; margin: 0; }
  h4 { font-size: var(--fs-md); margin: 0 0 var(--s3); }
  .slot-tabs { display: flex; flex-wrap: wrap; gap: var(--s2); margin-bottom: var(--s4); }
  .slot-tabs button { border-radius: var(--r-pill); min-height: 2.5rem; padding: var(--s2) var(--s4); }
  .slot-tabs button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
  .slot-tabs button span { margin-left: var(--s2); font-size: var(--fs-xs); }
  .search-label { display: grid; gap: var(--s2); font-size: var(--fs-sm); color: var(--text-muted); margin: var(--s4) 0; }
  .search-label input { min-width: 0; width: 100%; min-height: 2.8rem; }
  .option-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(16rem, 100%), 1fr)); gap: var(--s3); }
  .enchant-options { max-height: 28rem; overflow-y: auto; overscroll-behavior: contain; padding: 3px; align-content: start; }
  .option-card { display: flex; align-items: center; gap: var(--s3); min-height: 5rem; border: 1px solid var(--border); border-radius: var(--r3); padding: var(--s3) var(--s4); cursor: pointer; font-size: var(--fs-md); line-height: 1.45; background: var(--surface-2); transition: background 160ms ease, border-color 160ms ease, transform 160ms ease; }
  .option-card:hover { border-color: var(--border-strong); background: var(--surface-3); transform: translateY(-1px); }
  .option-card.selected { border-color: var(--accent); background: var(--accent-soft); }
  .option-card:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
  .option-card input { width: 1.05rem; height: 1.05rem; flex: none; }
  .option-card small { display: block; color: var(--text-muted); margin-top: var(--s1); font-size: var(--fs-xs); }
  .option-card .quality { color: var(--accent-hi); font-weight: 600; }
  .unchanged { cursor: default; border-style: dashed; }
  .checkmark { color: var(--accent); font-weight: 700; }
  .gem-layouts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr)); gap: var(--s4); }
  .gem-composer { padding: var(--s4); border: 1px solid var(--border); border-radius: var(--r3); background: var(--surface-2); }
  .chosen-set { display: flex; align-items: center; gap: var(--s3); justify-content: space-between; margin: var(--s3) 0; padding: var(--s3); border: 1px solid var(--accent-border); background: var(--accent-soft); border-radius: var(--r3); font-size: var(--fs-md); }
  .chosen-set span { overflow-wrap: anywhere; }
  .chosen-set button { flex-shrink: 0; }
  .consumable-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(17rem, 100%), 1fr)); gap: var(--s5); }
  .consumable-category { min-width: 0; }
  .consumable-category header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s2); }
  .consumable-options { display: grid; gap: var(--s3); max-height: 32rem; overflow-y: auto; overscroll-behavior: contain; padding: 3px; scrollbar-width: thin; }
  .clear-selection { margin-top: var(--s3); }
  .empty-state { border: 1px dashed var(--border-strong); border-radius: var(--r3); padding: var(--s5); color: var(--text-muted); font-size: var(--fs-md); }
  @media (max-width: 640px) { .enhancement-section { padding: var(--s4); } .category-heading { align-items: start; } }
  @media (prefers-reduced-motion: reduce) { .option-card { transition: none; transform: none; } }
</style>
