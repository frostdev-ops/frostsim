<script lang="ts">
  // Gems, enchants and consumables as Top Gear search dimensions (P08.4).
  //
  // Every option here is a catalog row fetched from the catalog worker. Nothing
  // is offered that the catalog cannot name, and a slot with no sockets is not
  // shown at all rather than shown empty.
  import { GEAR_SLOTS, SLOT_LABELS, type GearSlot, type ItemInstance } from '../import/character'
  import Banner from './Banner.svelte'
  import type { Consumable, EnchantOption, ResolvedItem } from '../catalog/types'
  import { app, catalogClient } from '../app.svelte'
  import { resolveItem } from '../items'
  import { fmtInt } from '../format'

  interface Props {
    character: { equipped: ItemInstance[]; level?: number }
    /** Per slot, the gem loadouts to try — each entry is one whole set of sockets. */
    gems: Partial<Record<GearSlot, number[][]>>
    enchants: Partial<Record<GearSlot, number[]>>
    consumables: Record<string, string[]>
  }
  let {
    character,
    gems = $bindable(),
    enchants = $bindable(),
    consumables = $bindable(),
  }: Props = $props()

  interface SlotInfo {
    slot: GearSlot
    item: ItemInstance
    resolved: ResolvedItem
  }

  // The catalog track's own type, not a local copy. A hand-written duplicate is
  // how `uniqueEquipped` could be added upstream and silently never reach the
  // picker that needs it — which is exactly what had happened here.
  import type { GemOption } from '../catalog/catalog'

  let gemOptions = $state(new Map<GearSlot, GemOption[]>())
  let enchantOptions = $state(new Map<GearSlot, EnchantOption[]>())
  let consumableOptions = $state(new Map<string, Consumable[]>())
  let loaded = $state(false)

  const equipped = $derived(
    new Map<GearSlot, ItemInstance>(character.equipped.map((i) => [i.slot, i])),
  )

  const socketed = $derived.by<SlotInfo[]>(() => {
    if (app.catalogState !== 'ready') return []
    const out: SlotInfo[] = []
    for (const slot of GEAR_SLOTS) {
      const item = equipped.get(slot)
      if (!item) continue
      const resolved = resolveItem(item, app.resolved)
      if (resolved?.sockets.length) out.push({ slot, item, resolved })
    }
    return out
  })

  const equippedInfos = $derived.by<SlotInfo[]>(() => {
    if (app.catalogState !== 'ready') return []
    const out: SlotInfo[] = []
    for (const slot of GEAR_SLOTS) {
      const item = equipped.get(slot)
      if (!item) continue
      const resolved = resolveItem(item, app.resolved)
      if (resolved) out.push({ slot, item, resolved })
    }
    return out
  })

  const CONSUMABLE_KINDS: { key: string; kind: Consumable['kind']; label: string }[] = [
    { key: 'flask', kind: 'flask', label: 'Flask' },
    { key: 'potion', kind: 'potion', label: 'Potion' },
    { key: 'food', kind: 'food', label: 'Food' },
  ]

  // One round trip per list, on open, rather than one per render.
  let opened = $state(false)
  $effect(() => {
    if (!opened || loaded) return
    const client = catalogClient()
    if (!client) return
    let cancelled = false
    void (async () => {
      const gemEntries = await Promise.all(
        socketed.map(async (info) =>
          [info.slot, await client.gemsFor(info.resolved.sockets)] as const),
      )
      const enchantEntries = await Promise.all(
        equippedInfos.map(async (info) =>
          [info.slot, await client.enchantsFor(info.item, character.level ?? 0)] as const),
      )
      const consumableEntries = await Promise.all(
        CONSUMABLE_KINDS.map(async (c) => [c.key, await client.consumables(c.kind)] as const),
      )
      if (cancelled) return
      gemOptions = new Map(gemEntries.filter(([, v]) => v.length))
      enchantOptions = new Map(enchantEntries.filter(([, v]) => v.length))
      consumableOptions = new Map(
        consumableEntries.map(([k, v]) => [
          k,
          v.slice().sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)),
        ]),
      )
      loaded = true
    })().catch(() => {
      if (!cancelled) loaded = true
    })
    return () => { cancelled = true }
  })

  /**
   * Adds one gem as a whole loadout for the slot.
   *
   * A UNIQUE-EQUIPPED GEM GOES IN ONE SOCKET ONLY. Filling three sockets with
   * the same unique gem is illegal, and the generator now rejects it — so
   * offering it would produce candidates that are thrown away, which reads to a
   * user as the search losing options for no reason. The remaining sockets are
   * left empty rather than filled with a second choice nobody made.
   */
  function toggleGem(slot: GearSlot, itemId: number, sockets: number, unique = false): void {
    const loadouts = gems[slot] ?? []
    const candidate = unique
      ? [itemId, ...Array.from({ length: Math.max(0, sockets - 1) }, () => 0)]
      : Array.from({ length: sockets }, () => itemId)
    const key = candidate.join('/')
    const next = loadouts.some((l) => l.join('/') === key)
      ? loadouts.filter((l) => l.join('/') !== key)
      : [...loadouts, candidate]
    if (next.length) gems[slot] = next
    else { delete gems[slot]; gems = { ...gems } }
  }

  function gemChosen(slot: GearSlot, itemId: number, sockets: number, unique = false): boolean {
    const key = (unique
      ? [itemId, ...Array.from({ length: Math.max(0, sockets - 1) }, () => 0)]
      : Array.from({ length: sockets }, () => itemId)).join('/')
    return (gems[slot] ?? []).some((l) => l.join('/') === key)
  }

  /**
   * Unique-equipped gems chosen for more than one slot. Uniqueness is counted
   * across the whole character, so two slots each offering the same unique gem
   * produce candidates that wear it twice — which generation rejects. Naming
   * them is better than silently losing the combinations.
   */
  const uniqueClashes = $derived.by(() => {
    const uniqueIds = new Set<number>()
    const byId = new Map<number, GemOption>()
    for (const list of gemOptions.values()) {
      for (const g of list) {
        byId.set(g.itemId, g)
        if (g.uniqueEquipped) uniqueIds.add(g.itemId)
      }
    }
    const bySlot = new Map<number, GearSlot[]>()
    for (const [slot, loadouts] of Object.entries(gems) as [GearSlot, number[][]][]) {
      for (const id of new Set((loadouts ?? []).flat())) {
        if (!uniqueIds.has(id)) continue
        bySlot.set(id, [...(bySlot.get(id) ?? []), slot])
      }
    }
    return [...bySlot.entries()]
      .filter(([, slots]) => slots.length > 1)
      .map(([id, slots]) => ({
        name: byId.get(id)?.name ?? `Gem ${id}`,
        slots,
      }))
  })

  function toggleEnchant(slot: GearSlot, enchantId: number): void {
    const ids = enchants[slot] ?? []
    const next = ids.includes(enchantId)
      ? ids.filter((i) => i !== enchantId)
      : [...ids, enchantId]
    if (next.length) enchants[slot] = next
    else { delete enchants[slot]; enchants = { ...enchants } }
  }

  function toggleConsumable(key: string, option: string): void {
    const list = consumables[key] ?? []
    const next = list.includes(option) ? list.filter((o) => o !== option) : [...list, option]
    if (next.length) consumables[key] = next
    else { delete consumables[key]; consumables = { ...consumables } }
  }

  const totalChosen = $derived(
    Object.values(gems).reduce((n, l) => n + (l?.length ?? 0), 0) +
      Object.values(enchants).reduce((n, l) => n + (l?.length ?? 0), 0) +
      Object.values(consumables).reduce((n, l) => n + (l?.length ?? 0), 0),
  )
</script>

<details class="disclosure" ontoggle={(e) => (opened = (e.currentTarget as HTMLDetailsElement).open)}>
  <summary>
    Gems, enchants and consumables
    {#if totalChosen}<span class="chip accent">{totalChosen} selected</span>{/if}
  </summary>

  {#if app.catalogState !== 'ready'}
    <p class="xs muted">Game data is still loading.</p>
  {:else if !loaded}
    <p class="xs muted" aria-live="polite">Reading gems, enchants and consumables…</p>
  {:else}
    <div class="stack-sm">
      <p class="xs muted">
        Each option becomes a search dimension composed onto whichever item ends up in the slot,
        so varying an item and its gems together explores the full cross product. That multiplies
        the workload quickly — the estimate above updates as you pick.
      </p>

      {#if uniqueClashes.length}
        <!--
          Uniqueness is counted across the whole character, so the same unique
          gem offered for two slots produces candidates wearing it twice, which
          generation rejects. Naming them beats silently losing combinations.
        -->
        <Banner kind="warn" title="A unique gem is selected in more than one slot">
          <ul>
            {#each uniqueClashes as clash, i (i)}
              <li>
                {clash.name} — {clash.slots.map((s) => SLOT_LABELS[s]).join(' and ')}
              </li>
            {/each}
          </ul>
          <p>
            Only one of these may be worn at a time, so any combination using it twice is thrown
            out before it reaches the engine. The search still runs; it simply has fewer
            candidates than the selection suggests.
          </p>
        </Banner>
      {/if}

      {#if gemOptions.size}
        <h4 class="small">Gems</h4>
        {#each socketed as info (info.slot)}
          {@const options = gemOptions.get(info.slot) ?? []}
          {#if options.length}
            <details class="nested">
              <summary class="xs">
                {SLOT_LABELS[info.slot]} · {info.resolved.sockets.length} socket{info.resolved.sockets.length > 1 ? 's' : ''}
                {#if gems[info.slot]?.length}
                  <span class="chip accent">{gems[info.slot]!.length}</span>
                {/if}
              </summary>
              <div class="opts">
                {#each options.slice(0, 40) as gem (gem.itemId)}
                  <label class="opt">
                    <input
                      type="checkbox"
                      checked={gemChosen(info.slot, gem.itemId, info.resolved.sockets.length, gem.uniqueEquipped)}
                      onchange={() => toggleGem(info.slot, gem.itemId, info.resolved.sockets.length, gem.uniqueEquipped)}
                    />
                    <span class="truncate">{gem.name}</span>
                    {#if gem.uniqueEquipped}
                      <span class="chip xs" title="Only one may be worn across the whole character, so it is tried in one socket.">
                        unique
                      </span>
                    {/if}
                  </label>
                {/each}
              </div>
              {#if options.length > 40}
                <p class="xs faint">
                  Showing 40 of {fmtInt(options.length)} gems the catalog lists for these sockets.
                </p>
              {/if}
            </details>
          {/if}
        {/each}
      {:else}
        <p class="xs muted">None of your equipped items has a socket.</p>
      {/if}

      {#if enchantOptions.size}
        <h4 class="small">Enchants</h4>
        {#each equippedInfos as info (info.slot)}
          {@const options = enchantOptions.get(info.slot) ?? []}
          {#if options.length}
            <details class="nested">
              <summary class="xs">
                {SLOT_LABELS[info.slot]}
                {#if enchants[info.slot]?.length}
                  <span class="chip accent">{enchants[info.slot]!.length}</span>
                {/if}
              </summary>
              <div class="opts">
                {#each options.slice(0, 40) as e (e.enchantId)}
                  <label class="opt">
                    <input
                      type="checkbox"
                      checked={(enchants[info.slot] ?? []).includes(e.enchantId)}
                      onchange={() => toggleEnchant(info.slot, e.enchantId)}
                    />
                    <span class="truncate">
                      {e.name ?? e.option}{e.rank ? ` (rank ${e.rank})` : ''}
                    </span>
                  </label>
                {/each}
              </div>
              {#if options.length > 40}
                <p class="xs faint">
                  Showing 40 of {fmtInt(options.length)} enchants valid for this slot.
                </p>
              {/if}
            </details>
          {/if}
        {/each}
      {/if}

      <h4 class="small">Consumables</h4>
      {#each CONSUMABLE_KINDS as c (c.key)}
        {@const options = consumableOptions.get(c.key) ?? []}
        {#if options.length}
          <details class="nested">
            <summary class="xs">
              {c.label}
              {#if consumables[c.key]?.length}
                <span class="chip accent">{consumables[c.key].length}</span>
              {/if}
            </summary>
            <div class="opts">
              {#each options.slice(0, 30) as item (item.itemId)}
                <label class="opt">
                  <input
                    type="checkbox"
                    checked={(consumables[c.key] ?? []).includes(item.option)}
                    onchange={() => toggleConsumable(c.key, item.option)}
                  />
                  <span class="truncate">
                    {item.name}{item.craftingQuality ? ` Q${item.craftingQuality}` : ''}
                  </span>
                </label>
              {/each}
            </div>
            {#if options.length > 30}
              <p class="xs faint">
                Showing 30 of {fmtInt(options.length)} {c.label.toLowerCase()}s.
              </p>
            {/if}
          </details>
        {/if}
      {/each}

      <p class="xs faint">
        Frostsim cannot tell you what any of this costs: the catalog carries no upgrade currency,
        crafting reagent or Catalyst charge prices, so no affordability constraint is applied and
        costs are reported as unknown rather than as zero.
      </p>
    </div>
  {/if}
</details>

<style>
  details.nested { margin-left: var(--s3); }
  details.nested > summary { cursor: pointer; padding: 0.2rem 0; color: var(--text-muted); }
  details.nested > summary:hover { color: var(--text); }
  .opts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(13rem, 100%), 1fr));
    gap: 0.15rem var(--s3);
    padding: var(--s2) 0 var(--s2) var(--s3);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: var(--s2);
    font-size: var(--fs-xs);
    min-width: 0;
  }
  .opt input { width: auto; flex: none; }
  h4 { margin-top: var(--s2); }
</style>
