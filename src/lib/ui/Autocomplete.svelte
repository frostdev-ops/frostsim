<script lang="ts" generics="T extends { value: string; label: string }">
  // A text input with a styled suggestion list (bits-ui Combobox: focus stays in the input, arrows move the highlight, Enter picks,
  // Escape closes, and the list is portalled so a dialog cannot clip it). The caller filters `items` from `value`.
  import type { Snippet } from 'svelte'
  import { Combobox } from 'bits-ui'
  import { fly } from 'svelte/transition'
  import { LoaderCircle } from '@lucide/svelte'
  import { ms, stagger } from '../theme.svelte'

  interface Props {
    /** The input's text; the user's typing and a pick both write it. */
    value: string
    items: T[]
    /** One row, given whether the keyboard or pointer has it highlighted. */
    row: Snippet<[T, boolean]>
    onpick?: (item: T) => void
    /** Shown under the input while a search is in flight. */
    busy?: boolean
    /** Shown in place of rows when there are none and the input has text. */
    empty?: string
    /** A row's class key, for its class-colored highlight. */
    classOf?: (item: T) => string | undefined
    label: string
    placeholder?: string
    disabled?: boolean
  }
  let { value = $bindable(''), items, row, onpick, busy = false, empty = '', classOf, label, placeholder = '', disabled = false }: Props = $props()

  let open = $state(false)
  let picked = $state('')
  /** Open only with something to show, so an empty panel never flashes while a search is in flight. */
  const hasContent = $derived(items.length > 0 || (!!empty && !!value.trim()))

  function pick(v: string): void {
    const item = items.find((i) => i.value === v)
    // Cleared at once, so picking the same row again still reports it.
    picked = ''
    if (!item) return
    value = item.label
    open = false
    onpick?.(item)
  }
</script>

<Combobox.Root type="single" bind:open={() => open && hasContent, (v) => (open = v)} bind:value={() => picked, pick} {items} inputValue={value} {disabled}>
  <div class="ac-field">
    <Combobox.Input type="text" class="ac-input" aria-label={label} {placeholder} autocomplete="off" spellcheck="false"
      oninput={(e) => { value = e.currentTarget.value; open = value.trim().length > 0 }}
      onfocus={() => { if (value.trim() && items.length) open = true }} />
    {#if busy}<span class="ac-busy" aria-hidden="true" transition:fly={{ x: 4, duration: ms('control') }}><LoaderCircle size={15} /></span>{/if}
  </div>
  <Combobox.Portal>
    <!-- Enter and exit are CSS animations on data-state: bits-ui waits for the exit one before it unmounts the list. -->
    <Combobox.Content class="ac-list" sideOffset={6} align="start">
      {#each items as item, i (item.value)}
        <Combobox.Item value={item.value} label={item.label} class="ac-item" data-class={classOf?.(item)}>
          {#snippet children({ highlighted })}
            <span class="ac-row" in:fly={{ y: 4, duration: ms('reveal'), delay: stagger(i, 24) }}>{@render row(item, highlighted)}</span>
          {/snippet}
        </Combobox.Item>
      {:else}
        <p class="ac-empty small muted">{empty}</p>
      {/each}
    </Combobox.Content>
  </Combobox.Portal>
</Combobox.Root>

<style>
  .ac-field { position: relative; }
  :global(.ac-input) { width: 100%; }
  .ac-busy {
    position: absolute; right: 10px; top: 50%; translate: 0 -50%; display: grid; color: var(--accent); pointer-events: none;
    animation: ac-spin 0.9s linear infinite;
  }
  @keyframes ac-spin { to { rotate: 360deg; } }
  :global(.ac-list) {
    z-index: 1100; box-sizing: border-box; width: max(var(--bits-combobox-anchor-width, 16rem), 18rem); max-width: calc(100vw - 32px);
    max-height: min(22rem, var(--bits-combobox-content-available-height, 60vh)); overflow: auto; overscroll-behavior: contain;
    display: grid; gap: 2px; padding: 6px; border-radius: 14px; border: 1px solid var(--glass-edge); background: var(--glass-strong);
    box-shadow: var(--shadow-3); -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);
    transform-origin: var(--bits-combobox-content-transform-origin, top left);
  }
  :global(.ac-list[data-state='open']) { animation: ac-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  /* bits-ui can leave a closed list mounted; it must then neither catch clicks nor be read out. */
  :global(.ac-list[data-state='closed']) { animation: ac-out 120ms ease-in forwards; pointer-events: none; }
  @keyframes -global-ac-in { from { opacity: 0; transform: translateY(-6px) scale(0.98); } }
  @keyframes -global-ac-out { to { opacity: 0; transform: translateY(-4px) scale(0.98); visibility: hidden; } }
  :global(.ac-item) {
    position: relative; display: block; border-radius: 10px; cursor: pointer; outline: none;
    transition: background-color var(--t-control, 120ms) var(--ease, ease), box-shadow var(--t-control, 120ms) var(--ease, ease);
  }
  :global(.ac-item[data-highlighted]) {
    background: color-mix(in oklab, var(--class-color, var(--accent)) 14%, var(--surface-3));
    box-shadow: inset 2px 0 0 var(--class-color, var(--accent));
  }
  .ac-row { display: block; padding: 7px 10px; }
  .ac-empty { margin: 8px 10px; }
  /* Without motion there is no exit animation to end hidden, so a closed list is hidden outright. */
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) :is(.ac-busy, :global(.ac-list[data-state])) { animation: none; }
    :global(:root:not([data-motion='full']) .ac-list[data-state='closed']) { visibility: hidden; }
  }
  :global(:root[data-motion='reduced'] .ac-list[data-state]) { animation: none; }
  :global(:root[data-motion='reduced'] .ac-list[data-state='closed']) { visibility: hidden; }
</style>
