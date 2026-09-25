<script lang="ts">
  import type { SimOutcome } from '../simc/job'
  import type { PlayerDetail as Detail } from '../simc/detail'
  import { parseAddonExport } from '../import/character'
  import ResultHeader from './ResultHeader.svelte'
  import PlayerDetail from './PlayerDetail.svelte'
  import EngineNotices from './EngineNotices.svelte'
  import SimulationDetails from './SimulationDetails.svelte'
  import ShareReport from './ShareReport.svelte'
  let { outcome, onrerun, onedit }: { outcome: SimOutcome; onrerun: () => void; onedit: () => void } = $props()
  const character = $derived(outcome.request.characterSnapshot ?? parseAddonExport(outcome.request.profile))
  let detail = $state<Detail | null>(null)
  /** Several characters in one run (D2): ranked, and the one picked here fills the detail below. */
  const ranked = $derived([...outcome.report.players].sort((a, b) => b.dps.mean - a.dps.mean))
  let focus = $state('')
  const shown = $derived(outcome.report.players.find((p) => p.name === focus) ?? outcome.report.players[0])
  const top = $derived(ranked[0]?.dps.mean || 1)
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  function download(name: string, blob: Blob) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url) }
</script>
<div class="report-layout">
  <div class="report-main">
    <ResultHeader {outcome} characterLabel={character.name} gear={character.equipped} />
    <EngineNotices logs={outcome.report.logs} engineNotices={outcome.engineNotices} inputWarnings={outcome.inputWarnings} />
    {#if ranked.length > 1}
      <section class="panel stack-sm ranking" aria-label="Characters in this sim">
        <h2>Characters in this sim</h2>
        <ol>
          {#each ranked as p, i (p.name)}
            <li>
              <button class:on={p === shown} aria-pressed={p === shown} onclick={() => (focus = p.name)}>
                <span class="rank">{i + 1}</span>
                <span class="who"><strong class="truncate">{p.name}</strong><span class="xs muted truncate">{p.specialization}</span></span>
                <span class="bar" aria-hidden="true"><span style="width: {(100 * p.dps.mean) / top}%"></span></span>
                <span class="num"><strong>{fmt.format(p.dps.mean)}</strong>{#if p.dpsConfidence}<span class="xs muted"> ± {fmt.format(p.dpsConfidence.margin)}</span>{/if}
                  {#if i}<span class="xs loss">−{((1 - p.dps.mean / top) * 100).toFixed(1)}%</span>{/if}</span>
              </button>
            </li>
          {/each}
        </ol>
      </section>
    {/if}
    {#if shown}{#key shown.name}<PlayerDetail {outcome} playerName={shown.name} bind:detail showDetails={false} />{/key}{/if}
  </div>
  <aside class="report-sidebar">
    <section class="panel stack-sm"><h2>Report options</h2><button class="primary" onclick={onrerun}>Run again</button><button onclick={onedit}>Edit setup</button>
      <ShareReport {outcome} />
      <details class="disclosure"><summary>Export report</summary><div class="stack-sm">
        <button class="sm" onclick={() => download('report.json', outcome.getRawJson())}>Download JSON</button>
        <button class="sm" onclick={() => download('profile.simc', new Blob([outcome.effectiveProfile || outcome.request.profile], { type: 'text/plain' }))}>Download profile</button>
        {#if outcome.getHtmlReport()}<button class="sm" onclick={() => download('report.html', outcome.getHtmlReport()!)}>Download HTML</button>{/if}
      </div></details>
    </section>
    <SimulationDetails {outcome} {detail} />
  </aside>
</div>
<style>
  h2 { font-size: 15px; }
  .ranking ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .ranking button {
    all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 1.5rem minmax(8rem, 14rem) 1fr auto; align-items: center; gap: 12px;
    padding: 8px 10px; border-radius: 10px; cursor: pointer;
  }
  .ranking button:hover, .ranking button.on { background: var(--surface-3); }
  .ranking button:focus-visible { box-shadow: var(--focus); }
  .rank { font: 700 14px var(--font-display); color: var(--text-muted); text-align: center; }
  .who { display: grid; min-width: 0; }
  .bar { height: 8px; border-radius: 99px; background: var(--bar-track); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), var(--accent-3, var(--accent))); }
  .num { text-align: right; white-space: nowrap; display: grid; }
  .loss { color: var(--loss); }
  @media (max-width: 640px) { .ranking button { grid-template-columns: 1.5rem 1fr auto; } .bar { display: none; } }
</style>
