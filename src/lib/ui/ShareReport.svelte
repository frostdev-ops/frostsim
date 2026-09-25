<script lang="ts">
  import Dialog from './Dialog.svelte'
  import { loadPlayerDetail } from '../simc/client'
  import type { SimOutcome } from '../simc/job'
  import { createReportLink, reportSnapshot, LINK_LIMITS, type SharedReport } from '../store/report-share'
  import { engineIdentity } from '../app.svelte'
  let { outcome, transform = (s: SharedReport) => s }: { outcome: SimOutcome; transform?: (s: SharedReport) => SharedReport } = $props()
  let open = $state(false), working = $state(false), error = $state(''), copied = $state(false)
  let mode = $state<'compact' | 'detailed' | 'hosted'>('detailed')
  // Hosted links (CLAUDE.md D15) need an account with a plan that includes them; the account chunk exists only in account builds.
  let acct = $state.raw<typeof import('../account/state.svelte') | null>(null)
  const hostedOk = $derived(import.meta.env.VITE_FEATURE_ACCOUNTS === true && !!acct?.hostedAllowed())
  let snapshot: SharedReport | null = null
  let link = $state<{ url: string; report: SharedReport } | null>(null)
  let generation = 0
  async function generate(upload = false) {
    const token = ++generation
    working = true; error = ''; copied = false; link = null
    // A hosted link uploads the report, so it waits for its own button rather than following the mode choice.
    if (import.meta.env.VITE_FEATURE_ACCOUNTS === true && mode === 'hosted' && !upload) { working = false; return }
    try {
      snapshot ??= reportSnapshot(outcome, await loadPlayerDetail(outcome.getRawJson(), outcome.report.players[0].name))
      const shared = transform(snapshot)
      const result = import.meta.env.VITE_FEATURE_ACCOUNTS === true && mode === 'hosted'
        ? { url: await (await import('../account/hosted')).createHostedShare({ shared, rawReport: await outcome.getRawJson().text() }, engineIdentity()), report: shared }
        : await createReportLink(shared, LINK_LIMITS[mode as 'compact' | 'detailed'])
      if (token === generation) link = result
    } catch (e) { if (token === generation) error = e instanceof Error ? e.message : 'The link could not be created.' }
    finally { if (token === generation) working = false }
  }
  $effect(() => { outcome; snapshot = null; link = null })
  async function copy() { if (!link) return; try { await navigator.clipboard.writeText(link.url); copied = true } catch { error = 'Copy was blocked. Select the link below and copy it manually.' } }
</script>
<button onclick={() => {
  // Hosted mode outlives the plan or the session that allowed it: reopening falls back to a link that needs neither.
  if (import.meta.env.VITE_FEATURE_ACCOUNTS === true && mode === 'hosted' && !hostedOk) mode = 'detailed'
  open = true; void generate(); if (import.meta.env.VITE_FEATURE_ACCOUNTS === true) void import('../account/state.svelte').then(m => (acct = m))
}}>Share report</button>
<Dialog {open} title="Share report" width="34rem" onclose={() => { open = false; generation++; working = false }}>
  <div class="stack">
    <div class="segmented">
      <button class:active={mode === 'detailed'} aria-pressed={mode === 'detailed'} onclick={() => { mode = 'detailed'; void generate() }}>Detailed link</button>
      <button class:active={mode === 'compact'} aria-pressed={mode === 'compact'} onclick={() => { mode = 'compact'; void generate() }}>Chat link · 2,000 max</button>
      {#if import.meta.env.VITE_FEATURE_ACCOUNTS === true && hostedOk}<button class:active={mode === 'hosted'} aria-pressed={mode === 'hosted'} onclick={() => { mode = 'hosted'; void generate() }}>Hosted link</button>{:else if import.meta.env.VITE_FEATURE_ACCOUNTS === true}{#await import('../account/PremiumPill.svelte') then m}<span class="hosted-pill"><m.default text="Hosted link" title="Short report links come with every Frostsim Cloud plan" onclick={() => { open = false }} /></span>{/await}{/if}
    </div>
    {#if import.meta.env.VITE_FEATURE_ACCOUNTS === true && mode === 'hosted'}
      <p class="small muted">Uploads the full report, with the engine's own report file of the last run, to Frostsim. Anyone with the link can open it until you revoke it under Account.</p>
      {#if !link && !working}<div><button class="primary" onclick={() => generate(true)}>Upload and create link</button></div>{/if}
    {:else}
      <p class="small muted">The report is inside the link. Anyone with it can open it. Nothing is uploaded.</p>
    {/if}
    {#if working}<p role="status">Compressing report…</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if link}
      <div class="stack-sm" aria-live="polite">
        <strong>{link.url.length.toLocaleString()} characters</strong>
        <p class="small">DPS, settings, gear and talents · {link.report.damage?.length ?? 0}/{link.report.meta.damageCount} damage contributors{link.report.damage?.some(r => r[7].length) ? ' with pet detail' : ''}{link.report.buffs ? ` · ${link.report.buffs.length} buffs` : ''}{link.report.extra?.sequence?.length ? ` · ${link.report.extra.sequence.length} actions` : ''}{link.report.extra?.timeline ? ' · timeline' : ''}</p>
        <details class="disclosure"><summary>What’s left out</summary><ul class="small muted">{#each link.report.meta.omitted ?? [] as item}<li>{item}</li>{/each}</ul></details>
        <label class="small">Report link<textarea class="mono" readonly rows="3" value={link.url} onfocus={e => e.currentTarget.select()}></textarea></label>
        <p class="xs muted">{mode === 'compact' ? 'Fits a 2,000-character message on its own.' : import.meta.env.VITE_FEATURE_ACCOUNTS === true && mode === 'hosted' ? 'Short enough for any chat service.' : 'For chat services with shorter message limits, use Chat link.'}</p>
      </div>
    {/if}
  </div>
  {#snippet footer()}<button onclick={() => open = false}>Close</button><button class="primary" disabled={!link || working} onclick={copy}>{copied ? 'Copied' : 'Copy link'}</button>{/snippet}
</Dialog>
<style>textarea { width: 100%; margin-top: 8px; overflow-wrap: anywhere; font-size: 12px; } .active { background: var(--accent-soft); color: var(--accent); } .hosted-pill { display: inline-flex; align-items: center; padding: 0 8px; }</style>
