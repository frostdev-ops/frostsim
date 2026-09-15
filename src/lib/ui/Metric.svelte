<script lang="ts">
  import { fmtInt, fmtPct } from '../format'
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

  const up = $derived(delta !== undefined && delta > 0)
  const down = $derived(delta !== undefined && delta < 0)
</script>

<div class="metric-block {size}">
  {#if label}<div class="xs muted">{label}</div>{/if}
  <div class="row-tight baseline">
    <output class="value">{fmtInt(value ?? NaN)}</output>
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
    font-size: var(--fs-metric);
    font-weight: 720;
    letter-spacing: -0.035em;
    line-height: 1.02;
    font-variant-numeric: tabular-nums;
    /* Headline number is where accent carries the type. */
    background: linear-gradient(180deg, var(--text), color-mix(in oklab, var(--accent) 34%, var(--text)));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
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
</style>
