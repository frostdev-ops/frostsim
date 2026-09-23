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
    border: 1px solid color-mix(in oklab, var(--tone) 28%, transparent);
    border-radius: var(--r3);
    background:
      radial-gradient(30rem 8rem at 0% 0%, color-mix(in oklab, var(--tone) 16%, transparent), transparent 70%),
      var(--glass);
    -webkit-backdrop-filter: blur(18px) saturate(1.4);
    backdrop-filter: blur(18px) saturate(1.4);
    box-shadow: 0 12px 30px -18px color-mix(in oklab, var(--tone) 60%, transparent);
    font-size: var(--fs-sm);
    overflow: hidden;
    --tone: var(--accent);
  }
  /* Leading bar in banner's own colour: kind legible at glance without tint relying. */
  .banner::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: var(--tone);
    box-shadow: 0 0 12px var(--tone);
  }
  .good { --tone: var(--good); }
  .warn { --tone: var(--warn); }
  .bad { --tone: var(--bad); }
  .mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--tone) 18%, transparent);
    color: var(--tone);
    box-shadow: 0 0 12px -2px color-mix(in oklab, var(--tone) 60%, transparent);
    font-size: var(--fs-xs);
    font-weight: 700;
    line-height: 1;
  }
  .body :global(p + p) { margin-top: var(--s2); }
  .body :global(code) { word-break: break-word; }

</style>
