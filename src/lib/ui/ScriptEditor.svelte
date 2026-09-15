<script lang="ts">
  // P10.1: capable script editor, no editor dependency (CodeMirror costs 150kB+ for 4 token types in key=value grammar).
  // Highlighting: <pre> behind transparent <textarea> with synced scroll; textarea is real control (selection, undo, IME, a11y).
  import { diagnose, findAll, tokenizeLine, type Diagnostic } from '../script'
  import { fmtInt } from '../format'

  interface Props {
    value: string
    label: string
    rows?: number
    hint?: string
    readonly?: boolean
  }
  let { value = $bindable(''), label, rows = 18, hint, readonly = false }: Props = $props()

  let area = $state<HTMLTextAreaElement | null>(null)
  let overlay = $state<HTMLPreElement | null>(null)
  let gutter = $state<HTMLDivElement | null>(null)
  let findOpen = $state(false)
  let needle = $state('')
  let caseSensitive = $state(false)
  let hitIndex = $state(0)
  let fullscreen = $state(false)

  const lines = $derived(value.split('\n'))
  const diagnostics = $derived<Diagnostic[]>(diagnose(value))
  const byLine = $derived.by(() => {
    const m = new Map<number, Diagnostic[]>()
    for (const d of diagnostics) m.set(d.line, [...(m.get(d.line) ?? []), d])
    return m
  })
  const worst = $derived(
    diagnostics.some((d) => d.level === 'error')
      ? 'error'
      : diagnostics.some((d) => d.level === 'warning')
        ? 'warning'
        : diagnostics.length
          ? 'info'
          : null,
  )
  const hits = $derived(findAll(value, needle, caseSensitive))

  function syncScroll(): void {
    if (!area) return
    if (overlay) {
      overlay.scrollTop = area.scrollTop
      overlay.scrollLeft = area.scrollLeft
    }
    if (gutter) gutter.scrollTop = area.scrollTop
  }

  function jumpTo(index: number): void {
    if (!hits.length || !area) return
    const wrapped = ((index % hits.length) + hits.length) % hits.length
    hitIndex = wrapped
    const hit = hits[wrapped]
    area.focus()
    area.setSelectionRange(hit.start, hit.end)
    // Put the match near the middle rather than at the very bottom edge.
    const lineHeight = area.scrollHeight / Math.max(1, lines.length)
    area.scrollTop = Math.max(0, (hit.line - 1) * lineHeight - area.clientHeight / 2)
    syncScroll()
  }

  function goToLine(line: number): void {
    if (!area) return
    const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0)
    area.focus()
    area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
    const lineHeight = area.scrollHeight / Math.max(1, lines.length)
    area.scrollTop = Math.max(0, (line - 1) * lineHeight - area.clientHeight / 2)
    syncScroll()
  }

  function onKeydown(event: KeyboardEvent): void {
    // Ctrl/Cmd-F opens editor find (not browser's, which can't see textarea contents).
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault()
      findOpen = true
      queueMicrotask(() => document.getElementById('script-find')?.focus())
      return
    }
    if (event.key === 'Escape' && findOpen) {
      event.preventDefault()
      findOpen = false
      area?.focus()
      return
    }
    // Tab indents (not leaves field); Escape-then-Tab still moves focus (not a keyboard trap, P12.11).
    if (event.key === 'Tab' && !event.shiftKey && !readonly) {
      event.preventDefault()
      const el = event.currentTarget as HTMLTextAreaElement
      const { selectionStart: a, selectionEnd: b } = el
      value = `${value.slice(0, a)}  ${value.slice(b)}`
      queueMicrotask(() => el.setSelectionRange(a + 2, a + 2))
    }
  }
</script>

<div class="editor stack-sm" class:fullscreen>
  <div class="spread wrap">
    <label class="small" for="script-area">{label}</label>
    <div class="row-tight">
      <span class="xs muted" aria-live="off">{fmtInt(lines.length)} lines</span>
      <button class="ghost sm" type="button" onclick={() => (findOpen = !findOpen)}>
        {findOpen ? 'Close find' : 'Find'}
      </button>
      <button class="ghost sm" type="button" onclick={() => navigator.clipboard?.writeText(value)}>
        Copy
      </button>
      <button class="ghost sm" type="button" onclick={() => (fullscreen = !fullscreen)}>
        {fullscreen ? 'Exit full screen' : 'Full screen'}
      </button>
    </div>
  </div>

  {#if findOpen}
    <div class="find row-tight wrap" role="search">
      <input
        id="script-find"
        type="search"
        placeholder="Find in script"
        bind:value={needle}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); jumpTo(hitIndex + (e.shiftKey ? -1 : 1)) } }}
      />
      <label class="xs row-tight">
        <input type="checkbox" bind:checked={caseSensitive} /> Match case
      </label>
      <span class="xs muted" aria-live="polite">
        {#if !needle}
          &nbsp;
        {:else if hits.length}
          {hitIndex + 1} of {fmtInt(hits.length)}
        {:else}
          No matches
        {/if}
      </span>
      <button class="ghost sm" type="button" disabled={!hits.length} onclick={() => jumpTo(hitIndex - 1)}>
        Previous
      </button>
      <button class="ghost sm" type="button" disabled={!hits.length} onclick={() => jumpTo(hitIndex + 1)}>
        Next
      </button>
    </div>
  {/if}

  <div class="frame">
    <div class="gutter" bind:this={gutter} aria-hidden="true">
      {#each lines as _, i (i)}
        {@const marks = byLine.get(i + 1)}
        <span class="num" class:err={marks?.some((d) => d.level === 'error')} class:warn={marks?.some((d) => d.level === 'warning')}>
          {i + 1}
        </span>
      {/each}
    </div>
    <div class="pane">
      <!-- Decoration only. The textarea below carries the real text. -->
      <pre class="hl" bind:this={overlay} aria-hidden="true"><code>{#each lines as line, i (i)}<span class="row">{#each tokenizeLine(line) as t, j (j)}<span class={t.kind}>{t.text}</span>{/each}{'\n'}</span>{/each}</code></pre>
      <textarea
        id="script-area"
        bind:this={area}
        bind:value
        {rows}
        {readonly}
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        aria-describedby={hint ? 'script-hint' : undefined}
        aria-invalid={worst === 'error' ? 'true' : undefined}
        onscroll={syncScroll}
        onkeydown={onKeydown}
      ></textarea>
    </div>
  </div>

  {#if hint}<p id="script-hint" class="xs muted">{hint}</p>{/if}

  {#if diagnostics.length}
    <details class="disclosure" open={worst === 'error'}>
      <summary>
        {fmtInt(diagnostics.length)} note{diagnostics.length === 1 ? '' : 's'}
        <span class="xs faint">— advisory; the engine's own parser decides what is valid</span>
      </summary>
      <ul class="diag">
        {#each diagnostics as d, i (i)}
          <li class={d.level}>
            <button class="link" type="button" onclick={() => goToLine(d.line)}>
              Line {d.line}
            </button>
            <span>{d.message}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<style>
  .editor.fullscreen {
    position: fixed;
    inset: 0;
    z-index: 40;
    padding: var(--s4);
    background: var(--surface);
    overflow: auto;
  }
  .frame {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    border: 1px solid var(--border);
    border-radius: var(--r2);
    background: var(--surface-2);
    overflow: hidden;
  }
  .gutter {
    display: grid;
    align-content: start;
    padding: 0.5rem 0.4rem 0.5rem 0.6rem;
    overflow: hidden;
    border-right: 1px solid var(--border);
    color: var(--text-faint);
    text-align: right;
    user-select: none;
  }
  .gutter .num { display: block; }
  .gutter .err { color: var(--bad); font-weight: 700; }
  .gutter .warn { color: var(--warn, var(--text-muted)); font-weight: 700; }

  .pane { position: relative; min-width: 0; }

  /* Overlay and textarea must agree on every metric or highlight drifts from text. Both inherit same block. */
  .hl,
  .pane textarea {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border: 0;
    font: inherit;
    font-family: var(--mono);
    font-size: var(--fs-xs);
    line-height: 1.5;
    tab-size: 2;
    white-space: pre;
    overflow-wrap: normal;
  }
  .gutter { font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.5; }

  .hl {
    position: absolute;
    inset: 0;
    overflow: auto;
    pointer-events: none;
    background: transparent;
    scrollbar-width: none;
  }
  .hl::-webkit-scrollbar { display: none; }

  .pane textarea {
    position: relative;
    display: block;
    width: 100%;
    resize: vertical;
    background: transparent;
    /* Transparent text over the overlay; the caret stays visible. */
    color: transparent;
    caret-color: var(--text);
    outline-offset: -2px;
  }
  .pane textarea::selection { background: color-mix(in oklab, var(--accent) 35%, transparent); }

  .comment { color: var(--text-faint); font-style: italic; }
  .key { color: var(--accent); }
  .op { color: var(--text-muted); }
  .value { color: var(--text); }
  .text { color: var(--text); }

  .find input[type='search'] { min-width: 12rem; }

  .diag { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
  .diag li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--s2);
    font-size: var(--fs-xs);
    padding-left: 0.5rem;
    border-left: 3px solid var(--border);
  }
  .diag li.error { border-left-color: var(--bad); }
  .diag li.warning { border-left-color: var(--warn, var(--border-strong)); }
  .diag li.info { border-left-color: var(--border-strong); }

  @media (prefers-reduced-motion: no-preference) {
    .editor.fullscreen { animation: none; }
  }
</style>
