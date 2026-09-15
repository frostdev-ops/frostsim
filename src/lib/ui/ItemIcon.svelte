<script lang="ts">
  // Visible icons in paced deduplicated queue; missing media stays absent; throttling doesn't become permanent absence.
  import { iconUrl, mediaVersion, noteIconMissing } from '../media.svelte'
  import { deferredIcon } from '../icon-loader'

  interface Props {
    itemId: number
    /** Quality index for border (always with name in text). */
    quality?: number
    size?: number
    /** Decorative when item name beside it (usual). */
    alt?: string
  }
  let { itemId, quality, size = 28, alt = '' }: Props = $props()

  let failed = $state(false)
  $effect(() => { itemId; failed = false })

  const url = $derived.by<string | null>(() => {
    void mediaVersion.n
    return failed ? null : iconUrl(itemId)
  })

  const qualityVar = $derived(
    quality !== undefined
      ? [
          'var(--q-poor)', 'var(--q-common)', 'var(--q-uncommon)', 'var(--q-rare)',
          'var(--q-epic)', 'var(--q-legendary)', 'var(--q-artifact)', 'var(--q-heirloom)',
        ][quality] ?? 'var(--border)'
      : 'var(--border)',
  )
</script>

{#if url}
  <span class="icon" style:--s="{size}px" style:--q={qualityVar}>
    <img
      use:deferredIcon={url}
      {alt}
      width={size}
      height={size}
      decoding="async"
      onerror={(event) => { failed = true; if (!(event instanceof CustomEvent && event.detail?.transient)) noteIconMissing(itemId) }}
    />
  </span>
{:else}
  <span class="icon placeholder" style:--s="{size}px" style:--q={qualityVar} role="img" aria-label={alt || `Item ${itemId}`}>?</span>
{/if}

<style>
  .icon {
    flex: none;
    display: block;
    width: var(--s);
    height: var(--s);
    border: 1px solid var(--q);
    border-radius: var(--r1);
    background: var(--surface-2);
    overflow: hidden;
  }
  .icon img { width: 100%; height: 100%; display: block; object-fit: cover; }
  .placeholder { display: grid; place-items: center; color: var(--text-muted); font-size: calc(var(--s) / 2); line-height: 1; }
</style>
