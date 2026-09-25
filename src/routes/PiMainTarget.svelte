<script lang="ts">
  // Main-target damage by target count, with Power Infusion, against single target: which specs'
  // extra targets feed the main target and which pull damage off it. A table, colored as a heatmap.
  import { mainTargetGrid, type PiData } from '../lib/powerInfusion'
  import { fmtInt } from '../lib/format'

  let { data, targets, onpick }: { data: PiData; targets: number; onpick: (n: number) => void } = $props()

  const COLS = [2, 3, 4, 5, 6, 7, 8, 9, 10]
  const rows = $derived(mainTargetGrid(data))
  // One scale for the whole grid, symmetric around "same as single target".
  const reach = $derived(Math.max(0.05, ...rows.flatMap((r) => r.cells.map((c) => Math.abs(c.kept - 1)))))
  const sortAt = $derived(Math.max(2, targets))
  const sorted = $derived([...rows].sort((a, b) =>
    (b.cells.find((c) => c.targets === sortAt)?.kept ?? 0) - (a.cells.find((c) => c.targets === sortAt)?.kept ?? 0)))

  const signed = (kept: number) => {
    const p = Math.round((kept - 1) * 100)
    return p === 0 ? '0%' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`
  }
  // Up to 62% of the pole color over the neutral midpoint, so the number stays readable. Square root,
  // so the common few-percent changes still show against the grid's largest swing.
  const tone = (kept: number) => `${Math.round(Math.sqrt(Math.min(1, Math.abs(kept - 1) / reach)) * 62)}%`

  let hot = $state<{ id: string; n: number } | null>(null)
  const hotRow = $derived(hot ? rows.find((r) => r.id === hot!.id) : undefined)
  const hotCell = $derived(hotRow?.cells.find((c) => c.targets === hot!.n))
</script>

<section class="panel stack-sm" aria-labelledby="pi-main-target">
  <h2 id="pi-main-target" class="small">Main-target damage as targets are added</h2>
  <p class="muted small">
    With Power Infusion, each spec's damage to the main target at 2 to 10 targets, compared with fighting
    it alone. <span class="key gain"></span> Blue: the extra targets add damage to the main target, because
    cleave and the resources it generates feed the single-target rotation.
    <span class="key loss"></span> Red: the rotation moves damage off the main target and onto the others.
    Column headers set the target count above.
  </p>

  <p class="readout small" aria-live="polite">
    {#if hotRow && hotCell}
      <strong>{hotRow.label}</strong> at {hotCell.targets} targets: main target {fmtInt(hotCell.dps)} DPS,
      against {fmtInt(hotRow.single)} alone ({signed(hotCell.kept)}).
    {:else}
      Hover a cell for the damage behind it.
    {/if}
  </p>

  <div class="scroll">
    <table class="grid">
      <caption class="sr-only">
        Main-target damage with Power Infusion at 2 to 10 targets as a change from single target, sorted by
        {sortAt} targets
      </caption>
      <thead>
        <tr>
          <th scope="col">Spec</th>
          {#each COLS as n}
            <th scope="col" class:current={n === targets} aria-sort={n === sortAt ? 'descending' : 'none'}>
              <button type="button" class="pick" onclick={() => onpick(n)} aria-label="Show {n} targets">{n}</button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody
        onpointerover={(e) => {
          const cell = (e.target as HTMLElement).closest('td')
          hot = cell?.dataset.id ? { id: cell.dataset.id, n: Number(cell.dataset.n) } : null
        }}
        onpointerleave={() => (hot = null)}
      >
        {#each sorted as r (r.id)}
          <tr class:funnel={r.funnel || r.aoe}>
            <th scope="row">{r.label}</th>
            {#each COLS as n}
              {@const c = r.cells.find((x) => x.targets === n)}
              <td
                data-id={r.id} data-n={n}
                class:current={n === targets}
                class:gain={c && c.kept > 1}
                class:loss={c && c.kept < 1}
                class:hot={hot?.id === r.id && hot.n === n}
                style:--mix={c ? tone(c.kept) : '0%'}
              >{c ? signed(c.kept) : '—'}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  /* Diverging pair from the dataviz reference: blue gain, red loss, gray midpoint. */
  .panel {
    --gain: #2a78d6; --loss: #e34948; --mid: #f0efec;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .panel { --gain: #3987e5; --loss: #e66767; --mid: #383835; }
  }
  :global(:root[data-theme='dark']) .panel { --gain: #3987e5; --loss: #e66767; --mid: #383835; }

  .key { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 2px; vertical-align: -1px; }
  .key.gain { background: color-mix(in oklab, var(--gain) 62%, var(--mid)); }
  .key.loss { background: color-mix(in oklab, var(--loss) 62%, var(--mid)); }
  .readout { min-height: 1.4em; margin: 0; }

  .scroll { overflow-x: auto; }
  .grid { width: 100%; border-collapse: separate; border-spacing: 2px; font-size: var(--fs-sm); }
  .grid th { font-weight: 400; text-align: left; white-space: nowrap; padding: 0.2rem 0.5rem 0.2rem 0; }
  .grid thead th { text-align: center; padding: 0; color: var(--text-muted); }
  .grid thead th:first-child { text-align: left; }
  .grid tr.funnel th[scope='row'] { color: var(--text-muted); }
  .pick {
    all: unset; display: block; width: 100%; padding: 0.2rem 0; text-align: center; cursor: pointer;
    border-radius: var(--r1); font-variant-numeric: tabular-nums;
  }
  .pick:hover { color: var(--text); background: var(--surface-3); }
  .pick:focus-visible { box-shadow: var(--focus); }
  th.current .pick { color: var(--text); font-weight: 600; }
  td {
    min-width: 3.2rem; padding: 0.25rem 0.35rem; text-align: center; border-radius: 3px;
    font-variant-numeric: tabular-nums; background: var(--mid); color: var(--text);
    transition: box-shadow var(--t-control, 120ms) ease;
  }
  td.gain { background: color-mix(in oklab, var(--gain) var(--mix), var(--mid)); }
  td.loss { background: color-mix(in oklab, var(--loss) var(--mix), var(--mid)); }
  td.current { font-weight: 600; }
  td.hot { box-shadow: inset 0 0 0 2px var(--text); }
  @media (prefers-reduced-motion: reduce) { td { transition: none; } }
</style>
