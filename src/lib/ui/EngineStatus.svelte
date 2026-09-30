<script lang="ts">
  // The one place the engine version shows: what runs, how fresh it is, and newer engines as they publish.
  import { onMount } from 'svelte'
  import { app, applyEngineUpdate, checkEngineUpdate, isBusy, switchEngineChannel } from '../app.svelte'
  import { activeEngineChannel, engineHealth } from '../simc/versions'
  import { engineChannelLabel, isEngineChannel, type EngineChannel } from '../simc/channel'
  import { hasGearDrafts } from '../selection.svelte'
  import Banner from './Banner.svelte'
  import Dialog from './Dialog.svelte'

  const SEEN_KEY = 'frostsim.engineNotes'
  const NEWS_DAYS = 7
  let { header = false }: { header?: boolean } = $props()

  let now = $state(Date.now())
  let blocker = $state<string | null>(null)
  let pending = $state<EngineChannel | 'update' | null>(null)
  const channelLabel = engineChannelLabel(activeEngineChannel)
  // The pack whose news was dismissed. Storage can be blocked; the banner then simply returns on the next load.
  let dismissed = $state((() => { try { return localStorage.getItem(SEEN_KEY) } catch { return null } })())

  const manifest = $derived(app.capability?.ok ? app.capability.manifest : null)
  const health = $derived(app.engine ? engineHealth(app.engine, app.engineStatus, now) : null)
  const update = $derived(app.engineUpdate)
  /** The running pack's own news, for a visitor who loaded after it published (an open tab gets the update banner instead). */
  const news = $derived.by(() => {
    const pack = app.engine
    if (!pack?.notes?.banner || dismissed === pack.id || now - Date.parse(pack.publishedAt) > NEWS_DAYS * 86400_000) return null
    return pack.notes
  })

  function ago(iso: string): string {
    const hours = (now - Date.parse(iso)) / 3600_000
    if (!Number.isFinite(hours)) return ''
    if (hours < 1) return 'under an hour ago'
    if (hours < 48) return `${Math.round(hours)} h ago`
    return `${Math.round(hours / 24)} days ago`
  }

  async function change(target: EngineChannel | 'update', accepted = false) {
    if (isBusy()) return
    if (!accepted && hasGearDrafts()) { pending = target; return }
    pending = null
    blocker = target === 'update' ? await applyEngineUpdate(false, accepted) : await switchEngineChannel(target, accepted)
  }

  function dismiss() {
    dismissed = app.engine?.id ?? null
    try { if (dismissed) localStorage.setItem(SEEN_KEY, dismissed) } catch { /* no storage */ }
  }

  onMount(() => {
    if (header) return
    // Coming back to the tab is the moment to move onto a newer engine; while it is open, only offer it.
    const onVisible = () => { if (document.visibilityState === 'visible') void checkEngineUpdate(true) }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(() => {
      now = Date.now()
      if (document.visibilityState === 'visible') void checkEngineUpdate(false)
    }, 30 * 60_000)
    return () => { document.removeEventListener('visibilitychange', onVisible); clearInterval(timer) }
  })
</script>

{#if header}
  <label class="engine-pill" class:ptr={activeEngineChannel === 'ptr'} title={isBusy() ? 'Wait for the simulation to finish before switching engines' : `Current engine: ${channelLabel}. Switch game version.`}>
    <span class="channel-dot" aria-hidden="true"></span><span class="xs muted">Engine</span>
    <select aria-label="Game version" value={activeEngineChannel} disabled={isBusy()} onchange={e => {
      const target = e.currentTarget.value
      e.currentTarget.value = activeEngineChannel
      if (isEngineChannel(target) && target !== activeEngineChannel) void change(target)
    }}>
      <option value="live">Live</option><option value="ptr">PTR</option>
    </select>
  </label>
{:else}
<div class="engine-row">
  {#if manifest}
    <p class="engine xs muted">
      <strong>{channelLabel}</strong> · WoW {manifest.wow.clientDataVersion} · SimulationCraft {manifest.engine.simcVersion} ·
      <a class="mono" href="https://github.com/simulationcraft/simc/commit/{manifest.engine.upstreamCommit}" rel="noreferrer">{manifest.engine.upstreamCommit.slice(0, 7)}</a>
      · Hotfixes {manifest.wow.hotfixDate ?? 'date not recorded'}
      {#if app.engine?.commitDate}· {ago(app.engine.commitDate)}{/if}
    </p>
  {:else}<span class="xs muted">{channelLabel} · {app.capabilityChecked ? 'engine unavailable' : 'checking engine…'}</span>{/if}
</div>

{#if app.capabilityChecked && (!app.engine || !app.capability?.ok)}
  <Banner kind="warn" title={`${channelLabel} engine unavailable`}>
    {app.engineStatus?.reason ?? (app.capability && !app.capability.ok ? app.capability.detail : app.engineError || 'No validated, compatible pack is available for this channel.')}
    {#snippet actions()}{#if activeEngineChannel === 'ptr'}<button class="sm primary" disabled={isBusy()} onclick={() => change('live')}>Switch to Live</button>{/if}{/snippet}
  </Banner>
{:else if update && app.engine}
  <Banner kind="info" title={`${channelLabel} SimulationCraft updated`} live>
    {update.notes?.banner ?? 'A newer engine is ready.'}
    (<a href="https://github.com/simulationcraft/simc/compare/{app.engine.upstreamCommit}...{update.upstreamCommit}" rel="noreferrer">see what changed</a>)
    Reload to use it.
    {#if update.notes?.changelog.length}
      <details><summary class="small">What changed</summary><ul>{#each update.notes.changelog as line}<li>{line}</li>{/each}</ul></details>
    {/if}
    {#snippet actions()}
      <button class="sm primary" disabled={isBusy()} onclick={() => change('update')}>Reload now</button>
    {/snippet}
  </Banner>
{:else if health?.message}
  <Banner kind={health.level === 'warn' ? 'warn' : 'info'} title={app.engineStatus?.state === 'failed' ? `${channelLabel} engine update failed` : `${channelLabel} engine status`}>{health.message}</Banner>
{/if}

{#if news && !update}
  <Banner kind="info" title={`${channelLabel} SimulationCraft updated`}>
    {news.banner}
    {#if news.changelog.length}
      <details><summary class="small">What changed</summary><ul>{#each news.changelog as line}<li>{line}</li>{/each}</ul></details>
    {/if}
    {#snippet actions()}
      <button class="sm" onclick={dismiss}>Dismiss</button>
    {/snippet}
  </Banner>
{/if}

{/if}

<Dialog open={blocker !== null} title="Engine switch paused" onclose={() => blocker = null}>
  <p role="alert">{blocker}</p>
  {#snippet footer()}<button onclick={() => blocker = null}>Close</button>{/snippet}
</Dialog>
<Dialog open={pending !== null} title="Reset unsimulated gear drafts?" onclose={() => pending = null}>
  <p>Changing the engine reloads this tab and resets gear drafts you have not simulated. Saved characters, reports, and stored scripts are preserved.</p>
  {#snippet footer()}<button onclick={() => pending = null}>Cancel</button><button class="primary" disabled={isBusy()} onclick={() => { if (pending) void change(pending, true) }}>Reset drafts and {pending === 'update' ? 'reload' : `switch to ${pending ? engineChannelLabel(pending) : ''}`}</button>{/snippet}
</Dialog>

<style>
  .engine-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
  .engine-pill { display: inline-flex; align-items: center; gap: 6px; flex: none; padding-left: 12px; border: 1px solid var(--accent-border); border-radius: 999px; background: var(--accent-soft); color: var(--accent-hi); white-space: nowrap; }
  .engine-pill.ptr { border-color: color-mix(in oklab, var(--accent-3) 45%, transparent); }
  .channel-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .ptr .channel-dot { background: var(--accent-3); }
  select { width: auto; min-height: 38px; padding: 5px 25px 5px 2px; border: 0; border-radius: 999px; background-color: transparent; color: inherit; font-weight: 700; }
  @media (max-width: 30rem) { .engine-pill .muted { display: none; } }
  .engine { margin: 0; text-align: right; }
</style>
