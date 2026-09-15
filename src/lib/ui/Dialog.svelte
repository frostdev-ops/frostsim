<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Dialog } from 'bits-ui'
  import { X } from '@lucide/svelte'
  interface Props { open: boolean; title: string; width?: string; onclose: () => void; children: Snippet; footer?: Snippet }
  let { open = $bindable(), title, width = '42rem', onclose, children, footer }: Props = $props()
  let returnFocus: HTMLElement | null = null
  let content = $state<HTMLDivElement | null>(null)
  $effect(() => { if (open && document.activeElement instanceof HTMLElement && !document.activeElement.closest('[role="dialog"]')) returnFocus = document.activeElement })
</script>
<Dialog.Root bind:open onOpenChange={(value) => { if (!value) onclose() }}>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay" />
    <!-- Bits' body-style restoration uses setAttribute, which our CSP blocks.
         CSS owns scroll locking; the overlay and focus scope retain modality. -->
    <Dialog.Content bind:ref={content} preventScroll={false} interactOutsideBehavior="ignore" onOpenAutoFocus={(event) => { const field = content?.querySelector<HTMLElement>('textarea:not(:disabled), input[type="text"]:not(:disabled), input[type="search"]:not(:disabled)'); if (field) { event.preventDefault(); field.focus() } }} onCloseAutoFocus={(event) => { event.preventDefault(); (returnFocus?.isConnected ? returnFocus : document.getElementById('main'))?.focus() }} class="dialog-content" style={`--dialog-width: ${width}`}>
      <header class="spread"><Dialog.Title class="dialog-title">{title}</Dialog.Title><Dialog.Close class="ghost sm" aria-label="Close"><X size={18} /></Dialog.Close></header>
      <div class="dialog-body">{@render children()}</div>
      {#if footer}<footer class="row">{@render footer()}</footer>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
<style>
  :global(html:has(.dialog-content[data-state='open'])) { scrollbar-gutter: stable; }
  :global(body:has(.dialog-content[data-state='open'])) { overflow: hidden; }
  :global(.dialog-title) { font: 600 20px var(--font-display); }
  :global(.dialog-overlay) { position: fixed; inset: 0; z-index: 1000; background: #0009; animation: appear var(--t-dialog) ease; }
  :global(.dialog-content) { position: fixed; z-index: 1001; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(var(--dialog-width), calc(100vw - 32px)); max-height: 88vh; display: flex; flex-direction: column; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow-3); padding: 24px; gap: 20px; animation: appear var(--t-dialog) ease; }
  .dialog-body { overflow: auto; min-height: 0; }
  header { flex: none; }
  footer { justify-content: flex-end; border-top: 1px solid var(--border); padding-top: 16px; }
  @keyframes appear { from { opacity: 0; } }
</style>
