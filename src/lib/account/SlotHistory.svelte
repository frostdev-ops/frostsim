<script lang="ts">
  // A character slot's history (CLAUDE.md D15; DESIGN.md C5): item level from its gear snapshots, DPS from its recorded sims (this
  // device's Quick Sims are uploaded here, patch re-sims come from the server), and what changed between saves.
  import { app } from '../app.svelte'
  import { api } from './api'
  import { gearChanges, simPoint, type GearItem, type SimPoint } from './history'

  interface Props { slotId: string; label: string; localId: string | null }
  let { slotId, label, localId }: Props = $props()

  interface Snapshot { id: string; createdAt: string; itemLevel: number | null; gear: GearItem[] }
  interface Sim { createdAt: string; source: 'run' | 'patch'; dps: number; dpsError?: number; fightStyle?: string; targets?: number; gameBuild?: string; reportId?: string }

  let history = $state<{ snapshots: Snapshot[]; sims: Sim[] } | null>(null)
  let scenario = $state('')

  const keyOf = (s: Pick<Sim, 'fightStyle' | 'targets'>) => `${s.fightStyle ?? 'Unknown'} · ${s.targets ?? 1} target${(s.targets ?? 1) === 1 ? '' : 's'}`
  const scenarios = $derived([...new Set((history?.sims ?? []).map(keyOf))])
  const shown = $derived((history?.sims ?? []).filter((s) => keyOf(s) === scenario))
  const levels = $derived((history?.snapshots ?? []).filter((s) => s.itemLevel !== null))
  const ilvlNow = $derived(levels.at(-1)?.itemLevel ?? null)
  const ilvlGain = $derived(levels.length > 1 ? ilvlNow! - levels[0].itemLevel! : 0)
  const dpsNow = $derived(shown.at(-1))
  const dpsPrev = $derived(shown.at(-2))
  const dpsChange = $derived(dpsNow && dpsPrev ? (dpsNow.dps / dpsPrev.dps - 1) * 100 : null)
  const changes = $derived.by(() => {
    const snaps = history?.snapshots ?? []
    return snaps.slice(1).map((s, i) => ({ at: s.createdAt, list: gearChanges(snaps[i].gear, s.gear) })).filter((c) => c.list.length).reverse()
  })

  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const signed = (n: number, digits = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`

  $effect(() => {
    const id = slotId
    const local = localId
    void sync(id, local)
  })
  // The newest scenario unless the user picked one that still exists.
  $effect(() => {
    if (!scenarios.includes(scenario)) scenario = history?.sims.length ? keyOf(history.sims.at(-1)!) : ''
  })

  /** Loads the history, uploads this device's Quick Sims of the character that it lacks, and reloads when any were added. */
  async function sync(id: string, local: string | null): Promise<void> {
    try {
      let h = await api<{ snapshots: Snapshot[]; sims: Sim[] }>(`/characters/${id}/history`)
      if (id !== slotId) return
      history = h
      const known = new Set(h.sims.map((s) => s.reportId).filter(Boolean))
      const fresh = local ? app.reports.filter((r) => r.characterId === local).map(simPoint).filter((p): p is SimPoint => !!p && !known.has(p.reportId)) : []
      let added = 0
      for (let i = 0; i < fresh.length; i += 50) added += (await api<{ added: number }>(`/characters/${id}/sims`, 'POST', { points: fresh.slice(i, i + 50) })).added
      if (!added) return
      h = await api(`/characters/${id}/history`)
      if (id === slotId) history = h
    } catch {
      // History is an extra: the slot itself still works, and the next visit tries again.
    }
  }

  /** x in [0, W] by time, y in [H, 0] by value, with 8% headroom. */
  function scale(points: { t: number; v: number; lo?: number; hi?: number }[], W: number, H: number) {
    const ts = points.map((p) => p.t)
    const vs = points.flatMap((p) => [p.lo ?? p.v, p.hi ?? p.v])
    const [t0, t1] = [Math.min(...ts), Math.max(...ts)]
    const [v0, v1] = [Math.min(...vs), Math.max(...vs)]
    const pad = (v1 - v0) * 0.08 || Math.max(1, Math.abs(v0) * 0.01)
    const x = (t: number) => (t1 === t0 ? W / 2 : ((t - t0) / (t1 - t0)) * W)
    const y = (v: number) => H - ((v - (v0 - pad)) / (v1 - v0 + 2 * pad)) * H
    return { x, y }
  }
  const W = 480
  const H = 110
  const ilvlChart = $derived.by(() => {
    const pts = levels.map((s) => ({ t: Date.parse(s.createdAt), v: s.itemLevel! }))
    if (!pts.length) return null
    const { x, y } = scale(pts, W, H)
    // A step line: item level holds until the next save.
    const d = pts.map((p, i) => (i ? `H${x(p.t)} V${y(p.v)}` : `M${x(p.t)} ${y(p.v)}`)).join(' ') + ` H${W}`
    return { d, dots: pts.map((p) => ({ cx: x(p.t), cy: y(p.v), label: `${p.v.toFixed(1)} on ${new Date(p.t).toLocaleDateString()}` })) }
  })
  const dpsChart = $derived.by(() => {
    const pts = shown.map((s) => ({ t: Date.parse(s.createdAt), v: s.dps, lo: s.dps - (s.dpsError ?? 0), hi: s.dps + (s.dpsError ?? 0), s }))
    if (!pts.length) return null
    const { x, y } = scale(pts, W, H)
    return {
      d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)} ${y(p.v)}`).join(' '),
      dots: pts.map((p) => ({
        cx: x(p.t), cy: y(p.v), lo: y(p.lo), hi: y(p.hi), patch: p.s.source === 'patch',
        label: `${fmt.format(p.v)} DPS${p.s.dpsError ? ` ± ${fmt.format(p.s.dpsError)}` : ''}, ${p.s.source === 'patch' ? `patch re-sim${p.s.gameBuild ? ` on ${p.s.gameBuild}` : ''}` : 'your sim'}, ${new Date(p.t).toLocaleDateString()}`,
      })),
    }
  })
</script>

{#if history}
  <div class="history" aria-label="{label} history">
    <div class="stats">
      <div class="stat">
        <span class="xs muted">Item level</span>
        <strong>{ilvlNow?.toFixed(1) ?? '—'}</strong>
        {#if ilvlGain}<span class="xs" class:up={ilvlGain > 0} class:down={ilvlGain < 0}>{signed(ilvlGain)} since {date(levels[0].createdAt)}</span>{/if}
      </div>
      <div class="stat">
        <span class="xs muted">DPS · {scenario || 'no sims yet'}</span>
        <strong>{dpsNow ? fmt.format(dpsNow.dps) : '—'}</strong>
        {#if dpsChange !== null}
          <span class="xs" class:up={dpsChange > 0} class:down={dpsChange < 0}>
            {signed(dpsChange)}% {dpsNow?.source === 'patch' ? `this patch${dpsNow.gameBuild ? ` (${dpsNow.gameBuild})` : ''}` : 'vs last sim'}
          </span>
        {/if}
      </div>
    </div>

    {#if scenarios.length > 1}
      <div class="segmented" role="radiogroup" aria-label="Fight shown">
        {#each scenarios as k (k)}
          <label><input type="radio" name="history-scenario" value={k} checked={scenario === k} onchange={() => (scenario = k)} />{k}</label>
        {/each}
      </div>
    {/if}

    <div class="charts">
      <figure>
        <figcaption class="xs muted">Item level</figcaption>
        {#if ilvlChart && levels.length > 1}
          <svg viewBox="-6 -6 {W + 12} {H + 12}" role="img" aria-label="Item level over time">
            <path d={ilvlChart.d} class="line ilvl" />
            {#each ilvlChart.dots as p, i (i)}<circle cx={p.cx} cy={p.cy} r="3.5" class="dot ilvl"><title>{p.label}</title></circle>{/each}
          </svg>
        {:else}
          <p class="empty xs muted">Save this character again after a gear change to start the line.</p>
        {/if}
      </figure>
      <figure>
        <figcaption class="xs muted">DPS <span class="legend"><i class="run"></i>your sims <i class="patch"></i>patch re-sims</span></figcaption>
        {#if dpsChart && shown.length > 1}
          <svg viewBox="-6 -6 {W + 12} {H + 12}" role="img" aria-label="DPS over time">
            <path d={dpsChart.d} class="line dps" />
            {#each dpsChart.dots as p, i (i)}
              <line x1={p.cx} x2={p.cx} y1={p.lo} y2={p.hi} class="err" />
              {#if p.patch}
                <rect x={p.cx - 4} y={p.cy - 4} width="8" height="8" transform="rotate(45 {p.cx} {p.cy})" class="dot patch"><title>{p.label}</title></rect>
              {:else}
                <circle cx={p.cx} cy={p.cy} r="3.5" class="dot dps"><title>{p.label}</title></circle>
              {/if}
            {/each}
          </svg>
        {:else}
          <p class="empty xs muted">Run a Quick Sim of this character and it shows up here, on every device.</p>
        {/if}
      </figure>
    </div>

    {#if changes.length}
      <details class="disclosure">
        <summary class="small">Gear changes <span class="muted">({changes.length} save{changes.length === 1 ? '' : 's'})</span></summary>
        <ol class="log">
          {#each changes.slice(0, 12) as c (c.at)}
            <li>
              <span class="xs muted">{date(c.at)}</span>
              <ul>
                {#each c.list as g (g.slot)}
                  <li class="small">
                    <span class="muted">{g.label}</span>
                    {g.from?.name ?? (g.from ? `Item ${g.from.itemId}` : 'empty')}{g.from?.ilvl ? ` ${g.from.ilvl}` : ''}
                    → <strong>{g.to?.name ?? (g.to ? `Item ${g.to.itemId}` : 'empty')}{g.to?.ilvl ? ` ${g.to.ilvl}` : ''}</strong>
                    {#if g.from?.ilvl && g.to?.ilvl && g.to.ilvl !== g.from.ilvl}<span class="xs" class:up={g.to.ilvl > g.from.ilvl} class:down={g.to.ilvl < g.from.ilvl}>{signed(g.to.ilvl - g.from.ilvl, 0)}</span>{/if}
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        </ol>
      </details>
    {/if}
  </div>
{/if}

<style>
  .history { display: grid; gap: var(--s3); padding-top: var(--s3); border-top: 1px solid var(--border); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--s3); }
  .stat { display: grid; gap: 2px; }
  .stat strong { font: 700 24px var(--font-display); }
  .up { color: var(--gain); }
  .down { color: var(--loss); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: var(--s3); }
  figure { margin: 0; padding: var(--s3); border-radius: var(--r3); background: var(--well); border: 1px solid var(--border); display: grid; gap: var(--s2); }
  figcaption { display: flex; justify-content: space-between; gap: var(--s2); }
  svg { width: 100%; height: auto; overflow: visible; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; }
  .line.ilvl { stroke: var(--accent-3); }
  .line.dps { stroke: var(--accent); }
  .dot.ilvl { fill: var(--accent-3); }
  .dot.dps { fill: var(--accent); }
  .dot.patch { fill: var(--warn); }
  .err { stroke: var(--text-faint); stroke-width: 1.5; }
  .empty { margin: 0; min-height: 4rem; display: grid; place-items: center; text-align: center; }
  .legend { display: inline-flex; align-items: center; gap: 4px; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-left: 6px; }
  .legend .run { background: var(--accent); }
  .legend .patch { background: var(--warn); border-radius: 1px; transform: rotate(45deg); }
  .log { list-style: none; margin: var(--s2) 0 0; padding: 0; display: grid; gap: var(--s2); }
  .log ul { list-style: none; margin: 2px 0 0; padding: 0 0 0 var(--s3); border-left: 2px solid var(--border); display: grid; gap: 2px; }
</style>
