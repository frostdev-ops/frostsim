<script lang="ts">
  // Quick Sim: setup, run, result header (P06.1-P06.4, P06.9-P06.12).
  import { activeCharacter, activeStored, app, DRAFT, isBusy, maxThreads, openDraft, toast } from '../lib/app.svelte'
  import { X } from '@lucide/svelte'
  import { run, startRun } from '../lib/job.svelte'
  import { estimateSeconds, iterationsForTarget } from '../lib/estimate'
  import { takeSetup, type SetupHandoff } from '../lib/handoff.svelte'
  import { registerShortcuts } from '../lib/shortcuts.svelte'
  import { buildProfile } from '../lib/import/serialize'
  import { fmtBytes, fmtInt, fmtSeconds, titleCase } from '../lib/format'
  import { href, navigate } from '../lib/router.svelte'
  import Banner from '../lib/ui/Banner.svelte'
  import EngineNotices from '../lib/ui/EngineNotices.svelte'
  import ReportFrame from '../lib/ui/ReportFrame.svelte'
  import RunPanel from '../lib/ui/RunPanel.svelte'
  import ResultHeader from '../lib/ui/ResultHeader.svelte'
  import SettingsForm from '../lib/ui/SettingsForm.svelte'
  import PlayerDetail from '../lib/ui/PlayerDetail.svelte'
  import { quickSettings } from '../lib/settings.svelte'
  import ReportResult from '../lib/ui/ReportResult.svelte'
  import CharacterBanner from '../lib/ui/CharacterBanner.svelte'
  import { multiActorParts } from '../lib/simc/multi-actor'
  import SimulationDetails from '../lib/ui/SimulationDetails.svelte'
  import { parseAddonExport } from '../lib/import/character'
  import type { PlayerDetail as Detail } from '../lib/simc/detail'
  import { withPlayerScopedLines } from '../lib/simc/options'

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const busy = $derived(isBusy())
  /** Other characters in this sim (D2), minus whichever one is now the main pick. */
  const extras = $derived(app.quickExtras.filter((id) => id !== app.activeCharacterId).flatMap((id) => {
    if (id === DRAFT) return app.draft ? [{ id, label: `${app.draft.name} (unsaved)`, character: app.draft }] : []
    const c = app.characters.find((s) => s.id === id)
    return c ? [{ id, label: c.label, character: c.character }] : []
  }))

  /**
   * How long this run is likely to take, learned from this device's own
   * finished runs. A fixed-iteration run asks directly; a target-error run has
   * no iteration count in advance, so past runs that actually REACHED a target
   * are converted through the engine's own 1/targetError² relationship.
   */
  const estimate = $derived.by(() => {
    const accuracy = quickSettings.accuracy()
    // Script mode has neither count nor target, so nothing to estimate.
    const iterations = accuracy.mode === 'iterations'
      ? accuracy.iterations
      : accuracy.mode === 'targetError'
        ? iterationsForTarget(app.reports, accuracy.targetError)
        : null
    return iterations ? estimateSeconds(app.reports, iterations) : null
  })
  const outcome = $derived(run.outcome)
  const resultCharacter = $derived(outcome ? outcome.request.characterSnapshot ?? parseAddonExport(outcome.request.profile) : null)
  let detail = $state<Detail | null>(null)

  // Talent string run would use: active one unless loadout picked.
  const loadout = $derived(
    quickSettings.loadoutName
      ? character?.loadouts.find((l) => l.name === quickSettings.loadoutName)
      : undefined,
  )

  /** Setup handed over from Top Gear (P08.14); held rather than applied silently, user asked for detailed run of one setup. */
  let setup = $state<SetupHandoff | null>(null)
  /** Settings collapse once a result exists; this reopens them. */
  let settingsOpen = $state(false)
  // Refreshed import starts new setup; old run stays in Reports.
  $effect(() => {
    if (!busy && character && resultCharacter && (character.importedAt !== resultCharacter.importedAt || character.raw !== resultCharacter.raw)) settingsOpen = true
  })
  $effect(() => {
    const incoming = takeSetup(stored?.id ?? null)
    if (incoming) {
      setup = incoming
      if (incoming.settings) quickSettings.apply(incoming.settings)
    } else if (setup && setup.characterId !== (stored?.id ?? null)) setup = null
  })

  async function go(): Promise<void> {
    if (!character) return
    // Handed-over delta wins over picked loadout for slots it names; untouched slots already meaning.
    const overrides = {
      ...(loadout ? { talents: loadout.talents } : {}),
      ...(setup ? { items: setup.items, talents: setup.talents ?? character.talents } : {}),
    }
    const lines = withPlayerScopedLines(
      [...(setup?.extraProfileLines ?? []), ...(quickSettings.extraProfileLines() ?? [])],
      Object.entries(setup?.consumables ?? {}).map(([key, value]) => `${key}=${value}`),
    )
    // One character: exactly the single-actor request as before. More: one block each (multi-actor.ts).
    const parts = extras.length
      ? multiActorParts([{ character, overrides }, ...extras.map((e) => ({ character: e.character }))], lines)
      : { profile: buildProfile(character, overrides), extraProfileLines: lines, names: [character.name] }
    const main = stored?.label ?? character.name
    // A new run shows its own result, even when started from the reopened setup.
    settingsOpen = false
    // Each stored character in the run, by the name the report gives it, so every one gets its own history point.
    const ids = [stored?.id, ...extras.map((e) => (e.id === DRAFT ? undefined : e.id))]
    await startRun({
      tool: 'quick',
      title: extras.length ? `${main} and ${extras.length} more — Quick Sim` : `${main} — Quick Sim`,
      summarize: extras.length ? (report) => ({
        members: parts.names.flatMap((name, i) => {
          const p = report.players.find((x) => x.name === name)
          return ids[i] && p ? [{ characterId: ids[i]!, name, dps: p.dps.mean, confidenceMargin: p.dpsConfidence?.margin }] : []
        }),
      }) : undefined,
      request: {
        schemaVersion: 1,
        profile: parts.profile,
        characterSnapshot: $state.snapshot({ ...character, talents: setup?.talents ?? loadout?.talents ?? character.talents, equipped: setup ? character.equipped.flatMap(item => setup!.items[item.slot] === null ? [] : [setup!.items[item.slot] ?? item]) : character.equipped }),
        settings: {
          fightStyle: quickSettings.fightStyle,
          maxTime: quickSettings.maxTime,
          targets: quickSettings.targets,
          threads: Math.min(quickSettings.threads, maxThreads()),
        },
        accuracy: quickSettings.accuracy(),
        extraProfileLines: parts.extraProfileLines,
        htmlReport: quickSettings.htmlReport,
      },
    })
  }

  function rerun(): void {
    if (outcome) void startRun({ tool: 'quick', title: outcome.report.players[0]?.name + ' — Quick Sim', request: outcome.request })
  }

  function editResult(): void {
    if (!outcome || !resultCharacter) return
    openDraft(resultCharacter, 'quick')
    const opts = outcome.report.options
    quickSettings.apply({ fightStyle: opts.fightStyle as typeof quickSettings.fightStyle, maxTime: opts.maxTime, targets: opts.desiredTargets })
    setup = { characterId: stored?.id ?? null, label: 'Previous result', items: Object.fromEntries(resultCharacter.equipped.map((item) => [item.slot, item])), talents: resultCharacter.talents, extraProfileLines: outcome.request.extraProfileLines }
    settingsOpen = true
  }

  function download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  // Cmd/Ctrl+Enter runs, but only when button itself would be enabled.
  $effect(() =>
    registerShortcuts({
      run: () => {
        if (busy || !app.capability?.ok || !character) return false
        void go()
      },
    }),
  )
</script>
{#if !character && !outcome && !busy}
  <section class="empty stack"><h1>Quick Sim</h1><p>Import a character to begin.</p><a href={href('character')}>Import character</a></section>
{:else if busy}
  <RunPanel />
{:else if outcome && !settingsOpen}
  <div class="stack">
    <div><button class="ghost sm" onclick={editResult}>← Back to setup</button></div>
    <ReportResult {outcome} onrerun={rerun} onedit={editResult} />
  </div>
{:else if character}
  <section class="panel stack quick-setup">
    <div class="spread"><h1>Quick Sim</h1>{#if outcome}<button class="ghost sm" onclick={() => settingsOpen = false}>Back to result</button>{/if}</div>
    <CharacterBanner {character} characterId={stored?.id} loadout={loadout?.name ?? 'Active loadout'} gear={setup ? character.equipped.map((item) => setup?.items[item.slot] ?? item) : character.equipped} />
    {#if setup}<div class="spread"><span class="small">Setup: {setup.label}</span><button class="ghost sm" onclick={() => setup = null}>Use equipped gear</button></div>{/if}
    <div class="together">
      <span class="xs muted label">Compare in this sim</span>
      {#each extras as e (e.id)}
        <span class="member" data-class={e.character.className}>
          <span class="truncate">{e.label}</span>
          <button class="ghost sm" onclick={() => (app.quickExtras = app.quickExtras.filter((id) => id !== e.id))} aria-label="Remove {e.label} from this sim"><X size={14} /></button>
        </span>
      {/each}
      {#await import('../lib/ui/CharacterPicker.svelte') then m}<m.default add value={null} exclude={[app.activeCharacterId ?? '', ...app.quickExtras]} onpick={(id) => (app.quickExtras = [...app.quickExtras, id])} label="Add a character to this sim" />{/await}
      {#if extras.length}<span class="xs muted">Each character runs in its own batch with these settings, so every one gets its own number.</span>{/if}
    </div>
    <SettingsForm settings={quickSettings} {character} />
    <div class="action-bar"><button class="primary" onclick={go} disabled={!app.capability?.ok}>Run Quick Sim</button>{#if estimate}<span class="small muted">≈ {fmtSeconds(estimate.seconds)}</span>{/if}</div>
    {#if run.error}<RunPanel />{/if}
  </section>
{/if}
<style>
  .quick-setup { gap: 24px; }
  .together { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
  .label { text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; margin-right: var(--s1); }
  .member {
    display: inline-flex; align-items: center; gap: 2px; max-width: 16rem; padding: 2px 2px 2px 10px; border-radius: 99px; font-size: var(--fs-sm);
    border: 1px solid color-mix(in oklab, var(--class-color, var(--accent)) 50%, transparent);
    background: color-mix(in oklab, var(--class-color, var(--accent)) 12%, transparent);
  }
  .member button { min-height: 1.5rem; padding: 0 0.3rem; }
</style>
