<script lang="ts">
  import type { ImportedCharacter } from '../import/character'
  import { classId } from '../import/constraints'
  import { app, ensureCatalog } from '../app.svelte'
  import { withTalentLayout } from '../catalog/talent-layout'
  import { modelForLoadout, decodeLoadout, TalentModel } from '../talents.svelte'
  import type { TalentSelection } from '../catalog/talents'
  import TalentTree from './TalentTree.svelte'
  let { character, talents }: { character: ImportedCharacter; talents: string } = $props()
  let model = $state<TalentModel | null>(null)
  let selection = $state<TalentSelection | null>(null)
  let error = $state(false)
  $effect(() => {
    const c = character, text = talents
    let cancelled = false
    void (async () => {
      try {
        const client = await ensureCatalog()
        const tree = await client?.talentTree(classId(c) ?? 0)
        const loaded = tree ? modelForLoadout(await withTalentLayout(tree, app.capability), text, c.level ?? 90) : null
        if (!cancelled) { model = loaded; selection = loaded ? decodeLoadout(loaded, text).selection : null; error = !loaded }
      } catch { if (!cancelled) error = true }
    })()
    return () => { cancelled = true }
  })
  const status = $derived(new Map(model && selection ? model.nodeStatus(selection).map(row => [row.nodeId, row]) : []))
  const heroId = $derived(model && selection ? model.validate(selection).activeSubTreeId : null)
  const nodes = $derived(model?.visibleNodes() ?? [])
</script>
{#if model && selection}
  <div class="preview" aria-label="Talent build preview">
    <TalentTree nodes={nodes.filter(n => n.treeIndex === 1)} statusById={status} layout={model.layout} readonly />
    <TalentTree nodes={nodes.filter(n => n.treeIndex === 3 && n.subTreeId === heroId)} statusById={status} layout={model.layout} readonly />
    <TalentTree nodes={nodes.filter(n => n.treeIndex === 2)} statusById={status} layout={model.layout} readonly />
  </div>
{:else}<div class="preview-placeholder small muted">{error ? 'Preview unavailable' : 'Loading talents…'}</div>{/if}
<style>
  .preview { --tree-height: 260px; display: grid; grid-template-columns: 2fr 1fr 2fr; gap: 12px; align-items: center; max-height: 280px; overflow: hidden; padding: 12px 4px; background: #202328; border-radius: 6px; }
  .preview :global(.rank), .preview :global(.choice-mark) { display: none; }
  .preview :global(.talent-node) { border-width: 1px; padding: 0; pointer-events: none; }
  .preview-placeholder { min-height: 160px; display: grid; place-items: center; }
</style>
