<script lang="ts" module>
  // One tip open at a time across the page. Each Tip has its own bits-ui Provider, which would
  // otherwise let a focused tip stay open while another opens on hover.
  let closeCurrent: (() => void) | null = null
</script>

<script lang="ts">
  // Explanatory tooltip for a chip, label or header. Hover or keyboard focus opens it after a
  // short delay; a tap toggles it on touch, where hover does not exist, and tapping elsewhere
  // closes it. Portalled, because a glass .panel ancestor (backdrop-filter) would capture a
  // fixed-position layer. bits-ui links the text to the trigger with aria-describedby.
  import { Tooltip } from 'bits-ui'
  import type { Snippet } from 'svelte'

  // `block`: the trigger fills its line instead of sizing to its content (a full-width bar track).
  let { text, children, content, block = false }: { text: string; children: Snippet; content?: Snippet; block?: boolean } = $props()
  let open = $state(false)
  // Touch: the tap's own focus event can open the tip before its click, so the click toggles
  // against the state at touch-down, not the current one.
  let pointer = ''
  let wasOpen = false

  const close = () => { open = false }
  $effect(() => {
    if (open) {
      if (closeCurrent !== close) closeCurrent?.()
      closeCurrent = close
    } else if (closeCurrent === close) closeCurrent = null
  })
  $effect(() => () => { if (closeCurrent === close) closeCurrent = null })
</script>

<Tooltip.Provider delayDuration={150}>
  <Tooltip.Root bind:open disableCloseOnTriggerClick>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="tip-trigger"
          class:block
          onpointerdown={(e) => { pointer = e.pointerType; wasOpen = open; (props.onpointerdown as ((e: PointerEvent) => void) | undefined)?.(e) }}
          onclick={(e) => { if (pointer === 'touch') open = !wasOpen; pointer = ''; (props.onclick as ((e: MouseEvent) => void) | undefined)?.(e) }}
        >{@render children()}</button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content class="tip-content" side="top" sideOffset={8} collisionPadding={10}>
        {#if content}{@render content()}{:else}{text}{/if}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
</Tooltip.Provider>

<style>
  /* The trigger adds nothing to layout: whatever it wraps looks exactly as before. */
  .tip-trigger {
    all: unset;
    display: inline;
    cursor: help;
    border-radius: var(--r1);
  }
  .tip-trigger.block { display: block; width: 100%; }
  .tip-trigger:focus-visible { box-shadow: var(--focus); }

  :global(.tip-content) {
    z-index: 1300;
    max-width: min(280px, calc(100vw - 20px));
    padding: 0.55rem 0.75rem;
    border: 1px solid var(--glass-edge);
    border-radius: 0.65rem;
    background: linear-gradient(180deg, var(--glass-hi), transparent 60%), var(--glass-strong);
    -webkit-backdrop-filter: blur(20px) saturate(1.5);
    backdrop-filter: blur(20px) saturate(1.5);
    box-shadow: var(--shadow-2), inset 0 1px 0 var(--rim), 0 0 28px -14px var(--accent-glow);
    color: var(--text);
    font-size: var(--fs-sm);
    font-weight: 450;
    line-height: 1.45;
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
    white-space: normal;
    overflow-wrap: break-word;
    transform-origin: var(--bits-tooltip-content-transform-origin, bottom center);
    transition: opacity 0.16s var(--ease), transform 0.22s var(--spring);
  }
  :global(.tip-content[data-starting-style]),
  :global(.tip-content[data-ending-style]) { opacity: 0; transform: translateY(4px) scale(0.96); }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full']) .tip-content) { transition: none; }
  }
  :global(:root[data-motion='reduced'] .tip-content) { transition: none; }
</style>
