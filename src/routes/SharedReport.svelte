<script lang="ts">
  import { router } from '../lib/router.svelte'
  import { decodeReport, sharedConfidence, sharedGear, sharedDetail, type SharedReport } from '../lib/store/report-share'
  import Metric from '../lib/ui/Metric.svelte'
  import GearStrip from '../lib/ui/GearStrip.svelte'
  import PlayerDetail from '../lib/ui/PlayerDetail.svelte'
  import EngineNotices from '../lib/ui/EngineNotices.svelte'
  import ComparisonBars from '../lib/ui/ComparisonBars.svelte'
  import SimulationDetails from '../lib/ui/SimulationDetails.svelte'
  import { titleCase } from '../lib/format'
  let report = $state<SharedReport | null>(null), error = $state(''), copied = $state(false)
  let copyError = $state('')
  $effect(() => {
    const payload = router.raw.slice(2)
    let cancelled = false
    report = null; error = ''; copied = false
    void decodeReport(payload).then(s => { if (!cancelled) report = s }).catch(e => { if (!cancelled) error = e instanceof Error ? e.message : 'This link could not be opened.' })
    return () => { cancelled = true }
  })
  async function copy(text: string) { copyError = ''; try { await navigator.clipboard.writeText(text); copied = true } catch { copyError = 'Clipboard unavailable. Select and copy the link or talent text manually.' } }
</script>
{#if error}<section class="panel stack"><h1>Could not open shared report</h1><p role="alert">{error}</p><a href="#/reports">Your reports</a></section>
{:else if !report}<section class="panel" role="status">Opening shared report…</section>
{:else}
  <div class="report-layout">
    <div class="report-main">
      <section class="panel stack-sm" data-class={report.meta.className}>
        <div class="spread"><div><span class="xs muted">Shared report</span><h1>{report.meta.kind}</h1></div><Metric value={report.d} confidence={sharedConfidence(report)} /></div>
        <div><h2>{report.n}</h2><span class="small muted">{titleCase(report.c)} · Level {report.l}</span></div>
        <GearStrip items={sharedGear(report)} size={40} />
      </section>
      {#if report.meta.valid === false}<p class="error" role="alert">The engine does not support this fight style for this specialization.</p>{/if}
      <EngineNotices logs={report.w} inputWarnings={report.meta.inputWarnings} />
      {#if report.meta.comparisons?.length}<ComparisonBars rows={report.meta.comparisons.map((r, i) => ({ id: String(i), label: r[0], mean: r[1], margin: r[2] ?? undefined, iterations: r[3] }))} baseline={{ label: report.n, mean: report.d, margin: report.e[0] ?? undefined }} caption="Shared comparison results" />{/if}
      {#if report.meta.weights?.length}<section class="panel"><h2>Stat weights</h2><table class="tbl"><tbody>{#each report.meta.weights as [stat, value]}<tr><th>{stat}</th><td>{value.toFixed(3)}</td></tr>{/each}</tbody></table></section>{/if}
      {#if report.meta.candidates?.length}<details class="panel disclosure"><summary>Compared setups</summary>{#each report.meta.candidates as candidate, i (i)}<div class="stack-sm"><strong>{candidate[0]} · {candidate[1]}{candidate[3] ? ' · within the leading group’s uncertainty' : ''}</strong><pre class="xs">{candidate[2].join('\n')}</pre></div>{/each}</details>{/if}
      {#if report.damage}<PlayerDetail shared={report} playerName={report.n} showDetails={false} />{/if}
    </div>
    <aside class="report-sidebar">
      <section class="panel stack-sm"><h2>Report options</h2><button class="primary" onclick={() => copy(location.href)}>{copied ? 'Copied' : 'Copy report link'}</button>{#if copyError}<p class="small" role="alert">{copyError}</p>{/if}<a class="small" href="#/character">Simulate your character</a></section>
      <SimulationDetails shared={report} detail={sharedDetail(report)} />
      <section class="panel stack">
        {#if report.talents}<details class="disclosure"><summary>Talent build</summary><textarea readonly aria-label="Talent export" value={report.talents} rows="4" onfocus={e => e.currentTarget.select()}></textarea><button class="sm" onclick={() => copy(report!.talents)}>Copy talents</button></details>{/if}
        <details class="disclosure"><summary>Included in this link</summary><p class="small muted">{report.damage?.length ?? 0}/{report.meta.damageCount} contributors · {report.buffs?.length ?? 0}/{report.meta.buffCount} buff uptimes</p><p class="xs muted">Left out: {report.meta.omitted?.join('; ') || 'none'}. Display values are rounded; headline DPS and uncertainty retain their original precision.</p></details>
      </section>
    </aside>
  </div>
{/if}
<style>h1 { font-size: 20px; } h2 { font-size: 16px; } textarea { width: 100%; font-size: 12px; margin-block: 8px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }</style>
