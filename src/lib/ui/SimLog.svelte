<script lang="ts">
  import { tick } from 'svelte'
  import { ArrowDown, Copy, Expand, Minimize } from '@lucide/svelte'
  import { reducedMotion } from '../theme.svelte'
  import { logTone } from './progress'
  let { lines }: { lines: readonly string[] } = $props()
  let viewport: HTMLDivElement | undefined = $state()
  let following = $state(true), expanded = $state(false), copied = $state(false), copyError = $state(false)
  let dragging = false
  $effect(() => {
    lines; expanded
    if (!following) return
    let cancelled = false
    void tick().then(() => { if (!cancelled) viewport?.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion() ? 'instant' : 'smooth' }) })
    return () => { cancelled = true }
  })
  async function copy() { try { await navigator.clipboard.writeText(lines.join('\n')); copied = true; copyError = false } catch { copyError = true } }
</script>
<svelte:window onpointerup={() => dragging = false} />
<section class="sim-log">
  <header><h3>SimulationCraft log</h3><div class="actions">
    <button class:following aria-pressed={following} onclick={() => following = !following}><ArrowDown size={14} />{following ? 'Following' : 'Follow latest'}</button>
    <button onclick={copy} title="Copy log"><Copy size={14} />{copied ? 'Copied' : 'Copy'}</button>
    <button onclick={() => expanded = !expanded} aria-label={expanded ? 'Collapse log' : 'Expand log'} title={expanded ? 'Collapse log' : 'Expand log'}>{#if expanded}<Minimize size={15} />{:else}<Expand size={15} />{/if}</button>
  </div></header>
  <!-- Scrollback is focusable so keyboard users can scroll and pause following. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="viewport" class:expanded bind:this={viewport} role="log" aria-label="SimulationCraft output" aria-live="off" tabindex="0"
    onwheel={event => { if (event.deltaY < 0) following = false }}
    onpointerdown={() => { dragging = true; following = false }}
    onkeydown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) following = false }}
    onscroll={() => { if (viewport && !dragging && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 8) following = true }}>
    {#each lines as line, i (i)}<div class="line {logTone(line)}">{line || ' '}</div>{:else}<div class="empty-log">Waiting for engine output…</div>{/each}
  </div>
  <footer><span>{lines.length.toLocaleString()} lines · {following ? 'Following latest output' : 'Scroll paused'}</span>{#if copyError}<span role="alert">Copy unavailable; select the log text to copy.</span>{/if}</footer>
</section>
<style>
  .sim-log { min-width: 0; border: 1px solid var(--border-strong); border-radius: 6px; background: #181a1f; overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
  h3 { font-size: 13px; font-weight: 600; } .actions { display: flex; gap: 4px; } button { min-height: 28px; padding: 4px 7px; font-size: 11px; background: transparent; border-color: transparent; gap: 4px; }
  button.following { color: var(--accent); background: var(--accent-soft); }
  .viewport { height: 290px; overflow: auto; padding-block: 10px; scrollbar-gutter: stable; overscroll-behavior: contain; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #b8c0cd; }
  .viewport.expanded { height: min(65vh, 650px); } .viewport:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .line { white-space: pre; min-width: max-content; padding-inline: 12px; min-height: 1.65em; animation: log-in 150ms ease-out; }
  .line.error { color: #ff8585; background: #54262b55; } .line.warning { color: #e9c477; } .line.progress { color: #81cce4; } .line.success { color: #91d4a0; }
  .empty-log { padding: 8px 12px; color: var(--text-faint); } footer { display: flex; justify-content: space-between; padding: 6px 12px; border-top: 1px solid var(--border); color: var(--text-faint); font-size: 11px; }
  @keyframes log-in { from { opacity: .3; transform: translateY(3px); } }
  @media(prefers-reduced-motion: reduce) { .line { animation: none; } }
  :global([data-motion='reduced']) .line { animation: none; }
</style>
