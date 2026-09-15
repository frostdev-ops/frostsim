<script lang="ts">
  import { app, catalogClient } from '../app.svelte'
  import { resolveItem } from '../items'
  import { mediaVersion, tooltipFor } from '../media.svelte'
  import type { ImportedCharacter } from '../import/character'
  import type { SetBonus } from '../catalog/types'
  import { ShieldCheck } from '@lucide/svelte'
  let { character }: { character: ImportedCharacter } = $props()
  let bonuses = $state<Record<number, SetBonus[]>>({})
  const groups = $derived.by(() => {
    const sets = new Map<number, { count: number; itemId: number }>()
    for (const item of character.equipped) {
      const resolved = resolveItem(item, app.resolved)
      if (resolved?.setId) sets.set(resolved.setId, { count: (sets.get(resolved.setId)?.count ?? 0) + 1, itemId: item.itemId })
    }
    return [...sets]
  })
  $effect(() => {
    const sets = groups
    const client = catalogClient()
    let cancelled = false
    if (client) void Promise.all(sets.map(async ([id]) => [id, await client.setBonuses(id)] as const)).then((rows) => { if (!cancelled) bonuses = Object.fromEntries(rows) }).catch(() => {})
    return () => { cancelled = true }
  })
  const rows = $derived.by(() => {
    void mediaVersion.n
    return groups.map(([id, group]) => { const data = tooltipFor(group.itemId); return { id, ...group, rich: data?.status === 'ready' ? data.tooltip.set : null } })
  })
</script>
{#if rows.length}<section class="tier-sets stack-sm"><h2 class="section-title">Tier bonuses</h2>
  {#each rows as set (set.id)}
    <div class="tier">
      <strong><ShieldCheck size={18} />{set.rich?.name?.replace(/\s*\(\d+\/\d+\)/, '') ?? bonuses[set.id]?.[0]?.name ?? 'Tier set'} <span>{set.count} equipped</span></strong>
      {#each set.rich?.bonuses ?? [] as bonus, i (i)}
        <p class:active={!!bonus.requiredCount && set.count >= bonus.requiredCount}>({bonus.requiredCount}) {bonus.text}</p>
      {/each}
      {#if !set.rich?.bonuses?.length}<span class="small muted">Loading set bonuses…</span>{/if}
    </div>
  {/each}
</section>{/if}
<style>
  .tier-sets { padding-block: 12px; }
  .tier { border: 1px solid var(--border); padding: 16px; border-radius: 6px; display: grid; gap: 8px; }
  strong { display: flex; align-items: center; gap: 8px; color: var(--q-artifact); }
  strong span { margin-left: auto; font-size: 12px; color: var(--text-muted); }
  p { color: var(--text-faint); font-size: 14px; }
  p.active { color: var(--good); }
</style>
