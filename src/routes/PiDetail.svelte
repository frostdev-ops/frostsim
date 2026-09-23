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
  import { ChevronRight } from '@lucide/svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { fade } from 'svelte/transition'

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

  const signedK = (n: number) => `${n >= 0 ? '+' : '−'}${k(Math.abs(n))}`
  const sum = (xs: PiAbility[], f: (a: PiAbility) => number) => xs.reduce((s, a) => s + f(a), 0)

  const DONUT = 5
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']
  /** The donut's slices and the table's top rows: the five largest sources, then "Other" holding the rest. */
  function donut(abilities: PiAbility[]) {
    const total = sum(abilities, (a) => a.with)
    const rest = abilities.slice(DONUT)
    const other: PiAbility | undefined = rest.length ? {
      key: 'other', label: `Other (${rest.length})`, pet: false, children: rest,
      with: sum(rest, (a) => a.with), without: sum(rest, (a) => a.without), gain: sum(rest, (a) => a.gain),
    } : undefined
    const rows = [...abilities.slice(0, DONUT), ...(other ? [other] : [])]
      .map((a, i) => ({ a, color: a.key === 'other' ? 'var(--series-other)' : SERIES[i] }))
    const pets = abilities.filter((a) => a.pet)
    return {
      total, rows,
      slices: rows.map(({ a, color }) => ({ key: a.key, label: labelOf(a), value: a.with, color, share: total ? a.with / total : 0 })),
      pets: { count: pets.length, share: total ? sum(pets, (a) => a.with) / total : 0 },
    }
  }
  // Expanded rows of the source table: "other", and any pet or ability with its own breakdown.
  const open = new SvelteSet<string>()
  const toggle = (key: string) => (open.has(key) ? open.delete(key) : open.add(key))

  const GAINS = 8
  let allGains = $state(false)
  function gains(abilities: PiAbility[], all: boolean) {
    const sorted = [...abilities].sort((a, b) => b.gain - a.gain)
    const rest = all ? [] : sorted.slice(GAINS)
    if (all) return sorted.map((a) => ({ label: labelOf(a), gain: a.gain, with: a.with, without: a.without }))
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
      {@const bars = gains(v.abilities, allGains)}
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

      <div class="stack-cards">
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
            {#if pie.pets.count}
              <span class="muted xs">
                Pets {share(pie.pets.share)} ({pie.pets.count}), your own spells {share(1 - pie.pets.share)}.
                Rows with an arrow open: Other lists every remaining source, a pet lists its abilities.
              </span>
            {/if}
          </figcaption>
          <div class="donut-wrap">
            <div class="plot donut">
              <PieChart
                data={pie.slices} key="key" value="value" label="label" c="color" cRange={pie.slices.map((p) => p.color)}
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
            {#snippet source(a: PiAbility, depth: number, color?: string)}
              <tr class="d{Math.min(depth, 3)}" in:fade={{ duration: reducedMotion() ? 0 : 140 }}>
                <th scope="row">
                  {#if a.children}
                    <button
                      type="button" class="exp" aria-expanded={open.has(a.key)}
                      aria-label="{open.has(a.key) ? 'Hide' : 'Show'} the breakdown of {labelOf(a)}"
                      onclick={() => toggle(a.key)}
                    ><ChevronRight size={13} aria-hidden="true" /></button>
                  {:else}
                    <span class="exp"></span>
                  {/if}
                  {#if color}<i class="key box" style:--c={color}></i>{/if}{labelOf(a)}
                </th>
                <td>{share(a.with / pie.total)}</td>
                <td class="muted">{k(a.with)}</td>
                <td class="muted">{signedK(a.gain)}</td>
              </tr>
              {#if a.children && open.has(a.key)}
                {#each a.children as c (c.key)}{@render source(c, depth + 1)}{/each}
              {/if}
            {/snippet}
            <table class="sources">
              <caption class="sr-only">Damage sources with Power Infusion; pets and Other expand</caption>
              <thead>
                <tr><th scope="col">Source</th><th scope="col">Share</th><th scope="col">DPS</th><th scope="col">PI adds</th></tr>
              </thead>
              <tbody>
                {#each pie.rows as { a, color } (a.key)}{@render source(a, 0, color)}{/each}
              </tbody>
            </table>
          </div>
        </figure>
      </div>

      <figure class="chart-card wide">
        <figcaption>
          <span class="chart-title">Where Power Infusion's extra damage came from</span>
          <span class="muted xs">DPS with PI minus without, per damage source. Pets count as one source each.</span>
          <button type="button" class="linkish xs" onclick={() => (allGains = !allGains)}>
            {allGains ? `Top ${GAINS} only` : `Show all ${v.abilities.length} sources`}
          </button>
        </figcaption>
        <div class="plot" style:height="{bars.length * 28 + 28}px">
          <!-- A new set of rows is a new chart: LayerChart's tween between different row lists keeps stale rows. Same rows, new values still animate. -->
          {#key bars.map((b) => b.label).join('|')}
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
          {/key}
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
  .stack-cards { display: grid; gap: var(--s3); }
  .donut-wrap { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: var(--s4); align-items: start; }
  .plot.donut { height: 160px; }
  .sources { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
  .sources thead th { color: var(--text-muted); font-weight: 500; text-align: right; padding: 0 0 0.3rem var(--s2); }
  .sources thead th:first-child { text-align: left; padding-left: 0; }
  .sources tbody th { text-align: left; font-weight: 400; padding: 0.15rem 0; }
  .sources td { text-align: right; padding: 0.15rem 0 0.15rem var(--s2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sources tbody tr + tr { border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); }
  .sources .d1 th { padding-left: 1.1rem; }
  .sources .d2 th { padding-left: 2.2rem; }
  .sources .d3 th { padding-left: 3.3rem; }
  .sources .d1, .sources .d2, .sources .d3 { color: var(--text-muted); }
  .exp {
    all: unset; display: inline-grid; place-items: center; width: 1.1rem; height: 1.1rem; margin-right: 0.2rem;
    vertical-align: -3px; border-radius: var(--r1); cursor: pointer; color: var(--text-muted);
  }
  span.exp { cursor: default; }
  button.exp:hover { background: var(--surface-3); color: var(--text); }
  button.exp:focus-visible { box-shadow: var(--focus); }
  .exp :global(svg) { transition: transform var(--t-panel, 200ms) var(--ease); }
  .exp[aria-expanded='true'] :global(svg) { transform: rotate(90deg); }
  .linkish { all: unset; cursor: pointer; color: var(--accent); margin-left: auto; }
  .linkish:hover { text-decoration: underline; }
  .linkish:focus-visible { box-shadow: var(--focus); border-radius: var(--r1); }
  @media (prefers-reduced-motion: reduce) { .exp :global(svg) { transition: none; } }

  .table-view table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); margin-top: var(--s2); }
  .table-view th, .table-view td { padding: 0.15rem var(--s2); text-align: right; font-variant-numeric: tabular-nums; }
  .table-view summary { cursor: pointer; color: var(--text-muted); }

  @media (max-width: 560px) {
    .donut-wrap { grid-template-columns: minmax(0, 1fr); }
    .plot.donut { width: 160px; justify-self: center; }
  }
</style>
