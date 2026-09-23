<script lang="ts">
  import { Tween } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'
  import { fmtSeconds } from '../format'
  import { reducedMotion } from '../theme.svelte'
  import SimLog from './SimLog.svelte'
  let { title, stage, summary = '', statusDetail = '', fraction, elapsed = 0, log = [], oncancel }: { title: string; stage: string; summary?: string; statusDetail?: string; fraction?: number; elapsed?: number; log?: string[]; oncancel: () => void } = $props()
  let showLog = $state(true)
  const uid = $props.id()
  const pct = $derived(fraction === undefined ? undefined : Math.min(99, fraction * 100))
  // The label glides between engine updates instead of jumping; the bar already
  // eases through its own transition.
  const shownPct = new Tween(0, { easing: cubicOut })
  $effect(() => { if (pct !== undefined) void shownPct.set(pct, { duration: reducedMotion() ? 0 : 600 }) })
</script>
<section class="panel active-run">
  <header><h1>{title}</h1>{#if summary}<p class="small muted">{summary}</p>{/if}</header>
  <div class="run-body">
    <div class="progress-ring" class:indeterminate={fraction === undefined} role="progressbar" aria-label={stage} aria-valuemin="0" aria-valuemax="100" aria-valuenow={fraction === undefined ? undefined : Math.round(Math.min(.99, fraction) * 100)}>
      <span class="halo" aria-hidden="true"></span>
      <span class="orbit" aria-hidden="true"></span>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          <linearGradient id="{uid}-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#5cc6e3" />
            <stop offset="55%" stop-color="#7fb4ff" />
            <stop offset="100%" stop-color="#a58bf7" />
          </linearGradient>
        </defs>
        <circle class="ticks" cx="60" cy="60" r="57" pathLength="120" />
        <circle class="track" cx="60" cy="60" r="50" />
        <circle class="fill" cx="60" cy="60" r="50" pathLength="100" stroke="url(#{uid}-g)" stroke-dasharray={pct === undefined ? '22 78' : `${pct} 100`} />
      </svg>
      <div class="ring-label"><strong>{pct === undefined ? '…' : Math.round(shownPct.current) + '%'}</strong><span>estimated</span></div>
    </div>
    <div class="stack output"><div class="spread"><h2 class="stage" aria-live="polite">{stage}</h2><button class="ghost sm" onclick={() => showLog = !showLog}>{showLog ? 'Hide log' : 'Show log'}</button></div>{#if statusDetail}<span class="small muted">{statusDetail}</span>{/if}{#if elapsed}<span class="small muted">{fmtSeconds(elapsed)} elapsed</span>{/if}{#if showLog}<SimLog lines={log} />{/if}</div>
  </div>
  <footer><button class="danger" onclick={oncancel}>Cancel simulation</button></footer>
</section>
<style>
  .active-run { padding: 28px; display: flex; flex-direction: column; gap: 24px; overflow: hidden; }
  /* A scanning light across the top edge while the engine works. */
  .active-run::after {
    opacity: 1;
    background:
      radial-gradient(40rem 14rem at 20% 0%, rgb(101 203 229 / 0.12), transparent 70%),
      linear-gradient(90deg, transparent, rgb(101 203 229 / 0.9), rgb(165 139 247 / 0.9), transparent) top / 40% 1px no-repeat;
    animation: scan 2.8s var(--ease) infinite;
  }
  @keyframes scan { from { background-position: 0 0, -40% 0; } to { background-position: 0 0, 140% 0; } }
  header p { margin-top: 8px; }
  .run-body { display: flex; align-items: center; gap: 48px; min-height: 230px; }
  .output { flex: 1; min-width: 0; }
  .stage {
    font-size: 22px;
    background: linear-gradient(90deg, var(--accent) 0%, #ffffff 20%, var(--accent) 40%, var(--accent-3) 100%) 0 0 / 250% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: text-sweep 3s linear infinite;
  }
  @keyframes text-sweep { to { background-position: -250% 0; } }

  .progress-ring { position: relative; width: 200px; height: 200px; flex: none; display: grid; place-items: center; }
  .halo {
    position: absolute;
    inset: 12%;
    border-radius: 50%;
    background: radial-gradient(circle, rgb(101 203 229 / 0.28), rgb(165 139 247 / 0.12) 55%, transparent 72%);
    filter: blur(8px);
    animation: breathe 2.6s ease-in-out infinite;
  }
  @keyframes breathe { 50% { scale: 1.12; opacity: 0.7; } }
  .orbit {
    position: absolute;
    inset: 2px;
    border-radius: 50%;
    background: conic-gradient(from 0deg, transparent 0 78%, rgb(101 203 229 / 0.7) 94%, #fff 98%, transparent 100%);
    -webkit-mask: radial-gradient(circle, transparent 64%, #000 65%, #000 67%, transparent 68%);
    mask: radial-gradient(circle, transparent 64%, #000 65%, #000 67%, transparent 68%);
    animation: spin 2.2s linear infinite;
  }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
  circle { fill: none; }
  .ticks { stroke: var(--border-strong); stroke-width: 2px; stroke-dasharray: 0.4 2.6; transform-origin: 60px 60px; animation: spin 40s linear infinite reverse; }
  .track { stroke: var(--bar-track); stroke-width: 9px; }
  .fill {
    stroke-width: 9px;
    stroke-linecap: round;
    filter: drop-shadow(0 0 6px rgb(101 203 229 / 0.8));
    transition: stroke-dasharray 0.6s var(--ease);
  }
  .indeterminate .fill { transform-origin: 60px 60px; animation: spin 1.4s cubic-bezier(.6, .1, .4, .9) infinite; }
  .ring-label { position: relative; display: flex; flex-direction: column; justify-content: center; align-items: center; }
  .ring-label strong {
    font: 700 42px/1 var(--font-display);
    font-variant-numeric: tabular-nums;
    background: linear-gradient(180deg, #fff, var(--accent-hi));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 0 14px rgb(101 203 229 / 0.45));
  }
  :global(:root[data-theme='light']) .ring-label strong { background: none; color: var(--accent); filter: none; }
  .ring-label span { font-size: 12px; color: var(--text-muted); letter-spacing: 0.12em; text-transform: uppercase; margin-top: 4px; }
  footer { display: flex; justify-content: flex-end; }
  @keyframes spin { to { rotate: 1turn; } }
  @media (max-width: 40rem) {
    .run-body { flex-direction: column; gap: 24px; }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .active-run :is(.halo, .orbit, .ticks, .fill, .stage) { animation: none; }
    :global(:root:not([data-motion='full'])) .active-run::after { animation: none; }
  }
  :global(:root[data-motion='reduced']) .active-run :is(.halo, .orbit, .ticks, .fill, .stage) { animation: none; }
  :global(:root[data-motion='reduced']) .active-run::after { animation: none; }
</style>
