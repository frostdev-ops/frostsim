<script lang="ts">
  // The one place the engine version shows: what runs, how fresh it is, and newer engines as they publish.
  import { onMount } from 'svelte'
  import { app, applyEngineUpdate, checkEngineUpdate, isBusy } from '../app.svelte'
  import { engineHealth } from '../simc/versions'
  import Banner from './Banner.svelte'

  let now = $state(Date.now())
  let blocker = $state<string | null>(null)

  const manifest = $derived(app.capability?.ok ? app.capability.manifest : null)
  const health = $derived(app.engine ? engineHealth(app.engine, app.engineStatus, now) : null)
  const update = $derived(app.engineUpdate)

  function ago(iso: string): string {
    const hours = (now - Date.parse(iso)) / 3600_000
    if (!Number.isFinite(hours)) return ''
    if (hours < 1) return 'under an hour ago'
    if (hours < 48) return `${Math.round(hours)} h ago`
    return `${Math.round(hours / 24)} days ago`
  }

  async function reloadNow() {
    blocker = await applyEngineUpdate(false)
  }

  onMount(() => {
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

{#if update && app.engine}
  <Banner kind="info" title="SimulationCraft updated" live>
    A newer engine
    (<a href="https://github.com/simulationcraft/simc/compare/{app.engine.upstreamCommit}...{update.upstreamCommit}" rel="noreferrer">see what changed</a>)
    is ready. Reload to use it; gear choices you have not simulated yet are reset.
    {#if blocker}<br /><span class="small">{blocker}</span>{/if}
    {#snippet actions()}
      <button class="sm primary" disabled={isBusy()} onclick={reloadNow}>Reload now</button>
    {/snippet}
  </Banner>
{:else if health?.message}
  <Banner kind={health.level === 'warn' ? 'warn' : 'info'}>{health.message}</Banner>
{/if}

{#if manifest}
  <p class="engine xs muted">
    SimulationCraft {manifest.engine.simcVersion} ·
    <a class="mono" href="https://github.com/simulationcraft/simc/commit/{manifest.engine.upstreamCommit}" rel="noreferrer">{manifest.engine.upstreamCommit.slice(0, 7)}</a>
    {#if app.engine?.commitDate}· {ago(app.engine.commitDate)}{/if}
    · WoW {manifest.wow.clientDataVersion}
  </p>
{/if}

<style>
  .engine {
    margin: 0;
    text-align: right;
  }
</style>
