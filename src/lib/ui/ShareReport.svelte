<script lang="ts">
  import Dialog from './Dialog.svelte'
  import { loadPlayerDetail } from '../simc/client'
  import type { SimOutcome } from '../simc/job'
  import { createReportLink, reportSnapshot, LINK_LIMITS, type SharedReport } from '../store/report-share'
  let { outcome, transform = (s: SharedReport) => s }: { outcome: SimOutcome; transform?: (s: SharedReport) => SharedReport } = $props()
  let open = $state(false), working = $state(false), error = $state(''), copied = $state(false)
  let mode = $state<'compact' | 'detailed'>('detailed')
  let snapshot: SharedReport | null = null
  let link = $state<{ url: string; report: SharedReport } | null>(null)
  let generation = 0
  async function generate() {
    const token = ++generation
    working = true; error = ''; copied = false; link = null
    try {
      snapshot ??= reportSnapshot(outcome, await loadPlayerDetail(outcome.getRawJson(), outcome.report.players[0].name))
      const result = await createReportLink(transform(snapshot), LINK_LIMITS[mode])
      if (token === generation) link = result
    } catch (e) { if (token === generation) error = e instanceof Error ? e.message : 'The link could not be created.' }
    finally { if (token === generation) working = false }
  }
  $effect(() => { outcome; snapshot = null; link = null })
  async function copy() { if (!link) return; try { await navigator.clipboard.writeText(link.url); copied = true } catch { error = 'Copy was blocked. Select the link below and copy it manually.' } }
</script>
<button onclick={() => { open = true; void generate() }}>Share report</button>
<Dialog {open} title="Share report" width="34rem" onclose={() => { open = false; generation++; working = false }}>
  <div class="stack">
    <div class="segmented">
      <button class:active={mode === 'detailed'} aria-pressed={mode === 'detailed'} onclick={() => { mode = 'detailed'; void generate() }}>Detailed link</button>
      <button class:active={mode === 'compact'} aria-pressed={mode === 'compact'} onclick={() => { mode = 'compact'; void generate() }}>Chat link · 2,000 max</button>
    </div>
    <p class="small muted">The report is inside the link. Anyone with it can open it. Nothing is uploaded.</p>
    {#if working}<p role="status">Compressing report…</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if link}
      <div class="stack-sm" aria-live="polite">
        <strong>{link.url.length.toLocaleString()} characters</strong>
        <p class="small">DPS, settings, gear and talents · {link.report.damage?.length ?? 0}/{link.report.meta.damageCount} damage contributors{link.report.damage?.some(r => r[7].length) ? ' with pet detail' : ''}{link.report.buffs ? ` · ${link.report.buffs.length} buffs` : ''}{link.report.extra?.sequence?.length ? ` · ${link.report.extra.sequence.length} actions` : ''}{link.report.extra?.timeline ? ' · timeline' : ''}</p>
        <details class="disclosure"><summary>What’s left out</summary><ul class="small muted">{#each link.report.meta.omitted ?? [] as item}<li>{item}</li>{/each}</ul></details>
        <label class="small">Report link<textarea class="mono" readonly rows="3" value={link.url} onfocus={e => e.currentTarget.select()}></textarea></label>
        <p class="xs muted">{mode === 'compact' ? 'Fits a 2,000-character message on its own.' : 'For chat services with shorter message limits, use Chat link.'}</p>
      </div>
    {/if}
  </div>
  {#snippet footer()}<button onclick={() => open = false}>Close</button><button class="primary" disabled={!link || working} onclick={copy}>{copied ? 'Copied' : 'Copy link'}</button>{/snippet}
</Dialog>
<style>textarea { width: 100%; margin-top: 8px; overflow-wrap: anywhere; font-size: 12px; } .active { background: var(--accent-soft); color: var(--accent); }</style>
