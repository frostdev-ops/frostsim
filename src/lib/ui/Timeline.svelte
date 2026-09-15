<script lang="ts">
  // P06.8: damage over fight time only when engine collected it. ABSENT not empty prevents invented data.
  // Inline SVG: one polyline over mean array. Table is same data (exact values with units).
  import type { Timeline } from '../simc/client'
  import { fmtInt } from '../format'

  interface Props {
    timeline: Timeline
    label?: string
  }
  let { timeline, label = 'Damage per second over fight time' }: Props = $props()

  const W = 720
  const H = 160

  // Engine's own min/max (describe sampled distribution, may be wider than this mean array).
  const top = $derived(Math.max(timeline.max, ...timeline.data, 1))
  const points = $derived(
    timeline.data.length < 2
      ? ''
      : timeline.data
          .map((v, i) => {
            const x = (i / (timeline.data.length - 1)) * W
            const y = H - (v / top) * H
            return `${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' '),
  )

  /** A readable table of a per-second array: every tenth second, plus the peak. */
  const rows = $derived.by(() => {
    const n = timeline.data.length
    if (!n) return []
    const step = Math.max(1, Math.round(n / 20))
    const out: { second: number; value: number; peak?: boolean }[] = []
    for (let i = 0; i < n; i += step) out.push({ second: i, value: timeline.data[i] })
    const peakIndex = timeline.data.indexOf(Math.max(...timeline.data))
    if (!out.some((r) => r.second === peakIndex)) {
      out.push({ second: peakIndex, value: timeline.data[peakIndex], peak: true })
      out.sort((a, b) => a.second - b.second)
    } else {
      const hit = out.find((r) => r.second === peakIndex)
      if (hit) hit.peak = true
    }
    return out
  })
</script>

{#if timeline.data.length >= 2}
  <figure class="stack-sm">
    <svg
      viewBox="0 0 {W} {H}"
      preserveAspectRatio="none"
      role="img"
      aria-label="{label}. Mean {fmtInt(timeline.mean)}, peak {fmtInt(timeline.max)}, low {fmtInt(timeline.min)} damage per second over {timeline.data.length} seconds. The table below carries the values."
    >
      <polyline class="line" points={points} />
    </svg>
    <figcaption class="xs muted">
      {label}. Mean <strong class="num">{fmtInt(timeline.mean)}</strong>,
      peak <strong class="num">{fmtInt(timeline.max)}</strong>,
      low <strong class="num">{fmtInt(timeline.min)}</strong> DPS
      over {fmtInt(timeline.data.length)} seconds.
      {#if timeline.meanStdDev !== undefined}
        Standard error of the mean ±{fmtInt(timeline.meanStdDev)}.
      {/if}
      This is the mean across iterations, not one fight.
    </figcaption>

  </figure>

    <details class="disclosure">
      <summary>Values ({rows.length} of {fmtInt(timeline.data.length)} seconds)</summary>
      <div class="scroll-x">
        <table class="compact">
          <caption class="sr-only">{label}, sampled</caption>
          <thead>
            <tr><th scope="col">Second</th><th scope="col" class="n">DPS</th></tr>
          </thead>
          <tbody>
            {#each rows as row, i (i)}
              <tr>
                <th scope="row">
                  {row.second}{#if row.peak}<span class="chip">peak</span>{/if}
                </th>
                <td class="n">{fmtInt(row.value)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
{/if}

<style>
  figure { margin: 0; }
  svg {
    width: 100%;
    height: 160px;
    display: block;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r2);
  }
  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .scroll-x { overflow-x: auto; }
</style>
