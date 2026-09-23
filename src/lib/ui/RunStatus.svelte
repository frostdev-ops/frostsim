<script lang="ts">
  // The running-sim panel. Motion here comes from the engine: the ring advances with progress, and
  // the pixel battle is paced by throughput, labelled with the running DPS estimate, and drawn over
  // a faint trace of that estimate and its error band converging.
  import { Tween } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'
  import { fmtInt, fmtPct, fmtSeconds } from '../format'
  import { reducedMotion } from '../theme.svelte'
  import type { EngineProgress } from './progress'
  import SimLog from './SimLog.svelte'
  import PixelFight from './PixelFight.svelte'
  import { activeCharacter, app } from '../app.svelte'
  import { advancedSettings, compareSettings, crestSettings, dropSettings, gearSettings, quickSettings } from '../settings.svelte'
  import type { ToolId } from '../store/records'
  let { title, stage, summary = '', statusDetail = '', fraction, elapsed = 0, log = [], metrics, tool, oncancel }: { title: string; stage: string; summary?: string; statusDetail?: string; fraction?: number; elapsed?: number; log?: string[]; metrics?: EngineProgress | null; tool?: ToolId; oncancel: () => void } = $props()
  let showLog = $state(false)
  const pct = $derived(fraction === undefined ? undefined : Math.min(99, fraction * 100))
  const shownPct = new Tween(0, { easing: cubicOut })
  $effect(() => { if (pct !== undefined) void shownPct.set(pct, { duration: reducedMotion() ? 0 : 600 }) })

  // Who is fighting what: from the active character and the tool's own settings.
  const character = $derived(activeCharacter())
  const runTool = $derived(tool ?? app.job?.tool ?? 'quick')
  const toolSettings = $derived({ quick: quickSettings, compare: compareSettings, gear: gearSettings, droptimizer: dropSettings, crests: crestSettings, advanced: advancedSettings }[runTool] ?? quickSettings)
</script>
<section class="panel active-run">
  <header class="spread">
    <div><h1>{title}</h1>{#if summary}<p class="small muted">{summary}</p>{/if}</div>
    <button class="danger sm" onclick={oncancel}>Cancel</button>
  </header>
  <div class="run-body">
    <div class="progress-ring" class:indeterminate={fraction === undefined} role="progressbar" aria-label={stage} aria-valuemin="0" aria-valuemax="100" aria-valuenow={fraction === undefined ? undefined : Math.round(Math.min(.99, fraction) * 100)}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="track" cx="60" cy="60" r="52" />
        <circle class="fill" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray={pct === undefined ? '18 82' : `${pct} 100`} />
      </svg>
      <div class="ring-label"><strong>{pct === undefined ? '…' : Math.round(shownPct.current) + '%'}</strong><span>estimated</span></div>
    </div>
    <div class="output">
      <p class="stage" aria-live="polite">{stage}</p>
      <PixelFight className={character?.className} spec={character?.spec} fightStyle={toolSettings.fightStyle} targets={toolSettings.targets} tool={runTool} speed={metrics?.iterationsPerSecond} dps={metrics?.mean} errorPct={metrics?.errorPct} progress={fraction} />
      {#if metrics?.mean !== undefined}
        <dl class="stats">
          <div><dt>DPS so far</dt><dd>{fmtInt(metrics.mean)}</dd></div>
          {#if metrics.errorPct !== undefined}<div><dt>Error</dt><dd>±{fmtPct(metrics.errorPct)}</dd></div>{/if}
          {#if metrics.iterationsPerSecond}<div><dt>Speed</dt><dd>{fmtInt(metrics.iterationsPerSecond)}<small> it/s</small></dd></div>{/if}
          {#if metrics.iterations}<div><dt>Iterations</dt><dd>{fmtInt(metrics.iterations)}</dd></div>{/if}
        </dl>
      {/if}
      {#if statusDetail}<span class="small muted">{statusDetail}</span>{/if}
      {#if elapsed}<span class="small muted">{fmtSeconds(elapsed)} elapsed</span>{/if}
    </div>
  </div>
  <details class="disclosure" bind:open={showLog}>
    <summary>SimulationCraft log</summary>
    {#if showLog}<SimLog lines={log} />{/if}
  </details>
</section>
<style>
  .active-run { padding: 24px 28px; display: flex; flex-direction: column; gap: 20px; }
  header { align-items: flex-start; }
  header p { margin-top: 6px; }
  .run-body { display: flex; align-items: center; gap: 36px; }
  .output { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .stage { font: 600 18px var(--font-display); color: var(--accent-hi); }
  :global(:root[data-theme='light']) .stage { color: var(--accent); }

  .progress-ring { position: relative; width: 150px; height: 150px; flex: none; display: grid; place-items: center; }
  svg { display: block; }
  .progress-ring svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
  circle { fill: none; }
  .track { stroke: var(--bar-track); stroke-width: 5px; }
  .fill { stroke: var(--accent); stroke-width: 5px; stroke-linecap: round; transition: stroke-dasharray 0.6s var(--ease); }
  .indeterminate .fill { transform-origin: 60px 60px; animation: spin 2.4s linear infinite; }
  .ring-label { position: relative; display: flex; flex-direction: column; align-items: center; }
  .ring-label strong { font: 700 32px/1 var(--font-display); font-variant-numeric: tabular-nums; color: var(--text); }
  .ring-label span { font-size: 11px; color: var(--text-faint); letter-spacing: 0.1em; text-transform: uppercase; margin-top: 4px; }

  .stats { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0; }
  .stats div { display: flex; flex-direction: column; gap: 2px; }
  .stats dt { font-size: var(--fs-xs); color: var(--text-faint); }
  .stats dd { margin: 0; font: 600 18px var(--font-display); font-variant-numeric: tabular-nums; }
  .stats small { font-size: 12px; color: var(--text-muted); font-weight: 500; }


  @keyframes spin { to { rotate: 1turn; } }
  @media (max-width: 40rem) { .run-body { flex-direction: column; align-items: flex-start; gap: 20px; } }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .active-run .fill { animation: none; transition: none; }
  }
  :global(:root[data-motion='reduced']) .active-run .fill { animation: none; transition: none; }
</style>
