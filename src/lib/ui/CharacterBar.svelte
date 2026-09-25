<script lang="ts">
  // The character the current screen works on (D1), above every tool screen. Each screen remembers its own pick.
  import { app, pickCharacter } from '../app.svelte'
  import { href } from '../router.svelte'
  import CharacterPicker from './CharacterPicker.svelte'
</script>

<div class="bar">
  {#if app.characters.length || app.draft}
    <span class="xs muted label">Simulating</span>
    <CharacterPicker value={app.activeCharacterId} onpick={(id) => pickCharacter(id)} label="Character for this screen" />
  {:else}
    <span class="small muted">No character yet.</span>
    <a class="small" href={href('character')}>Import one</a>
  {/if}
</div>

<style>
  .bar { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
  .label { text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; }
</style>
