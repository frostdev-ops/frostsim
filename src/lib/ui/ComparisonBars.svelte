<script lang="ts">
  // Ranked comparison per Raidbots: bars with exact DPS and change vs baseline (P12.4, REPORT-01). Bars are CSS-only decoration; real table always present for A11y (P12.13).
  import type { GearSlot, ItemInstance } from '../import/character'
  import { fmtDelta, fmtDeltaPct, fmtInt } from '../format'
  import { hasWinner as winnerOf } from '../ranking'
  import GearStrip from './GearStrip.svelte'
  import ItemLink from './ItemLink.svelte'
  import type { ResolvedItem } from '../catalog/types'
  import { ms, stagger } from '../theme.svelte'
  import { fly } from 'svelte/transition'

  export interface ComparisonRow {
    id: string
    label: string
    item?: ResolvedItem
    /** Catalog values resolved from candidate's gems, enchants, item options. */
    resolvedItems?: ResolvedItem[]
    /** Absent when the engine returned no result for this candidate. */
    mean?: number
    /** The engine's own confidence margin. Never a standard deviation. */
    margin?: number
    iterations?: number
    /** True when difference from baseline inside error bars; false when separated; undefined when neither reported error. */
    indistinguishable?: boolean
    /** Why this row has no number: 'missing' | 'blocked' | a status string. */
    status?: string
    /** Rendered under the label, e.g. which slots changed. */
    detail?: string
    /** Marks a candidate that uses an item the character does not own. */
    hypothetical?: boolean
    /** Gear thumbnails for this candidate, shown before the label. */
    icons?: ItemInstance[]
    /** Slots this candidate changed, ringed in the strip. */
    changedSlots?: GearSlot[]
  }

  interface Props {
    rows: ComparisonRow[]
    baseline: { label: string; mean: number; margin?: number; equipped?: boolean }
    /** The reference set, shown as thumbnails on the baseline row. */
    baselineGear?: ItemInstance[]
    /** Rows past this are collapsed behind a disclosure. */
    visible?: number
    caption: string
    onselect?: (row: ComparisonRow) => void
  }
  let {
    rows, baseline, baselineGear = [], visible = 20, caption, onselect,
  }: Props = $props()

  let showAll = $state(false)

  const measured = $derived(rows.filter((r) => r.mean !== undefined))
  const unmeasured = $derived(rows.filter((r) => r.mean === undefined))
  const ranked = $derived([...measured].sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0)))

  // Bars anchored at baseline, not floor. Delta grows right for gain, left for loss; zero sits proportionally.
  const deltas = $derived(ranked.map((r) => (r.mean ?? 0) - baseline.mean))
  const maxGain = $derived(Math.max(0, ...deltas))
  const maxLoss = $derived(Math.max(0, ...deltas.map((d) => -d)))
  const reach = $derived(Math.max(maxGain + maxLoss, 1))
  /** Where baseline line sits, 0-100. */
  const zeroPct = $derived(maxLoss === 0 ? 2 : (maxLoss / reach) * 96 + 2)

  /** A delta as a share of the track, always non-negative. */
  function widthOf(delta: number): number {
    return (Math.abs(delta) / reach) * 96
  }

  const shown = $derived(showAll ? ranked : ranked.slice(0, visible))

  /** Baseline row shows only compared slots, not whole set; avoids tall row and off-topic items. */
  const comparedSlots = $derived(new Set(rows.flatMap((r) => r.changedSlots ?? [])))
  const baselineShown = $derived(
    comparedSlots.size ? baselineGear.filter((i) => comparedSlots.has(i.slot)) : [],
  )

  /** Duplicate ids mean caller generated same candidate twice; shows as visible data problem instead of each_key_duplicate crash. */
  const duplicateIds = $derived.by(() => {
    const seen = new Set<string>()
    const dupes = new Set<string>()
    for (const r of rows) (seen.has(r.id) ? dupes : seen).add(r.id)
    return [...dupes]
  })
  const leader = $derived(ranked[0])
  /** Crown rule tested in ranking.ts. */
  const hasWinner = $derived(winnerOf(leader, baseline.mean))
  const untested = $derived(measured.some((r) => r.indistinguishable === undefined))
</script>

<div class="compare">
  <ol class="bars" style:--zero="{zeroPct}%">
    <li class="row baseline-row">
      <div class="label">
        {#if baselineShown.length}
          <GearStrip items={baselineShown} size={36} still inline />
        {/if}
        <span class="truncate name">{baseline.label}</span>
        {#if baseline.equipped !== false}<span class="chip">equipped</span>{/if}
      </div>
      <div class="track"><span class="zero-line" aria-hidden="true"></span></div>
      <div class="figures">
        <span class="dps num">{fmtInt(baseline.mean)}</span>
        <span class="delta muted">baseline</span>
      </div>
    </li>

    {#if duplicateIds.length}
      <li class="dupe-note xs">
        {duplicateIds.length} setup{duplicateIds.length === 1 ? '' : 's'} appear more than once in
        this comparison, so the ranking below repeats rows and may be wrong. This is a Frostsim
        bug, not something in your gear.
      </li>
    {/if}

    {#each shown as row, i (i)}
      {@const delta = (row.mean ?? 0) - baseline.mean}
      {@const w = widthOf(delta)}
      <li
        class="row"
        class:winner={hasWinner && row.id === leader?.id}
        style:--i={Math.min(i, 12)}
        in:fly|global={{ y: 6, duration: ms('reveal'), delay: stagger(i) }}
      >
        <div class="label">
          {#if hasWinner && row.id === leader?.id}
            <span class="crown" aria-hidden="true">◆</span>
          {/if}
          {#if row.icons?.length}
            <GearStrip items={row.icons} resolvedItems={row.resolvedItems ? new Map(row.resolvedItems.map(item => [item.instanceId, item])) : undefined} size={36} changed={row.changedSlots ?? []} still inline />
          {/if}
          {#if onselect}
            <button class="pick truncate name" onclick={() => onselect(row)}>{row.label}</button>
          {:else if row.item}
            <ItemLink itemId={row.item.itemId} name={row.label} resolved={row.item} />
          {:else}
            <span class="truncate name">{row.label}</span>
          {/if}
          {#if row.hypothetical}<span class="chip warn">hypothetical</span>{/if}
          {#if row.indistinguishable}<span class="chip" title="Inside the error bars: this difference cannot be told apart from none">tie</span>{/if}
        </div>
        <div class="track">
          <span class="zero-line" aria-hidden="true"></span>
          <!--
            Anchored at the baseline: gains grow right of the line, losses left.
            The width is the DELTA, so the length of the bar is the size of the
            difference rather than the size of the number.
          -->
          <div
            class="fill"
            class:up={delta > 0 && !row.indistinguishable}
            class:down={delta < 0 && !row.indistinguishable}
            class:flat={!!row.indistinguishable}
            style:left={delta >= 0 ? 'var(--zero)' : `calc(var(--zero) - ${w}%)`}
            style:width="{Math.max(w, 0.35)}%"
          ></div>
          {#if row.margin !== undefined}
            <!-- The error bar is the reason a near-tie is not a ranking. -->
            <span
              class="err-bar"
              style:left={`calc(var(--zero) + ${(delta - row.margin) / reach * 96}%)`}
              style:width="{Math.max(0.4, (row.margin * 2 / reach) * 96)}%"
            ></span>
          {/if}
        </div>
        <div class="figures">
          <span class="dps num">{fmtInt(row.mean)}</span>
          <!--
            The measured difference is always printed. A tie is a statement
            about the error bars, not a zero: it is shown muted, with the chip,
            never rounded away.
          -->
          <span
            class="delta num"
            class:gain={delta > 0 && !row.indistinguishable}
            class:loss={delta < 0 && !row.indistinguishable}
            class:muted={!!row.indistinguishable}
            title={row.indistinguishable ? 'Inside the error bars: measured, but not separable from the baseline' : undefined}
          >
            {delta > 0 ? '▲' : delta < 0 ? '▼' : ''}{fmtDelta(delta)}
            <span class="xs pct">{fmtDeltaPct(baseline.mean ? (delta / baseline.mean) * 100 : 0)}</span>
            {#if row.indistinguishable === undefined}
              <span class="xs faint" title="Neither side reported an error estimate, so this difference cannot be tested">?</span>
            {/if}
          </span>
        </div>
      </li>
    {/each}
  </ol>

  {#if ranked.length > visible}
    <button class="ghost sm more" onclick={() => (showAll = !showAll)}>
      {showAll ? 'Show fewer' : `Show all ${fmtInt(ranked.length)}`}
    </button>
  {/if}

  {#if untested}
    <p
      class="xs muted"
      title="A difference without a confidence interval is a single sample, not a measurement — so whether it is real cannot be tested either way."
    >
      Rows marked ? have no error estimate, so their difference cannot be tested.
    </p>
  {/if}

  {#if unmeasured.length}
    <p class="xs muted">
      {unmeasured.length} candidate{unmeasured.length === 1 ? '' : 's'} produced no result and
      {unmeasured.length === 1 ? 'is' : 'are'} not ranked:
      {unmeasured.slice(0, 4).map((r) => r.label).join(', ')}{unmeasured.length > 4 ? '…' : ''}.
      This ranking is therefore not exhaustive.
    </p>
  {/if}

  <!-- Accessible equivalent: exact values, uncertainty, sample counts the bars approximate. -->
  <details class="disclosure">
    <summary>Exact values as a table</summary>
    <div class="tbl-scroll">
      <table class="tbl">
        <caption class="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Setup</th>
            <th scope="col" class="n">DPS</th>
            <th scope="col" class="n">Change</th>
            <th scope="col" class="n">Uncertainty</th>
            <th scope="col" class="n">Samples</th>
          </tr>
        </thead>
        <tbody>
          <tr class="baseline-cells">
            <th scope="row">{baseline.label}{baseline.equipped !== false ? ' (equipped)' : ''}</th>
            <td class="n">{fmtInt(baseline.mean)}</td>
            <td class="n">—</td>
            <td class="n">{baseline.margin !== undefined ? `±${fmtInt(baseline.margin)}` : '—'}</td>
            <td class="n">—</td>
          </tr>
          {#each ranked as row, i (i)}
            {@const delta = (row.mean ?? 0) - baseline.mean}
            <tr>
              <th scope="row">
                {row.label}
                {#if row.indistinguishable}<span class="chip">too close to call</span>{/if}
                {#if row.hypothetical}<span class="chip warn">hypothetical</span>{/if}
              </th>
              <td class="n">{fmtInt(row.mean)}</td>
              <td class="n">
                {fmtDelta(delta)}
                ({fmtDeltaPct(baseline.mean ? (delta / baseline.mean) * 100 : 0)})
                {#if row.indistinguishable}, inside the error bars{/if}
                {#if row.indistinguishable === undefined}, significance untested{/if}
              </td>
              <td class="n">{row.margin !== undefined ? `±${fmtInt(row.margin)}` : '—'}</td>
              <td class="n">{row.iterations ? fmtInt(row.iterations) : '—'}</td>
            </tr>
          {/each}
          {#each unmeasured as row, i (i)}
            <tr>
              <th scope="row">{row.label}</th>
              <td class="n">—</td>
              <td class="n" colspan="3">{row.status ?? 'no result'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </details>
</div>

<style>
  .compare { display: flex; flex-direction: column; gap: var(--s2); }

  .bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.12rem; }
  .dupe-note {
    color: var(--warn-text, var(--text));
    background: var(--warn-surface, var(--surface-2));
    border: 1px solid var(--warn-border, var(--border));
    border-radius: var(--r1);
    padding: 0.4rem 0.55rem;
  }

  /* Dense rows: height of gear thumbnails they carry, nothing more. */
  .row {
    display: grid;
    grid-template-columns: minmax(14rem, 38ch) minmax(7rem, 1fr) minmax(8.5rem, auto);
    align-items: center;
    gap: var(--s3);
    padding: 0.2rem var(--s2);
    border-radius: var(--r2);
    border: 1px solid transparent;
    transition:
      background 0.3s var(--ease),
      border-color 0.3s var(--ease),
      box-shadow 0.3s var(--ease),
      transform 0.4s var(--spring);
  }
  .row:hover {
    background:
      radial-gradient(24rem circle at var(--mx, 50%) var(--my, 50%), rgb(101 203 229 / 0.12), transparent 60%),
      rgb(255 255 255 / 0.02);
    border-color: color-mix(in oklab, var(--accent) 30%, transparent);
    box-shadow: 0 10px 30px -18px var(--accent-glow);
    /* Lift, not jump: 1px is interactive without shifting neighbours. */
    transform: translateY(-1px);
  }
  .baseline-row {
    background: color-mix(in oklab, var(--surface-2) 80%, transparent);
    border-color: var(--border);
  }
  .winner {
    position: relative;
    overflow: hidden;
    background: linear-gradient(90deg, color-mix(in oklab, var(--good) 16%, transparent), color-mix(in oklab, var(--good) 4%, transparent));
    border-color: color-mix(in oklab, var(--good) 45%, transparent);
    box-shadow: 0 0 30px -14px var(--good);
  }
  /* A light sweep crosses the winning row once it lands. */
  .winner::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 35%, rgb(255 255 255 / 0.14) 50%, transparent 65%);
    translate: -110% 0;
    animation: sweep 1.6s var(--ease) 0.9s forwards;
    pointer-events: none;
  }
  @keyframes sweep { to { translate: 110% 0; } }

  .label { display: flex; align-items: center; gap: 0.4rem; min-width: 0; font-size: var(--fs-sm); }
  .label .name { flex: 0 1 auto; }
  .crown { color: var(--good); font-size: 0.8em; filter: drop-shadow(0 0 6px var(--good)); animation: crown 2.4s ease-in-out infinite; }
  @keyframes crown { 50% { filter: drop-shadow(0 0 2px var(--good)); } }
  .pick {
    all: unset;
    cursor: pointer;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick:hover { color: var(--accent); }
  .pick:focus-visible { box-shadow: var(--focus); border-radius: var(--r1); }

  .track {
    position: relative;
    height: 1.35rem;
    border-radius: 0.35rem;
    background: var(--bar-track);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.3);
    overflow: hidden;
  }
  /* Baseline as line every bar starts from; reference the whole screen uses. */
  .zero-line {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--zero);
    width: 1px;
    background: var(--text-faint);
    opacity: 0.85;
  }
  .fill {
    position: absolute;
    top: 3px;
    bottom: 3px;
    border-radius: 3px;
    background: var(--accent);
    transform-origin: left center;
    animation: grow 0.9s var(--ease) calc(var(--i, 0) * 45ms + 120ms) backwards;
    transition:
      width var(--t-panel) var(--ease),
      left var(--t-panel) var(--ease);
  }
  .fill.down { transform-origin: right center; }
  @keyframes grow { from { transform: scaleX(0); opacity: 0.4; } }
  /* Gains right and lighten outward, losses left and lighten inward: both leave baseline. */
  .fill.up {
    background: linear-gradient(90deg, color-mix(in oklab, var(--gain) 45%, transparent), var(--gain) 85%, color-mix(in oklab, var(--gain) 40%, white));
    box-shadow: 0 0 12px color-mix(in oklab, var(--gain) 45%, transparent);
  }
  .fill.down {
    background: linear-gradient(270deg, color-mix(in oklab, var(--loss) 50%, transparent), var(--loss));
  }
  .fill.flat { background: var(--border-strong); box-shadow: none; }
  .err-bar {
    position: absolute;
    top: 50%;
    height: 7px;
    transform: translateY(-50%);
    border-inline: 1px solid var(--text);
    opacity: 0.4;
    pointer-events: none;
  }

  @media (max-width: 52rem) {
    /* Narrow: bar drops below label rather than squeezing. */
    .row { grid-template-columns: minmax(0, 1fr) minmax(7rem, auto); row-gap: 0.2rem; }
    .track { grid-column: 1 / -1; order: 3; }
  }

  .figures {
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: var(--s2);
    white-space: nowrap;
  }
  .dps { font-weight: 640; font-size: var(--fs-sm); }
  .delta { font-size: var(--fs-xs); font-weight: 600; }

  .more { align-self: flex-start; }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) :is(.fill, .crown) { animation: none; }
    :global(:root:not([data-motion='full'])) .winner::after { animation: none; }
  }
  :global(:root[data-motion='reduced']) :is(.fill, .crown) { animation: none; }
  :global(:root[data-motion='reduced']) .winner::after { animation: none; }
  .baseline-cells { background: var(--surface-2); }

  @media (max-width: 44rem) {
    .row { grid-template-columns: minmax(0, 1fr) auto; }
    .track { grid-column: 1 / -1; order: 3; }
    .figures { justify-content: flex-end; }
  }
</style>
