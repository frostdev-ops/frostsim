<script lang="ts">
  import { Tween } from 'svelte/motion'
  import { expoOut } from 'svelte/easing'
  import { fmtInt, fmtPct } from '../format'
  import { reducedMotion } from '../theme.svelte'
  import type { ConfidenceInterval, Distribution } from '../simc/report'

  interface Props {
    label?: string
    value: number | undefined
    unit?: string
    /** The report's own interval. Absent means the engine gave no estimator. */
    confidence?: ConfidenceInterval
    /** Standard error of the mean, shown separately — never merged with the CI. */
    distribution?: Distribution
    size?: 'lg' | 'md'
    /** Absolute change against a baseline, when there is one to compare to. */
    delta?: number
    /** The same change as a percentage. Shown beside the absolute, never alone. */
    deltaPct?: number
  }
  let {
    label, value, unit = 'DPS', confidence, distribution, size = 'lg', delta, deltaPct,
  }: Props = $props()

  const sePct = $derived(
    distribution?.meanStdDev !== undefined && value
      ? (distribution.meanStdDev / value) * 100
      : undefined,
  )

  // Uncertainty compact and secondary (not sentence); full phrasing in title attr (precision one hover away, not in way).
  const uncertainty = $derived.by(() => {
    if (confidence) {
      return {
        short: `±${fmtInt(confidence.margin)} · ${fmtPct(confidence.relativePct)}`,
        long: `Confidence interval from the engine's own estimator: ±${fmtInt(confidence.margin)} at ${Math.round(confidence.level * 100)}% confidence, ${fmtPct(confidence.relativePct)} of the mean.`,
      }
    }
    if (sePct !== undefined) {
      return {
        short: `SE ${fmtPct(sePct)}`,
        long: `Standard error of the mean, ${fmtPct(sePct)}. The engine reported no confidence estimator for this run, so this is not a confidence interval.`,
      }
    }
    return { short: 'no interval', long: 'The engine reported no uncertainty for this run.' }
  })

  // The headline counts up to its value. Screen readers get the final number
  // only, from the sr-only copy; the counting digits are hidden from them.
  const finite = $derived(value !== undefined && Number.isFinite(value))
  const shown = new Tween(0, { easing: expoOut })
  $effect(() => {
    if (value !== undefined && Number.isFinite(value)) void shown.set(value, { duration: reducedMotion() ? 0 : 1300 })
  })

  const up = $derived(delta !== undefined && delta > 0)
  const down = $derived(delta !== undefined && delta < 0)
</script>

<div class="metric-block {size}">
  {#if label}<div class="xs muted">{label}</div>{/if}
  <div class="row-tight baseline">
    <span class="value" aria-hidden="true">{fmtInt(finite ? Math.round(shown.current) : NaN)}</span>
    <span class="sr-only">{fmtInt(value ?? NaN)}</span>
    <span class="unit muted">{unit}</span>
    {#if delta !== undefined && Number.isFinite(delta)}
      <span class="delta num" class:up class:down>
        {up ? '▲' : down ? '▼' : ''}{fmtInt(Math.abs(delta))}
        {#if deltaPct !== undefined}<span class="pct">{fmtPct(Math.abs(deltaPct))}</span>{/if}
      </span>
    {/if}
  </div>
  <div class="xs muted uncertainty" title={uncertainty.long}>{uncertainty.short}</div>
</div>

<style>
  .baseline { align-items: baseline; }
  .value {
    font-family: var(--font-display);
    font-size: var(--fs-metric);
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.02;
    font-variant-numeric: tabular-nums;
    /* Headline number is where accent carries the type: ice gradient with a
       light sweep that crosses it once the count lands. */
    background:
      linear-gradient(100deg, transparent 40%, rgb(255 255 255 / 0.9) 50%, transparent 60%) 160% 0 / 250% 100% no-repeat,
      linear-gradient(180deg, #ffffff 15%, var(--accent-hi) 60%, var(--accent) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 0 22px rgb(101 203 229 / 0.35));
    animation: glint 1.4s var(--ease) 1.1s backwards;
  }
  @keyframes glint { from { background-position: 160% 0, 0 0; } to { background-position: -60% 0, 0 0; } }
  :global(:root[data-theme='light']) .value {
    background: linear-gradient(180deg, var(--text), var(--accent));
    -webkit-background-clip: text;
    background-clip: text;
    filter: none;
  }
  @supports not (background-clip: text) {
    .value { color: var(--text); }
  }
  @media (forced-colors: active) {
    .value { color: CanvasText; background: none; }
  }
  .md .value { font-size: var(--fs-2xl); }
  .unit { font-weight: 600; font-size: var(--fs-md); }
  .uncertainty { margin-top: 0.15rem; }

  .delta {
    animation: pop 0.6s var(--spring) 0.9s backwards;
    margin-left: var(--s2);
    padding: 0.1rem 0.4rem;
    font-size: var(--fs-sm);
    font-weight: 650;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Direction carries glyph and color; survives color deficiency and forced-colors. */
  .delta.up {
    color: var(--good);
    border-color: color-mix(in oklab, var(--good) 55%, transparent);
    background: color-mix(in oklab, var(--good) 12%, transparent);
  }
  .delta.down {
    color: var(--bad);
    border-color: color-mix(in oklab, var(--bad) 55%, transparent);
    background: color-mix(in oklab, var(--bad) 12%, transparent);
  }
  .delta .pct { opacity: 0.8; margin-left: 0.25rem; }
  .delta.up { box-shadow: 0 0 18px -6px var(--good); }
  @keyframes pop { from { opacity: 0; transform: scale(0.6); } }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .value, :global(:root:not([data-motion='full'])) .delta { animation: none; }
  }
  :global(:root[data-motion='reduced']) .value, :global(:root[data-motion='reduced']) .delta { animation: none; }
</style>
