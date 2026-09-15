<script lang="ts">
  // P06.5-P06.8: ability/pet damage, buff uptimes, sample sequence; parsed on demand off main thread.
  import { loadPlayerDetail } from '../simc/client'
  import { damageBreakdown, type DamageRow, type PlayerDetail } from '../simc/detail'
  import type { SimOutcome } from '../simc/job'
  import { fmtInt, fmtPct, fmtSeconds, titleCase } from '../format'
  import Banner from './Banner.svelte'
  import TimelineChart from './Timeline.svelte'
  import { spellIconUrl } from '../media.svelte'
  import { ms, stagger } from '../theme.svelte'
  import { fly } from 'svelte/transition'
  import ItemIcon from './ItemIcon.svelte'
  import ItemLink from './ItemLink.svelte'
  import SimulationDetails from './SimulationDetails.svelte'
  import GameIcon from './GameIcon.svelte'
  import { sharedDamage, sharedDetail, type SharedReport } from '../store/report-share'

  interface Props {
    outcome?: SimOutcome
    shared?: SharedReport
    playerName: string
    showDetails?: boolean
    detail?: PlayerDetail | null
  }
  let { outcome, shared, playerName, showDetails = true, detail = $bindable(null) }: Props = $props()

  type Tab = 'abilities' | 'buffs' | 'sequence' | 'timeline'
  let tab = $state<Tab>('abilities')

  const timeline = $derived(
    outcome?.report.players.find((p) => p.name === playerName)?.damageTimeline ?? shared?.extra?.timeline,
  )
  const tabs = $derived<[Tab, string][]>([
    ['abilities', 'Damage'],
    ...(!shared || shared.buffs ? [['buffs', 'Buffs'] as [Tab, string]] : []),
    ...(!shared || shared.extra?.sequence ? [['sequence', 'Sample fight'] as [Tab, string]] : []),
    ...(timeline ? [['timeline', 'Over time'] as [Tab, string]] : []),
  ])
  let error = $state('')
  let loading = $state(false)
  let expanded = $state<Set<string>>(new Set())
  let sort = $state<{ key: 'dps' | 'amount' | 'count' | 'name'; desc: boolean }>({
    key: 'dps', desc: true,
  })
  let seqPage = $state(0)

  const SEQ_PAGE = 60

  // Re-parse when a new run replaces this one; the raw blob is the identity.
  $effect(() => {
    if (shared) {
      detail = sharedDetail(shared)
      loading = false
      return
    }
    if (!outcome) return
    const blob = outcome.getRawJson()
    const name = playerName
    let cancelled = false
    loading = true
    error = ''
    detail = null
    expanded = new Set()
    seqPage = 0
    loadPlayerDetail(blob, name)
      .then((d) => { if (!cancelled) detail = d })
      .catch((e: unknown) => {
        if (!cancelled) error = e instanceof Error ? e.message : String(e)
      })
      .finally(() => { if (!cancelled) loading = false })
    return () => { cancelled = true }
  })

  function toggle(name: string): void {
    const next = new Set(expanded)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    expanded = next
  }

  function sortBy(key: typeof sort.key): void {
    sort = sort.key === key ? { key, desc: !sort.desc } : { key, desc: true }
  }

  function sorted(rows: readonly DamageRow[]): DamageRow[] {
    const dir = sort.desc ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case 'name': return (a.spellName ?? titleCase(a.name)).localeCompare(b.spellName ?? titleCase(b.name)) * -dir
        case 'amount': return (b.totalAmount - a.totalAmount) * dir
        case 'count': return (b.executeCount - a.executeCount) * dir
        default: return (b.dpsWithChildren - a.dpsWithChildren) * dir
      }
    })
  }

  const actorTotal = $derived(shared?.d ?? outcome?.report.players.find((p) => p.name === playerName)?.dps.mean ?? detail?.totalDps ?? 0)
  const abilities = $derived(shared ? sorted(sharedDamage(shared)) : detail ? sorted(damageBreakdown(detail, actorTotal)) : [])
  const accountedTotal = $derived(abilities.reduce((sum, row) => sum + row.dpsWithChildren, 0))
  const remainder = $derived(Math.max(0, actorTotal - accountedTotal))
  function visibleRows(rows: DamageRow[], depth = 0): { row: DamageRow; depth: number }[] {
    return rows.flatMap((row) => [{ row, depth }, ...(expanded.has(row.key) ? visibleRows(sorted(row.children ?? []), depth + 1) : [])])
  }
  const displayed = $derived(visibleRows(abilities))
  function expandAll(rows: DamageRow[]): string[] {
    return rows.flatMap((row) => row.children?.length ? [row.key, ...expandAll(row.children)] : [])
  }
  const maxShare = $derived(Math.max(0, ...abilities.map((a) => a.portionPct ?? 0)))
  const sequence = $derived(detail?.sequence ?? [])
  const pageCount = $derived(Math.max(1, Math.ceil(sequence.length / SEQ_PAGE)))
  const page = $derived(sequence.slice(seqPage * SEQ_PAGE, (seqPage + 1) * SEQ_PAGE))

  const constantBuffs = $derived(detail?.buffs.filter((b) => b.constant) ?? [])
  const dynamicBuffs = $derived(detail?.buffs.filter((b) => !b.constant) ?? [])
  const overCapped = $derived(dynamicBuffs.some((b) => (b.uptimePct ?? 0) > 100))

  /** Damage school drives color, label carries meaning. */
  function schoolClass(school?: string): string {
    return `school-${(school ?? 'physical').toLowerCase().replace(/[^a-z]/g, '')}`
  }
</script>

{#if showDetails && outcome}<SimulationDetails {outcome} {detail} />{/if}

<section class="panel stack-sm">
  <div class="spread">
    <h2 class="small">Damage breakdown</h2>
    <div class="segmented" role="tablist" aria-label="Report detail">
      <!-- The timeline tab appears only when the engine collected one. It is
           absent rather than empty in the report, so an offered-and-empty tab
           is impossible by construction. -->
      {#each tabs as [id, label] (id)}
        <label>
          <input type="radio" name="detail-tab" value={id} bind:group={tab} />
          {label}
        </label>
      {/each}
    </div>
    {#if tab === 'abilities' && detail}<button class="ghost sm" onclick={() => expanded = expanded.size ? new Set() : new Set(expandAll(abilities))}>{expanded.size ? 'Collapse all' : 'Expand all'}</button>{/if}
  </div>

  {#if loading}
    <div class="stack-sm" aria-live="polite">
      <p class="xs muted">Reading the engine report…</p>
      {#each { length: 5 } as _, i (i)}<div class="skeleton row-skel"></div>{/each}
    </div>
  {:else if error}
    <Banner kind="warn" title="The detailed breakdown could not be read">
      <p class="mono xs">{error}</p>
      <p>The headline result above is unaffected — it came from the same report.</p>
    </Banner>
  {:else if detail}
    {#if tab === 'timeline' && timeline}
      <TimelineChart {timeline} label="{playerName}: damage per second over fight time" />
    {:else if tab === 'abilities'}

      <!--
        Icon, name colored by school, share bar, numbers: standard shape for damage breakdown that lets eye rank without reading.
      -->
      <div class="tbl-scroll">
        <table class="tbl">
          <caption class="sr-only">{playerName}: damage by ability, including pets</caption>
          <thead>
            <tr>
              <th scope="col">
                <button onclick={() => sortBy('name')} aria-label="Sort by ability">
                  Ability {sort.key === 'name' ? (sort.desc ? '▾' : '▴') : ''}
                </button>
              </th>
              <th scope="col" class="n">Share</th>
              <th scope="col" class="bar-col"><span class="sr-only">Share as a bar</span></th>
              <th scope="col" class="n">
                <button onclick={() => sortBy('amount')}>Damage {sort.key === 'amount' ? (sort.desc ? '▾' : '▴') : ''}</button>
              </th>
              <th scope="col" class="n">
                <button onclick={() => sortBy('count')}>
                  Count {sort.key === 'count' ? (sort.desc ? '▾' : '▴') : ''}
                </button>
              </th>
              <th scope="col" class="n">Uptime</th>
            </tr>
          </thead>
          <tbody>
            {#each displayed as entry, i (entry.row.key)}
                {@const r = entry.row}
                {@const depth = entry.depth}
                {@const icon = spellIconUrl(r.id)}
                <tr class:child={depth > 0} in:fly|global={{ y: 4, duration: ms('reveal'), delay: stagger(i, 10) }}>
                  <th scope="row">
                    <span class="ab" style:padding-left="{depth * 1.1}rem">
                      {#if r.itemId}<ItemLink itemId={r.itemId} name={r.spellName ?? titleCase(r.name)}><ItemIcon itemId={r.itemId} size={24} alt={r.spellName ?? titleCase(r.name)} /></ItemLink>{:else}<GameIcon spellId={r.id} label={r.spellName ?? titleCase(r.name)} />{/if}
                      {#if r.children?.length}
                        <button class="disclose" onclick={() => toggle(r.key)} aria-expanded={expanded.has(r.key)}>
                          <span class="school {schoolClass(r.isPet ? 'pet' : r.school)}">{r.spellName ?? titleCase(r.name)}</span>
                          <span class="faint" aria-hidden="true">{expanded.has(r.key) ? '▾' : '▸'}</span>
                        </button>
                      {:else if r.itemId}
                        <ItemLink itemId={r.itemId} name={r.spellName ?? titleCase(r.name)} />
                      {:else}
                        <span class="school {schoolClass(r.school)}">{r.spellName ?? titleCase(r.name)}</span>
                      {/if}

                    </span>
                  </th>
                  <td class="n">{r.portionPct !== undefined ? fmtPct(r.portionPct, 1) : '—'}</td>
                  <td class="bar-col">
                    <span
                      class="bar {schoolClass(r.isPet ? 'pet' : r.school)}"
                      style:width="{maxShare ? Math.min(100, ((r.portionPct ?? 0) / maxShare) * 100) : 0}%"
                    ></span>
                  </td>
                  <td class="n">{fmtInt(r.totalAmount)}</td>
                  <td class="n">{fmtInt(r.executeCount)}</td>
                  <td class="n" title={`${fmtInt(r.dpsWithChildren)} DPS · ${r.critPct !== undefined ? fmtPct(r.critPct, 1) + ' crit' : 'Crit not reported'}`}>—</td>
                </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if shared && (shared.damage?.length ?? 0) < shared.meta.damageCount}
        <p class="xs muted">{shared.damage?.length ?? 0} of {shared.meta.damageCount} contributors included in this link.</p>
      {:else if remainder > Math.max(1, actorTotal * 0.001)}
        <p class="xs muted">
          The report does not assign the remaining {fmtInt(remainder)} DPS to a damage ability.
        </p>
      {/if}
    {:else if tab === 'buffs'}
      {#if overCapped}
        <p class="xs muted">
          An uptime above 100% is not an error: a buff tracked on several targets accumulates
          uptime per target. The values are the engine's own and are not clipped.
        </p>
      {/if}

      {#each [['Dynamic', dynamicBuffs], ['Constant', constantBuffs]] as [heading, rows] (heading)}
        {#if (rows as typeof dynamicBuffs).length}
          <h3 class="small">{heading}</h3>
          {#if heading === 'Constant'}
            <p class="xs muted">Up for the whole fight, so uptime carries no information.</p>
          {/if}
          <div class="tbl-scroll">
            <table class="tbl">
              <caption class="sr-only">{heading} buffs</caption>
              <thead>
                <tr>
                  <th>Buff</th>
                  {#if heading === 'Dynamic'}
                    <th class="n">Uptime</th><th class="n">Applied</th>
                    <th class="n">Refreshed</th><th class="n">Benefit</th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each rows as b, i (i)}
                  {@const buff = b as (typeof dynamicBuffs)[number]}
                  <tr>
                    <th scope="row">{buff.spellName ?? titleCase(buff.name)}</th>
                    {#if heading === 'Dynamic'}
                      <td class="n">{buff.uptimePct !== undefined ? fmtPct(buff.uptimePct, 1) : '—'}</td>
                      <td class="n">{buff.startCount !== undefined ? buff.startCount.toFixed(1) : '—'}</td>
                      <td class="n">{buff.refreshCount !== undefined ? buff.refreshCount.toFixed(1) : '—'}</td>
                      <td class="n">{buff.benefitPct !== undefined ? fmtPct(buff.benefitPct, 1) : '—'}</td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/each}

      {#if !detail.buffs.length}
        <p class="small muted">This report recorded no buff data.</p>
      {/if}
    {:else}
      {#if !sequence.length && !detail.precombat.length}
        <p class="small muted">
          This report recorded no action sequence. The engine writes one only when it is asked to.
        </p>
      {:else}
        <Banner kind="info" title="One simulated fight, not a rotation to follow">
          <p>
            This is the engine's record of a single iteration out of
            {fmtInt(shared?.meta.samples ?? outcome?.report.actualIterations)}. It shows what the action list did once,
            under that fight's particular timing and procs.
          </p>
        </Banner>

        {#if detail.precombat.length}
          <h3 class="small">Precombat</h3>
          <ol class="seq small">
            {#each detail.precombat as step, i (i)}
              <li><span class="mono t">—</span> {step.spellName ?? titleCase(step.action)}</li>
            {/each}
          </ol>
        {/if}

        <div class="spread">
          <h3 class="small">Combat</h3>
          {#if pageCount > 1}
            <div class="row-tight">
              <button class="ghost sm" disabled={seqPage === 0} onclick={() => seqPage--}>
                Previous
              </button>
              <span class="xs muted">Page {seqPage + 1} of {pageCount}</span>
              <button class="ghost sm" disabled={seqPage >= pageCount - 1} onclick={() => seqPage++}>
                Next
              </button>
            </div>
          {/if}
        </div>
        <ol class="seq small" start={seqPage * SEQ_PAGE + 1}>
          {#each page as step, i (seqPage * SEQ_PAGE + i)}
            <li>
              <span class="mono t">{fmtSeconds(step.time)}</span>
              <span class="act">{step.spellName ?? titleCase(step.action)}</span>
              {#if step.target}<span class="xs faint">→ {step.target}</span>{/if}
              {#if step.buffs.length}
                <span class="xs faint buffs">
                  {step.buffs.map((b) => (b.stacks > 1 ? `${b.name} ×${b.stacks}` : b.name)).join(', ')}
                </span>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .tbl th, .tbl td { padding-block: 6px; }
  .tbl { font-size: 13px; }

  .row-skel { height: 1.4rem; }
  .disclose {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    gap: 0.3rem;
    align-items: center;
  }
  .disclose:focus-visible { box-shadow: var(--focus); border-radius: var(--r1); }
  .pet-mark { width: 22px; flex: none; text-align: center; color: var(--accent); }
  .child { background: var(--surface-2); }
  /* Row headers are names, not column captions: no small caps, no tracking. */
  tbody th { text-transform: none; letter-spacing: 0; font-size: var(--fs-sm); font-weight: 550; }
  .ab { display: inline-flex; align-items: center; gap: 0.45rem; min-width: 0; }

  .sch { display: none; }
  @media (min-width: 60rem) { .sch { display: inline; } }
  .bar-col { width: 28%; min-width: 7rem; padding-left: 0 !important; }
  .bar {
    display: block;
    height: 0.55rem;
    min-width: 2px;
    border-radius: 999px;
    background: currentColor;
    opacity: 0.8;
    transition: width var(--t-panel) var(--ease);
  }
  .school { font-size: var(--fs-xs); font-weight: 600; }
  /* Colour is a hint; the school name is always printed next to it. */
  .school-fire { color: #e2703a; }
  .school-frost { color: #4fa8d8; }
  .school-shadow { color: #9b6ad4; }
  .school-nature { color: #4aa86a; }
  .school-arcane { color: #c176d8; }
  .school-holy { color: #d4b455; }
  .school-physical { color: var(--text-muted); }
  .school-pet { color: var(--accent); }
  .seq { margin: 0; padding-left: 2.2rem; display: grid; gap: 0.1rem; }
  .seq li { padding: 0.1rem 0; }
  .t { color: var(--text-faint); display: inline-block; min-width: 3.2rem; }
  .act { font-weight: 550; }
  .buffs { margin-left: 0.4rem; }
</style>
