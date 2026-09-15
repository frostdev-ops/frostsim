<script lang="ts">
  // Load catalog for screens needing item identity; report plainly what's true while unavailable (P03.7).
  import { activeCharacter, app, ensureCatalog, resolveCharacter } from '../app.svelte'
  import { fmtInt } from '../format'
  import Banner from './Banner.svelte'

  interface Props {
    /** Shown when the catalog is present and matches the engine. Off by default. */
    quiet?: boolean
  }
  let { quiet = true }: Props = $props()

  $effect(() => {
    if (app.capabilityChecked) ensureCatalog().catch(() => { /* reported in app state */ })
  })

  // Re-resolve on active character change so switching never leaves previous names on screen.
  $effect(() => {
    const character = activeCharacter()
    if (character && app.catalogState === 'ready') {
      resolveCharacter(character).catch(() => { /* reported in app state */ })
    }
  })
</script>

{#if app.catalogState === 'loading'}
  <p class="small muted" role="status">Loading game data…</p>
{:else if app.catalogState === 'failed'}
  <Banner kind="warn" title="Game data is not available">
    <p>{app.catalogError}</p>
    <p>
      Items show the addon's own labels instead of resolved names and item levels, equipment
      legality cannot be checked before a run, and catalog item search is unavailable. Simulation
      itself is unaffected — the engine carries its own game data.
    </p>
  </Banner>
{:else if app.catalogState === 'ready' && app.catalogWarnings.length}
  <Banner kind="warn" title="Game data does not match the engine">
    <ul>
      {#each app.catalogWarnings as w (w.code)}<li>{w.message}</li>{/each}
    </ul>
    <p>
      Item levels and stats shown here may not be what the engine simulates. Rebuild the catalog
      against this engine before trusting a comparison.
    </p>
  </Banner>
{:else if app.catalogState === 'ready' && !quiet && app.catalogManifest}
  <p class="xs muted">
    {fmtInt(app.catalogManifest.counts.items)} items from catalog {app.catalogManifest.catalogId}.
  </p>
{/if}
