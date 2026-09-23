<script lang="ts">
  import { onMount } from 'svelte'
  import { clearTrace } from '../trace'
  import Dialog from './Dialog.svelte'

  const key = 'frostsim.storage-choice.v1'
  let open = $state(false)
  let note = $state('')
  let choice = $state('necessary')
  onMount(() => {
    try {
      const saved = localStorage.getItem(key)
      choice = saved === 'diagnostics' ? saved : 'necessary'
    } catch { /* Storage unavailable: diagnostics stay off and no popup is needed. */ }
    if (choice !== 'diagnostics') clearTrace()
  })

  function save(value: string): void {
    if (value === 'necessary') clearTrace()
    try {
      localStorage.setItem(key, value)
      choice = value
      note = ''
      open = false
    } catch {
      note = 'Your browser could not save this choice. Your previous saved choice still applies. You can clear site data in your browser settings or close this notice and continue.'
    }
  }
</script>

<nav class="legal-links" aria-label="Legal">
  <a href="/legal/terms.html" target="_blank" rel="noopener">Terms of use</a>
  <a href="/legal/privacy.html" target="_blank" rel="noopener">Privacy policy</a>
  <button class="ghost sm" onclick={() => (open = true)}>Cookie settings</button>
</nav>

<Dialog bind:open title="Browser storage" width="30rem" onclose={() => (open = false)}>
  <div class="stack">
    <p>Browser storage keeps your saved characters and settings. No advertising or analytics cookies.</p>
    <p>Diagnostic storage is <strong>{choice === 'diagnostics' ? 'on' : 'off'}</strong> (off by default). Optional logs stay on this device and are never sent automatically.</p>
    <p><a href="/legal/privacy.html" target="_blank" rel="noopener">Read the privacy policy (opens a new tab)</a></p>
    {#if note}<p role="status">{note}</p>{/if}
  </div>
  {#snippet footer()}
    <button onclick={() => save('necessary')}>{choice === 'diagnostics' ? 'Disable diagnostics' : 'Keep diagnostics off'}</button>
    <button onclick={() => save('diagnostics')}>Enable diagnostics</button>
  {/snippet}
</Dialog>

<style>
  .legal-links { display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
</style>
