<script lang="ts">
  // Textarea with line-number gutter, copy, fullscreen (P10.1); no editor dependency (ponytail: lazy-load when APLs need search/highlighting).
  import { toast } from '../app.svelte'

  interface Props {
    value: string
    label: string
    rows?: number
    hint?: string
    readonly?: boolean
  }
  let { value = $bindable(), label, rows = 8, hint, readonly = false }: Props = $props()

  let full = $state(false)
  let ta: HTMLTextAreaElement | undefined = $state()
  let scrollTop = $state(0)

  const lines = $derived(value.split('\n').length)
  const id = $props.id()
</script>

<div class="wrap-code" class:full>
  <div class="head">
    <label for={id} class="small strongish">{label}</label>
    <span class="grow"></span>
    <span class="xs faint">{lines} line{lines === 1 ? '' : 's'}</span>
    <button
      class="ghost sm"
      type="button"
      onclick={async () => {
        await navigator.clipboard.writeText(value)
        toast('good', 'Copied.')
      }}
    >Copy</button>
    <button class="ghost sm" type="button" onclick={() => (full = !full)}>
      {full ? 'Exit fullscreen' : 'Fullscreen'}
    </button>
  </div>

  <div class="editor">
    <div class="gutter" aria-hidden="true" style:transform="translateY({-scrollTop}px)">
      {#each { length: lines } as _, i (i)}<span>{i + 1}</span>{/each}
    </div>
    <textarea
      {id}
      bind:this={ta}
      bind:value
      {readonly}
      rows={full ? 30 : rows}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      wrap="off"
      aria-describedby={hint ? `${id}-hint` : undefined}
      onscroll={() => (scrollTop = ta?.scrollTop ?? 0)}
    ></textarea>
  </div>

  {#if hint}<p class="hint xs" id="{id}-hint">{hint}</p>{/if}
</div>

<style>
  .wrap-code { display: flex; flex-direction: column; gap: 0.3rem; }
  .wrap-code.full {
    position: fixed;
    inset: var(--s4);
    z-index: 30;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r3);
    padding: var(--s4);
    box-shadow: var(--shadow-3);
  }
  .wrap-code.full .editor { flex: 1 1 auto; }
  .wrap-code.full textarea { height: 100%; }
  .head { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
  .strongish { font-weight: 550; }
  .editor { display: flex; max-width: 100%; border: 1px solid var(--border); border-radius: var(--r2); background: var(--surface); overflow: hidden; }
  .editor:focus-within { box-shadow: var(--focus); }
  .gutter {
    display: flex;
    flex-direction: column;
    flex: none;
    padding: 0.45rem 0.4rem 0.45rem 0.6rem;
    background: var(--surface-2);
    border-right: 1px solid var(--border);
    color: var(--text-faint);
    font: var(--fs-xs) / 1.5 var(--font-mono);
    text-align: right;
    user-select: none;
    min-width: 2.4rem;
  }
  textarea {
    min-width: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0.45rem 0.6rem;
    line-height: 1.5;
    font-size: var(--fs-xs);
    resize: vertical;
    overflow: auto;
  }
  textarea:focus-visible { box-shadow: none; }
  .hint { color: var(--text-muted); }
</style>
