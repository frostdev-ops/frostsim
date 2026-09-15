<script lang="ts">
  // Engine notices separated by meaning (P06.9). Classification is ReportLog.kind from engine level, not string matching.
  import type { ReportLog } from '../simc/client'
  import Banner from './Banner.svelte'

  interface Props {
    /** From JSON report; baseline actor's notices only. */
    logs: ReportLog[]
    /** Parsed from engine stderr; sees child sims not in merged report (error_list is per-sim). */
    engineNotices?: ReportLog[]
    /** Non-fatal input rewrites, shown separately. */
    inputWarnings?: string[]
  }
  let { logs, engineNotices = [], inputWarnings = [] }: Props = $props()

  // Dedup by message: two streams overlap for baseline, same sentence = two problems.
  const all = $derived.by(() => {
    const seen = new Set<string>()
    const out: ReportLog[] = []
    for (const l of [...logs, ...engineNotices]) {
      const key = `${l.kind}\u0000${l.message}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(l)
    }
    return out
  })

  const problems = $derived(all.filter((l) => l.kind === 'problem'))
  const unverified = $derived(all.filter((l) => l.kind === 'unverified'))
  const notes = $derived(all.filter((l) => l.kind === 'note'))
  // Unrecognized level is kept; silence is worse than showing what engine said.
  const unknown = $derived(all.filter((l) => l.kind === 'unknown'))
</script>

{#if inputWarnings.length}
  <Banner kind="warn" title="Input changed before the run">
    <ul>
      {#each inputWarnings as w, i (i)}<li>{w}</li>{/each}
    </ul>
  </Banner>
{/if}

{#if problems.length}
  <!-- Next to result, not hidden; case where number above may be wrong. -->
  <Banner kind="bad" title="The engine reported problems — the number above may be wrong">
    <ul>
      {#each problems as p, i (i)}<li class="mono xs">{p.message}</li>{/each}
    </ul>
  </Banner>
{/if}

{#if unverified.length}
  <!-- One-line expandable; result stands, not panel-sized warning. -->
  <details class="disclosure unverified">
    <summary>
      <span class="chip warn">{unverified.length}</span>
      simulation {unverified.length === 1 ? 'warning' : 'warnings'}
    </summary>
    <ul class="xs muted">
      {#each unverified as u, i (i)}<li class="mono">{u.message}</li>{/each}
    </ul>
  </details>
{/if}

{#if notes.length || unknown.length}
  <details class="disclosure">
    <summary>
      {notes.length + unknown.length} engine note{notes.length + unknown.length === 1 ? '' : 's'}
    </summary>
    <ul class="xs muted">
      {#each notes as n, i (i)}<li class="mono">{n.message}</li>{/each}
      {#each unknown as u, i (`u${i}`)}
        <li class="mono">
          {u.message}
          <span class="chip">level “{u.level}”, not recognised by this build</span>
        </li>
      {/each}
    </ul>
  </details>
{/if}
