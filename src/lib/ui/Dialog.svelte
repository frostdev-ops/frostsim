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
  :global(.dialog-title) { font: 600 21px var(--font-display); letter-spacing: 0.01em; }
  :global(.dialog-overlay) {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: radial-gradient(60rem 40rem at 50% 40%, rgb(101 203 229 / 0.08), transparent 70%), rgb(3 5 9 / 0.6);
    -webkit-backdrop-filter: blur(6px) saturate(1.2);
    backdrop-filter: blur(6px) saturate(1.2);
    animation: appear var(--t-dialog) ease;
  }
  :global(:root[data-theme='light'] .dialog-overlay) { background: rgb(12 26 43 / 0.28); }
  :global(.dialog-content) {
    position: fixed;
    z-index: 1001;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(var(--dialog-width), calc(100vw - 32px));
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--glass-edge);
    border-radius: 18px;
    background: linear-gradient(180deg, var(--glass-hi), transparent 30%), var(--glass-strong);
    -webkit-backdrop-filter: blur(28px) saturate(1.6);
    backdrop-filter: blur(28px) saturate(1.6);
    box-shadow: var(--shadow-3), inset 0 1px 0 var(--rim), 0 0 80px -30px var(--accent-glow);
    padding: 24px;
    gap: 20px;
    animation: dialog-in 0.5s var(--spring);
  }
  /* A cold rim along the top edge. */
  :global(.dialog-content)::before {
    content: '';
    position: absolute;
    inset: -1px 18% auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), var(--accent-3), transparent);
    pointer-events: none;
  }
  @keyframes dialog-in {
    from { opacity: 0; transform: translate(-50%, calc(-50% + 16px)) scale(0.95); }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full']) .dialog-content) { animation: appear var(--t-dialog) ease; }
  }
  :global(:root[data-motion='reduced'] .dialog-content) { animation: appear var(--t-dialog) ease; }
  .dialog-body { overflow: auto; min-height: 0; }
  header { flex: none; }
  footer { justify-content: flex-end; border-top: 1px solid var(--border); padding-top: 16px; }
  @keyframes appear { from { opacity: 0; } }
</style>
