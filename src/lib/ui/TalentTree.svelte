<script lang="ts">
  import type { TalentNodeGroup, TalentNodeStatus } from '../catalog/talents'
  import type { TalentLayout } from '../catalog/types'
  import { visibleTalentEdges } from '../catalog/talent-layout'
  import { Tooltip } from 'bits-ui'
  import GameIcon from './GameIcon.svelte'
  import Dialog from './Dialog.svelte'
  interface Props {
    nodes: TalentNodeGroup[]; statusById: Map<number, TalentNodeStatus>; layout?: TalentLayout;
    readonly?: boolean; dimmed?: boolean; onallocate?: (nodeId: number, entryId: number, delta: 1 | -1) => void;
    selectedNodeId?: number | null; oninspect?: (nodeId: number) => void; list?: boolean; search?: string;
  }
  let { nodes, statusById, layout, readonly = false, dimmed = false, onallocate, selectedNodeId = null, oninspect, search = '' }: Props = $props()
  let choice = $state<TalentNodeGroup | null>(null)
  const positioned = $derived(nodes.filter(node => layout?.nodes[node.nodeId]))
  const minX = $derived(Math.min(...positioned.map(node => layout!.nodes[node.nodeId].x), 0))
  const bounds = $derived.by(() => {
    const points = positioned.map(node => layout!.nodes[node.nodeId])
    if (!points.length) return { x: 0, y: 0, width: 360, height: 600 }
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
    return { x, y, width: Math.max(240, (Math.max(...points.map(p => p.x)) - x) / 12 + 60), height: Math.max(240, (Math.max(...points.map(p => p.y)) - y) / 12 + 70) }
  })
  const point = (id: number) => ({ x: (layout!.nodes[id].x - bounds.x) / 12 + 30, y: (layout!.nodes[id].y - bounds.y) / 12 + 30 })
  const visibleIds = $derived(new Set(positioned.map(node => node.nodeId)))
  const edges = $derived(visibleTalentEdges(layout, visibleIds))
  function shown(node: TalentNodeGroup) { return node.entries.find(entry => entry.entryId === statusById.get(node.nodeId)?.entryId) ?? node.entries[0] }
  function act(node: TalentNodeGroup, event: MouseEvent) {
    oninspect?.(node.nodeId)
    if (readonly) return
    if (event.shiftKey || event.button === 2) onallocate?.(node.nodeId, shown(node).entryId, -1)
    else if (node.entries.length > 1 && node.nodeType !== 1) choice = node
    else onallocate?.(node.nodeId, shown(node).entryId, 1)
  }
</script>
<Tooltip.Provider delayDuration={180}>
  <div class="talent-canvas" class:dimmed style:--tree-ratio={bounds.width / bounds.height} style:aspect-ratio={`${bounds.width} / ${bounds.height}`} role="group" aria-label="Talent tree">
    <svg viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-hidden="true">
      {#each edges as edge (edge.from + ':' + edge.to)}
        <line x1={point(edge.from).x} y1={point(edge.from).y} x2={point(edge.to).x} y2={point(edge.to).y} class:allocated={(statusById.get(edge.from)?.rank ?? 0) > 0 && (statusById.get(edge.to)?.rank ?? 0) > 0} />
      {/each}
    </svg>
    {#each positioned as node (node.nodeId)}
      {@const entry = shown(node)}
      {@const state = statusById.get(node.nodeId)}
      {@const position = point(node.nodeId)}
      {@const art = layout!.nodes[node.nodeId]}
      {@const rank = state?.rank ?? 0}
      {@const nodeClass = `talent-node ${node.nodeType === 1 ? 'tiered' : ''} ${art.shape === 'PASSIVE' ? 'passive' : ''} ${node.entries.length > 1 ? 'choice' : ''} ${rank ? 'allocated' : ''} ${!state?.available && !rank ? 'locked' : ''} ${search && !node.entries.some(e => e.name.toLowerCase().includes(search.toLowerCase())) ? 'unmatched' : ''}`}
      {@const nodeStyle = `left:${position.x / bounds.width * 100}%;top:${position.y / bounds.height * 100}%;--node-size:${40 / bounds.width * 100}%;`}
      {#snippet face()}
        {#if node.nodeType === 1}
          {#each node.entries as tier, index (tier.entryId)}
            {@const before = node.entries.slice(0, index).reduce((sum, e) => sum + e.maxRanks, 0)}
            <span class="tier-icon" class:learned={rank > before}><GameIcon spellId={tier.spellId} label={tier.name} size={32} /><small>{Math.max(0, Math.min(tier.maxRanks, rank - before))}/{tier.maxRanks}</small></span>
          {/each}
        {:else}<GameIcon spellId={entry.spellId} label={entry.name} size={36} />{/if}
        <span class="rank">{rank}/{node.maxRanks}</span>
        {#if node.entries.length > 1 && node.nodeType !== 1}<span class="choice-mark">◆</span>{/if}
      {/snippet}
      <!-- Readonly trees are previews (nodes ignore the pointer), so a tooltip per node could never open. -->
      {#if readonly}
        <button class={nodeClass} style={nodeStyle} aria-label={`${entry.name}, rank ${rank} of ${node.maxRanks}`} aria-pressed={rank > 0} tabindex={-1}>{@render face()}</button>
      {:else}
      <Tooltip.Root>
        <Tooltip.Trigger
          class={nodeClass}
          style={nodeStyle}
          aria-label={`${entry.name}, rank ${rank} of ${node.maxRanks}`}
          aria-pressed={rank > 0}
          aria-disabled={!state?.available && !rank}
          tabindex={0}
          onclick={(event) => act(node, event)}
          oncontextmenu={(event) => { event.preventDefault(); act(node, event) }}
        >{@render face()}</Tooltip.Trigger>
        <Tooltip.Portal><Tooltip.Content class="talent-tooltip" sideOffset={12}>
          <div class="row"><GameIcon spellId={entry.spellId} label={entry.name} size={32} /><strong>{entry.name}</strong></div>
          <div class="small muted">Rank {rank}/{node.maxRanks} · {layout?.descriptions[entry.entryId]?.castTime ?? (art.shape === 'PASSIVE' ? 'Passive' : '')}</div>
          <p>{layout?.descriptions[entry.entryId]?.text ?? ''}</p>
          {#if state?.reason}<p class="reason">{state.reason}</p>{/if}
          <span class="xs muted">Click to learn · Shift-click to refund</span>
        </Tooltip.Content></Tooltip.Portal>
      </Tooltip.Root>
      {/if}
    {/each}
  </div>
</Tooltip.Provider>
<Dialog open={!!choice} title="Choose a talent" width="26rem" onclose={() => choice = null}>
  {#if choice}<div class="stack-sm">{#each choice.entries as entry (entry.entryId)}
    <button class="talent-choice" onclick={() => { if (choice) onallocate?.(choice.nodeId, entry.entryId, 1); choice = null }}><GameIcon spellId={entry.spellId} label={entry.name} size={36} /><span>{entry.name}</span></button>
  {/each}</div>{/if}
</Dialog>
<style>
  .talent-canvas { position: relative; width: 100%; max-width: calc(var(--tree-height, 620px) * var(--tree-ratio)); margin-inline: auto; isolation: isolate; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; }
  line { stroke: #565044; stroke-width: 2; transition: stroke 0.4s var(--ease); } line.allocated { stroke: #e2b75a; stroke-width: 2.5; filter: drop-shadow(0 0 4px #e8bf6399); }
  :global(.talent-node) { position: absolute; width: var(--node-size); min-height: 0; aspect-ratio: 1; transform: translate(-50%, -50%); padding: 2px; border: 2px solid #71664f; border-radius: 4px; background: #171713; transition: filter 0.25s var(--ease), box-shadow 0.35s var(--ease), border-color 0.3s var(--ease), scale 0.45s var(--spring), opacity 0.3s var(--ease); }
  :global(.talent-node .icon) { width: 100% !important; height: 100% !important; border: 0; border-radius: inherit; }
  :global(.talent-node.tiered) { width: calc(var(--node-size) * 3); aspect-ratio: 3; border-radius: 4px; gap: 4px; }
  .tier-icon { position: relative; min-width: 0; flex: 1; filter: grayscale(1); }
  .tier-icon.learned { filter: none; }
  .tier-icon small { position: absolute; bottom: -4px; right: 0; background: #171713; font-size: 9px; line-height: 12px; }
  :global(.talent-node.tiered > .rank) { display: none; }
  :global(.talent-node.passive) { border-radius: 50%; }
  :global(.talent-node.allocated) { border-color: #e8bf63; box-shadow: 0 0 0 1px #755018, 0 0 14px #e8bf6355, inset 0 0 8px #e8bf6340; animation: talent-glow 3.2s ease-in-out infinite; }
  @keyframes talent-glow { 50% { box-shadow: 0 0 0 1px #755018, 0 0 22px #e8bf6380, inset 0 0 10px #e8bf6355; } }
  :global(.talent-node:not(.allocated) .icon) { filter: grayscale(1) brightness(.65); }
  :global(.talent-node.locked) { opacity: .65; }
  :global(.talent-node:hover), :global(.talent-node:focus-visible) { border-color: #fff0b4; filter: brightness(1.25); scale: 1.12; z-index: 2; box-shadow: 0 0 0 1px #755018, 0 0 24px #fff0b466; }
  :global(.talent-node:active:not(:disabled)) { transform: translate(-50%, -50%) scale(.97); }
  :global(.talent-node.unmatched) { opacity: .2; }
  .rank { position: absolute; bottom: -9px; left: 50%; transform: translateX(-50%); background: #171713; border: 1px solid #71664f; border-radius: 3px; color: #d4c9b0; font-size: 10px; padding: 0 3px; line-height: 14px; }
  .choice-mark { position: absolute; right: -8px; top: -8px; color: #e8bf63; font-size: 10px; text-shadow: 0 1px #000; }
  :global(.talent-tooltip) { z-index: 1200; max-width: 340px; background: linear-gradient(180deg, #e8bf6314, transparent 40%), rgb(18 20 25 / 0.92); -webkit-backdrop-filter: blur(20px) saturate(1.4); backdrop-filter: blur(20px) saturate(1.4); border: 1px solid #796749; border-radius: 12px; padding: 16px; display: grid; gap: 10px; box-shadow: 0 20px 50px -10px #000c, 0 0 30px -12px #e8bf6366, inset 0 1px 0 #fff1; animation: talent-tip 0.3s var(--ease); }
  @keyframes talent-tip { from { opacity: 0; transform: translateY(4px) scale(0.97); } }
  :global(.talent-tooltip strong) { color: #efcd7d; font-family: var(--font-display); font-size: 16px; text-shadow: 0 0 14px #e8bf6355; }
  :global(.talent-tooltip p) { font-size: 13px; white-space: pre-line; }
  :global(.talent-tooltip .reason) { color: var(--warn); }
  .talent-choice { width: 100%; text-align: left; justify-content: start; }
  .dimmed { opacity: .35; }
  @media (prefers-reduced-motion: reduce) { :global(:root:not([data-motion='full']) .talent-node.allocated) { animation: none; } }
  :global(:root[data-motion='reduced'] .talent-node.allocated) { animation: none; }
</style>
