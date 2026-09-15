<script lang="ts">
  import { fmtSeconds } from '../format'
  import SimLog from './SimLog.svelte'
  let { title, stage, summary = '', statusDetail = '', fraction, elapsed = 0, log = [], oncancel }: { title: string; stage: string; summary?: string; statusDetail?: string; fraction?: number; elapsed?: number; log?: string[]; oncancel: () => void } = $props()
  let showLog = $state(true)
</script>
<section class="panel active-run">
  <header><h1>{title}</h1>{#if summary}<p class="small muted">{summary}</p>{/if}</header>
  <div class="run-body">
    <div class="progress-ring" role="progressbar" aria-label={stage} aria-valuemin="0" aria-valuemax="100" aria-valuenow={fraction === undefined ? undefined : Math.round(Math.min(.99, fraction) * 100)}>
      <svg viewBox="0 0 120 120" aria-hidden="true" class:indeterminate={fraction === undefined}><circle class="track" cx="60" cy="60" r="52" /><circle class="fill" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray={fraction === undefined ? '25 75' : `${Math.min(99, fraction * 100)} 100`} /></svg>
      <div class="ring-label"><strong>{fraction === undefined ? '…' : Math.round(Math.min(.99, fraction) * 100) + '%'}</strong><span>estimated</span></div>
    </div>
    <div class="stack output"><div class="spread"><h2 aria-live="polite">{stage}</h2><button class="ghost sm" onclick={() => showLog = !showLog}>{showLog ? 'Hide log' : 'Show log'}</button></div>{#if statusDetail}<span class="small muted">{statusDetail}</span>{/if}{#if elapsed}<span class="small muted">{fmtSeconds(elapsed)} elapsed</span>{/if}{#if showLog}<SimLog lines={log} />{/if}</div>
  </div>
  <footer><button onclick={oncancel}>Cancel simulation</button></footer>
</section>
<style>
  .active-run { padding: 28px; display: flex; flex-direction: column; gap: 24px; }
  header p { margin-top: 8px; }
  .run-body { display: flex; align-items: center; gap: 40px; min-height: 230px; }
  .output { flex: 1; min-width: 0; }
  .run-body h2 { font-size: 20px; color: var(--accent); }
  .progress-ring { position: relative; width: 190px; height: 190px; flex: none; }
  svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  circle { fill: none; stroke-width: 8px; }
  .track { stroke: var(--bar-track); }
  .fill { stroke: var(--accent); stroke-linecap: round; transition: stroke-dasharray var(--t-control) linear; }
  .ring-label { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; }
  .ring-label strong { font-size: 38px; color: var(--accent); }
  .ring-label span { font-size: 12px; color: var(--text-muted); }
  footer { display: flex; justify-content: flex-end; }
  .indeterminate { animation: rotate 1.5s linear infinite; }
  @keyframes rotate { to { transform: rotate(270deg); } }
  @media(prefers-reduced-motion: reduce) { .indeterminate { animation: none; } }
  :global([data-motion='reduced']) .indeterminate { animation: none; }
</style>
