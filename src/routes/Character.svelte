<script lang="ts">
  // Import and character workspace (P04.6-P04.8, P12.1, P12.2).
  import {
    classLabel, GEAR_SLOTS, isSameCharacter, looksLikeProfile, parseAddonExport,
    type GearSlot, type ImportedCharacter, type ItemInstance,
  } from '../lib/import/character'
  import { SAMPLE_EXPORT, SAMPLE_LABEL } from '../lib/import/sample'
  import { inheritedRunOptions } from '../lib/import/serialize'
  import {
    activeCharacter, activeStored, app, deleteCharacter, isBusy, renameCharacter,
    saveCharacter, toast,
  } from '../lib/app.svelte'
  import { fmtDateTime } from '../lib/format'
  import { href, navigate, router } from '../lib/router.svelte'
  import { makePortable, readPortable, redactCharacter } from '../lib/store/records'
  import { encodeShare } from '../lib/store/share'
  import Banner from '../lib/ui/Banner.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import Dialog from '../lib/ui/Dialog.svelte'
  import ItemLine from '../lib/ui/ItemLine.svelte'
  import CharacterBanner from '../lib/ui/CharacterBanner.svelte'
  import TierSets from '../lib/ui/TierSets.svelte'
  import TalentPreview from '../lib/ui/TalentPreview.svelte'
  import Roster from '../lib/ui/Roster.svelte'
  import { rememberTalentDraft } from '../lib/talents.svelte'
  import { clearSetup, sendSetup } from '../lib/handoff.svelte'
  import { RefreshCw, Plus } from '@lucide/svelte'

  const DRAFT_KEY = 'frostsim.draft'

  let pasted = $state('')
  let parseError = $state('')
  let showRaw = $state(false)
  let renaming = $state(false)
  let renameValue = $state('')
  let shareBusy = $state(false)
  let fileInput: HTMLInputElement | undefined = $state()
  let draftSaved = $state(false)
  let importing = $state(false)
  let updateId = $state<string | null>(null)
  let saving = $state(false)

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const equippedBySlot = $derived(
    new Map<GearSlot, ItemInstance>((character?.equipped ?? []).map((i) => [i.slot, i])),
  )
  const updateTarget = $derived(app.characters.find(c => c.id === updateId))
  const preview = $derived(pasted.trim() && looksLikeProfile(pasted) ? parseAddonExport(pasted) : null)
  const matching = $derived(preview ? app.characters.filter(c => isSameCharacter(c.character, preview)) : [])
  const importLabel = $derived(updateTarget || matching.length === 1 ? 'Update character' : 'Import character')
  const errors = $derived((character?.diagnostics ?? []).filter((d) => d.severity === 'error'))
  const warnings = $derived((character?.diagnostics ?? []).filter((d) => d.severity === 'warning'))
  const inherited = $derived(character ? inheritedRunOptions(character) : [])

  // Autosave paste box so refresh mid-import doesn't lose it (P04.7).
  $effect(() => {
    const text = pasted
    if (!text) return
    const t = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, text); draftSaved = true } catch { /* ignore */ }
    }, 600)
    return () => clearTimeout(t)
  })

  $effect(() => {
    if (pasted || character) return
    try {
      const recovered = localStorage.getItem(DRAFT_KEY)
      if (recovered) { pasted = recovered; draftSaved = true }
    } catch { /* ignore */ }
  })

  function clearDraft(): void {
    try { localStorage.removeItem(DRAFT_KEY) } catch { /* ignore */ }
    draftSaved = false
  }

  function openImport(update: boolean): void {
    updateId = update ? stored?.id ?? null : null
    parseError = ''
    importing = true
  }

  // #/character/import (the pickers' "Import a character"): open the import dialog, then drop the suffix.
  $effect(() => {
    if (router.rest[0] !== 'import') return
    navigate('character', true)
    if (character) openImport(false)
  })

  async function commitImport(parsed: ImportedCharacter, label?: string): Promise<void> {
    if (saving) return
    if (updateTarget && !isSameCharacter(updateTarget.character, parsed)) {
      parseError = `This export does not match ${updateTarget.character.name} on ${updateTarget.character.server ?? 'the saved realm'}. Use Import another for a different character.`
      return
    }
    const matches = app.characters.filter(c => isSameCharacter(c.character, parsed))
    if (!updateTarget && matches.length > 1) {
      parseError = 'Several saved characters match. Open the one you want and choose Update from SimC.'
      return
    }
    const target = updateTarget ?? matches[0]
    saving = true
    try {
      await saveCharacter(parsed, target?.label ?? label, target?.id)
      clearSetup()
      pasted = ''
      importing = false
      if (!app.storage.failure) {
        clearDraft()
        toast('good', `${target ? 'Updated' : 'Imported'} ${parsed.name || 'character'}.`)
      }
    } catch {
      parseError = 'Could not save this export. Please try again.'
    } finally {
      saving = false
    }
  }

  async function ingest(text: string, label?: string): Promise<void> {
    parseError = ''
    if (!text.trim()) {
      parseError = 'Nothing to import. Paste the output of /simc from the game.'
      return
    }
    if (!looksLikeProfile(text)) {
      parseError =
        'That does not look like a /simc export — no class line such as `warlock=Name` was found.'
      return
    }
    const parsed = parseAddonExport(text)
    if (parsed.diagnostics.some((d) => d.severity === 'error')) {
      parseError = parsed.diagnostics.find((d) => d.severity === 'error')!.message
      return
    }
    await commitImport(parsed, label)
  }

  async function onFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0]
    ;(event.target as HTMLInputElement).value = ''
    if (!file) return
    if (file.size > 4 * 1024 * 1024) {
      parseError = 'That file is larger than 4 MB. A /simc export is a few kilobytes.'
      return
    }
    let text: string
    try { text = await file.text() } catch { parseError = 'Could not read that file. Paste the export instead.'; return }
      // .json file is Frostsim export not addon export.
    if (file.name.endsWith('.json')) {
      const check = readPortable(text)
      if (!check.ok) { parseError = check.reason; return }
      if (check.file.kind !== 'character') {
        parseError = 'That file holds a saved setup or report, not a character.'
        return
      }
      await commitImport(check.file.payload as ImportedCharacter)
      return
    }
    await ingest(text, file.name.replace(/\.[^.]+$/, ''))
  }

  function download(name: string, text: string, type = 'application/json'): void {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  function exportCharacter(redact: boolean): void {
    if (!character) return
    const payload = redact ? redactCharacter(character) : character
    download(
      `${(payload.name || 'character').toLowerCase()}.frostsim.json`,
      JSON.stringify(makePortable('character', payload, undefined, redact), null, 2),
    )
  }

  async function shareLink(): Promise<void> {
    if (!character) return
    shareBusy = true
    const result = await encodeShare(makePortable('character', redactCharacter(character), undefined, true))
    shareBusy = false
    if (!result.ok) {
      toast(
        'bad',
        result.reason === 'too-large'
          ? 'This character is too large for a link. Use “Export file” instead.'
          : 'This browser cannot build share links. Use “Export file” instead.',
      )
      return
    }
    const url = `${location.origin}${location.pathname}#${result.fragment}`
    try {
      await navigator.clipboard.writeText(url)
      toast('good', 'Share link copied. Character name and realm were removed.')
    } catch {
      prompt('Copy this link:', url)
    }
  }

  async function copyProfile(): Promise<void> {
    if (!character) return
    try {
      await navigator.clipboard.writeText(character.raw)
      toast('good', 'Original export copied.')
    } catch {
      toast('bad', 'The browser blocked clipboard access.')
    }
  }
</script>

{#snippet exportField()}
  <label class="field">
    <span>SimC output</span>
    <textarea rows="10" aria-label="SimC output" bind:value={pasted} oninput={() => parseError = ''} spellcheck="false" disabled={saving}
      aria-invalid={parseError ? 'true' : undefined} aria-describedby={parseError ? 'paste-error' : 'paste-hint'}
      placeholder="Paste the full /simc output here…"></textarea>
    {#if parseError}<span class="err" id="paste-error" role="alert">{parseError}</span>
    {:else}<span class="hint" id="paste-hint">Type <kbd>/simc</kbd> in WoW, copy everything, then paste here.</span>{/if}
  </label>
  {#if preview && !preview.diagnostics.some(d => d.severity === 'error')}
    <div class="import-preview"><strong>{preview.name}</strong><span class="small muted">{classLabel(preview)} · {preview.server ?? ''} {preview.region?.toUpperCase() ?? ''}</span>
      {#if updateTarget || matching.length === 1}<span class="small muted">Refreshes gear, bags, and talents. Saved reports stay available.</span>{/if}
    </div>
  {/if}
{/snippet}

<input type="file" accept=".simc,.txt,.json,text/plain,application/json" bind:this={fileInput} onchange={onFile} class="sr-only" />

<div class="stack">
  <CatalogStatus />

  {#if !character}
    <!-- First visit (P12.1). -->
    <section class="panel stack">
      <h1>Import a character</h1>
      <p class="muted">Paste your SimulationCraft addon export to get started.</p>
      {@render exportField()}

      <div class="row">
        <button class="primary" onclick={() => ingest(pasted)} disabled={saving || !pasted.trim()}>
          {saving ? 'Saving…' : importLabel}
        </button>
        <button onclick={() => fileInput?.click()} disabled={saving}>Open file…</button>
        <button class="ghost" onclick={() => ingest(SAMPLE_EXPORT, SAMPLE_LABEL)} disabled={saving}>
          Try the sample character
        </button>
      </div>

      <p class="small muted">{draftSaved ? 'Draft saved on this device. ' : ''}Your export and simulations stay in your browser.</p>
    </section>
  {:else}
    <Roster onimport={() => openImport(false)} />
    <!-- Character workspace (P12.2). -->
    <section class="panel stack">
      <CharacterBanner {character} characterId={stored?.id} embedded />
      <div class="spread">
        <div><h1>Character</h1><span class="small muted">Imported {fmtDateTime(character.importedAt)}</span></div>
        <div class="row">
          <button class="ghost" onclick={() => openImport(false)} disabled={isBusy()}><Plus size={16} /> Import another</button>
          <button onclick={() => openImport(true)} disabled={isBusy()}><RefreshCw size={16} /> Update from SimC</button>
          <button class="primary" onclick={() => navigate('quick')} disabled={isBusy()}>Quick Sim</button>
        </div>
      </div>

      {#if errors.length}
        <Banner kind="bad" title="This export could not be read" live>
          <ul>{#each errors as d (d.lineNumber + d.message)}<li>Line {d.lineNumber}: {d.message}</li>{/each}</ul>
        </Banner>
      {/if}

      {#if warnings.length}
        <details class="disclosure">
          <summary>{warnings.length} line{warnings.length > 1 ? 's' : ''} needed attention</summary>
          <ul class="small muted">
            {#each warnings as d (d.lineNumber + d.message)}
              <li>Line {d.lineNumber}: {d.message} <code class="xs">{d.text}</code></li>
            {/each}
          </ul>
        </details>
      {/if}

      {#if inherited.length}
        <Banner kind="warn" title="This profile sets its own run options">
          <p>
            {inherited.map((o) => `${o.key}=${o.value}`).join(', ')} — Frostsim's accuracy
            settings take precedence, and the values above are neutralised for each run so they
            cannot stop a run early.
          </p>
        </Banner>
      {/if}

      <h2 class="section-title">Equipped gear</h2>
      <div class="equipment-grid">
        {#each GEAR_SLOTS.filter((slot) => !['shirt', 'tabard'].includes(slot)) as slot (slot)}
          <ItemLine {slot} item={equippedBySlot.get(slot) ?? null} compact />
        {/each}
      </div>
      <TierSets {character} />
      <section class="stack-sm">
        <div class="spread"><h2 class="section-title">Talent loadouts</h2><a href={href('talents')}>Edit talents</a></div>
        <div class="loadout-grid">
          {#each character.loadouts as loadout (loadout.name + loadout.talents)}
            <div class="panel stack-sm"><div class="spread"><strong>{loadout.name}</strong>{#if loadout.talents === character.talents}<span class="small muted">Active</span>{/if}</div><TalentPreview {character} talents={loadout.talents} /><div class="row"><button class="sm primary" onclick={() => { sendSetup({ characterId: stored?.id ?? null, label: loadout.name, items: {}, talents: loadout.talents }); navigate('quick') }}>Simulate</button><button class="sm" onclick={() => { rememberTalentDraft(stored?.id ?? null, loadout.talents); navigate('talents') }}>Edit</button><a class="small" href={href('compare')}>Compare</a></div></div>
          {/each}
        </div>
      </section>

      <footer class="row">
        <button class="sm ghost" onclick={() => { renaming = true; renameValue = stored?.label ?? character.name }}>Rename</button>
        <button class="sm" onclick={copyProfile}>Copy original export</button>
        <button class="sm" onclick={() => exportCharacter(false)}>Export file</button>
        <button class="sm" onclick={() => exportCharacter(true)}>Export without identity</button>
        <button class="sm" onclick={shareLink} disabled={shareBusy}>
          {shareBusy ? 'Building link…' : 'Copy share link'}
        </button>
        <button class="sm ghost" onclick={() => (showRaw = !showRaw)}>
          {showRaw ? 'Hide' : 'Show'} raw export
        </button>
        <span class="grow"></span>
        {#if stored}
          <button
            class="sm danger"
            onclick={() => { if (confirm(`Delete ${stored.label}? Reports keep their own snapshot.`)) void deleteCharacter(stored.id) }}
          >
            Delete
          </button>
        {/if}
      </footer>

      {#if showRaw}
        <pre class="log">{character.raw}</pre>
      {/if}
    </section>

  {/if}
</div>

<Dialog bind:open={importing} title={updateTarget ? `Update ${updateTarget.character.name}` : 'Import a character'} onclose={() => importing = false}>
  <div class="stack">{@render exportField()}</div>
  {#snippet footer()}
    <button class="ghost" onclick={() => fileInput?.click()} disabled={saving}>Open file…</button>
    <span class="grow"></span>
    <button onclick={() => importing = false} disabled={saving}>Cancel</button>
    <button class="primary" onclick={() => ingest(pasted)} disabled={saving || !pasted.trim()}>{saving ? 'Saving…' : importLabel}</button>
  {/snippet}
</Dialog>

<Dialog
  bind:open={renaming}
  title="Rename character"
  width="24rem"
  onclose={() => (renaming = false)}
>
  <label class="field">
    <span>Name in Frostsim</span>
    <input type="text" bind:value={renameValue} />
    <span class="hint">Only the label changes. The imported export is untouched.</span>
  </label>
  {#snippet footer()}
    <button onclick={() => (renaming = false)}>Cancel</button>
    <button
      class="primary"
      onclick={() => {
        if (stored && renameValue.trim()) void renameCharacter(stored.id, renameValue.trim())
        renaming = false
      }}
    >
      Save
    </button>
  {/snippet}
</Dialog>

<style>
  .equipment-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 20px; }
  .loadout-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  @media (max-width: 760px) { .equipment-grid, .loadout-grid { grid-template-columns: 1fr; } }
  .import-preview { display: grid; gap: 4px; padding: 12px 16px; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: 4px; }
  footer { border-top: 1px solid var(--border); padding-top: var(--s3); }
</style>
