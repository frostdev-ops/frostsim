<script lang="ts">
  // Every character on this device as a card (D4). Picking one opens it below; each card can go straight to a Quick Sim with
  // that character, which sets Quick Sim's own pick and leaves every other screen's alone.
  import type { Snippet } from 'svelte'
  import { Plus, Zap } from '@lucide/svelte'
  import { app, DRAFT, isBusy, pickCharacter } from '../app.svelte'
  import { classLabel, type ImportedCharacter } from '../import/character'
  import { fmtInt, titleCase } from '../format'
  import { navigate } from '../router.svelte'
  import Portrait from './Portrait.svelte'
  import { portraitOptedIn } from '../portrait.svelte'

  /** `badge`: a line under a stored character's name, by its id. `tail`: cards after the characters, in place of the import card. */
  let { onimport, badge, tail }: { onimport: () => void; badge?: Snippet<[string]>; tail?: Snippet } = $props()

  interface Card { id: string; label: string; character: ImportedCharacter; storedId?: string; updatedAt?: number }
  const cards = $derived<Card[]>([
    ...(app.draft ? [{ id: DRAFT, label: `${app.draft.name || 'Character'} (unsaved)`, character: app.draft }] : []),
    ...app.characters.map((c) => ({ id: c.id, label: c.label, character: c.character, storedId: c.id, updatedAt: c.updatedAt })),
  ])
  /** Newest finished Quick Sim DPS per stored character. */
  const lastDps = $derived.by(() => {
    const out = new Map<string, number>()
    for (const r of app.reports) {
      if (r.tool === 'quick' && r.completion === 'complete' && r.characterId && r.summary.dps && !out.has(r.characterId)) out.set(r.characterId, r.summary.dps)
    }
    return out
  })
  const sub = (c: ImportedCharacter) => [c.spec ? titleCase(c.spec) : classLabel(c), c.level ? `Level ${c.level}` : '', c.server ?? ''].filter(Boolean).join(' · ')

  function simWith(id: string): void {
    pickCharacter(id, 'quick')
    navigate('quick')
  }
</script>

<section class="roster" aria-label="Your characters">
  {#each cards as c (c.id)}
    <div class="card" class:on={c.id === app.activeCharacterId} data-class={c.character.className}>
      <button class="open" onclick={() => pickCharacter(c.id, 'character')} aria-pressed={c.id === app.activeCharacterId} aria-label="Open {c.label}">
        {#if c.storedId && portraitOptedIn(c.storedId)}
          <Portrait characterId={c.storedId} region={c.character.region} realm={c.character.server} name={c.character.name} size={44} quiet />
        {:else}
          <span class="mark" aria-hidden="true">{c.label.slice(0, 1).toUpperCase()}</span>
        {/if}
        <span class="text">
          <strong class="truncate">{c.label}</strong>
          <span class="xs muted truncate">{sub(c.character)}</span>
          {#if c.storedId && lastDps.get(c.storedId)}<span class="xs dps">{fmtInt(lastDps.get(c.storedId)!)} DPS</span>{/if}
          {#if c.storedId && badge}{@render badge(c.storedId)}{/if}
        </span>
      </button>
      <button class="sm ghost sim" disabled={isBusy()} onclick={() => simWith(c.id)} title="Quick Sim {c.label}" aria-label="Quick Sim {c.label}"><Zap size={16} /></button>
    </div>
  {/each}
  {#if tail}{@render tail()}
  {:else}<button class="card add" onclick={onimport}><Plus size={18} aria-hidden="true" /><span class="small">Import a character</span></button>{/if}
</section>

<style>
  .roster { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(16rem, 100%), 1fr)); gap: var(--s3); }
  .card {
    position: relative; display: flex; align-items: center; gap: var(--s2); min-width: 0; min-height: 4.25rem; padding: var(--s2);
    border-radius: var(--r3); border: 1px solid var(--glass-edge); border-left: 3px solid var(--class-color, var(--accent));
    background: radial-gradient(18rem 6rem at 0% 0%, color-mix(in oklab, var(--class-color, var(--accent)) 12%, transparent), transparent 70%), var(--glass);
    transition: border-color var(--t-control) var(--ease), box-shadow var(--t-control) var(--ease);
  }
  .card.on { border-color: var(--class-color, var(--accent)); box-shadow: 0 0 28px -14px var(--class-color, var(--accent-glow)); }
  .open { all: unset; box-sizing: border-box; flex: 1; display: flex; align-items: center; gap: var(--s3); min-width: 0; cursor: pointer; border-radius: var(--r2); }
  .open:focus-visible { box-shadow: var(--focus); }
  .text { display: grid; min-width: 0; line-height: 1.25; }
  .dps { color: var(--accent); font-weight: 600; }
  .mark {
    flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 10px; font: 700 18px var(--font-display);
    color: var(--class-color, var(--accent)); background: color-mix(in oklab, var(--class-color, var(--accent)) 20%, transparent);
  }
  .sim { flex: none; }
  .add {
    all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: var(--s2); min-height: 4.25rem;
    border-radius: var(--r3); border: 1px dashed var(--border-strong); color: var(--text-muted); cursor: pointer;
  }
  .add:hover { color: var(--accent); border-color: var(--accent); }
  .add:focus-visible { box-shadow: var(--focus); }
</style>
