<script lang="ts">
  // P10: raw scripts, expert mode, engine options, stat weights.
  import { activeCharacter, activeStored, app, isBusy, maxThreads, toast } from '../lib/app.svelte'
  import { run, startRun } from '../lib/job.svelte'
  import { registerShortcuts } from '../lib/shortcuts.svelte'
  import { advancedSettings } from '../lib/settings.svelte'
  import { buildProfile } from '../lib/import/serialize'
  import { PROTECTED_OPTIONS } from '../lib/simc/options'
  import { advancedCapability } from '../lib/simc/client'
  import { fmtInt, titleCase } from '../lib/format'
  import { href } from '../lib/router.svelte'
  import Banner from '../lib/ui/Banner.svelte'
  import CodeArea from '../lib/ui/CodeArea.svelte'
  import ScriptEditor from '../lib/ui/ScriptEditor.svelte'
  import { ms, stagger } from '../lib/theme.svelte'
  import { fly } from 'svelte/transition'
  import RunPanel from '../lib/ui/RunPanel.svelte'
  import ResultHeader from '../lib/ui/ResultHeader.svelte'
  import ShareReport from '../lib/ui/ShareReport.svelte'
  import SettingsForm from '../lib/ui/SettingsForm.svelte'
  import {
    activeSpec, copyFromSpec, expert, persistDrafts, route, specsWithDrafts, STAT_CHOICES,
    statWeights, useSpec, canNormalizeWeights,
  } from '../lib/advanced.svelte'
  import { checkSettings, importRouteExport, routeOptions } from '../lib/dungeonRoute'
  import { slotScopeProblem, type SlotName } from '../lib/simc/options'

  type Tab = 'script' | 'expert' | 'weights'
  let tab = $state<Tab>('script')

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const busy = $derived(isBusy())
  const outcome = $derived(run.outcome)

  const baseProfile = $derived(character ? buildProfile(character) : '')

  /** Script actually sent with Expert Mode slots in fixed order (P10.3). */
  const effectiveScript = $derived.by(() => {
    if (expert.mode === 'raw') return expert.raw
    const parts = [expert.header, expert.preActor, baseProfile.trimEnd(), expert.postActor, expert.footer]
    return parts.filter((p) => p.trim()).join('\n\n') + '\n'
  })

  // P10.9: route's sim options and pull events appended to script.
  // P10.3: per-line scope problems marked while typing, not explained after run returns wrong actor number.
  const SLOTS: [SlotName, string][] = [
    ['header', 'Header'], ['preActor', 'Before the actor'],
    ['postActor', 'After the actor'], ['footer', 'Footer'],
  ]
  const slotIssues = $derived.by(() => {
    const out: { slot: string; line: number; message: string }[] = []
    for (const [slot, label] of SLOTS) {
      expert[slot].split('\n').forEach((line, i) => {
        const problem = slotScopeProblem(slot, line)
        if (problem) out.push({ slot: label, line: i + 1, message: problem })
      })
    }
    return out
  })

  const parsedRoute = $derived(importRouteExport(route.text))
  const routeSettingIssues = $derived(checkSettings(route))
  const routeIssues = $derived([...routeSettingIssues, ...parsedRoute.issues])
  const routeLines = $derived(
    route.enabled && !routeIssues.length && parsedRoute.pulls
      ? [...routeOptions(route), ...Object.entries(parsedRoute.buffs).map(([key, value]) => `override.${key}=${value ? 1 : 0}`)]
      : [],
  )

  const extraLines = $derived([
    ...expert.extraOptions
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
    ...routeLines,
  ])
  const protectedHits = $derived(
    extraLines.filter((l) =>
      (PROTECTED_OPTIONS as readonly string[]).includes(l.split('=')[0].trim().toLowerCase()),
    ),
  )
  const actorCount = $derived(
    (effectiveScript.match(/^\s*(?:deathknight|demonhunter|druid|evoker|hunter|mage|monk|priest|paladin|rogue|shaman|warlock|warrior|enemy|pet|guardian|copy)\s*=/gim) ?? []).length,
  )

  const capability = $derived(advancedCapability(app.capability))

  // Accuracy script mode is validation error outside raw run; can't survive switch to character mode.
  $effect(() => {
    if (expert.mode !== 'raw' && advancedSettings.accuracyMode === 'script') {
      advancedSettings.accuracyMode = 'targetError'
    }
  })

  const weights = $derived(outcome?.report.players[0]?.scaleFactors ?? null)
  const scaling = $derived(outcome?.report.scaling)
  /** Pawn reads one normalization; wrong label is wrong export. P10.4: load spec slots; switch saves current and loads new. */
  $effect(() => {
    useSpec(character?.spec ?? '')
  })

  const otherSpecs = $derived(
    specsWithDrafts().filter((s) => s !== activeSpec() && s.trim().length > 0),
  )

  // Mirror every edit so draft survives reload, not just screen change.
  $effect(() => {
    void [expert.mode, expert.raw, expert.header, expert.preActor, expert.postActor,
      expert.footer, expert.extraOptions, statWeights.selected.length, statWeights.normalize]
    persistDrafts()
  })

  /** Normalisation needs a primary attribute among the scaled stats (see go()). */
  const canNormalize = $derived(canNormalizeWeights(statWeights))
  const normalized = $derived(scaling?.normalized ?? canNormalize)

  const pawnString = $derived.by(() => {
    if (!weights?.length || !character) return ''
    const body = weights
      .filter((w) => Number.isFinite(w.value))
      .map((w) => `${pawnKey(w.stat)}=${w.value.toFixed(2)}`)
      .join(', ')
    const name = `${stored?.label ?? character.name} ${character.spec ?? ''}`.trim()
    return `( Pawn: v1: "${name}": Class=${character.className}, ${body} )`
  })

  function pawnKey(stat: string): string {
    const map: Record<string, string> = {
      strength: 'Strength', agility: 'Agility', intellect: 'Intellect', stamina: 'Stamina',
      crit: 'CritRating', haste: 'HasteRating', mastery: 'MasteryRating',
      versatility: 'Versatility', weapon_dps: 'Dps', spell_power: 'SpellPower',
      attack_power: 'Ap',
    }
    return map[stat] ?? stat
  }

  async function go(): Promise<void> {
    if (!character && expert.mode !== 'raw') return
    const extras = [...extraLines]
    if (tab === 'weights') {
      extras.push('calculate_scale_factors=1')
      if (statWeights.selected.length) extras.push(`scale_only=${statWeights.selected.join(',')}`)
      // Engine normalizes against PRIMARY attribute's factor; exclude every primary and zeros come back. Raw values are honest.
      // Requested by PRESENCE never =0 (upstream parses non-1 as stat name, exits 70).
      if (canNormalize) extras.push('normalize_scale_factors=1')
    }
    await startRun({
      tool: 'advanced',
      title: `${stored?.label ?? 'Script'} — ${tab === 'weights' ? 'Stat weights' : 'Advanced'}`,
      request: {
        schemaVersion: 1,
        // Guided mode: slots go to engine, scope rules in layer that knows option table.
        profile: expert.mode === 'raw' ? expert.raw : baseProfile,
        slots: expert.mode === 'raw' ? undefined : {
          header: expert.header || undefined,
          preActor: expert.preActor || undefined,
          postActor: expert.postActor || undefined,
          footer: expert.footer || undefined,
        },
        settings: {
          fightStyle: advancedSettings.fightStyle,
          maxTime: advancedSettings.maxTime,
          targets: advancedSettings.targets,
          threads: Math.min(advancedSettings.threads, maxThreads()),
        },
        mode: expert.mode === 'raw' ? 'raw' : 'guided',
        accuracy: advancedSettings.accuracy(),
        extraProfileLines: [...(advancedSettings.extraProfileLines() ?? []), ...(route.enabled && !routeIssues.length ? parsedRoute.profileLines : [])],
        extraOptions: extras.length ? extras : undefined,
      },
    })
  }

  function loadBaseline(): void {
    expert.raw = baseProfile
    toast('info', 'Loaded your character as a starting script.')
  }

  // Cmd/Ctrl+Enter runs when button is enabled.
  $effect(() =>
    registerShortcuts({
      run: () => {
        if (busy || !effectiveScript.trim() || !!protectedHits.length) return false
        void go()
      },
    }),
  )
</script>

<div class="stack">
  <section class="panel stack">
    <header>
      <div class="stack-sm">
        <h1>Advanced</h1>
        <p class="muted small" title="Frostsim keeps thread count, report destination and network behaviour to itself; everything else in the script is yours.">
          {stored?.label ?? 'No character'}
          · {tab === 'weights' ? 'stat weights' : tab === 'expert' ? 'Expert Mode' : 'raw script'}
          · {advancedSettings.fightStyle} · {advancedSettings.targets}T · {advancedSettings.maxTime}s
        </p>
      </div>
      <button class="primary" onclick={go} disabled={busy || !effectiveScript.trim() || !!protectedHits.length}>
        {busy ? 'Running…' : tab === 'weights' ? 'Calculate weights' : 'Run script'}
      </button>
    </header>

    <div class="segmented" role="tablist" aria-label="Advanced tools">
      {#each [['script', 'Raw script'], ['expert', 'Expert Mode'], ['weights', 'Stat weights']] as [id, label] (id)}
        <label>
          <input type="radio" name="advanced-tab" value={id} bind:group={tab} />
          {label}
        </label>
      {/each}
    </div>

    {#if tab === 'script'}
      <div class="stack-sm">
        <div class="row">
          <div class="segmented" role="radiogroup" aria-label="Script source">
            <label>
              <input type="radio" bind:group={expert.mode} value="character" />
              Build from character
            </label>
            <label>
              <input type="radio" bind:group={expert.mode} value="raw" />
              Raw script only
            </label>
          </div>
          {#if expert.mode === 'raw' && character}
            <button class="sm" onclick={loadBaseline}>Load my character</button>
          {/if}
        </div>

        <!-- P10.4: which spec these slots belong to, stated not assumed. -->
        <p class="xs muted">
          {#if activeSpec()}
            These slots are saved for <strong>{titleCase(activeSpec())}</strong> and are not shared
            with this character's other specs.
          {:else}
            This character has no specialization in its export, so these slots are kept in a
            general bucket rather than against a spec.
          {/if}
          {#if otherSpecs.length}
            Copy from:
            {#each otherSpecs as other, i (other)}
              <button
                class="link xs"
                onclick={() => { if (!copyFromSpec(other)) toast('bad', `${titleCase(other)} has no saved slots.`) }}
              >{titleCase(other)}</button>{i < otherSpecs.length - 1 ? ',' : ''}
            {/each}
          {/if}
        </p>

        {#if expert.mode === 'raw'}
          <ScriptEditor
            bind:value={expert.raw}
            label="SimulationCraft input"
            rows={18}
            hint="Everything you type is passed to the engine as-is. The engine's own parser decides what is valid. Ctrl-F or Cmd-F searches this script; Tab indents, and Escape then Tab moves on."
          />
        {:else if character}
          <p class="small muted">
            Your character forms the script; Expert Mode adds text around it. Switch to the Expert
            Mode tab to see and edit the injection slots.
          </p>
        {:else}
          <Banner kind="info" title="No character imported">
            <p><a href={href('character')}>Import one</a>, or switch to raw script.</p>
          </Banner>
        {/if}
      </div>
    {:else if tab === 'expert'}
      <div class="stack-sm">
        <!-- POSITION IS SCOPE. Same line means different things in different slots; measured: gear after enemy= equips dummy. -->
        <p class="small muted">
          Four slots. <strong>Where a line goes decides who it applies to</strong>, not just the
          order it is read in &mdash; SimulationCraft gives each option to the most recently
          declared actor.
        </p>
        <ul class="xs muted">
          <li>
            <strong>Header</strong> runs before any actor exists, so only whole-simulation options
            belong here. A line meant for your character is claimed by nobody and silently ignored.
          </li>
          <li>
            <strong>Before the actor</strong> is still whole-simulation scope.
          </li>
          <li>
            <strong>After the actor</strong> is the only slot where gear, talents and anything else
            about your character actually applies to your character.
          </li>
          <li>
            <strong>Footer</strong> comes after everything, including any enemy the fight style
            declares &mdash; so a line about your character placed here can land on the enemy
            instead.
          </li>
        </ul>
        <CodeArea bind:value={expert.header} label="Header — before everything" rows={3} />
        <CodeArea bind:value={expert.preActor} label="Before the actor" rows={3} />
        <p class="chip">your character's lines</p>
        <CodeArea bind:value={expert.postActor} label="After the actor" rows={3} />
        <CodeArea bind:value={expert.footer} label="Footer — after everything" rows={3} />

        {#if slotIssues.length}
          <!--
            Reported, never corrected. Relocating a line to where we guessed it
            was meant would be a second silent behaviour on top of the engine's,
            and the user is the only one who knows what they intended.
          -->
          <Banner kind="warn" title="Some lines are in a slot where they will not do what you expect">
            <ul>
              {#each slotIssues as issue, i (i)}
                <li><strong>{issue.slot}, line {issue.line}:</strong> {issue.message}</li>
              {/each}
            </ul>
            <p class="xs">
              These still run. They simply apply to nothing, or to the enemy instead of you, and
              the result will look like an ordinary number rather than an error.
            </p>
          </Banner>
        {/if}

        <!-- P10.3: complete effective script; read-only in real editor so diagnostics apply to actual run. -->
        <details class="disclosure">
          <summary>
            {run.outcome ? 'The script the engine actually ran' : 'A preview of the script'}
          </summary>
          <div class="stack-sm">
            {#if run.outcome}
              <!-- Engine's final text from MEMFS, not reconstruction. Protected options appear commented, not silent. -->
              <p class="xs muted">
                Exactly what was sent to SimulationCraft on the last run, including any options
                Frostsim neutralised. This is the engine's own copy, not Frostsim's description
                of it.
              </p>
              <ScriptEditor
                value={run.outcome.effectiveProfile}
                label="Script as run"
                rows={14}
                readonly
              />
            {:else}
              <p class="xs muted">
                Frostsim's preview of what it will send. The engine assembles the final script
                itself, so the exact text appears here after a run &mdash; if the two ever differ,
                trust the one below after running.
              </p>
              <ScriptEditor
                value={effectiveScript}
                label="Preview"
                rows={14}
                readonly
              />
            {/if}
          </div>
        </details>
      </div>
    {:else}
      <div class="stack-sm">
        <p class="small muted">
          Stat weights say how much one point of each stat is worth <em>for your current gear and
          talents</em>. They are a local approximation: they stop being accurate as soon as the
          gear changes enough. For an actual item choice, Compare or Top Gear answers the question
          directly.
        </p>
        <fieldset class="stack-sm">
          <legend class="small">Stats to scale</legend>
          <div class="checks">
            {#each STAT_CHOICES as stat (stat.id)}
              <label class="check">
                <input
                  type="checkbox"
                  checked={statWeights.selected.includes(stat.id)}
                  onchange={(e) => {
                    if (e.currentTarget.checked) statWeights.selected.push(stat.id)
                    else statWeights.selected = statWeights.selected.filter((s) => s !== stat.id)
                  }}
                />
                {stat.label}
              </label>
            {/each}
          </div>
          <p class="xs muted">
            Each selected stat costs a full extra simulation pass. Selecting none scales every stat
            the engine considers relevant, which is the slowest option.
          </p>
        </fieldset>
        <label class="check">
          <input type="checkbox" bind:checked={statWeights.normalize} />
          Normalise against the primary stat
        </label>
        {#if statWeights.normalize && !canNormalize}
          <p class="xs warn-text">
            Needs Strength, Agility or Intellect among the scaled stats; without one the engine
            has nothing to normalise against, so this run will report raw values instead.
          </p>
        {/if}
      </div>
    {/if}

    <!-- P10.9: explicit verified input from pinned checkout. No dungeon mappings here; user supplies, we verify. -->
    <details class="disclosure">
      <summary>
        Dungeon route
        {#if route.enabled}<span class="chip accent">on</span>{/if}
      </summary>
      <div class="stack-sm">
        <label class="check">
          <input type="checkbox" bind:checked={route.enabled} />
          Simulate a dungeon route instead of a single fight
        </label>
        <p class="xs muted">
          This changes the fight style for the whole run. Frostsim has no dungeon data &mdash;
          SimulationCraft ships none, and inventing enemy health would be making up numbers. Paste
          a route from a tool that has it, or write the pulls yourself.
        </p>

        {#if route.enabled}
          <div class="row-tight wrap">
            <label class="xs">
              Keystone level
              <input type="number" min="0" max="40" bind:value={route.keystoneLevel} />
            </label>
            <label class="xs">
              Your share of pull health (%)
              <input type="number" min="0" max="100" bind:value={route.keystonePctHp} />
            </label>
            <label class="xs">
              Extra simplified damage-dealers
              <input type="number" min="0" max="3" bind:value={route.simpleDpsMembers} />
            </label>
            <label class="check xs">
              <input type="checkbox" bind:checked={route.smartTargeting} />
              Retarget to the largest enemy first
            </label>
          </div>

          <ScriptEditor
            bind:value={route.text}
            label="SimulationCraft route export or pull events"
            rows={8}
            hint={'One pull per line: raid_events+=/pull,enemies=NAME:HEALTH|NAME2:HEALTH2,delay=5,bloodlust=0 — a name starting BOSS_ marks the boss, and NAME:HEALTH:RACE:COUNT repeats an enemy.'}
          />

          {#if routeIssues.length}
            <Banner kind="bad" title="This route will not run">
              <ul>
                {#each routeIssues as issue, i (i)}
                  <li>
                    {#if issue.line}<strong>Line {issue.line}:</strong>{/if}
                    {issue.message}
                  </li>
                {/each}
              </ul>
            </Banner>
          {:else if parsedRoute.pulls}
            <p class="xs muted">
              {fmtInt(parsedRoute.pulls)} pull{parsedRoute.pulls === 1 ? '' : 's'},
              {fmtInt(parsedRoute.enemies)} enem{parsedRoute.enemies === 1 ? 'y' : 'ies'}
              {#if parsedRoute.bosses}, {parsedRoute.bosses} marked as a boss{/if}.
              Pull order and enemy health are preserved; identifiers are normalized for the engine.
            </p>
          {:else}
            <p class="xs muted">No pulls yet, so the run would use the normal fight style.</p>
          {/if}
        {/if}
      </div>
    </details>

    <details class="disclosure">
      <summary>Extra engine options</summary>
      <div class="stack-sm">
        <CodeArea
          bind:value={expert.extraOptions}
          label="One option per line"
          rows={4}
          hint="Applied after the script, so they win. Lines starting with # are ignored."
        />
        {#if protectedHits.length}
          <Banner kind="bad" title="These options are application-owned" live>
            <ul>{#each protectedHits as l, i (i)}<li class="mono xs">{l}</li>{/each}</ul>
            <p>
              Thread count, report destination and network access decide whether a run is safe and
              measurable, so they are not settable here. Remove those lines to run.
            </p>
          </Banner>
        {/if}
      </div>
    </details>

    <SettingsForm
      settings={advancedSettings}
      character={character}
      rawScript={expert.mode === 'raw'}
    />

    <details class="disclosure">
      <summary>Effective script ({effectiveScript.split('\n').length} lines, {actorCount} actor{actorCount === 1 ? '' : 's'})</summary>
      <pre class="log">{effectiveScript}</pre>
    </details>

    {#if capability.reasons.length}
      <Banner kind="warn" title="What this engine build can do">
        <ul>{#each capability.reasons as r, i (i)}<li>{r}</li>{/each}</ul>
        <p>
          Your script is kept exactly as written either way. Frostsim does not rewrite one to fit a
          narrower engine.
        </p>
      </Banner>
    {/if}

    {#if actorCount > 1}
      <Banner kind="warn" title="{actorCount} actors in this script">
        <p>
          Every actor is simulated. Run time scales with the number of them, and the result header
          shows the first player only — the full report has the rest.
        </p>
      </Banner>
    {/if}
  </section>

  <RunPanel />

  {#if outcome}
    {#if outcome.report.players.length === 1}<div class="row"><ShareReport {outcome} /></div>{/if}
    <ResultHeader
      outcome={outcome}
      characterLabel={stored?.label ?? outcome.report.players[0]?.name ?? 'Script'}
      onrerun={go}
    />

    {#if outcome.report.players.length > 1}
      <section class="panel panel-flush">
        <div class="tbl-scroll">
          <table class="tbl">
            <caption class="sr-only">Every actor in this script</caption>
            <thead>
              <tr><th>Actor</th><th>Spec</th><th class="n">DPS</th><th class="n">Uncertainty</th></tr>
            </thead>
            <tbody>
              {#each outcome.report.players as p (p.name)}
                <tr>
                  <th scope="row">{p.name}</th>
                  <td>{p.specialization}</td>
                  <td class="n">{fmtInt(p.dps.mean)}</td>
                  <td class="n">
                    {p.dpsConfidence ? `±${fmtInt(p.dpsConfidence.margin)}` : '—'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    {#if tab === 'weights'}
      <section class="panel stack-sm">
        <div class="spread">
          <h2 class="small">Stat weights</h2>
          {#if weights?.length}
            <span class="xs muted">{normalized ? 'normalised to the scaling metric' : 'raw, as the engine reported them'}</span>
          {/if}
        </div>
        {#if weights?.length}
          {@const top = Math.max(...weights.map((w) => Math.abs(w.value)), 1e-9)}
          <!--
            One bar per stat, longest first: the ranking is the point, the
            number is the receipt. The engine gives no uncertainty on a scale
            factor, so no error bar is drawn — that is not an omission.
          -->
          <div class="weights" role="table" aria-label="Stat weights">
            {#each [...weights].sort((a, b) => b.value - a.value) as w, i (w.stat)}
              <div class="w" role="row" in:fly|global={{ y: 4, duration: ms('reveal'), delay: stagger(i, 30) }}>
                <span class="w-name" role="cell">{STAT_CHOICES.find((s) => s.id === w.stat)?.label ?? w.stat}</span>
                <span class="w-track" role="cell" aria-hidden="true">
                  <span class="w-bar" class:neg={w.value < 0} style:width="{(Math.abs(w.value) / top) * 100}%"></span>
                </span>
                <span class="w-val num" role="cell">{w.value.toFixed(2)}</span>
              </div>
            {/each}
          </div>
          <div class="row-tight pawn">
            <input type="text" readonly value={pawnString} aria-label="Pawn string" class="grow mono xs" />
            <button
              class="sm"
              title="Paste into the Pawn addon. A weight from a short run moves between runs; raise accuracy before trusting a close call."
              onclick={async () => {
                await navigator.clipboard.writeText(pawnString)
                toast('good', 'Pawn string copied.')
              }}
            >Copy Pawn string</button>
          </div>
        {:else}
          <Banner kind="warn" title="No stat weights in this report">
            <p>
              The run finished but the engine reported no scale factors. That happens when
              scaling was not requested, or when every selected stat scaled to nothing for this
              profile. Download the raw report to check.
            </p>
          </Banner>
        {/if}
        {#if scaling}
          <p class="xs faint">
            Scaling metric {scaling.scaleOver ?? 'dps'}; delta multiplier
            {scaling.deltaMultiplier ?? 1}.
            {#if scaling.scaleOnly?.length}Limited to {scaling.scaleOnly.join(', ')}.{/if}
          </p>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  fieldset { margin: 0; padding: 0; border: 0; }
  legend { padding: 0; font-weight: 600; margin-bottom: var(--s2); }
  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(9rem, 100%), 1fr));
    gap: 0.3rem var(--s3);
  }
  .check { display: flex; align-items: center; gap: var(--s2); font-size: var(--fs-sm); }
  .check input { width: auto; }
  .warn-text { color: var(--warn); }
  .weights { display: grid; gap: 0.35rem; }
  .w {
    display: grid;
    grid-template-columns: minmax(7rem, 11rem) 1fr 4.5rem;
    gap: var(--s3);
    align-items: center;
    font-size: var(--fs-sm);
  }
  .w-track { height: 0.6rem; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
  .w-bar {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--accent-hi));
    transition: width var(--t-panel) var(--ease);
  }
  .w-bar.neg { background: var(--bad); }
  .w-val { text-align: right; font-weight: 600; }
  .pawn input { min-width: 0; }
  @media (max-width: 40rem) {
    .w { grid-template-columns: 1fr 4.5rem; }
    .w-track { grid-column: 1 / -1; }
  }
</style>
