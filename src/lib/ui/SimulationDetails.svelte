<script lang="ts">
  import GameIcon from './GameIcon.svelte'
  import ItemIcon from './ItemIcon.svelte'
  import ItemLink from './ItemLink.svelte'
  import { presentation, initPresentation, spellForName } from '../presentation.svelte'
  import { catalogClient, app } from '../app.svelte'
  import type { Consumable } from '../catalog/types'
  import type { SimOutcome } from '../simc/job'
  import type { BuffRow, PlayerDetail } from '../simc/detail'
  import { fmtInt, fmtPct, fmtSeconds, titleCase } from '../format'
  import { spellIconUrl } from '../media.svelte'
  import { RAID_BUFFS, type RaidBuff } from '../simc/raid-buffs'
  import { weeklyDefaultLines, weeklyDefaultsSource } from '../simc/weekly-defaults'
  import { sharedConfidence, type SharedReport } from '../store/report-share'
  import { routeSummary } from '../dungeonRoute'

  interface Props { outcome?: SimOutcome; shared?: SharedReport; detail?: PlayerDetail | null }
  let { outcome, shared, detail = null }: Props = $props()
  let failedIcons = $state<Set<number>>(new Set())
  let catalogConsumables = $state<Consumable[]>([])
  $effect(() => { app.catalogState; void initPresentation(); const client = catalogClient(); if (client) void Promise.all(['flask', 'food', 'potion'].map(kind => client.consumables(kind as Consumable['kind']))).then(rows => catalogConsumables = rows.flat()).catch(() => {}) })
  const report = $derived(outcome?.report ?? {
    options: { fightStyle: shared!.o[0], maxTime: shared!.o[1], desiredTargets: shared!.o[2], targetError: shared!.o[4] },
    engine: { simcVersion: shared!.engine[0], gitRevision: shared!.engine[1] },
    actualIterations: shared!.meta.samples, iterationsSimulated: shared!.o[3], worstRelativeErrorPct: sharedConfidence(shared!)?.relativePct,
  })
  const options = $derived(report.options)
  const route = $derived(shared?.meta.route ?? routeSummary([outcome?.request.profile ?? '', ...(outcome?.request.extraProfileLines ?? [])].join('\n').split('\n')))
  const consumables = $derived(detail?.consumables)
  const weeklyDefaults = $derived(outcome && outcome.request.mode !== 'raw' && weeklyDefaultLines(outcome.request.profile).length > 0)
  const consumableRows = $derived([
    { label: 'Flask / phial', value: consumables?.flask },
    { label: 'Food', value: consumables?.food },
    { label: 'Potion', value: consumables?.potion },
    { label: 'Augment rune', value: consumables?.augmentation },
    { label: 'Weapon enhancement', value: consumables?.temporaryEnchant },
  ])
  const token = (value: string) => value.replace(/_\d+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  function buffFor(value: string | undefined): BuffRow | undefined {
    return value ? detail?.buffs.find((buff) => token(buff.name) === token(value)) : undefined
  }
  function consumableName(value: string | undefined): string {
    if (!value) return 'Not reported'
    if (value === 'disabled' || value === 'none') return 'None'
    return titleCase(value.replace(/_(\d+)$/, ' (Rank $1)').replace(/:/g, ': '))
  }
  const buffs = $derived(detail?.buffs.filter((buff) =>
    (buff.constant || (token(buff.name) === 'bloodlust' && (buff.uptimePct ?? 0) > 0)) &&
    !consumableRows.some((row) => row.value && token(row.value) === token(buff.name)),
  ) ?? [])
  const raidOverrides = $derived(Object.entries(detail?.raidBuffs ?? {}).filter(([key, enabled]) =>
    enabled && key in RAID_BUFFS && !buffs.some((buff) => token(buff.name) === token(key)),
  ))
</script>
<section class="panel simulation-details stack" aria-label="Simulation details">
  <h2>Simulation details</h2>
  <div><strong>{options.fightStyle === 'DungeonRoute' ? 'Dungeon Route' : titleCase(options.fightStyle)}</strong>{#if options.fightStyle === 'DungeonRoute'}<p class="small">{route.name}</p><p class="small muted">{route.pulls} pulls · ends after the final pull</p>{:else}<p class="small muted">{fmtSeconds(options.maxTime)} · {options.desiredTargets} target{options.desiredTargets === 1 ? '' : 's'}</p>{/if}</div>
  <div class="icon-list" aria-label="Buffs and consumables">
    {#each buffs as buff, i (i)}
      <span class="buff-icon" title={buff.spellName ?? titleCase(buff.name)}>
        <GameIcon spellId={buff.id} label={buff.spellName ?? titleCase(buff.name)} size={28} />
      </span>
    {/each}
    {#each raidOverrides as [key] (key)}<GameIcon label={RAID_BUFFS[key as RaidBuff]} size={28} />{/each}
    {#each consumableRows.filter(row => row.value && !['none', 'disabled'].includes(row.value)) as row (row.label)}
      {@const item = catalogConsumables.find(item => item.option === row.value)}
      {@const special = [...(presentation.data?.augmentation ?? []), ...(presentation.data?.weapon ?? [])].find(option => option.value === row.value?.replace(/^main_hand:/, ''))}
      <span title={row.label + ': ' + consumableName(row.value)}>{#if item}<ItemLink itemId={item.itemId} name={item.name}><ItemIcon itemId={item.itemId} size={28} alt={item.name} /></ItemLink>{:else}<GameIcon spellId={special?.spellId ?? buffFor(row.value)?.id} label={consumableName(row.value)} size={28} />{/if}</span>
    {/each}
  </div>
  <dl>
    <div><dt>Margin of error</dt><dd>{report.worstRelativeErrorPct !== undefined ? fmtPct(report.worstRelativeErrorPct) : '—'}</dd></div>
    <div><dt>Iterations</dt><dd>{fmtInt(report.actualIterations ?? report.iterationsSimulated)}</dd></div>
    <div><dt>Processing time</dt><dd>{fmtSeconds(outcome?.appElapsedSeconds ?? shared?.elapsed)}</dd></div>
    <div><dt>Engine</dt><dd>SimC {report.engine.simcVersion}</dd></div>
  </dl>
  <details class="disclosure"><summary>Consumables</summary><dl>{#each consumableRows as row (row.label)}{@const item = catalogConsumables.find(item => item.option === row.value)}<div><dt>{row.label}</dt><dd>{#if item}<ItemLink itemId={item.itemId} name={item.name} />{:else}{consumableName(row.value)}{/if}</dd></div>{/each}</dl></details>
  <details class="disclosure"><summary>Technical details</summary><dl>
    <div><dt>Build</dt><dd>{report.engine.gitRevision ?? '—'}</dd></div>
    <div><dt>Target error</dt><dd>{options.targetError}%</dd></div>
    {#if weeklyDefaults}<div><dt>Default baseline</dt><dd>{weeklyDefaultsSource.commit.slice(0, 7)}</dd></div>{/if}
  </dl></details>
</section>
<style>
  h2 { font-size: 15px; }
  .simulation-details { gap: 16px; }
  .icon-list { display: flex; flex-wrap: wrap; gap: 5px; }
  .buff-icon { width: 30px; height: 30px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--border-strong); font-size: 10px; border-radius: 3px; overflow: hidden; }
  dl { margin: 0; font-size: 12px; }
  dl > div { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  dt { color: var(--text-muted); }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
</style>
