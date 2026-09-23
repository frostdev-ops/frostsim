<script lang="ts">
  import { Popover } from 'bits-ui'
  import { ChevronDown, Check } from '@lucide/svelte'
  import ItemIcon from './ItemIcon.svelte'
  import GameIcon from './GameIcon.svelte'
  import ItemLink from './ItemLink.svelte'
  let { label, value = $bindable(), fallback = '', onchange, options }: { label: string; value?: string; fallback?: string; onchange?: (value: string) => void; options: { value: string; label: string; itemId?: number; spellId?: number }[] } = $props()
  let open = $state(false)
  let search = $state('')
  let visibleCount = $state(60)
  $effect(() => { search; visibleCount = 60 })
  const chosen = $derived(options.find((o) => o.value === (value ?? fallback)))
  const filtered = $derived(options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())))
</script>
<div class="choice">
  <span class="small muted">{label}</span>
  <Popover.Root bind:open onOpenChange={(v) => { if (!v) search = '' }}>
    <div class="choice-row"><Popover.Trigger class="choice-trigger" aria-label={label} title={chosen?.label}>
      {#if chosen?.itemId}<ItemIcon itemId={chosen.itemId} size={28} />{:else if chosen?.spellId}<GameIcon spellId={chosen.spellId} label={chosen.label} size={28} />{/if}
      <span class="truncate grow">{chosen?.label ?? value ?? fallback ?? 'SimC Default'}</span><ChevronDown size={16} />
    </Popover.Trigger>
    {#if chosen?.itemId}<ItemLink itemId={chosen.itemId} name={chosen.label} compact>↗<span class="sr-only">Wowhead</span></ItemLink>{/if}</div>
    <Popover.Portal><Popover.Content class="choice-popover" sideOffset={6}>
      <input type="search" bind:value={search} placeholder="Search…" aria-label="Search {label}" />
      <div class="choice-list">
        {#each filtered.slice(0, visibleCount) as option (option.value)}
          {#if option.itemId}
          <div class="choice-row"><ItemLink itemId={option.itemId} name={option.label} selected={value === option.value} onselect={() => { value = option.value; onchange?.(option.value); open = false }}><ItemIcon itemId={option.itemId} size={28} /><span class="grow">{option.label}</span>{#if value === option.value}<Check size={16} />{/if}</ItemLink></div>
          {:else}
          <div class="choice-row"><button class="choice-option" title={option.label} onclick={() => { value = option.value; onchange?.(option.value); open = false }}>
            {#if option.spellId}<GameIcon spellId={option.spellId} label={option.label} size={28} />{/if}<span class="grow">{option.label}</span>{#if value === option.value}<Check size={16} />{/if}
          </button>
          </div>
          {/if}
        {:else}<p class="small muted">No matches</p>{/each}
        {#if filtered.length > visibleCount}<button class="choice-option" onclick={() => visibleCount += 60}>Show more · {filtered.length} options</button>{/if}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
</div>
<style>
  .choice-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .choice { min-width: 0; display: grid; gap: 6px; }
  :global(.choice-trigger) { width: 100%; justify-content: start; text-align: left; background: var(--field); padding: 5px 10px; }
  :global(.choice-popover) { z-index: 1100; width: min(390px, calc(100vw - 24px)); background: linear-gradient(180deg, var(--glass-hi), transparent 30%), var(--glass-strong); -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6); border: 1px solid var(--glass-edge); border-radius: 14px; padding: 10px; box-shadow: var(--shadow-3), inset 0 1px 0 var(--rim); animation: appear 0.35s var(--ease); }
  .choice-list { max-height: 310px; overflow-y: auto; margin-top: 8px; }
  .choice-option { width: 100%; text-align: left; border: 0; justify-content: start; padding: 8px; font-size: 14px; background: transparent; box-shadow: none; border-radius: 8px; }
  .choice-option:hover { background: linear-gradient(90deg, rgb(101 203 229 / 0.14), transparent); }
  @keyframes appear { from { opacity: 0; transform: translateY(-4px); } }
</style>
