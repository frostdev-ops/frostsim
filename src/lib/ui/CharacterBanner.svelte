<script lang="ts">
  import type { ImportedCharacter, ItemInstance } from '../import/character'
  import { classLabel } from '../import/character'
  import { titleCase } from '../format'
  import Portrait from './Portrait.svelte'
  import GearStrip from './GearStrip.svelte'
  import { ExternalLink } from '@lucide/svelte'
  import { fetchCharacterMedia } from '../media-cache'
  let { character, characterId = '', embedded = false, gear = character.equipped, loadout = '' }: { character: ImportedCharacter; characterId?: string; embedded?: boolean; gear?: ItemInstance[]; loadout?: string } = $props()
  const identity = $derived(character.region && character.server && character.name)
  const url = $derived(identity ? 'https://raider.io/characters/' + [character.region, character.server!.replace(/\s*\(.*\)\s*$/, '').toLowerCase().replace(/\s+/g, '-'), character.name].map((value) => encodeURIComponent(value ?? '')).join('/') : '')
  let failed = $state(false)
  let retry = $state(0)
  let profile = $state<{ score: number | null; progression: { name: string; summary: string }[] } | null>(null)
  $effect(() => {
    const current = url
    retry
    profile = null
    failed = false
    let cancelled = false
    if (embedded && current) {
      void fetchCharacterMedia('/api/wow/raider-profile/' + current.split('/characters/')[1])
        .then(response => response.ok ? response.json() : null)
        .then(value => {
          if (cancelled) return
          if (!value || !Array.isArray(value.progression)) { failed = true; return }
          profile = {
            score: typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : null,
            progression: value.progression.filter((r: { name?: unknown; summary?: unknown }) => typeof r?.name === 'string' && typeof r?.summary === 'string'),
          }
        }).catch(() => { if (!cancelled) failed = true })
    }
    return () => { cancelled = true }
  })
</script>
<section class="character-banner" data-class={character.className}>
    <div class="identity">
      <Portrait {characterId} region={character.region} realm={character.server} name={character.name} size={64} quiet />
      <div class="stack-sm"><h2>{character.name}</h2><span class="small muted">{character.level} {titleCase(character.spec ?? '')} {classLabel(character)}</span>{#if loadout}<span class="small">{loadout}</span>{/if}</div>
      {#if url}<a class="profile-link small" href={url} target="_blank" rel="noreferrer">Raider.IO <ExternalLink size={14} /></a>{/if}
    </div>
    {#if profile}<div class="progression">{#if profile.score !== null}<div><span class="xs muted">Mythic+ score</span><strong class="score">{profile.score.toLocaleString()}</strong></div>{/if}{#each profile.progression as raid (raid.name)}<div><span class="xs muted">{titleCase(raid.name.replaceAll('-', ' '))}</span><strong>{raid.summary}</strong></div>{/each}</div>{/if}
    {#if failed}<div class="row small muted">Raider.IO progression unavailable <button class="ghost sm" onclick={() => retry++}>Retry</button></div>{/if}
  {#if !embedded}<GearStrip items={gear} size={40} />{/if}
</section>
<style>
  .character-banner { min-width: 0; border-radius: 8px; background: var(--surface-2); padding: 18px; display: flex; flex-direction: column; gap: 16px; }
  .identity { display: flex; align-items: center; gap: 16px; }
  h2 { color: var(--class-color, var(--text)); font-size: 22px; letter-spacing: .04em; }
  .profile-link { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
  .progression { display: flex; flex-wrap: wrap; gap: 16px 32px; border-top: 1px solid var(--border); padding-top: 14px; }
  .progression > div { display: flex; flex-direction: column; gap: 4px; }
  .progression strong { font-variant-numeric: tabular-nums; }
  .score { color: var(--accent); }
</style>
