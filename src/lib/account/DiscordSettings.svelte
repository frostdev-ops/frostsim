<script lang="ts">
  // Discord server settings, #/discord (CLAUDE.md D15): how much of a server's cloud pool each Discord role gets a month. Only the
  // member who pays for the server's plan sees and edits it; the server enforces the same rule (guild-roles.ts).
  import { MessagesSquare } from '@lucide/svelte'
  import { api } from './api'
  import { account } from './state.svelte'
  import { STANDARD_SIM_CPU_SECONDS, approxSims } from './plans'

  interface Role { id: string; name: string; color: number }
  interface Guild {
    guildId: string
    name: string | null
    botPresent: boolean
    roles: Role[]
    limits: Record<string, number | null>
    pool: { coreSeconds: number; usedCoreSeconds: number; periodEnd: string } | null
  }
  type Mode = 'default' | 'pool' | 'none' | 'limit'
  interface Row { mode: Mode; sims: number }

  let guilds = $state<Guild[] | null>(null)
  let error = $state('')
  /** Edits per guild, per role, until saved. */
  let edits = $state<Record<string, Record<string, Row>>>({})
  let saving = $state('')
  let saved = $state('')

  const toSims = (cs: number) => Math.round(cs / STANDARD_SIM_CPU_SECONDS)
  const colour = (c: number) => (c ? `#${c.toString(16).padStart(6, '0')}` : 'var(--text-muted)')

  function rowsOf(g: Guild): Record<string, Row> {
    return Object.fromEntries(g.roles.map((r) => {
      const set = Object.hasOwn(g.limits, r.id)
      const v = g.limits[r.id]
      const mode: Mode = !set ? (r.id === g.guildId ? 'pool' : 'default') : v === null ? 'pool' : v === 0 ? 'none' : 'limit'
      return [r.id, { mode, sims: set && v ? toSims(v) : 50 }]
    }))
  }

  async function load(): Promise<void> {
    try {
      guilds = (await api<{ guilds: Guild[] }>('/discord/guilds')).guilds
      edits = Object.fromEntries(guilds.map((g) => [g.guildId, rowsOf(g)]))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function save(g: Guild): Promise<void> {
    const limits: Record<string, number | null> = {}
    for (const [id, row] of Object.entries(edits[g.guildId])) {
      // @everyone left on "up to the pool" is the default, so it needs no row either.
      if (row.mode === 'default' || (id === g.guildId && row.mode === 'pool')) continue
      limits[id] = row.mode === 'pool' ? null : row.mode === 'none' ? 0 : Math.round(Math.max(1, row.sims) * STANDARD_SIM_CPU_SECONDS)
    }
    saving = g.guildId
    error = ''
    try {
      const next = await api<Guild>(`/discord/guilds/${g.guildId}`, 'PUT', { limits })
      guilds = guilds!.map((x) => (x.guildId === g.guildId ? next : x))
      edits[g.guildId] = rowsOf(next)
      saved = g.guildId
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      saving = ''
    }
  }

  $effect(() => {
    if (account.me && guilds === null) void load()
  })
</script>

<div class="page stack">
  <header class="stack-sm">
    <span class="eyebrow"><MessagesSquare size={14} aria-hidden="true" /> Discord</span>
    <h1>Server settings</h1>
    <p class="muted">Choose how much of your server's cloud pool each Discord role gets a month. A role you set overrides @everyone, and a
      member with several set roles gets the largest. Members past their share run <code>/sim</code> on their own plan if they have one.</p>
  </header>

  {#if !account.me}
    <p><button class="primary" onclick={() => (account.open = true)}>Sign in</button> to manage your Discord servers.</p>
  {:else if error && !guilds}
    <p class="error">{error}</p>
  {:else if !guilds}
    <p class="muted">Loading…</p>
  {:else if !guilds.length}
    <p class="muted">You don't pay for a Frostsim plan on any Discord server. <a href="#/plans">Add Frostsim to your server</a>, then run
      <code>/frostsim subscribe</code> there.</p>
  {:else}
    {#each guilds as g (g.guildId)}
      <section class="panel guild stack-sm">
        <div class="row head">
          <h2>{g.name ?? g.guildId}</h2>
          {#if g.pool}
            <span class="small muted">≈ {approxSims(g.pool.coreSeconds - g.pool.usedCoreSeconds).toLocaleString()} of
              {approxSims(g.pool.coreSeconds).toLocaleString()} sims left until {new Date(g.pool.periodEnd).toLocaleDateString()}</span>
          {/if}
        </div>
        {#if !g.botPresent}
          <p class="small">The Frostsim bot isn't in this server, so its roles can't be listed. <a href="/api/v1/discord/install">Add it again</a>.</p>
        {:else}
          <ul class="roles">
            {#each g.roles as r (r.id)}
              {@const row = edits[g.guildId][r.id]}
              <li>
                <span class="name"><span class="dot" style:background={colour(r.color)}></span>{r.name}</span>
                <select bind:value={row.mode} aria-label="Allowance for {r.name}" onchange={() => (saved = '')}>
                  {#if r.id !== g.guildId}<option value="default">Same as @everyone</option>{/if}
                  <option value="pool">Up to the whole pool</option>
                  <option value="limit">Sims a month</option>
                  <option value="none">No cloud runs</option>
                </select>
                {#if row.mode === 'limit'}
                  <input type="number" min="1" step="1" bind:value={row.sims} aria-label="Sims a month for {r.name}" oninput={() => (saved = '')} />
                {/if}
              </li>
            {/each}
          </ul>
          <div class="row">
            <button class="primary" disabled={saving === g.guildId} onclick={() => save(g)}>{saving === g.guildId ? 'Saving…' : 'Save'}</button>
            {#if saved === g.guildId}<span class="small muted">Saved.</span>{/if}
            {#if error && saving === ''}<span class="small error">{error}</span>{/if}
          </div>
          <p class="xs muted">A sim here is a Quick Sim at 4,000 iterations; high-precision runs and heavy fights count as several.</p>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
  .page { max-width: 46rem; margin: 0 auto; padding: var(--s5) var(--s4); }
  .eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); }
  h1 { margin: 0; }
  .guild { padding: var(--s5); }
  .head { justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: var(--s2); }
  h2 { margin: 0; font-size: 18px; }
  .roles { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s2); }
  .roles li { display: grid; grid-template-columns: minmax(0, 1fr) auto 6rem; gap: var(--s2); align-items: center; }
  .name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .error { color: var(--danger, #f87171); }
  @media (max-width: 30rem) {
    .roles li { grid-template-columns: minmax(0, 1fr) auto; }
    .roles li input { grid-column: 2; }
  }
</style>
