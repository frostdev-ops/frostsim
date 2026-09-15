<script lang="ts">
  import { FIGHT_PRESETS } from '../simc/client'
  import type { ToolSettings } from '../settings.svelte'
  import type { ImportedCharacter } from '../import/character'
  import { app, maxThreads, isBusy, selectEngineVersion } from '../app.svelte'
  import { RAID_BUFFS, type RaidBuff } from '../simc/raid-buffs'
  import GameIcon from './GameIcon.svelte'
  import EquipmentOptions from './EquipmentOptions.svelte'
  import ConsumableFields from './ConsumableFields.svelte'
  import RoutePicker from './RoutePicker.svelte'
  interface Props { settings: ToolSettings; character?: ImportedCharacter | null; perCandidate?: boolean; rawScript?: boolean; staged?: boolean }
  let { settings, character = null, perCandidate = false, rawScript = false, staged = false }: Props = $props()
  const inherited = $derived(Object.fromEntries((character?.profileLines ?? []).filter(line => /^(override\.[a-z_]+|optimal_raid)=/.test(line)).map(line => [line.split('=')[0], line.slice(line.indexOf('=') + 1)])))
  const dungeonSlice = $derived(settings.fightStyle === 'DungeonSlice')
  const lockedDuration = $derived(['DungeonSlice', 'DungeonRoute', 'Ultraxion'].includes(settings.fightStyle))
  const lockedTargets = $derived(['DungeonSlice', 'DungeonRoute'].includes(settings.fightStyle))
  const standardAccuracy = $derived(settings.accuracyMode === 'targetError' && [0.1, 0.05].includes(settings.targetError) && settings.maxIterations === 100000)
  const highPrecision = $derived(standardAccuracy && settings.targetError === 0.05)
</script>
<div class="settings stack">
  {#if !rawScript}
    <div class="fields">
      <label class="field"><span>Fight style</span><select value={settings.presetId} onchange={(e) => settings.selectPreset(e.currentTarget.value)}>{#each FIGHT_PRESETS.filter((p) => p.supported.ok) as preset (preset.id)}<option value={preset.id}>{preset.label}</option>{/each}</select></label>
      <label class="field"><span>Targets</span><input type="number" min="1" max="50" disabled={lockedTargets} value={lockedTargets ? 1 : settings.targets} onchange={(e) => settings.targets = Number(e.currentTarget.value)} />{#if dungeonSlice}<span class="hint">Set by fight style</span>{/if}</label>
      <label class="field"><span>{settings.fightStyle === 'DungeonRoute' ? 'Safety limit' : 'Fight length'}</span><select disabled={lockedDuration} value={settings.maxTime} onchange={(e) => settings.maxTime = Number(e.currentTarget.value)}>{#each [...new Set([120, 180, 240, 300, 360, 420, 480, 600, settings.maxTime])] as seconds}<option value={seconds}>{seconds / 60} minutes</option>{/each}</select>{#if dungeonSlice}<span class="hint">Set by fight style</span>{/if}</label>
      {#if character?.loadouts.length}<label class="field"><span>Talents</span><select bind:value={settings.loadoutName}><option value={null}>Active loadout</option>{#each character.loadouts as loadout (loadout.name)}<option value={loadout.name}>{loadout.name}</option>{/each}</select></label>{/if}
    </div>
    {#if settings.fightStyle === 'DungeonRoute'}<RoutePicker {settings} /><p class="xs muted">The route ends after its final pull; the engine enforces a 45-minute safety limit.</p>{/if}
    <ConsumableFields {settings} level={character?.level} profileLines={character?.profileLines} />
    <section class="stack-sm">
      <div class="spread"><h3 class="section-title">Raid buffs</h3><div class="row"><button class="sm" onclick={() => settings.raidBuffs = Object.fromEntries(Object.keys(RAID_BUFFS).map((key) => [key, true]))}>Optimal raid buffs</button><button class="sm ghost" onclick={() => settings.raidBuffs = Object.fromEntries(Object.keys(RAID_BUFFS).map((key) => [key, false]))}>No external buffs</button></div></div>
      <div class="buff-grid">{#each Object.entries(RAID_BUFFS) as [key, label] (key)}<label class="check small"><input type="checkbox" checked={settings.raidBuffs[key as RaidBuff] ?? (inherited['override.' + key] ? inherited['override.' + key] !== '0' : inherited.optimal_raid !== '0')} onchange={(e) => settings.raidBuffs[key as RaidBuff] = e.currentTarget.checked} /><GameIcon label={label.split(' / ')[0]} size={24} />{label}</label>{/each}</div>
    </section>
  {/if}
  {#if character && !rawScript}<EquipmentOptions {character} {settings} />{/if}
  <details class="disclosure advanced-options">
    <summary>Advanced{!standardAccuracy && !staged && !rawScript ? ' · Custom accuracy' : ''}</summary>
    <div class="stack">
      <div class="fields">
        <label class="field"><span>Accuracy mode</span><select bind:value={settings.accuracyMode} disabled={staged}><option value="targetError">Target error</option><option value="iterations">Fixed iterations</option>{#if rawScript}<option value="script">Use script settings</option>{/if}</select></label>
        {#if settings.accuracyMode === 'targetError'}<label class="field"><span>{perCandidate ? 'Error per candidate (%)' : 'Target error (%)'}</span><input type="number" min="0.01" max="10" step="0.01" bind:value={settings.targetError} /></label><label class="field"><span>Maximum iterations</span><input type="number" min="100" max="1000000" step="100" bind:value={settings.maxIterations} /></label>
        {:else if settings.accuracyMode === 'iterations'}<label class="field"><span>Iterations</span><input type="number" min="100" max="1000000" step="100" bind:value={settings.iterations} /></label>{/if}
        <label class="field"><span>Threads</span><input type="number" min="1" max={maxThreads()} bind:value={settings.threads} /></label>
      </div>
      <label class="check small"><input type="checkbox" bind:checked={settings.htmlReport} />Include detailed HTML report</label>
      <label class="field"><span>SimulationCraft version</span>
        <select value={app.engineVersion} disabled={isBusy() || !app.capabilityChecked} onchange={(e) => { const id = e.currentTarget.value; e.currentTarget.value = app.engineVersion; void selectEngineVersion(id) }}>
          <option value="auto">Automatic · latest validated build</option>
          {#each app.engineVersions as version (version.id)}<option value={version.id}>{version.label}</option>{/each}
        </select>
        <span class="hint">Automatic uses the latest validated stable or nightly build. Alpha and beta builds are opt-in. Switching reloads the page and resets unsaved gear selections.</span>
      </label>
      {#if app.engineVersionError}<p class="small" role="alert">{app.engineVersionError}</p>{/if}
      <span class="small muted">Engine: {app.capability?.ok ? `${app.capability.manifest.engine.simcVersion} · ${app.capability.manifest.engine.upstreamCommit.slice(0, 7)}` : 'Unavailable'}</span>
    </div>
  </details>
  {#if !rawScript}<div class="spread">
    {#if !staged}<label class="check small"><input type="checkbox" checked={highPrecision} onchange={(e) => { settings.accuracyMode = 'targetError'; settings.targetError = e.currentTarget.checked ? 0.05 : 0.1; settings.maxIterations = 100000 }} />High Precision <span class="muted" title="0.05% target error; about four times the work of 0.1%">(0.05%)</span></label>{/if}
    <button class="ghost sm" onclick={() => settings.restoreDefaults()}>Restore defaults</button>
  </div>{/if}
</div>
<style>
  .settings { gap: 24px; }
  .buff-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; padding-block: 8px; }
  .advanced-options { border-top: 1px solid var(--border); padding-top: 16px; }
  @media(max-width: 900px) { .buff-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
