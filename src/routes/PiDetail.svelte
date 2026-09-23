<script lang="ts">
  // One spec's Power Infusion drawer: its no-PI and PI reports side by side. Loaded on first open
  // (with LayerChart) so the table page stays light. Breakdown rows come from the same
  // damageBreakdown the quick sim uses, so pets and child spells are counted the same way.
  import 'layerchart/core.css'
  import { BarChart, LineChart, AreaChart, PieChart, Tooltip } from 'layerchart'
  import {
    loadPiDetail, piDetailView, piRows,
    type PiAbility, type PiData, type PiRow, type PiSpec,
  } from '../lib/powerInfusion'
  import { fmtDelta, fmtDeltaPct, fmtInt, fmtPct, titleCase } from '../lib/format'
  import { reducedMotion } from '../lib/theme.svelte'

  let { data, spec, row, targets, units }: {
    data: PiData; spec: PiSpec; row: PiRow; targets: number; units: 'dps' | 'pct'
  } = $props()

  const detail = $derived(loadPiDetail(spec.profile))
  const motion = $derived(reducedMotion() ? undefined : ({ type: 'tween', duration: 450 } as const))

  const k = (n: number) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`
  const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`
  const share = (x: number) => `${Math.round(x * 100)}%`
  const labelOf = (a: PiAbility) => a.pet ? `${titleCase(a.label)} (pet)` : a.label

  // Every target count for this row, in the table's units.
  const across = $derived(Array.from({ length: 10 }, (_, i) => i + 1).flatMap((n) => {
    const r = piRows(data, n, 'total', units).find((x) => x.id === row.id)
    return r ? [{ n, total: units === 'dps' ? r.total.gain : r.total.pct, main: units === 'dps' ? r.main.gain : r.main.pct }] : []
  }))
  const unit = (v: number) => units === 'dps' ? fmtDelta(v) : fmtDeltaPct(v)

  const DONUT = 5
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']
  function donut(abilities: PiAbility[]) {
    const total = abilities.reduce((s, a) => s + a.with, 0)
    const top = abilities.slice(0, DONUT).map((a, i) => ({ key: a.key, label: labelOf(a), value: a.with, color: SERIES[i] }))
    const rest = abilities.slice(DONUT).reduce((s, a) => s + a.with, 0)
    const slices = rest > 0 ? [...top, { key: 'other', label: `Other (${abilities.length - DONUT})`, value: rest, color: 'var(--series-other)' }] : top
    return slices.map((s) => ({ ...s, share: total ? s.value / total : 0 }))
  }
  const GAINS = 8
  function gains(abilities: PiAbility[]) {
    const sorted = [...abilities].sort((a, b) => b.gain - a.gain)
    const rest = sorted.slice(GAINS)
    return [
      ...sorted.slice(0, GAINS).map((a) => ({ label: labelOf(a), gain: a.gain, with: a.with, without: a.without })),
      ...(rest.length ? [{ label: `Other (${rest.length})`, gain: rest.reduce((s, a) => s + a.gain, 0), with: rest.reduce((s, a) => s + a.with, 0), without: rest.reduce((s, a) => s + a.without, 0) }] : []),
    ]
  }
</script>

<div class="pi-detail">
  {#await detail}
    <p class="muted small">Loading {spec.name} details…</p>
  {:then file}
    {@const run = file.runs.find((r) => r.targets === targets)}
    {#if !run}
      <p class="muted small">No detail at {targets} targets.</p>
    {:else}
      {@const v = piDetailView(run, row.funnel)}
      {@const pie = donut(v.abilities)}
      {@const bars = gains(v.abilities)}
      <div class="tiles">
        <div class="tile">
          <span class="tile-label">Extra damage, all targets</span>
          <span class="tile-value">{fmtDelta(row.total.gain)}</span>
          <span class="tile-sub">{fmtDeltaPct(row.total.pct)} · ±{fmtInt(row.total.margin)}</span>
        </div>
        <div class="tile">
          <span class="tile-label">To the main target</span>
          <span class="tile-value">{fmtDelta(row.main.gain)}</span>
          <span class="tile-sub">{row.toMain === undefined ? 'within noise' : `${share(row.toMain)} of the gain`}</span>
        </div>
        {#if v.pi}
          <div class="tile">
            <span class="tile-label">Power Infusion casts</span>
            <span class="tile-value">{v.pi.casts.toFixed(1)}</span>
            <span class="tile-sub">per fight, {spec.piTiming === 'apl' ? "timed by the spec's action list" : 'on cooldown'}</span>
          </div>
          <div class="tile">
            <span class="tile-label">Power Infusion up</span>
            <span class="tile-value">{fmtPct(v.pi.uptimePct, 1)}</span>
            <span class="tile-sub">of the fight</span>
          </div>
        {/if}
      </div>

      <figure class="chart-card wide">
        <figcaption>
          <span class="chart-title">Damage per second over the fight</span>
          <span class="keys">
            <span><i class="key line s1"></i>With Power Infusion</span>
            <span><i class="key line so"></i>Without</span>
            <span><i class="key band s1"></i>PI up in most runs</span>
            <span><i class="key band so"></i>Bloodlust</span>
          </span>
        </figcaption>
        <div class="plot tall">
          <LineChart
            data={v.timeline} x="t" {motion}
            series={[
              { key: 'without', label: 'Without', color: 'var(--series-other)' },
              { key: 'with', label: 'With Power Infusion', color: 'var(--series-1)' },
            ]}
            annotations={[
              ...v.lustWindows.map((x) => ({ type: 'range' as const, x, layer: 'below' as const, fill: 'var(--band-lust)' })),
              ...v.piWindows.map((x) => ({ type: 'range' as const, x, layer: 'below' as const, fill: 'var(--band-pi)' })),
            ]}
            props={{ xAxis: { format: clock }, yAxis: { format: k }, spline: { strokeWidth: 2 } }}
            padding={{ left: 40, bottom: 24, top: 8, right: 8 }}
          >
            {#snippet tooltip()}
              <Tooltip.Root>
                {#snippet children({ data: s })}
                  <Tooltip.Header value={clock(s.t)} />
                  <Tooltip.List>
                    <Tooltip.Item label="With PI" value={s.with} format={fmtInt} color="var(--series-1)" />
                    <Tooltip.Item label="Without" value={s.without} format={fmtInt} color="var(--series-other)" />
                    <Tooltip.Item label="Difference" value={s.gain} format={fmtDelta} />
                    <Tooltip.Item label="PI up in" value={s.piUp} format={share} />
                  </Tooltip.List>
                {/snippet}
              </Tooltip.Root>
            {/snippet}
          </LineChart>
        </div>
      </figure>

      <figure class="chart-card wide">
        <figcaption>
          <span class="chart-title">What Power Infusion adds, second by second</span>
          <span class="muted xs">With minus without. Each is its own simulation, so small swings either side of zero are noise.</span>
        </figcaption>
        <div class="plot">
          <AreaChart
            data={v.timeline} x="t" y="gain" {motion}
            series={[{ key: 'gain', label: 'Difference', color: 'var(--series-1)' }]}
            annotations={v.piWindows.map((x) => ({ type: 'range' as const, x, layer: 'below' as const, fill: 'var(--band-pi)' }))}
            props={{ xAxis: { format: clock }, yAxis: { format: k }, area: { fillOpacity: 0.14 }, spline: { strokeWidth: 2 } }}
            padding={{ left: 40, bottom: 24, top: 8, right: 8 }}
          >
            {#snippet tooltip()}
              <Tooltip.Root>
                {#snippet children({ data: s })}
                  <Tooltip.Header value={clock(s.t)} />
                  <Tooltip.List>
                    <Tooltip.Item label="Difference" value={s.gain} format={fmtDelta} color="var(--series-1)" />
                    <Tooltip.Item label="PI up in" value={s.piUp} format={share} />
                  </Tooltip.List>
                {/snippet}
              </Tooltip.Root>
            {/snippet}
          </AreaChart>
        </div>
      </figure>

      <div class="pair">
        <figure class="chart-card">
          <figcaption>
            <span class="chart-title">Gain from 1 to 10 targets</span>
            <span class="keys">
              <span><i class="key line s1"></i>All targets</span>
              <span><i class="key line s2"></i>Main target</span>
            </span>
          </figcaption>
          <div class="plot">
            <LineChart
              data={across} x="n" {motion} points
              series={[
                { key: 'total', label: 'All targets', color: 'var(--series-1)' },
                { key: 'main', label: 'Main target', color: 'var(--series-2)' },
              ]}
              annotations={[{ type: 'line', x: targets, label: `${targets}T` }]}
              props={{ xAxis: { format: (n: number) => `${n}` }, yAxis: { format: units === 'dps' ? k : (n: number) => `${n.toFixed(1)}%` } }}
              padding={{ left: 40, bottom: 24, top: 12, right: 12 }}
            >
              {#snippet tooltip()}
                <Tooltip.Root>
                  {#snippet children({ data: s })}
                    <Tooltip.Header value="{s.n} target{s.n === 1 ? '' : 's'}" />
                    <Tooltip.List>
                      <Tooltip.Item label="All targets" value={s.total} format={unit} color="var(--series-1)" />
                      <Tooltip.Item label="Main target" value={s.main} format={unit} color="var(--series-2)" />
                    </Tooltip.List>
                  {/snippet}
                </Tooltip.Root>
              {/snippet}
            </LineChart>
          </div>
        </figure>

        <figure class="chart-card">
          <figcaption>
            <span class="chart-title">Where the damage comes from, with PI</span>
          </figcaption>
          <div class="donut-wrap">
            <div class="plot donut">
              <PieChart
                data={pie} key="key" value="value" label="label" c="color" cRange={pie.map((p) => p.color)}
                innerRadius={-22} padAngle={0.02} cornerRadius={4} {motion}
              >
                {#snippet tooltip()}
                  <Tooltip.Root>
                    {#snippet children({ data: s })}
                      <Tooltip.Header value={s.label} />
                      <Tooltip.List>
                        <Tooltip.Item label="Share" value={s.share} format={share} color={s.color} />
                        <Tooltip.Item label="DPS" value={s.value} format={fmtInt} />
                      </Tooltip.List>
                    {/snippet}
                  </Tooltip.Root>
                {/snippet}
              </PieChart>
            </div>
            <table class="sources">
              <caption class="sr-only">Damage sources with Power Infusion</caption>
              <tbody>
                {#each pie as s (s.key)}
                  <tr>
                    <th scope="row"><i class="key box" style:--c={s.color}></i>{s.label}</th>
                    <td>{share(s.share)}</td>
                    <td class="muted">{k(s.value)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </figure>
      </div>

      <figure class="chart-card wide">
        <figcaption>
          <span class="chart-title">Where Power Infusion's extra damage came from</span>
          <span class="muted xs">DPS with PI minus without, per damage source. Pets count as one source each.</span>
        </figcaption>
        <div class="plot" style:height="{bars.length * 28 + 28}px">
          <BarChart
            data={bars} x="gain" y="label" orientation="horizontal" {motion}
            series={[{ key: 'gain', label: 'Extra DPS', color: 'var(--series-1)' }]}
            props={{ xAxis: { format: k }, yAxis: { tickMarks: false }, bars: { radius: 4, strokeWidth: 0 } }}
            padding={{ left: 150, bottom: 24, top: 4, right: 12 }}
          >
            {#snippet tooltip()}
              <Tooltip.Root>
                {#snippet children({ data: s })}
                  <Tooltip.Header value={s.label} />
                  <Tooltip.List>
                    <Tooltip.Item label="Extra DPS" value={s.gain} format={fmtDelta} color="var(--series-1)" />
                    <Tooltip.Item label="With PI" value={s.with} format={fmtInt} />
                    <Tooltip.Item label="Without" value={s.without} format={fmtInt} />
                  </Tooltip.List>
                {/snippet}
              </Tooltip.Root>
            {/snippet}
          </BarChart>
        </div>
      </figure>

      <details class="table-view">
        <summary class="small">Damage over the fight as a table</summary>
        <table>
          <thead><tr><th scope="col">Time</th><th scope="col">Without</th><th scope="col">With PI</th><th scope="col">Difference</th><th scope="col">PI up in</th></tr></thead>
          <tbody>
            {#each v.timeline.filter((s) => s.t % 15 === 0) as s (s.t)}
              <tr><th scope="row">{clock(s.t)}</th><td>{fmtInt(s.without)}</td><td>{fmtInt(s.with)}</td><td>{fmtDelta(s.gain)}</td><td>{share(s.piUp)}</td></tr>
            {/each}
          </tbody>
        </table>
      </details>
      <p class="xs muted">
        The engine records damage over time for all targets together, so there is no main-target timeline.
        Main-target figures above come from the priority-target measure of the same simulations.
      </p>
    {/if}
  {:catch e}
    <p class="small err-text">{e instanceof Error ? e.message : String(e)}</p>
  {/await}
</div>

<style>
  /* Chart palette, validated with the dataviz validator against this app's surfaces (#ffffff / #0d1b2e). */
  .pi-detail {
    --series-1: #0284c7; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100; --series-5: #e87ba4;
    --series-other: var(--text-faint);
    --band-pi: color-mix(in oklab, var(--series-1) 13%, transparent);
    --band-lust: color-mix(in oklab, var(--text-faint) 16%, transparent);
    /* LayerChart reads these. */
    --color-primary: var(--series-1);
    --color-surface-100: var(--surface);
    --color-surface-200: var(--surface-2);
    --color-surface-300: var(--border);
    --color-surface-content: var(--text);
    display: grid;
    gap: var(--s3);
    padding: var(--s3) 0 var(--s2);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .pi-detail {
      --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500; --series-5: #d55181;
    }
  }
  :global(:root[data-theme='dark']) .pi-detail {
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500; --series-5: #d55181;
  }

  /* LayerChart fades every other series when the pointer lands on a highlight dot. Series never
     dim here: the tooltip already reads every series at the pointer's second. */
  .pi-detail :global(.lc-highlight-point) { pointer-events: none; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr)); gap: var(--s2); }
  .tile {
    display: grid; gap: 0.1rem; padding: var(--s2) var(--s3);
    border: 1px solid var(--border); border-radius: var(--r3); background: var(--surface-2);
  }
  .tile-label { font-size: var(--fs-xs); color: var(--text-muted); }
  .tile-value { font-size: var(--fs-xl); font-weight: 600; }
  .tile-sub { font-size: var(--fs-xs); color: var(--text-muted); }

  .chart-card {
    margin: 0; padding: var(--s2) var(--s3) var(--s3);
    border: 1px solid var(--border); border-radius: var(--r3); background: var(--surface);
    min-width: 0;
  }
  figcaption { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem var(--s3); margin-bottom: var(--s2); }
  .chart-title { font-size: var(--fs-sm); font-weight: 600; }
  .keys { display: flex; flex-wrap: wrap; gap: 0.2rem var(--s3); font-size: var(--fs-xs); color: var(--text-muted); }
  .keys > span { display: inline-flex; align-items: center; gap: 0.35rem; }
  .key { display: inline-block; flex: none; background: var(--c); }
  .s1 { --c: var(--series-1); }
  .s2 { --c: var(--series-2); }
  .so { --c: var(--series-other); }
  .key.line { width: 14px; height: 2px; border-radius: 1px; }
  .key.band { width: 12px; height: 10px; border-radius: 2px; background: color-mix(in oklab, var(--c) 22%, transparent); }
  .key.box { width: 10px; height: 10px; border-radius: 2px; margin-right: 0.45rem; }

  .plot { height: 180px; }
  .plot.tall { height: 240px; }
  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: var(--s3); }
  .donut-wrap { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: var(--s3); align-items: center; }
  .plot.donut { height: 160px; }
  .sources { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
  .sources th { text-align: left; font-weight: 400; padding: 0.15rem 0; }
  .sources td { text-align: right; padding: 0.15rem 0 0.15rem var(--s2); font-variant-numeric: tabular-nums; white-space: nowrap; }

  .table-view table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); margin-top: var(--s2); }
  .table-view th, .table-view td { padding: 0.15rem var(--s2); text-align: right; font-variant-numeric: tabular-nums; }
  .table-view summary { cursor: pointer; color: var(--text-muted); }

  @media (max-width: 560px) {
    .donut-wrap { grid-template-columns: minmax(0, 1fr); }
    .plot.donut { width: 160px; justify-self: center; }
  }
</style>
