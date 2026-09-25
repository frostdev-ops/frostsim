<script lang="ts">
  // Picks one character from this device's library (plus the unsaved draft). Used by the per-screen bar and by Quick Sim's
  // "add a character" (D2). The trigger reads like the header chip: class mark, label, spec.
  import { Popover } from 'bits-ui'
  import { Check, ChevronDown, Plus } from '@lucide/svelte'
  import { app, DRAFT } from '../app.svelte'
  import { classLabel, type ImportedCharacter } from '../import/character'
  import { titleCase } from '../format'
  import { navigate } from '../router.svelte'

  interface Props {
    /** A stored id, DRAFT, or null for nothing picked yet. */
    value: string | null
    onpick: (id: string) => void
    /** Ids not offered (already in the sim). */
    exclude?: string[]
    /** Trigger text when nothing is picked. */
    placeholder?: string
    label?: string
    /** Trigger as a small "+" button instead of the chosen character. */
    add?: boolean
  }
  let { value, onpick, exclude = [], placeholder = 'Choose a character', label = 'Character', add = false }: Props = $props()
  let open = $state(false)
  let search = $state('')

  interface Option { id: string; label: string; character: ImportedCharacter; draft?: boolean }
  const all = $derived<Option[]>([
    ...(app.draft ? [{ id: DRAFT, label: `${app.draft.name || 'Character'} (unsaved)`, character: app.draft, draft: true }] : []),
    ...app.characters.map((c) => ({ id: c.id, label: c.label, character: c.character })),
  ])
  const options = $derived(all.filter((o) => !exclude.includes(o.id)))
  const shown = $derived(search ? options.filter((o) => `${o.label} ${o.character.spec ?? ''} ${o.character.server ?? ''}`.toLowerCase().includes(search.toLowerCase())) : options)
  const chosen = $derived(all.find((o) => o.id === value))
  const sub = (c: ImportedCharacter) => [c.spec ? titleCase(c.spec) : classLabel(c), c.level ? `${c.level}` : '', c.server ?? ''].filter(Boolean).join(' · ')
  const choose = (id: string) => { onpick(id); open = false; search = '' }
</script>

<Popover.Root bind:open>
  {#if add}
    <Popover.Trigger class="picker-add" aria-label="Add a character" disabled={!options.length}><Plus size={15} />Add character</Popover.Trigger>
  {:else}
    <Popover.Trigger class="picker-trigger" aria-label="{label}: {chosen?.label ?? placeholder}" data-class={chosen?.character.className}>
      <span class="mark" aria-hidden="true">{(chosen?.label ?? '?').slice(0, 1).toUpperCase()}</span>
      <span class="text">
        <strong class="truncate">{chosen?.label ?? placeholder}</strong>
        {#if chosen}<span class="xs muted truncate">{sub(chosen.character)}</span>{/if}
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </Popover.Trigger>
  {/if}
  <Popover.Portal>
    <Popover.Content class="picker-popover" sideOffset={6} align="start">
      {#if options.length > 6}<input type="search" bind:value={search} placeholder="Search characters…" aria-label="Search characters" />{/if}
      <div class="picker-list" role="listbox" aria-label={label}>
        {#each shown as o (o.id)}
          <button class="picker-option" role="option" aria-selected={o.id === value} data-class={o.character.className} onclick={() => choose(o.id)}>
            <span class="mark" aria-hidden="true">{o.label.slice(0, 1).toUpperCase()}</span>
            <span class="text"><strong class="truncate">{o.label}</strong><span class="xs muted truncate">{sub(o.character)}</span></span>
            {#if o.id === value}<Check size={16} aria-hidden="true" />{/if}
          </button>
        {:else}
          <p class="small muted empty">{options.length ? 'No matches.' : 'No other characters on this device.'}</p>
        {/each}
      </div>
      <button class="picker-option import" onclick={() => { open = false; navigate('character/import') }}><Plus size={16} aria-hidden="true" />Import a character</button>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.picker-trigger), .picker-option {
    all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; min-width: 0; cursor: pointer;
  }
  :global(.picker-trigger) {
    padding: 4px 10px 4px 4px; border-radius: 99px; border: 1px solid var(--glass-edge); background: var(--well); max-width: 22rem;
    transition: border-color var(--t-control) var(--ease);
  }
  :global(.picker-trigger:hover) { border-color: var(--class-color, var(--accent)); }
  :global(.picker-trigger:focus-visible), .picker-option:focus-visible { box-shadow: var(--focus); }
  :global(.picker-add) {
    all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 99px; cursor: pointer;
    border: 1px dashed var(--border-strong); color: var(--text-muted); font-size: var(--fs-sm);
  }
  :global(.picker-add:hover:not(:disabled)) { color: var(--accent); border-color: var(--accent); }
  :global(.picker-add:disabled) { opacity: 0.5; cursor: default; }
  :global(.picker-add:focus-visible) { box-shadow: var(--focus); }
  .mark, :global(.picker-trigger) .mark {
    flex: none; display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%;
    font: 700 14px var(--font-display); color: var(--class-color, var(--accent));
    background: color-mix(in oklab, var(--class-color, var(--accent)) 20%, transparent);
  }
  .text, :global(.picker-trigger) .text { display: grid; min-width: 0; flex: 1; text-align: left; line-height: 1.2; }
  :global(.picker-popover) {
    z-index: 1100; width: min(22rem, calc(100vw - 32px)); max-height: min(28rem, 70vh); display: flex; flex-direction: column; gap: 6px; padding: 8px;
    border-radius: 14px; border: 1px solid var(--glass-edge); background: var(--glass-strong); box-shadow: var(--shadow-3);
    -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);
  }
  .picker-list { overflow: auto; display: grid; gap: 2px; min-height: 0; }
  .picker-option { padding: 6px 8px; border-radius: 10px; }
  .picker-option:hover, .picker-option[aria-selected='true'] { background: var(--surface-3); }
  .import { color: var(--accent); border-top: 1px solid var(--border); border-radius: 0 0 10px 10px; padding-top: 10px; font-size: var(--fs-sm); }
  .empty { margin: 6px 8px; }
</style>
