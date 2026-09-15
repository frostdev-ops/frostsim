import type { TalentLayout, TalentTree } from './types'
import type { EngineCapability } from '../simc/capability'
const pending = new Map<string, Promise<TalentLayout>>()
/** Client tables can repeat connection for specs. Line between same visible nodes drawn once. */
export function visibleTalentEdges(layout: TalentLayout | undefined, visibleIds: ReadonlySet<number>): TalentLayout['edges'] {
  const lines = new Map<string, TalentLayout['edges'][number]>()
  for (const edge of layout?.edges ?? []) {
    if (edge.visual && visibleIds.has(edge.from) && visibleIds.has(edge.to)) lines.set(`${edge.from}:${edge.to}`, edge)
  }
  return [...lines.values()]
}
export async function withTalentLayout(tree: TalentTree, capability: EngineCapability | null): Promise<TalentTree> {
  if (!capability?.ok) throw Error('The selected engine is unavailable.')
  const engine = capability.manifest
  const base = capability.engineDir.startsWith('/engine/versions/')
    ? `${capability.engineDir.replace(/fallback\/$/, '')}talent-layout/` : '/talent-layout/'
  const key = `${base}:${engine.engine.upstreamCommit}:${tree.classId}`
  let request = pending.get(key)
  if (!request) {
    request = fetch(base + 'class-' + tree.classId + '.json').then(async (response) => {
      if (!response.ok) throw Error('Talent presentation data is unavailable.')
      const data = await response.json() as TalentLayout
      if (data.schemaVersion !== 1 || data.classId !== tree.classId || data.engineCommit !== engine.engine.upstreamCommit ||
        data.build !== engine.wow.clientDataVersion || !Number.isFinite(Date.parse(data.expiresAt)) ||
        !data.nodes || !data.descriptions || !Array.isArray(data.edges) || !data.budgetSources) throw Error('Talent data needs to be refreshed.')
      const ids = new Set(tree.nodes.map(n => n.nodeId))
      for (const node of tree.nodes) {
        if (node.treeIndex === 4) continue
        const position = data.nodes[node.nodeId]
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw Error('Talent positions do not match this engine.')
      }
      if (data.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to) || ![0, 1, 2, 3, 4, 5].includes(edge.type))) throw Error('Invalid talent connections.')
      for (const key of ['class', 'spec', 'hero'] as const) {
        if (!Array.isArray(data.budgetSources[key]) || !data.budgetSources[key].length ||
          data.budgetSources[key].some(row => !Number.isInteger(row.level) || !Number.isInteger(row.amount) || row.amount < 0)) throw Error('Invalid talent point budgets.')
      }
      // Graph, grants, budgets from pinned tables. Only live Blizzard descriptions/shapes expire; expiry doesn't disable old engines.
      if (Date.parse(data.expiresAt) <= Date.now()) return { ...data, descriptions: {},
        nodes: Object.fromEntries(Object.entries(data.nodes).map(([id, node]) =>
          [id, { ...node, shape: node.entryType === 2 ? 'PASSIVE' : 'ACTIVE' }])) }
      return data
    }).catch(error => { pending.delete(key); throw error })
    pending.set(key, request)
  }
  return { ...tree, layout: await request }
}
