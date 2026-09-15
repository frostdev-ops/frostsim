<script lang="ts">
  import { spellIconUrl } from '../media.svelte'
  import { initPresentation, spellForName } from '../presentation.svelte'
  import { Sparkles } from '@lucide/svelte'
  import { deferredIcon } from '../icon-loader'
  let { spellId, label, size = 24 }: { spellId?: number; label: string; size?: number } = $props()
  let failed = $state(false)
  $effect(() => { spellId; label; failed = false })
  $effect(() => { void initPresentation() })
  const effectiveId = $derived(spellId || spellForName(label))
  const src = $derived(effectiveId ? spellIconUrl(effectiveId) : null)
</script>
<span class="icon" title={label} style:width="{size}px" style:height="{size}px">
  {#if src && !failed}<img use:deferredIcon={src} alt="" width={size} height={size} onerror={() => failed = true} />{:else}<Sparkles size={size * .65} aria-hidden="true" />{/if}
</span>
<style>.icon { display: inline-grid; place-items: center; flex: none; border: 1px solid var(--border-strong); border-radius: 3px; background: var(--surface-2); overflow: hidden; color: var(--text-muted); } img { width: 100%; height: 100%; object-fit: cover; }</style>
