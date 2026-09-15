<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    kind?: 'info' | 'good' | 'warn' | 'bad'
    title?: string
    /** Errors and cancellations must reach a screen reader immediately. */
    live?: boolean
    children?: Snippet
    actions?: Snippet
  }
  let { kind = 'info', title, live = false, children, actions }: Props = $props()

  const ICON = { info: 'i', good: '✓', warn: '!', bad: '×' }
</script>

<div
  class="banner {kind}"
  role={kind === 'bad' ? 'alert' : live ? 'status' : undefined}
  aria-live={live && kind !== 'bad' ? 'polite' : undefined}
>
  <span class="mark" aria-hidden="true">{ICON[kind]}</span>
  <div class="grow stack-sm">
    {#if title}<strong>{title}</strong>{/if}
    {#if children}<div class="body">{@render children()}</div>{/if}
  </div>
  {#if actions}<div class="row-tight">{@render actions()}</div>{/if}
</div>

<style>
  .banner {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--s3);
    padding: var(--s3);
    padding-left: calc(var(--s3) + 3px);
    border: 1px solid var(--border);
    border-radius: var(--r3);
    background: var(--info-soft);
    font-size: var(--fs-sm);
    overflow: hidden;
  }
  /* Leading bar in banner's own colour: kind legible at glance without tint relying. */
  .banner::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: var(--accent);
  }
  .good::before { background: var(--good); }
  .warn::before { background: var(--warn); }
  .bad::before { background: var(--bad); }
  .mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--r-pill);
    background: var(--surface);
    font-size: var(--fs-xs);
    font-weight: 700;
    line-height: 1;
  }
  .body :global(p + p) { margin-top: var(--s2); }
  .body :global(code) { word-break: break-word; }
  .good { background: var(--good-soft); border-color: transparent; }
  .good .mark { color: var(--good); }
  .warn { background: var(--warn-soft); border-color: transparent; }
  .warn .mark { color: var(--warn); }
  .bad { background: var(--bad-soft); border-color: transparent; }
  .bad .mark { color: var(--bad); }
</style>
