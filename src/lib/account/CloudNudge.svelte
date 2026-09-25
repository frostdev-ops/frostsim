<script lang="ts">
  // Under a running job (CLAUDE.md D14, D15): where the run is going, said plainly, and for someone without cloud runs who has
  // waited a while, where it could go instead.
  import { Cloud, Monitor, Zap } from '@lucide/svelte'
  import { fly } from 'svelte/transition'
  import PremiumPill from './PremiumPill.svelte'
  import { computeEntitled } from './state.svelte'
  import { placement } from './placement.svelte'
  import { runPlace } from './run-place.svelte'
  import { ms } from '../theme.svelte'
  import type { RunPlace } from '../simc/hybrid'

  let { elapsed }: { elapsed: number } = $props()

  const UNIT: Record<string, [string, string]> = { candidates: ['candidate', 'candidates'], characters: ['character', 'characters'], stats: ['stat weight', 'stat weights'] }
  const title = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const list = (names: string[]) => names.length <= 3 ? names.map(title).join(', ') : `${names.slice(0, 2).map(title).join(', ')} and ${names.length - 2} more`

  function share(p: RunPlace, side: 'here' | 'there'): string {
    const names = side === 'here' ? p.hereNames : p.thereNames
    const n = (side === 'here' ? p.here : p.there) ?? 0
    const [one, many] = UNIT[p.kind ?? 'candidates']
    return p.kind === 'candidates' || !names?.length ? `${n} ${n === 1 ? one : many}` : list(names)
  }

  const place = $derived(runPlace.current)
</script>

{#if place}
  <div class="place" class:hybrid={place.mode === 'hybrid'} role="status" in:fly={{ y: 4, duration: ms('reveal') }}>
    {#if place.mode === 'hybrid'}
      <span class="badge"><Zap size={13} aria-hidden="true" />Hybrid run</span>
      <span class="split">
        <span class="side"><Monitor size={13} aria-hidden="true" /><strong>{share(place, 'here')}</strong> on this PC</span>
        <span class="side"><Cloud size={13} aria-hidden="true" /><strong>{share(place, 'there')}</strong> on Frostsim Cloud</span>
        <span class="xs muted">at the same time{#if place.both?.length}; {list(place.both)} runs on both, so each side's weights are normalized to its own{/if}</span>
      </span>
    {:else if place.mode === 'cloud'}
      <span class="badge cloud"><Cloud size={13} aria-hidden="true" />Frostsim Cloud</span>
      <span class="xs muted">{place.note ?? 'The whole run is on our servers.'}</span>
    {:else}
      <span class="badge local"><Monitor size={13} aria-hidden="true" />This PC</span>
      <span class="xs muted">{place.note}</span>
    {/if}
    {#if place.mode === 'hybrid' && place.note}<span class="xs muted note">{place.note}</span>{/if}
  </div>
{:else if computeEntitled() && placement.value !== 'browser'}
  <p class="nudge xs muted">Running on this PC: custom scripts and simc HTML reports always run here.</p>
{:else if elapsed >= 15 && !computeEntitled()}
  <p class="nudge xs muted">Running on your PC. Long runs can go to our servers instead, so your game keeps its frames. <PremiumPill text="Cloud runs" /></p>
{/if}

<style>
  .nudge { margin: var(--s2) 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
  .place {
    margin-top: var(--s2); display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 12px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--well);
  }
  .place.hybrid {
    border-color: color-mix(in oklab, var(--accent) 45%, transparent);
    background: linear-gradient(90deg, color-mix(in oklab, var(--accent) 12%, transparent), transparent 70%), var(--well);
  }
  .badge {
    display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 99px; font: 650 var(--fs-xs, 12px) var(--font-display);
    letter-spacing: 0.03em; color: var(--accent); background: color-mix(in oklab, var(--accent) 16%, transparent);
  }
  .badge.local { color: var(--text-muted); background: var(--surface-3); }
  .split { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; font-size: var(--fs-sm); }
  .side { display: inline-flex; align-items: center; gap: 5px; }
  .hybrid .badge :global(svg) { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.45; } }
  .note { flex-basis: 100%; }
  @media (prefers-reduced-motion: reduce) { :global(:root:not([data-motion='full'])) .hybrid .badge :global(svg) { animation: none; } }
</style>
