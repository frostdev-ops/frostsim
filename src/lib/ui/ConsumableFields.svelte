<script lang="ts">
  import { app, catalogClient } from '../app.svelte'
  import type { ToolSettings } from '../settings.svelte'
  import type { Consumable } from '../catalog/types'
  import ChoiceSelect from './ChoiceSelect.svelte'
  import { presentation, initPresentation } from '../presentation.svelte'
  $effect(() => { void initPresentation() })
  let { settings, level = 90, profileLines = [] }: { settings: ToolSettings; level?: number; profileLines?: string[] } = $props()
  const inherited = $derived(Object.fromEntries(profileLines.filter(line => /^(food|flask|potion|augmentation|temporary_enchant)=/.test(line)).map(line => [line.split('=')[0], line.slice(line.indexOf('=') + 1)])))
  let options = $state<Record<string, Consumable[]>>({})
  const categories = [{ key: 'food', label: 'Food' }, { key: 'flask', label: 'Flask / phial' }, { key: 'potion', label: 'Potion' }] as const
  $effect(() => {
    app.catalogState; const client = catalogClient(); const currentLevel = level
    let cancelled = false
    if (client) void Promise.all(categories.map(async ({ key }) => [key, (await client.consumables(key)).filter((v) => v.reqLevel <= currentLevel).sort((a, b) => b.level - a.level || b.craftingQuality - a.craftingQuality)] as const)).then((rows) => { if (!cancelled) options = Object.fromEntries(rows) }).catch(() => {})
    return () => { cancelled = true }
  })
</script>
<section class="stack-sm"><h3 class="section-title">Consumables</h3>
  <div class="consumable-fields">
    {#each categories as category (category.key)}
      <ChoiceSelect label={category.label} fallback={inherited[category.key]} bind:value={settings.consumables[category.key]} options={[
        { value: '', label: 'SimC Default' }, { value: 'disabled', label: 'None' },
        ...(options[category.key] ?? []).map((v) => ({ value: v.option, label: v.name + (v.craftingQuality ? ' · Quality ' + v.craftingQuality : ''), itemId: v.itemId }))
      ]} />
    {/each}
    <ChoiceSelect label="Augmentation" fallback={inherited.augmentation} bind:value={settings.consumables.augmentation} options={[{ value: '', label: 'SimC Default' }, { value: 'disabled', label: 'None' }, ...(presentation.data?.augmentation ?? [])]} />
    <ChoiceSelect label="Weapon enhancement" fallback={inherited.temporary_enchant} bind:value={settings.consumables.temporary_enchant} options={[{ value: '', label: 'SimC Default' }, { value: 'disabled', label: 'None' }, ...(presentation.data?.weapon ?? []).map(option => ({ ...option, value: 'main_hand:' + option.value }))]} />
  </div>
</section>
<style>.consumable-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; } @media(max-width: 700px) { .consumable-fields { grid-template-columns: 1fr; } }</style>
