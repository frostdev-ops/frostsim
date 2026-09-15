<script lang="ts">
  import type { ImportedCharacter } from '../import/character'
  import type { ToolSettings } from '../settings.svelte'
  import { app } from '../app.svelte'
  import { resolveItem } from '../items'
  import ChoiceSelect from './ChoiceSelect.svelte'
  let { character, settings }: { character: ImportedCharacter; settings: ToolSettings } = $props()
  const names = $derived(character.equipped.map(item => (resolveItem(item, app.resolved)?.name ?? item.addonName ?? '').toLowerCase()))
  const crucible = $derived(names.includes('crucible of erratic energies'))
  const whelp = $derived(names.includes('ruby whelp shell'))
  const training = ['fire_shot', 'lobbing_fire_nova', 'curing_whiff', 'mending_breath', 'sleepy_ruby_warmth', 'under_red_wings']
</script>
{#if crucible || whelp}<section class="stack-sm"><h3 class="section-title">Trinkets</h3>
  {#if crucible}<div class="stack-sm"><strong class="small">Crucible of Erratic Energies</strong><div class="row">{#each ['violence', 'sustenance', 'predation'] as choice}<label class="check small"><input type="checkbox" checked={settings.equipmentOptions['midnight.crucible_of_erratic_energies_' + choice] === '1'} onchange={(e) => settings.equipmentOptions['midnight.crucible_of_erratic_energies_' + choice] = e.currentTarget.checked ? '1' : '0'} />{choice[0].toUpperCase() + choice.slice(1)}</label>{/each}</div></div>{/if}
  {#if whelp}<ChoiceSelect label="Ruby Whelp Shell training" bind:value={settings.equipmentOptions['dragonflight.player.ruby_whelp_shell_training']} options={[{ value: '', label: 'Default / random' }, ...training.map(value => ({ value: value + ':6', label: value.replaceAll('_', ' ') }))]} />{/if}
</section>{/if}
