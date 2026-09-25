<script lang="ts">
  // Power Infusion value per spec at 1-10 targets, precomputed offline from upstream MID2 profiles (CLAUDE.md D13).
  // Reference data, not the user's character; regenerate with npm run data:power-infusion.
  import raw from '../lib/catalog/generated/power-infusion.json'
  import { HOLDS, piRows, SPREADS, type PiData, type PiSpec, type PiGain, type PiRank, type Spread } from '../lib/powerInfusion'
  import { fmtDelta, fmtDeltaPct, fmtInt, fmtPct } from '../lib/format'
  import Tip from '../lib/ui/Tip.svelte'
  import PiMainTarget from './PiMainTarget.svelte'
  import { ArrowDown, ChevronRight, Info } from '@lucide/svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { slide } from 'svelte/transition'
  import { ms } from '../lib/theme.svelte'

  const data = raw as unknown as PiData  // generated JSON; tuples infer as number[]
  const TARGETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  // How many independent runs each spec's numbers average (merge_power_infusion.py), for the source line.
  const runs = [...new Set(data.specs.map((s) => s.sources ?? 1))].sort((a, b) => a - b)
  // Specs a partial re-sim carried over keep the engine they ran on (merge_power_infusion.py --carry).
  const byCommit = new Map<string, PiSpec[]>()
  for (const s of data.specs) if (s.engine) byCommit.set(s.engine.commit, [...(byCommit.get(s.engine.commit) ?? []), s])
  const carried = [...byCommit.values()]
  const hold = `${HOLDS * 100}%`
  const spread = `${SPREADS * 100}%`

  // One source for every explanation: the legend and the hover text read the same strings.
  const EXPLAIN = {
    cooldown:
      "This spec's action list has no Power Infusion line, so it was used on cooldown from the pull, " +
      'every two minutes, instead of lined up with the spec\'s burst.',
    holds:
      `With Power Infusion, the main target still takes ${hold} or more of the damage it takes alone. ` +
      'The spec hits the extra targets without taking damage off the main one: a funnel in practice.',
    slight: `The main target keeps ${spread} to ${hold} of the damage it takes alone.`,
    spreads:
      `The main target keeps under ${spread} of the damage it takes alone: ` +
      'the AoE rotation moves damage onto the other targets.',
    noise: "The gain is smaller than its own 95% margin of error, so it can't be told apart from zero.",
    funnel:
      "SimulationCraft's priority-target option (max_prio_damage for hunters, priority_rotation for " +
      'Subtlety) switched on. The "(funnel option off)" row is the same spec with it off. No other spec has one.',
    total: "Power Infusion's extra damage summed over every target, with its 95% margin of error.",
    main: "Power Infusion's extra damage on the main target only, with its 95% margin of error.",
    toMain: "Share of Power Infusion's extra damage that lands on the main target. 100% is a perfect funnel.",
  }
  const SPREAD: Record<Spread, { text: string; tone: string }> = {
    holds: { text: 'keeps main target', tone: 'good' },
    slight: { text: 'slight spread', tone: '' },
    spreads: { text: 'spreads', tone: 'accent' },
  }

  let targets = $state(5)
  let rank = $state<PiRank>('total')
  let units = $state<'dps' | 'pct'>('dps')

  const rows = $derived(piRows(data, targets, rank, units))
  const size = (g: PiGain) => Math.max(0, units === 'dps' ? g.gain : g.pct)
  const scale = $derived(Math.max(1e-9, ...rows.map((r) => size(r.total))))
  const pct = (x: number) => `${Math.round(x * 100)}%`

  // Which bar segment the pointer is on; lights that segment and its line in the tooltip.
  let hot = $state<{ id: string; part: 'main' | 'others' } | null>(null)
  const isHot = (id: string, part: 'main' | 'others') => hot?.id === id && hot.part === part

  // Drawers start closed. The chart module (LayerChart) and each spec's data load on first open.
  const open = new SvelteSet<string>()
  let drawer = $state<Promise<typeof import('./PiDetail.svelte')>>()
  const toggle = (id: string) => {
    if (open.has(id)) open.delete(id)
    else { drawer ??= import('./PiDetail.svelte'); open.add(id) }
  }
  const specOf = (name: string) => data.specs.find((s) => s.name === name)!

  const COLUMNS: { key: PiRank; label: string }[] = [
    { key: 'total', label: 'All targets' },
    { key: 'main', label: 'Main target' },
    { key: 'toMain', label: 'To main' },
  ]
</script>

{#snippet gain(g: PiGain)}
  <span class="value">{units === 'dps' ? fmtDelta(g.gain) : fmtDeltaPct(g.pct)}</span>
  <span class="margin">±{units === 'dps' ? fmtInt(g.margin) : fmtPct(g.marginPct)}</span>
{/snippet}

<div class="stack">
  <section class="panel stack-sm">
    <h1>Power Infusion value</h1>
    <p class="muted small">
      How much damage each spec gains from one Power Infusion on a two-minute cooldown, from single
      target to ten, and how much of it is funneled into the main target. SimulationCraft's default
      {data.profiles} profile for each spec, not your character; the spec's own action list decides when
      to use it. Bloodlust is on. Labels are explained at the bottom.
    </p>
  </section>

  <section class="panel stack-sm">
    <div class="controls">
      <div class="segmented" role="radiogroup" aria-label="Targets">
        {#each TARGETS as n}
          <label><input type="radio" bind:group={targets} value={n} />{n}</label>
        {/each}
      </div>
      <div class="segmented" role="radiogroup" aria-label="Units">
        <label><input type="radio" bind:group={units} value="dps" />DPS</label>
        <label><input type="radio" bind:group={units} value="pct" />%</label>
      </div>
    </div>

    <div class="table-scroll">
    <table>
      <caption class="sr-only">
        Power Infusion gain per spec at {targets} target{targets === 1 ? '' : 's'}, sorted by
        {COLUMNS.find((c) => c.key === rank)?.label}. Column headers sort; each spec opens a details drawer.
      </caption>
      <thead>
        <tr>
          <th scope="col">Spec</th>
          {#each COLUMNS as c (c.key)}
            <th scope="col" aria-sort={rank === c.key ? 'descending' : 'none'}>
              <span class="head">
                <button type="button" class="sort" class:active={rank === c.key} onclick={() => (rank = c.key)}>
                  {c.label}<ArrowDown size={12} aria-hidden="true" />
                </button>
                <Tip text={EXPLAIN[c.key]}><Info class="info" size={13} aria-label="About {c.label}" /></Tip>
              </span>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.id)}
          {@const outer = (size(r.total) / scale) * 100}
          {@const share = r.toMain === undefined ? undefined : Math.min(1, Math.max(0, r.toMain))}
          <tr class:funnel={r.funnel} class:open={open.has(r.id)}>
            <th scope="row">
              <button
                type="button" class="expand" aria-expanded={open.has(r.id)} aria-controls="pi-drawer-{r.id}"
                aria-label="{open.has(r.id) ? 'Hide' : 'Show'} details for {r.label}" onclick={() => toggle(r.id)}
              ><ChevronRight size={14} aria-hidden="true" /></button>
              {#if r.funnel}
                <Tip text={EXPLAIN.funnel}><span class="name hint">{r.label}</span></Tip>
              {:else}
                <span class="name">{r.label}</span>
              {/if}
              {#if r.cooldown}<Tip text={EXPLAIN.cooldown}><span class="chip warn">on cooldown</span></Tip>{/if}
              {#if r.spread && r.kept !== undefined}
                <Tip text={EXPLAIN[r.spread]}>
                  <span class="chip {SPREAD[r.spread].tone}">{SPREAD[r.spread].text} · {r.spread === 'holds' ? '' : 'main keeps '}{pct(r.kept)}</span>
                </Tip>
              {/if}
              {#if r.total.noise}<Tip text={EXPLAIN.noise}><span class="chip">within noise</span></Tip>{/if}
              {#snippet split()}
                <span class="split" class:funnel={r.funnel}>
                  <span class="split-title">{r.label}: Power Infusion at {targets} target{targets === 1 ? '' : 's'}</span>
                  <span class="split-row" class:hot={isHot(r.id, 'main')}>
                    <i class="sw main"></i><span>Main target</span>
                    <b>{fmtDelta(r.main.gain)}</b><span>{share === undefined ? '' : pct(share)}</span>
                  </span>
                  {#if targets > 1}
                    <span class="split-row" class:hot={isHot(r.id, 'others')}>
                      <i class="sw others"></i><span>Other targets</span>
                      <b>{fmtDelta(r.total.gain - r.main.gain)}</b><span>{share === undefined ? '' : pct(1 - share)}</span>
                    </span>
                  {/if}
                  <span class="split-row total">
                    <i></i><span>All targets</span><b>{fmtDelta(r.total.gain)}</b><span>±{fmtInt(r.total.margin)}</span>
                  </span>
                  {#if share === undefined}<span class="split-note">{EXPLAIN.noise} No split is shown.</span>{/if}
                </span>
              {/snippet}
              <span class="bar">
                <Tip
                  block
                  content={split}
                  text="Main target {fmtDelta(r.main.gain)}, all targets {fmtDelta(r.total.gain)}"
                >
                  <span class="sr-only">Power Infusion split for {r.label}</span>
                  <span
                    class="track" aria-hidden="true"
                    onpointerover={(e) => {
                      const part = (e.target as HTMLElement).dataset.part
                      hot = part === 'main' || part === 'others' ? { id: r.id, part } : null
                    }}
                    onpointerleave={() => (hot = null)}
                  >
                    <span class="fill" style:width="{outer}%">
                      <span data-part="main" class="to-main" class:hot={isHot(r.id, 'main')} style:width="{(share ?? 0) * 100}%"></span>
                      <span data-part="others" class="others" class:hot={isHot(r.id, 'others')}></span>
                    </span>
                  </span>
                </Tip>
              </span>
            </th>
            <td>{@render gain(r.total)}</td>
            <td>{@render gain(r.main)}</td>
            <td>{r.toMain === undefined ? '—' : pct(r.toMain)}</td>
          </tr>
          {#if open.has(r.id)}
            <tr class="drawer" id="pi-drawer-{r.id}">
              <td colspan="4">
                <div class="drawer-inner" transition:slide={{ duration: ms('panel') * 1.6 }}>
                  {#await drawer then mod}
                    {#if mod}
                      <mod.default {data} spec={specOf(r.spec)} row={r} {targets} {units} />
                    {/if}
                  {:catch e}
                    <p class="small err-text">Could not load the charts: {e instanceof Error ? e.message : String(e)}</p>
                  {/await}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    </div>
  </section>

  <PiMainTarget {data} {targets} onpick={(n) => (targets = n)} />

  <section class="panel stack-sm" aria-labelledby="pi-legend">
    <h2 id="pi-legend" class="small">Legend</h2>
    <dl class="legend">
      <dt><span class="chip good">keeps main target</span></dt>
      <dd>{EXPLAIN.holds}</dd>
      <dt><span class="chip">slight spread</span></dt>
      <dd>{EXPLAIN.slight}</dd>
      <dt><span class="chip accent">spreads</span></dt>
      <dd>{EXPLAIN.spreads}</dd>
      <dt><span class="chip warn">on cooldown</span></dt>
      <dd>{EXPLAIN.cooldown}</dd>
      <dt><span class="chip">within noise</span></dt>
      <dd>{EXPLAIN.noise}</dd>
      <dt><span class="term">(funnel option on)</span></dt>
      <dd>{EXPLAIN.funnel}</dd>
      <dt>
        <span class="track sample" aria-hidden="true">
          <span class="fill"><span class="to-main"></span><span class="others"></span></span>
        </span>
        <span class="sr-only">Bar</span>
      </dt>
      <dd>
        Bar length is Power Infusion's gain on all targets, scaled to the largest gain shown. The
        <strong>bright</strong> part is what landed on the main target, the <strong>shaded</strong> part
        what went to the other targets. Hover or tap a bar for the numbers. Green bars are
        funnel-option rows.
      </dd>
      <dt><span class="term">All targets</span></dt>
      <dd>{EXPLAIN.total}</dd>
      <dt><span class="term">Main target</span></dt>
      <dd>{EXPLAIN.main}</dd>
      <dt><span class="term">To main</span></dt>
      <dd>{EXPLAIN.toMain}</dd>
    </dl>
    <p class="xs muted">
      The % in a rotation label is the main target's damage with Power Infusion as a share of its damage
      alone, shown from two targets on. {data.fightStyle},
      target error {data.targetError}% per run{runs.at(-1)! > 1 ? `, each spec averaged over ${runs.length > 1 ? `${runs[0]} to ${runs.at(-1)}` : runs[0]} independent runs` : ''}, simc {data.engine.simcVersion} ({data.engine.commit.slice(0, 10)}),
      WoW {data.engine.wowVersion}, generated {data.generatedAt}.
      {#each carried as specs (specs[0].engine!.commit)}
        {specs.map((s) => s.name).join(', ')}: carried over from simc {specs[0].engine!.simcVersion}
        ({specs[0].engine!.commit.slice(0, 10)}), WoW {specs[0].engine!.wowVersion}.
      {/each}
    </p>
  </section>
</div>

<style>
  .controls { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.3rem var(--s2); text-align: right; vertical-align: top; }
  thead th { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; white-space: nowrap; }
  thead th:first-child, tbody th { text-align: left; width: 100%; font-weight: 400; }
  .hint { text-decoration: underline dotted; text-underline-offset: 3px; }
  .head { display: inline-flex; align-items: center; gap: 0.25rem; }
  .sort {
    all: unset; display: inline-flex; align-items: center; gap: 0.2rem; cursor: pointer;
    border-radius: var(--r1); color: var(--text-muted);
  }
  .sort :global(svg) { opacity: 0; transition: opacity var(--t-control) ease; }
  .sort:hover, .sort.active { color: var(--text); }
  .sort.active :global(svg) { opacity: 1; }
  .sort:hover :global(svg) { opacity: 0.5; }
  .sort:focus-visible { box-shadow: var(--focus); }
  thead :global(.info) { color: var(--text-faint); vertical-align: -2px; }
  .expand {
    all: unset; display: inline-grid; place-items: center; width: 1.25rem; height: 1.25rem;
    margin: 0 0.15rem 0 -0.2rem; vertical-align: -3px; border-radius: var(--r1); cursor: pointer;
    color: var(--text-muted);
  }
  .expand:hover { background: var(--surface-3); color: var(--text); }
  .expand:focus-visible { box-shadow: var(--focus); }
  .expand :global(svg) { transition: transform var(--t-panel) var(--ease); }
  .open .expand :global(svg) { transform: rotate(90deg); }
  tr.drawer { border-top: none !important; }
  tr.drawer > td { padding: 0; white-space: normal; text-align: left; }
  /* The table may scroll sideways on a phone; the drawer stays the width of what is visible. */
  .drawer-inner { position: sticky; left: 0; width: 100cqi; box-sizing: border-box; padding-inline: var(--s2); }
  tbody tr + tr { border-top: 1px solid var(--border); }
  td { white-space: nowrap; }
  .value, .margin { display: block; }
  .margin { font-size: var(--fs-xs); color: var(--text-muted); }
  .name { margin-right: 0.4rem; }
  .track {
    display: block;
    height: 0.6rem;
    margin-top: 0.3rem;
    border-radius: var(--r1);
    background: var(--bar-track);
    overflow: hidden;
  }
  .bar { display: block; }
  .bar .track { height: 0.7rem; cursor: help; }
  .fill { display: flex; height: 100%; --bar: var(--accent); }
  .funnel .fill, .split.funnel { --bar: var(--good); }
  .to-main, .others { height: 100%; transition: opacity var(--t-control, 120ms) ease, filter var(--t-control, 120ms) ease; }
  .to-main { flex: none; background: var(--bar); }
  .others { flex: 1; background: color-mix(in oklab, var(--bar) 40%, transparent); }
  /* The main-target part always stays at full strength; hover only brightens the part under the pointer. */
  .fill > .hot { filter: brightness(1.3); }

  .split { display: grid; grid-template-columns: auto 1fr auto auto; gap: 0.2rem 0.5rem; align-items: center; }
  .split-title { grid-column: 1 / -1; font-weight: 500; margin-bottom: 0.15rem; }
  .split-row { display: contents; }
  .split-row > * { transition: opacity 120ms ease; }
  .split:has(.hot) .split-row:not(.hot):not(.total) > * { opacity: 0.55; }
  .split-row b { text-align: right; font-variant-numeric: tabular-nums; }
  .split-row > span:last-child { text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .split-row.total > * { border-top: 1px solid var(--border); padding-top: 0.2rem; }
  .sw { width: 0.7rem; height: 0.7rem; border-radius: 2px; }
  .sw.main { background: var(--bar); }
  .sw.others { background: color-mix(in oklab, var(--bar) 40%, transparent); }
  .split-note { grid-column: 1 / -1; color: var(--text-muted); font-size: var(--fs-xs); }

  .legend {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--s2) var(--s4);
    align-items: baseline;
    margin: 0;
    font-size: var(--fs-sm);
  }
  .legend dt { justify-self: start; }
  .legend dd { margin: 0; color: var(--text-muted); }
  .term { font-weight: 500; }
  .track.sample { width: 6rem; margin: 0; }
  .sample .fill { width: 100%; }
  .sample .to-main { width: 35%; }
  @media (prefers-reduced-motion: reduce) { .to-main, .others, .split-row > *, .expand :global(svg), .sort :global(svg) { transition: none; } }
  .table-scroll { overflow-x: auto; container-type: inline-size; }
  @media (max-width: 560px) {
    thead th { white-space: normal; }
    .head { flex-wrap: wrap; justify-content: flex-end; }
    th, td { padding-inline: 0.3rem; }
    .legend { grid-template-columns: minmax(0, 1fr); gap: 0.2rem; }
    .legend dd { margin-bottom: var(--s2); }
  }
</style>
