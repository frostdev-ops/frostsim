<script lang="ts">
  // P07: named equipment and talent variants against one locked baseline.
  import {
    buildCandidate, canFill, nextCandidateId, rankCandidates,
    type Candidate, type RankedCandidate,
  } from '../lib/candidates'
  import { GEAR_SLOTS, SLOT_LABELS, type GearSlot, type ItemInstance } from '../lib/import/character'
  import { buildProfile, overrideLines } from '../lib/import/serialize'
  import {
    activeCharacter, activeStored, app, constraintsFor, isBusy, maxThreads,
    profilesetsSupported, toast,
  } from '../lib/app.svelte'
  import { checkItemForSlot } from '../lib/catalog/legality'
  import { display, resolveItem } from '../lib/items'
  import { takeHandoff } from '../lib/handoff.svelte'
  import { savedTalentLoadouts } from '../lib/talents.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import { run, startRun } from '../lib/job.svelte'
  import { registerShortcuts } from '../lib/shortcuts.svelte'
  import { compareSettings } from '../lib/settings.svelte'
  import { fmtDelta, fmtDeltaPct, fmtInt, fmtPct } from '../lib/format'
  import { href, navigate } from '../lib/router.svelte'
  import Banner from '../lib/ui/Banner.svelte'
  import Dialog from '../lib/ui/Dialog.svelte'
  import ItemLine from '../lib/ui/ItemLine.svelte'
  import ItemLink from '../lib/ui/ItemLink.svelte'
  import GearStrip from '../lib/ui/GearStrip.svelte'
  import TalentPreview from '../lib/ui/TalentPreview.svelte'
  import RunPanel from '../lib/ui/RunPanel.svelte'
  import ResultHeader from '../lib/ui/ResultHeader.svelte'
  import ShareReport from '../lib/ui/ShareReport.svelte'
  import ComparisonBars, { type ComparisonRow } from '../lib/ui/ComparisonBars.svelte'
  import SettingsForm from '../lib/ui/SettingsForm.svelte'

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  const busy = $derived(isBusy())
  const outcome = $derived(run.outcome)

  let candidates = $state<Candidate[]>([])
  let picking = $state<GearSlot | null>(null)
  let draftItems = $state<string[]>([])
  let itemSearch = $state('')
  $effect(() => { picking; draftItems = []; itemSearch = '' })
  /** Setup folds behind ranking once exists; this reopens it. */
  let setupOpen = $state(false)
  let customTalents = $state('')
  let customTalentName = $state('')
  let localTalentLoadouts = $state<{ name: string; talents: string }[]>([])
  $effect(() => { localTalentLoadouts = savedTalentLoadouts(stored?.id ?? null) })
  let renamingId = $state<string | null>(null)
  let renameValue = $state('')
  /** Cancelled run still shows what completed (P07.7). */
  let lastRunCandidates = $state<Candidate[]>([])

  const runnable = $derived(candidates.filter((c) => !c.issues.length))
  const level = $derived(character?.level ?? 0)
  const derivation = $derived(character ? constraintsFor(character) : null)

  /** Catalog legality for one placement, or undefined while no catalog is loaded. */
  const legality = $derived.by(() => {
    if (app.catalogState !== 'ready' || !derivation) return undefined
    return (slot: GearSlot, item: ItemInstance) => {
      const resolved = resolveItem(item, app.resolved)
      if (!resolved) {
        return { issues: [], unchecked: [`item ${item.itemId} is not in the catalog, so its equipment rules are unchecked`] }
      }
      const found = checkItemForSlot(resolved, slot, derivation.constraints)
      return {
        issues: found.filter((i) => !i.advisory).map((i) => i.message),
        unchecked: found.filter((i) => i.advisory).map((i) => i.message),
      }
    }
  })
  const equippedBySlot = $derived(
    new Map<GearSlot, ItemInstance>((character?.equipped ?? []).map((i) => [i.slot, i])),
  )
  // Eligible slots: catalog's answer (loaded) or export's recorded slot (not loaded).
  const bagBySlot = $derived.by(() => {
    const m = new Map<GearSlot, ItemInstance[]>()
    for (const item of character?.bag ?? []) {
      const resolved = resolveItem(item, app.resolved)
      const slots = resolved ? resolved.eligibleSlots : GEAR_SLOTS.filter((s) => canFill(item, s))
      for (const slot of slots) m.set(slot, [...(m.get(slot) ?? []), item])
    }
    return m
  })

  const ranked = $derived.by<RankedCandidate[]>(() => {
    if (!outcome || !lastRunCandidates.length) return []
    const baselineMean = outcome.report.players[0]?.dps.mean ?? 0
    // profilesetStatus: execution track's completed/missing (one impl of "engine dropped").
    const completed = new Set(outcome.profilesetStatus.completed)
    const results = new Map(
      outcome.report.profilesets
        .filter((p) => completed.has(p.name))
        .map((p) => [
          p.name,
          { mean: p.mean, meanError: p.meanError, iterations: p.iterations },
        ]),
    )
    return rankCandidates(lastRunCandidates, results, {
      mean: baselineMean,
      margin: outcome.report.players[0]?.dpsConfidence?.margin,
    })
  })

  const bars = $derived<ComparisonRow[]>(
    ranked.map((r) => ({
      id: r.candidate.id,
      label: r.candidate.label,
      mean: r.mean,
      margin: r.margin,
      iterations: r.iterations,
      indistinguishable: r.indistinguishable,
      status: r.status === 'blocked' ? 'not run: ' + r.candidate.issues[0] : 'no result',
      detail: r.candidate.changes
        .map((ch) => (ch.talents ? `talents “${ch.talents.name}”` : ch.slot ? SLOT_LABELS[ch.slot] : ''))
        .filter(Boolean)
        .join(', '),
      // Exact instances variant equipped (row shows the swap).
      icons: r.candidate.changes.map((ch) => ch.to).filter((i): i is ItemInstance => !!i),
      changedSlots: r.candidate.changes.map((ch) => ch.slot).filter((s): s is GearSlot => !!s),
    })),
  )

  const missing = $derived(
    outcome
      ? outcome.profilesetStatus.missing.filter((id) =>
          lastRunCandidates.some((c) => c.id === id),
        ).length
      : 0,
  )

  function addLoadout(name: string): void {
    const loadout = character?.loadouts.find((l) => l.name === name)
    if (!character || !loadout) return
    if (candidates.some((c) => c.changes[0]?.talents?.name === name)) {
      toast('info', `“${name}” is already in the list.`)
      return
    }
    candidates.push(
      buildCandidate(
        character,
        { label: loadout.name, talents: { name: loadout.name, value: loadout.talents } },
        nextCandidateId(candidates),
        legality,
      ),
    )
  }

  function addCustomTalents(): void {
    if (!character || !customTalents.trim()) return
    const name = customTalentName.trim() || `Custom talents ${candidates.length + 1}`
    candidates.push(
      buildCandidate(
        character,
        { label: name, talents: { name, value: customTalents.trim() } },
        nextCandidateId(candidates),
        legality,
      ),
    )
    customTalents = ''
    customTalentName = ''
  }

  function addItem(slot: GearSlot, item: ItemInstance, from?: string): void {
    if (!character || candidates.some((c) => c.changes.some((change) => change.slot === slot && change.to?.instanceId === item.instanceId))) return
    const name = resolveItem(item, app.resolved)?.name ?? item.addonName ?? `Item ${item.itemId}`
    const label = from
      ? `${name} in ${SLOT_LABELS[slot]} (${from})`
      : `${name} in ${SLOT_LABELS[slot]}`
    candidates.push(
      buildCandidate(
        character, { label, items: { [slot]: item } }, nextCandidateId(candidates), legality,
      ),
    )
  }

  /**
   * P09.10 receiving half. An item sent from the Droptimizer becomes a named
   * candidate carrying the EXACT instance the Droptimizer evaluated — `addItem`
   * stores the object, it does not rebuild one from an item id — and the label
   * names where it came from so the comparison is readable a day later.
   */
  let received = $state<string[]>([])
  $effect(() => {
    // A draft's handoffs carry a null id, like the draft itself.
    if (!character) return
    const items = takeHandoff('compare', stored?.id ?? null)
    if (!items.length) return
    for (const h of items) {
      addItem(h.slot, h.item, h.source)
      received.push(`${display(h.item, app.resolved).name} from ${h.source}`)
    }
  })

  function duplicate(c: Candidate): void {
    candidates.push({ ...c, id: nextCandidateId(candidates), label: `${c.label} (copy)` })
  }

  async function go(): Promise<void> {
    if (!character || !runnable.length) return
    const snapshot = runnable.map((c) => ({ ...c }))
    lastRunCandidates = snapshot
    await startRun({
      tool: 'compare',
      title: `${stored?.label ?? character.name} — Compare (${snapshot.length})`,
      request: {
        schemaVersion: 1,
        profile: buildProfile(character),
        settings: {
          fightStyle: compareSettings.fightStyle,
          maxTime: compareSettings.maxTime,
          targets: compareSettings.targets,
          threads: Math.min(compareSettings.threads, maxThreads()),
        },
        accuracy: compareSettings.accuracy(),
        extraProfileLines: compareSettings.extraProfileLines(),
        profilesets: snapshot.map((c) => ({ id: c.id, lines: overrideLines(c.overrides) })),
      },
      summarize: (report) => ({
        candidateCount: snapshot.length,
        topCandidates: report.profilesets
          .slice()
          .sort((a, b) => b.mean - a.mean)
          .slice(0, 5)
          .map((p) => ({
            id: p.name,
            label: snapshot.find((c) => c.id === p.name)?.label ?? p.name,
            mean: p.mean,
            delta: p.mean - (report.players[0]?.dps.mean ?? 0),
          })),
      }),
    })
  }

  function exportCandidate(r: RankedCandidate): void {
    if (!character) return
    const text = buildProfile(character, r.candidate.overrides)
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${r.candidate.label.replace(/[^\w-]+/g, '-').toLowerCase()}.simc`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Cmd/Ctrl+Enter runs when button would be enabled.
  $effect(() =>
    registerShortcuts({
      run: () => {
        if (busy || !runnable.length || !profilesetsSupported()) return false
        void go()
      },
    }),
  )
</script>

{#if !character}
  <section class="empty stack">
    <h1>No character yet</h1>
    <p class="muted">Compare needs an imported character to use as the baseline.</p>
    <p><a href={href('character')}>Import one</a>.</p>
  </section>
{:else}
  <div class="stack">
    <CatalogStatus />

    <section class="panel stack" hidden={busy}>
      <header>
        <div class="stack-sm">
          <h1>Compare</h1>
          <p class="muted small">
            {stored?.label ?? character.name}
            · {candidates.length} variant{candidates.length === 1 ? '' : 's'}

          </p>
        </div>
        <div class="row-tight">
          {#if outcome && ranked.length && !busy}
            <button class="ghost sm" onclick={() => (setupOpen = !setupOpen)}>
              {setupOpen ? 'Hide setup' : 'Setup'}
            </button>
          {/if}
          <button class="primary" onclick={go} disabled={busy || !runnable.length || !profilesetsSupported()}>
            {busy ? 'Running…' : `Run ${runnable.length} variant${runnable.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </header>

      {#if !profilesetsSupported() && app.capabilityChecked}
        <Banner kind="warn" title="This engine build cannot run variants in one pass">
          <p>
            The single-threaded fallback compiles out the engine's variant support, so Compare
            needs the threaded build. Quick Sim still works.
          </p>
        </Banner>
      {/if}

      {#if !outcome || !ranked.length || setupOpen}
      <div class="cols">
        <div class="stack-sm">
          <h2 class="small">
            Baseline <span class="chip">locked</span>

          </h2>
          <!-- Equipped as icons (not stats rows): screen is about what changes, baseline doesn't. -->
          <GearStrip
            items={character.equipped}
            size={44}
            onselect={(slot) => { if ((bagBySlot.get(slot) ?? []).length) picking = slot }}
            badges={Object.fromEntries(
              GEAR_SLOTS.filter((s) => (bagBySlot.get(s) ?? []).length)
                .map((s) => [s, String((bagBySlot.get(s) ?? []).length)]),
            )}
          />
          {#if character.loadouts.length}
            <p class="xs muted">Talents: {character.loadouts.find((l) => l.talents === character.talents)?.name ?? 'as imported'}</p>
          {/if}
        </div>

        <div class="stack">
          <div class="stack-sm">
            <h2 class="small">Add a variant</h2>
            {#if character.loadouts.length}
              <div class="row">
                {#each character.loadouts as l (l.name)}
                  <button class="sm" onclick={() => addLoadout(l.name)}>+ {l.name}</button>
                {/each}
              </div>
            {/if}
            {#if localTalentLoadouts.length}
              <p class="xs muted">Saved in the talent editor</p>
              <div class="row">
                {#each localTalentLoadouts as loadout (loadout.name)}
                  <button class="sm" onclick={() => { customTalentName = loadout.name; customTalents = loadout.talents; addCustomTalents() }}>+ {loadout.name}</button>
                {/each}
              </div>
            {/if}
            <details class="disclosure">
              <summary>Custom talent string</summary>
              <div class="stack-sm">
                <label class="field">
                  <span>Name</span>
                  <input type="text" bind:value={customTalentName} placeholder="My build" />
                </label>
                <label class="field">
                  <span>Talent string</span>
                  <textarea rows="2" bind:value={customTalents} spellcheck="false"></textarea>
                  <span class="hint">
                    Pasted from the game or a guide. The engine validates it; a string for another
                    spec will be reported as an engine error, not silently ignored.
                  </span>
                </label>
                <div>
                  <button class="sm" onclick={addCustomTalents} disabled={!customTalents.trim()}>
                    Add
                  </button>
                </div>
              </div>
            </details>

          </div>

          <div class="stack-sm">
            <h2 class="small">
              Variants
              <span class="chip">{candidates.length}</span>
            </h2>
            {#if !candidates.length}
              <p class="small muted">Nothing to compare yet.</p>
            {:else}
              <ul class="plain stack-sm">
                {#each candidates as c (c.id)}
                  <li class="cand" class:blocked={c.issues.length}>
                    {#if c.changes.some((ch) => ch.to)}
                      <GearStrip
                        items={c.changes.map((ch) => ch.to).filter((i): i is ItemInstance => !!i)}
                        size={36}
                        inline
                        still
                      />
                    {/if}
                    <div class="grow stack-sm min">
                      <span class="row-tight">
                        <strong class="truncate">{c.label}</strong>

                      </span>
                      <span class="xs muted">
                        {#each c.changes as ch, i (i)}
                          {#if ch.talents}talents “{ch.talents.name}”{/if}
                          {#if ch.slot}
                            {SLOT_LABELS[ch.slot]}:
                            {#if ch.from}{@const shown = display(ch.from, app.resolved)}<ItemLink itemId={ch.from.itemId} name={shown.name} resolved={shown.resolved} />{:else}empty{/if} →
                            {#if ch.to}{@const shown = display(ch.to, app.resolved)}<ItemLink itemId={ch.to.itemId} name={shown.name} resolved={shown.resolved} />{:else}empty{/if}
                          {/if}
                        {/each}
                      </span>
                      {#each c.issues as issue, i (i)}
                        <span class="xs err-text">{issue}</span>
                      {/each}
                    </div>
                    {#each c.changes.filter(ch => ch.talents) as ch, index (index)}<TalentPreview {character} talents={ch.talents!.value} />{/each}
                    <div class="row-tight">
                      <button
                        class="ghost sm"
                        onclick={() => { renamingId = c.id; renameValue = c.label }}
                        aria-label="Rename {c.label}"
                      >Rename</button>
                      <button class="ghost sm" onclick={() => duplicate(c)} aria-label="Duplicate {c.label}">
                        Duplicate
                      </button>
                      <button
                        class="ghost sm"
                        onclick={() => (candidates = candidates.filter((x) => x.id !== c.id))}
                        aria-label="Remove {c.label}"
                      >Remove</button>
                    </div>
                  </li>
                {/each}
              </ul>
              {#if candidates.some((c) => c.unchecked.length)}
                <details class="disclosure">
                  <summary>What is not checked before running</summary>
                  <ul class="xs muted">
                    {#each [...new Set(candidates.flatMap((c) => c.unchecked))] as u, i (i)}
                      <li>{u}</li>
                    {/each}
                  </ul>
                </details>
              {/if}
            {/if}
          </div>
        </div>
      </div>

      <details class="disclosure">
        <summary>Run settings</summary>
        <SettingsForm settings={compareSettings} perCandidate />
      </details>
      {/if}
    </section>

    <RunPanel />

    {#if outcome && ranked.length}
      <div class="row"><ShareReport {outcome} transform={s => ({ ...s, meta: { ...s.meta, comparisons: s.meta.comparisons?.map(r => [lastRunCandidates.find(c => c.id === r[0])?.label ?? r[0], r[1], r[2], r[3]]), candidates: s.meta.candidates?.map(r => [lastRunCandidates.find(c => c.id === r[0])?.label ?? r[0], r[1], r[2], r[3]]) } })} /></div>
      <!-- Compact: ranking is answer; baseline is reference only. -->
      <ResultHeader
        outcome={outcome}
        characterLabel={stored?.label ?? character.name}
        characterId={stored?.id}
        region={character.region}
        realm={character.server}
        onrerun={go}
        compact
      />

      {#if missing}
        <Banner kind="warn" title="{missing} variant{missing === 1 ? '' : 's'} returned no result">
          <p>
            The engine drops a variant that produced no damage — usually an invalid talent string
            or an item it could not equip. Those rows are marked below; this table is not a
            complete comparison.
          </p>
        </Banner>
      {/if}

      <section class="panel stack-sm">
        <h2 class="small">Ranked against your current setup <span class="chip">{ranked.length}</span></h2>
        <ComparisonBars
          rows={bars}
          baseline={{
            label: 'Current setup',
            mean: outcome.report.players[0]?.dps.mean ?? 0,
            margin: outcome.report.players[0]?.dpsConfidence?.margin,
          }}
          baselineGear={character.equipped}
          caption="Variants ranked against the baseline"
          onselect={(row) => {
            const r = ranked.find((x) => x.candidate.id === row.id)
            if (r) exportCandidate(r)
          }}
        />
        <details class="disclosure">
          <summary>How to read this</summary>
          <p class="xs muted">
            Every variant ran against the same baseline in one engine pass with the same seeds,
            so small differences are more trustworthy than two separate runs. A tie has a
            difference inside the combined error bars: not equal, just not yet separated. Raise
            accuracy to separate them. Click a row to export that variant as a profile.
          </p>
        </details>
      </section>
    {/if}
  </div>
{/if}

<Dialog
  open={!!picking}
  title={picking ? `Alternatives for ${SLOT_LABELS[picking]}` : ''}
  onclose={() => (picking = null)}
>
  {#if picking && character}
    <!-- Slot captured HERE (not in handler): addItem clears picking; would get null on 2nd selection. -->
    {@const pickingSlot = picking}
    <div class="stack-sm">
      <input type="search" placeholder="Search items…" aria-label="Search alternatives" bind:value={itemSearch} />
      {#each (bagBySlot.get(pickingSlot) ?? []).filter((item) => (item.addonName ?? String(item.itemId)).toLowerCase().includes(itemSearch.toLowerCase())) as item (item.instanceId)}
        <ItemLine
          slot={pickingSlot}
          {item}
          compact
          selected={draftItems.includes(item.instanceId) || candidates.some((c) => c.changes.some((change) => change.slot === pickingSlot && change.to?.instanceId === item.instanceId))}
          onclick={() => { if (candidates.some(c => c.changes.some(change => change.slot === pickingSlot && change.to?.instanceId === item.instanceId))) return; draftItems = draftItems.includes(item.instanceId) ? draftItems.filter((id) => id !== item.instanceId) : [...draftItems, item.instanceId] }}
        />
      {:else}
        <p class="small muted">No bag item fits this slot.</p>
      {/each}
    </div>
  {/if}
  {#snippet footer()}
    <button onclick={() => picking = null}>Cancel</button>
    <button class="primary" disabled={!draftItems.length} onclick={() => { if (picking) for (const item of bagBySlot.get(picking) ?? []) { if (draftItems.includes(item.instanceId)) addItem(picking, item) } picking = null }}>Add {draftItems.length} variants</button>
  {/snippet}
</Dialog>

<Dialog
  open={!!renamingId}
  title="Rename variant"
  width="24rem"
  onclose={() => (renamingId = null)}
>
  <label class="field">
    <span>Label</span>
    <input type="text" bind:value={renameValue} />
    <span class="hint">
      Labels are for you. The engine identifies each variant by its short id, so two variants can
      share a name without colliding.
    </span>
  </label>
  {#snippet footer()}
    <button onclick={() => (renamingId = null)}>Cancel</button>
    <button
      class="primary"
      onclick={() => {
        const c = candidates.find((x) => x.id === renamingId)
        if (c && renameValue.trim()) c.label = renameValue.trim()
        renamingId = null
      }}
    >Save</button>
  {/snippet}
</Dialog>

<style>
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    gap: var(--s5);
  }
  @media (max-width: 62rem) { .cols { grid-template-columns: minmax(0, 1fr); } }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  .cand {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s2) var(--s3);
    border: 1px solid var(--border);
    border-radius: var(--r2);
  }
  .cand.blocked { border-color: var(--bad); background: var(--bad-soft); }
  .min { min-width: 0; gap: 0.1rem; }
  .err-text { color: var(--bad); }
</style>
