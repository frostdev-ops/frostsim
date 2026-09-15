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
  function download(name: string, blob: Blob) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url) }
</script>
<div class="report-layout">
  <div class="report-main">
    <ResultHeader {outcome} characterLabel={character.name} gear={character.equipped} />
    <EngineNotices logs={outcome.report.logs} engineNotices={outcome.engineNotices} inputWarnings={outcome.inputWarnings} />
    {#if outcome.report.players[0]}<PlayerDetail {outcome} playerName={outcome.report.players[0].name} bind:detail showDetails={false} />{/if}
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
<style>h2 { font-size: 15px; }</style>
