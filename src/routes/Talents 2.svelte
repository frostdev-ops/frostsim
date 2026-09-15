<script lang="ts">
  // P08.5. The talent tree, its rules and its loadouts.
  //
  // Every legality decision comes from the catalog track's `TalentModel`; this
  // screen renders what it says and never second-guesses it. Two limits are
  // structural and are shown rather than hidden, because a talent editor that
  // cannot tell a user their loadout is invalid is worse than none:
  //
  //  - THERE IS NO PREREQUISITE-EDGE DATA. `trait_data_t` has row, col and
  //    req_points and no parent link, and simc ships no trait-edge table. A
  //    loadout placing an unconnected talent passes every check here and the
  //    game rejects it. No connectors are drawn, for the same reason.
  //  - THE POINT TOTAL IS NOT IN THE ENGINE DATA. It is a level- and
  //    patch-dependent game rule. The budget below is the user's own number and
  //    is off by default; with it off the engine reports totals as unchecked.
  import { activeCharacter, activeStored, app, catalogClient, ensureCatalog } from '../lib/app.svelte'
  import {
    activeBudget, budget, decodeLoadout, encodeLoadout, modelForLoadout, plain, specIdsIn,
    TalentModel,
  } from '../lib/talents.svelte'
  import { TALENT_TREE, type TalentNodeStatus, type TalentSelection } from '../lib/catalog/talents'
  import type { TalentTree as TalentTreeData } from '../lib/catalog/types'
  import { classId } from '../lib/import/constraints'
  import { href } from '../lib/router.svelte'
  import { fmtInt } from '../lib/format'
  import Banner from '../lib/ui/Banner.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import CodeArea from '../lib/ui/CodeArea.svelte'
  import TalentTree from '../lib/ui/TalentTree.svelte'

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())

  let tree = $state<TalentTreeData | null>(null)
  let loading = $state(false)
  let loadError = $state('')
  let model = $state<TalentModel | null>(null)
  let selection = $state<TalentSelection | null>(null)
  let inspectedNodeId = $state<number | null>(null)
  let pasted = $state('')
  /** Real spec names, so a character with no loadout can still be given a tree. */
  let specs = $state<{ id: number; token: string; name: string; nameFromEngine: boolean }[]>([])
  let pasteError = $state('')
  let refusal = $state('')

  // The class tree is catalog data and lives in the worker; the model is built
  // here because it is pure logic over a plain payload.
  $effect(() => {
    const c = character
    if (!c) { tree = null; model = null; selection = null; return }
    const cid = classId(c)
    if (!cid) { loadError = 'This character’s class could not be identified, so its talent tree cannot be loaded.'; return }
    loading = true
    loadError = ''
    void (async () => {
      try {
        const client = await ensureCatalog()
        const loaded = client ? await client.talentTree(cid) : null
        tree = loaded
        specs = client ? await client.specs(cid) : []
        if (!loaded) {
          loadError = 'This build’s catalog has no talent tree for this class.'
        } else {
          adopt(loaded, c.talents ?? '')
        }
      } catch (err) {
        loadError = `The talent tree could not be loaded: ${err instanceof Error ? err.message : String(err)}`
      } finally {
        loading = false
      }
    })()
  })

  /** Adopts a loadout string, or an empty tree for the spec it names. */
  function adopt(loaded: TalentTreeData, loadout: string): void {
    refusal = ''
    inspectedNodeId = null
    if (loadout.trim()) {
      const m = modelForLoadout(loaded, loadout)
      if (m) {
        const decoded = decodeLoadout(m, loadout)
        model = m
        selection = decoded.selection
        pasteError = ''
        return
      }
      pasteError =
        'That loadout string could not be read for any specialization of this class. It may be '
        + 'from another class, or from a newer talent format than this build understands.'
    }
    // With no readable loadout, nothing names a specialization — so the user
    // picks one and gets an empty tree rather than an explanation.
    model = null
    selection = null
  }

  /** Opens an empty tree for a chosen spec, with nothing allocated. */
  function startEmpty(specId: number): void {
    if (!tree) return
    pasteError = ''
    refusal = ''
    inspectedNodeId = null
    model = new TalentModel(tree, specId)
    selection = { specId, picks: [] }
  }

  const status = $derived.by<Map<number, TalentNodeStatus>>(() => {
    const out = new Map<number, TalentNodeStatus>()
    if (!model || !selection) return out
    for (const s of model.nodeStatus(plain(selection))) out.set(s.nodeId, s)
    return out
  })

  const validation = $derived(
    model && selection ? model.validate(plain(selection), activeBudget()) : null,
  )

  const groups = $derived.by(() => {
    if (!model) return { class: [], spec: [], hero: [], selection: [] }
    const active = validation?.activeSubTreeId ?? null
    return {
      class: model.nodes.filter((n) => n.treeIndex === TALENT_TREE.CLASS),
      spec: model.nodes.filter((n) => n.treeIndex === TALENT_TREE.SPECIALIZATION),
      hero: model.nodes.filter((n) => n.treeIndex === TALENT_TREE.HERO && (!active || n.subTreeId === active)),
      selection: model.nodes.filter((n) => n.treeIndex === TALENT_TREE.SELECTION),
    }
  })

  const inspected = $derived(inspectedNodeId !== null ? model?.node(inspectedNodeId) ?? null : null)
  const inspectedStatus = $derived(inspectedNodeId !== null ? status.get(inspectedNodeId) ?? null : null)

  const encoded = $derived.by(() => {
    if (!model || !selection) return ''
    try {
      return encodeLoadout(model, plain(selection))
    } catch {
      return ''
    }
  })

  function allocate(nodeId: number, entryId: number, delta: 1 | -1): void {
    if (!model || !selection) return
    const result = model.allocate(plain(selection), nodeId, entryId, delta)
    refusal = result.refused ?? ''
    if (!result.refused) selection = result.selection
  }

  function applyPasted(): void {
    if (!tree) return
    adopt(tree, pasted)
  }

  function loadSaved(loadout: string): void {
    if (!tree) return
    pasted = loadout
    adopt(tree, loadout)
  }

  function reset(): void {
    if (tree && character) adopt(tree, character.talents ?? '')
  }
</script>

{#if !character}
  <section class="empty stack">
    <h1>No character yet</h1>
    <p class="muted">Talents are read from an imported character.</p>
    <p><a href={href('character')}>Import one</a>.</p>
  </section>
{:else}
  <div class="stack">
    <CatalogStatus />

    <section class="panel stack">
      <header>
        <div class="stack-sm">
          <h1>Talents</h1>
          <p class="muted small">
            {stored?.label ?? character.name}
            {#if validation}
              · {fmtInt(validation.spent.class)} class
              · {fmtInt(validation.spent.spec)} spec
              · {fmtInt(validation.spent.hero)} hero
            {/if}
            <span
              class="chip warn"
              title="Point costs, spec ownership, hero-tree rules and rank limits are checked. Prerequisite connections are not: the engine ships no trait-edge table, so a loadout can pass here and still be rejected in game."
            >validation partial</span>
          </p>
        </div>
        <div class="row-tight">
          <button class="sm ghost" onclick={reset} disabled={!tree}>Reset to imported</button>
        </div>
      </header>

      {#if loading}
        <p class="muted small">Loading the talent tree&hellip;</p>
      {/if}
      {#if loadError}
        <Banner kind="bad" title="The talent tree is not available"><p>{loadError}</p></Banner>
      {/if}
      {#if tree && !model}
        <!--
          No readable loadout. The spec names come from the catalog's `specs`
          table rather than a hand-typed list; an empty one means the catalog
          predates that table and needs rebuilding, NOT that the class has no
          specs — so the two cases say different things.
        -->
        {#if specs.length}
          <Banner kind="info" title="Choose a specialization to start from">
            <p>
              This character's export carries no talent loadout, so there is nothing to say which
              specialization to show. Pick one and you get an empty tree to build in.
            </p>
            {#snippet actions()}
              {#each specs as spec (spec.id)}
                <button class="sm" onclick={() => startEmpty(spec.id)}>
                  {spec.name}{#if !spec.nameFromEngine}<span class="chip xs">derived name</span>{/if}
                </button>
              {/each}
            {/snippet}
          </Banner>
        {:else}
          <Banner kind="warn" title="No specialization list in this catalog">
            <p>
              This character's export carries no talent loadout, and this catalog has no
              specialization table to offer instead — it predates that data. Rebuilding the catalog
              adds it. Pasting a loadout string below also works.
            </p>
          </Banner>
        {/if}
      {/if}

      {#if pasteError}
        <Banner kind="warn" title="That loadout could not be read"><p>{pasteError}</p></Banner>
      {/if}
      {#if refusal}
        <Banner kind="warn" title="That change was refused"><p>{refusal}</p></Banner>
      {/if}

      {#if validation}
        <div class="spread wrap">
          <label class="row-tight xs">
            <input type="checkbox" bind:checked={budget.enforce} />
            Check against a point budget
          </label>
        </div>

        {#if budget.enforce}
          <div class="row-tight wrap xs">
            <label>Class <input type="number" min="0" max="99" bind:value={budget.class} /></label>
            <label>Spec <input type="number" min="0" max="99" bind:value={budget.spec} /></label>
            <label>Hero <input type="number" min="0" max="99" bind:value={budget.hero} /></label>
          </div>
          <p class="xs muted">
            These totals are yours, not the engine&rsquo;s. simc exports no table for how many
            talent points a character has, so nothing here can confirm them.
          </p>
        {/if}

        <!--
          VALIDATION HERE IS PARTIAL AND SAYS SO. simc ships no trait-edge table,
          so nothing in this build can tell whether a talent connects to the ones
          it requires. A loadout can pass every check here and be rejected by the
          game. The banner therefore never says "legal" — only that the rules
          this build CAN check are satisfied.
        -->
        {#if validation.issues.length}
          <Banner
            kind={validation.legal ? 'warn' : 'bad'}
            title={validation.legal ? 'Advisory notes' : 'This loadout breaks a rule'}
          >
            <ul>
              {#each validation.issues as issue, i (i)}
                <li>{issue.message}</li>
              {/each}
            </ul>
          </Banner>
        {/if}

        <!--
          The clean case is one line, not a paragraph. The distinction it makes
          is real and stays in the summary: checked is not legal, because the
          engine ships no trait-edge table.
        -->
        <details class="disclosure">
          <summary>
            {#if !validation.issues.length}
              <span class="chip good">checked</span>
            {/if}
            Not the same as legal — {validation.unverifiable.length} rule{validation.unverifiable.length === 1 ? '' : 's'} cannot be checked
          </summary>
          <p class="xs muted">
            Prerequisite connections between talents are not in the engine data, so a talent placed
            without the talents leading to it passes here and the game still rejects it. Confirm the
            loadout in game before trusting a result built on it.
          </p>
          <ul class="xs muted">
            {#each validation.unverifiable as note, i (i)}<li>{note}</li>{/each}
          </ul>
        </details>
      {/if}
    </section>

    {#if model && selection}
      {#if groups.selection.length}
        <section class="panel stack-sm">
          <h2 class="small">Hero tree</h2>
          <TalentTree
            nodes={groups.selection}
            statusById={status}
            onallocate={allocate}
            oninspect={(id) => (inspectedNodeId = id)}
            selectedNodeId={inspectedNodeId}
          />
        </section>
      {/if}

      <div class="trees">
        <section class="panel stack-sm">
          <h2 class="small">Class</h2>
          <TalentTree
            nodes={groups.class}
            statusById={status}
            onallocate={allocate}
            oninspect={(id) => (inspectedNodeId = id)}
            selectedNodeId={inspectedNodeId}
          />
        </section>
        <section class="panel stack-sm">
          <h2 class="small">Specialization</h2>
          <TalentTree
            nodes={groups.spec}
            statusById={status}
            onallocate={allocate}
            oninspect={(id) => (inspectedNodeId = id)}
            selectedNodeId={inspectedNodeId}
          />
        </section>
        {#if groups.hero.length}
          <section class="panel stack-sm">
            <h2 class="small">
              Hero talents
              {#if !validation?.activeSubTreeId}<span class="chip">no tree chosen</span>{/if}
            </h2>
            <TalentTree
              nodes={groups.hero}
              statusById={status}
              dimmed={!validation?.activeSubTreeId}
              onallocate={allocate}
              oninspect={(id) => (inspectedNodeId = id)}
              selectedNodeId={inspectedNodeId}
            />
          </section>
        {/if}
      </div>

      {#if inspected && inspectedStatus}
        <section class="panel stack-sm">
          <h2 class="small">{inspected.entries[0]?.name ?? `Node ${inspected.nodeId}`}</h2>
          <p class="small">
            Rank {inspectedStatus.rank} of {inspectedStatus.maxRanks}.
            {#if inspectedStatus.granted}Granted by your specialization, at no point cost.{/if}
          </p>
          {#if inspectedStatus.reason}
            <p class="small muted">{inspectedStatus.reason}</p>
          {/if}
          {#if inspected.entries.length > 1}
            <p class="xs muted">A choice of {inspected.entries.length}:</p>
            <div class="row-tight wrap">
              {#each inspected.entries as entry (entry.entryId)}
                <button
                  class="sm"
                  class:primary={inspectedStatus.entryId === entry.entryId}
                  onclick={() => allocate(inspected.nodeId, entry.entryId, 1)}
                >
                  {entry.name}
                </button>
              {/each}
            </div>
          {/if}
          {#if inspected.reqPoints}
            <p class="xs muted">Unlocks at {inspected.reqPoints} points spent in this tree.</p>
          {/if}
        </section>
      {/if}

      <section class="panel stack-sm">
        <h2 class="small">Loadout string</h2>
        <p class="xs muted">
          Click a talent to add a rank, shift-click or right-click to remove one. The string below
          is regenerated from the tree and is what a sim would run.
        </p>
        <CodeArea value={encoded} readonly rows={3} label="Current loadout string" />
      </section>
    {/if}

    <section class="panel stack-sm">
      <h2 class="small">Load a different loadout</h2>
      {#if character.loadouts?.length}
        <p class="xs muted">Saved in your addon export:</p>
        <div class="row-tight wrap">
          {#each character.loadouts as saved, i (i)}
            <button class="sm" onclick={() => loadSaved(saved.talents)}>{saved.name}</button>
          {/each}
        </div>
      {:else}
        <p class="xs muted">
          Your export carries no named loadouts. The addon writes them only for loadouts you have
          saved in game.
        </p>
      {/if}
      <CodeArea bind:value={pasted} rows={3} label="Paste a loadout string" />
      <div class="row-tight">
        <button class="sm" onclick={applyPasted} disabled={!pasted.trim() || !tree}>
          Load this string
        </button>
      </div>
    </section>
  </div>
{/if}

<style>
  .trees { display: grid; gap: var(--s4); grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 1100px) {
    .trees { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  .wrap { flex-wrap: wrap; }
</style>
