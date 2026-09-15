<script lang="ts">
  import { untrack } from 'svelte'
  import { app, activeCharacter, activeStored, ensureCatalog, toast } from '../lib/app.svelte'
  import {
    activeBudget, budget, decodeLoadout, encodeLoadout, modelForLoadout, plain,
    rememberTalentDraft, savedTalentLoadouts, saveTalentLoadout, talentDraft, TalentModel,
  } from '../lib/talents.svelte'
  import { TALENT_TREE, type TalentNodeStatus, type TalentSelection } from '../lib/catalog/talents'
  import type { TalentTree as TalentTreeData, SpecEntry } from '../lib/catalog/types'
  import { classId } from '../lib/import/constraints'
  import { href, navigate } from '../lib/router.svelte'
  import { sendSetup } from '../lib/handoff.svelte'
  import Banner from '../lib/ui/Banner.svelte'
  import CatalogStatus from '../lib/ui/CatalogStatus.svelte'
  import CodeArea from '../lib/ui/CodeArea.svelte'
  import TalentTree from '../lib/ui/TalentTree.svelte'
  import { withTalentLayout } from '../lib/catalog/talent-layout'

  const character = $derived(activeCharacter())
  const stored = $derived(activeStored())
  let localLoadouts = $state<{ name: string; talents: string }[]>([])
  $effect(() => { localLoadouts = savedTalentLoadouts(stored?.id ?? null) })
  let tree = $state<TalentTreeData | null>(null)
  let loading = $state(false)
  let loadError = $state('')
  let model = $state<TalentModel | null>(null)
  let selection = $state<TalentSelection | null>(null)
  let inspectedNodeId = $state<number | null>(null)
  let pasted = $state('')
  let specs = $state<SpecEntry[]>([])
  const importedSpec = $derived(specs.find((s) => s.token.replace(/_/g, '').toLowerCase() === `${character?.className ?? ''}${character?.spec ?? ''}`.replace(/_/g, '').toLowerCase()))
  let pasteError = $state('')
  let refusal = $state('')
  let name = $state('')
  let activeTab = $state<'class' | 'spec' | 'hero'>('spec')
  let list = $state(false)
  let search = $state('')
  let undoStack = $state<TalentSelection[]>([])
  function undoChange(): void { const previous = undoStack.pop(); if (previous) selection = previous }

  $effect(() => {
    const c = character
    const id = stored?.id ?? null
    let cancelled = false
    tree = null; model = null; selection = null; specs = []; loadError = ''; pasteError = ''
    if (!c) return
    const cid = classId(c)
    if (!cid) { loadError = 'The character’s class could not be identified.'; return }
    loading = true
    void (async () => {
      try {
        const client = await ensureCatalog()
        const [loaded, availableSpecs] = client ? await Promise.all([client.talentTree(cid), client.specs(cid)]) : [null, []]
        if (cancelled) return
        const complete = loaded ? await withTalentLayout(loaded, app.capability) : null
        if (cancelled) return
        tree = complete; specs = availableSpecs
        if (!loaded) loadError = 'The talent catalog has no tree for this class.'
        else if (complete) adopt(complete, talentDraft(id) ?? c.talents ?? '')
      } catch (err) {
        if (!cancelled) loadError = `Could not load talents: ${err instanceof Error ? err.message : String(err)}`
      } finally { if (!cancelled) loading = false }
    })()
    return () => { cancelled = true }
  })

  function adopt(loaded: TalentTreeData, loadout: string): void {
    refusal = ''; pasteError = ''; inspectedNodeId = null
    if (loadout.trim()) {
      const m = modelForLoadout(loaded, loadout, character?.level ?? 90)
      const currentSpec = importedSpec
      if (m && (!currentSpec || currentSpec.id === m.specId)) {
        model = m; selection = decodeLoadout(m, loadout).selection
        return
      }
      pasteError = 'This export is incomplete or incompatible with your character’s specialization and current talent data. Copy a fresh talent export from the game.'
      return
    }
    model = null; selection = null
  }

  function startEmpty(specId: number): void {
    if (!tree) return
    pasteError = ''; refusal = ''; inspectedNodeId = null
    model = new TalentModel(tree, specId, character?.level ?? 90)
    selection = model.initialSelection()
  }
  const status = $derived.by<Map<number, TalentNodeStatus>>(() => new Map(
    model && selection ? model.nodeStatus(plain(selection)).map((s) => [s.nodeId, s]) : [],
  ))
  const validation = $derived(model && selection ? model.validate(plain(selection), activeBudget()) : null)
  const groups = $derived.by(() => {
    const visible = model?.visibleNodes() ?? []
    return {
      class: visible.filter((n) => n.treeIndex === TALENT_TREE.CLASS),
      spec: visible.filter((n) => n.treeIndex === TALENT_TREE.SPECIALIZATION),
      hero: visible.filter((n) => n.treeIndex === TALENT_TREE.HERO && n.subTreeId === validation?.activeSubTreeId),
      selection: visible.filter((n) => n.treeIndex === TALENT_TREE.SELECTION),
    }
  })
  const visibleNodes = $derived(groups[activeTab].filter((n) => !search.trim() || n.entries.some((e) => e.name.toLowerCase().includes(search.trim().toLowerCase()))))
  const inspected = $derived(inspectedNodeId !== null ? model?.visibleNodes().find((n) => n.nodeId === inspectedNodeId) : null)
  const inspectedStatus = $derived(inspectedNodeId !== null ? status.get(inspectedNodeId) : null)
  const inspectedEntry = $derived(inspected?.entries.find((e) => e.entryId === inspectedStatus?.entryId) ?? inspected?.entries[0])
  const encoded = $derived(model && selection ? encodeLoadout(model, plain(selection)) : '')
  const canUse = $derived(!!encoded && !!validation?.legal && !pasteError && (!importedSpec || importedSpec.id === model?.specId))
  const specName = $derived(specs.find((s) => s.id === model?.specId)?.name ?? character?.spec ?? 'Specialization')
  $effect(() => {
    const value = encoded
    const id = stored?.id ?? null
    if (value) untrack(() => rememberTalentDraft(id, value))
  })
  function allocate(nodeId: number, entryId: number, delta: 1 | -1): void {
    if (!model || !selection) return
    const result = model.allocate(plain(selection), nodeId, entryId, delta)
    refusal = result.refused ?? ''
    if (!result.refused) { undoStack.push(plain(selection)); selection = result.selection; pasteError = '' }
  }
  function selectTab(tab: typeof activeTab): void { activeTab = tab; search = ''; inspectedNodeId = null }
  function loadSaved(loadout: string): void { if (tree) { pasted = loadout; adopt(tree, loadout) } }
  function reset(): void { if (tree && character) adopt(tree, character.talents ?? '') }
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(encoded); toast('good', 'Talent string copied.') }
    catch { toast('bad', 'Could not copy. Select and copy the loadout string below.') }
  }
  function save(): void {
    if (!stored || !canUse || !name.trim()) return
    const ok = saveTalentLoadout(stored.id, name.trim(), encoded)
    toast(ok ? 'good' : 'info', ok ? `Saved “${name.trim()}” on this device.` : 'Available in this tab; browser storage is unavailable.')
  }
  function quickSim(): void {
    if (!canUse) return
    sendSetup({ characterId: stored?.id ?? null, label: name.trim() || 'Edited talents', items: {}, talents: encoded })
    navigate('quick')
  }
</script>
{#if !character}
  <section class="empty stack"><h1>Talents</h1><a href={href('character')}>Import a character</a></section>
{:else}
  <div class="stack talent-page">
    <div class="spread"><div><h1>Talents</h1><span class="small muted">{character.name} · {specName}</span></div><div class="row"><button class="sm" onclick={undoChange} disabled={!undoStack.length}>Undo</button><button class="sm" onclick={reset} disabled={!tree}>Reset</button><button class="sm" onclick={copy} disabled={!encoded}>Copy build</button><button class="primary" onclick={quickSim} disabled={!canUse}>Simulate build</button></div></div>
    <div class="spread">
      <div class="row"><select aria-label="Load talent build" value="" onchange={(e) => { if(e.currentTarget.value) loadSaved(e.currentTarget.value) }}><option value="">Load a build…</option>{#each [...character.loadouts, ...localLoadouts] as loadout, i (i)}<option value={loadout.talents}>{loadout.name}</option>{/each}</select><input type="search" aria-label="Search talents" placeholder="Find a talent…" bind:value={search} /></div>
      <div class="row"><input type="text" bind:value={name} placeholder="Build name" aria-label="Build name" /><button disabled={!canUse || !name.trim()} onclick={save}>Save build</button></div>
    </div>
    {#if loading}<p class="muted">Loading talent trees…</p>{/if}
    {#if loadError || pasteError}<Banner kind="bad" title="Talents unavailable"><p>{loadError || pasteError}</p></Banner>{/if}
    {#if model && selection && validation && tree?.layout}
      <section class="panel tree-board">
        <div class="tree-column"><header><h2>Class</h2><span>{validation.spent.class} / {model.pointBudget()?.class}</span></header><TalentTree nodes={groups.class} statusById={status} layout={tree.layout} onallocate={allocate} {search} /></div>
        <div class="tree-column hero-column">
          <header><h2>Hero talents</h2><span>{validation.spent.hero} / {model.pointBudget()?.hero}</span></header>
          <select class="hero-select" aria-label="Hero talent tree" value={validation.activeSubTreeId ?? ''} onchange={(e) => {
            const target = Number(e.currentTarget.value)
            for (const node of groups.selection) { const entry = node.entries.find(e => e.subTreeId === target); if(entry) { allocate(node.nodeId, entry.entryId, 1); break } }
          }}><option value="" disabled>Choose hero tree</option>{#each model.availableSubTrees() as hero (hero.id)}<option value={hero.id}>{hero.name}</option>{/each}</select>
          {#key validation.activeSubTreeId}<TalentTree nodes={groups.hero} statusById={status} layout={tree.layout} onallocate={allocate} {search} />{/key}
        </div>
        <div class="tree-column"><header><h2>{specName}</h2><span>{validation.spent.spec} / {model.pointBudget()?.spec}</span></header><TalentTree nodes={groups.spec} statusById={status} layout={tree.layout} onallocate={allocate} {search} /></div>
      </section>
      {#if refusal}<p class="small" role="status">{refusal}</p>{/if}
      {#if !validation.legal}<details class="disclosure"><summary>{validation.issues.length} build issue{validation.issues.length === 1 ? '' : 's'}</summary><ul>{#each validation.issues as issue, i (i)}<li>{issue.message}</li>{/each}</ul></details>{/if}
    {/if}
    <details class="disclosure"><summary>Import / export talent string</summary><div class="stack-sm"><CodeArea bind:value={pasted} label="Talent string" rows={3} /><div class="row"><button onclick={() => tree && adopt(tree, pasted)} disabled={!tree || !pasted.trim()}>Import build</button><button onclick={copy} disabled={!encoded}>Copy current build</button></div></div></details>
  </div>
{/if}
<style>
  .talent-page { gap: 20px; }
  .talent-page > .spread > .row { flex-wrap: nowrap; }
  .talent-page > .spread > .row input, .talent-page > .spread > .row select { width: 220px; }
  .tree-board { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr); gap: 20px; background: #202328; padding: 24px 12px; min-height: 620px; }
  .tree-column { min-width: 0; }
  .tree-column header { text-align: center; display: grid; gap: 6px; margin-bottom: 24px; }
  .tree-column h2 { color: #e7d6af; font-size: 20px; }
  .tree-column header span { color: var(--text-muted); font-size: 13px; }
  .hero-select { width: 100%; font-size: 13px; color: #e7c774; border-color: #766040; margin-bottom: 20px; }
  .hero-column { padding-top: 48px; }
  @media(max-width: 900px) { .tree-board { min-width: 900px; } .talent-page { overflow-x: auto; } }
</style>
