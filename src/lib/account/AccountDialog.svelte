<script lang="ts">
  // Account dialog (CLAUDE.md D15; DESIGN.md C10, P4-P6): sign-in, profile, sign-in methods, plan and usage, cloud characters,
  // hosted links, the Loothing permission, export and deletion. Sign-in, checkout and the billing portal are top-level navigations
  // (CSP form-action 'none', COOP), and forms only ever run fetch from onsubmit.
  import { untrack } from 'svelte'
  import Dialog from '../ui/Dialog.svelte'
  import { activeCharacter, activeStored, app, saveCharacter, toast } from '../app.svelte'
  import { fmtBytes, fmtDateTime } from '../format'
  import { api, AccountError } from './api'
  import { account, cloudDownload, go, guildOf, refresh, signedOut, startUrl, type Me } from './state.svelte'

  interface Provider { id: string; label: string }
  interface CloudCharacter { id: string; label: string; bytes: number; updatedAt: string }
  interface Share { id: string; title: string; bytes: number | null; createdAt: string; expiresAt: string | null }

  // Thread counts are the server catalog's (DESIGN.md C6). Prices and core-hours live on Stripe and show at checkout.
  const PLANS: [string, string, string][] = [
    ['compute_s_monthly', 'Compute S', 'Cloud runs on up to 8 threads, hosted links included'],
    ['compute_m_monthly', 'Compute M', 'Cloud runs on up to 16 threads, hosted links included'],
    ['compute_l_monthly', 'Compute L', 'Cloud runs on up to 32 threads, hosted links included'],
    ['slots_5_monthly', 'Character slots', 'Five cloud character slots'],
    ['shares_plus_monthly', 'Hosted links', 'Full-detail report links without cloud runs'],
  ]

  let providers = $state<Provider[]>([])
  let cloud = $state<{ slots: number; characters: CloudCharacter[] } | null>(null)
  let shares = $state<Share[] | null>(null)
  let busy = $state('')
  let error = $state('')
  let name = $state('')
  let confirm = $state('')

  const me = $derived(account.me)
  const billing = $derived(account.billing)
  const character = $derived(activeCharacter())
  const linked = $derived(new Set(me?.identities.map((i) => i.provider)))
  const hours = (s: number) => (s / 3600).toFixed(1)
  const when = (iso: string | null) => fmtDateTime(iso ? Date.parse(iso) : undefined)
  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id
  const guildId = $derived(account.guildToken ? guildOf(account.guildToken) : null)
  const planName = (key: string) => PLANS.find((p) => p[0] === key)?.[1] ?? (key === 'discord_guild_monthly' ? 'Discord server' : key)

  // Opening the dialog always asks who is signed in: the marker can be missing (blocked or cleared storage) while the session works.
  $effect(() => {
    if (account.open) untrack(() => void load())
    else account.notice = ''
  })

  async function run(what: string, fn: () => Promise<void>): Promise<void> {
    busy = what
    error = ''
    try {
      await fn()
    } catch (e) {
      if (e instanceof AccountError && e.status === 401) signedOut()
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = ''
    }
  }

  const load = () => run('load', async () => {
    const [list] = await Promise.all([api<{ providers: Provider[] }>('/auth/providers'), refresh()])
    providers = list.providers
    name = account.me?.user.displayName ?? ''
    if (account.me) await lists()
  })

  /** Characters and hosted links are one server feature; switched off, their sections are left out. */
  async function lists(): Promise<void> {
    const [c, s] = await Promise.all([
      api<{ slots: number; characters: CloudCharacter[] }>('/characters').catch(() => null),
      api<{ shares: Share[] }>('/shares').catch(() => null),
    ])
    cloud = c
    shares = s?.shares ?? null
  }

  const rename = () => run('rename', async () => {
    account.me = await api<Me>('/me', 'PATCH', { displayName: name.trim() })
    toast('good', 'Name saved.')
  })
  const unlink = (provider: string) => run('unlink', async () => {
    await api(`/me/identities/${encodeURIComponent(provider)}`, 'DELETE')
    await refresh()
    toast('good', 'Sign-in method removed. Your other devices were signed out.')
  })
  const loothing = (on: boolean) => run('loothing', async () => {
    await api('/me/integrations/loothing', on ? 'PUT' : 'DELETE')
    await refresh()
  })
  const checkout = (lookupKey: string, guildToken?: string) => run('checkout', async () => {
    go((await api<{ url: string }>('/billing/checkout', 'POST', { lookupKey, guildToken })).url)
  })
  const portal = () => run('portal', async () => go((await api<{ url: string }>('/billing/portal', 'POST')).url))

  /** POST adds a slot; `replace` overwrites that cloud character in place (PUT), so re-saving after a gear change needs no free slot. */
  const saveToCloud = (replace?: CloudCharacter) => run('save', async () => {
    const c = activeCharacter()
    if (!c) return
    const label = ((app.draft ? '' : activeStored()?.label) || c.name || 'Character').slice(0, 100)
    await api(replace ? `/characters/${replace.id}` : '/characters', replace ? 'PUT' : 'POST', { label, raw: c.raw })
    await lists()
    toast('good', replace ? `Replaced ${replace.label} with ${label} in the cloud.` : `Saved ${label} to the cloud.`)
  })
  const download = (id: string) => run('download', async () => {
    const saved = await api<{ label: string; raw: string }>(`/characters/${id}`)
    const { parsed, match } = cloudDownload(saved.raw, app.characters)
    await saveCharacter(parsed, match?.label ?? saved.label, match?.id)
    toast('good', `${match ? 'Updated' : 'Added'} ${saved.label} on this device.`)
  })
  const removeCloud = (id: string) => run('remove', async () => {
    await api(`/characters/${id}`, 'DELETE')
    await lists()
  })
  const revoke = (id: string) => run('revoke', async () => {
    await api(`/shares/${id}`, 'DELETE')
    await lists()
  })

  const exportData = () => run('export', async () => {
    const data = await api('/me/export')
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'frostsim-account.json'
    a.click()
    URL.revokeObjectURL(url)
  })
  const deleteAccount = () => run('delete', async () => {
    // 202 {pending}: Stripe or storage cleanup continues on the server's hourly retry; the account is locked already.
    const out = await api<{ pending?: boolean } | undefined>('/me', 'DELETE')
    signedOut()
    confirm = ''
    toast('good', out?.pending ? 'Account deletion started. It finishes within the hour.' : 'Account deleted.')
  })
  const signOut = () => run('signout', async () => {
    await api('/auth/logout', 'POST')
    signedOut()
    toast('info', 'Signed out.')
  })
</script>

<Dialog bind:open={account.open} title={me ? 'Account' : 'Sign in'} width="36rem" onclose={() => (account.open = false)}>
  <div class="stack">
    {#if account.notice}<p class="small err" role="alert">{account.notice}</p>{/if}
    {#if error}<p class="small err" role="alert">{error}</p>{/if}
    {#if busy}<p class="xs muted" role="status">Working…</p>{/if}

    {#if account.guildToken}
      <section class="stack-sm" aria-labelledby="acct-guild">
        <h3 id="acct-guild">Discord server plan</h3>
        {#if me}
          <p class="small">
            Subscribes the Discord server with ID {guildId ?? 'unknown'} to its own pool of cloud runs, billed to you. Discord shows
            this link only to whoever ran /frostsim subscribe, so continue only if that was you.
          </p>
          <div class="row">
            <button class="primary" disabled={!!busy} onclick={() => checkout('discord_guild_monthly', account.guildToken ?? undefined)}>Continue to checkout</button>
            <button class="ghost" onclick={() => (account.guildToken = null)}>Not now</button>
          </div>
        {:else}
          <p class="small">Sign in first. You come back here afterwards.</p>
        {/if}
      </section>
    {/if}

    {#if !me}
      <p class="small">
        Frostsim works without an account. Signing in adds cloud character slots, hosted report links and cloud runs.
      </p>
      {#if providers.length}
        <div class="row">
          {#each providers as p (p.id)}
            <button onclick={() => location.assign(startUrl(p.id, 'login'))}>Sign in with {p.label}</button>
          {/each}
        </div>
      {:else if !busy && !error}
        <p class="small muted">No sign-in method is set up on this server.</p>
      {/if}
    {:else}
      <section class="stack-sm" aria-labelledby="acct-profile">
        <h3 id="acct-profile">Profile</h3>
        <form class="row" onsubmit={(e) => { e.preventDefault(); void rename() }}>
          <label class="field grow"><span>Display name</span><input type="text" bind:value={name} maxlength="64" required /></label>
          <button type="submit" disabled={!!busy || !name.trim() || name.trim() === me.user.displayName}>Save</button>
        </form>
      </section>

      <section class="stack-sm" aria-labelledby="acct-ids">
        <h3 id="acct-ids">Sign-in methods</h3>
        <ul>
          {#each me.identities as id (id.provider)}
            <li class="spread">
              <span>{providerLabel(id.provider)}{id.displayName ? ` · ${id.displayName}` : ''}</span>
              <button class="sm ghost" disabled={!!busy || me.identities.length < 2} onclick={() => unlink(id.provider)} aria-label="Unlink {providerLabel(id.provider)}">Unlink</button>
            </li>
          {/each}
        </ul>
        {#if providers.some((p) => !linked.has(p.id))}
          <div class="row">
            {#each providers.filter((p) => !linked.has(p.id)) as p (p.id)}
              <button class="sm" onclick={() => location.assign(startUrl(p.id, 'link'))}>Link {p.label}</button>
            {/each}
          </div>
        {/if}
        <p class="xs muted">Removing a sign-in method signs out your other devices. The last one cannot be removed.</p>
      </section>

      {#if billing}
        <section class="stack-sm" aria-labelledby="acct-plan">
          <h3 id="acct-plan">Plan and usage</h3>
          {#if billing.entitlements.maxThreads >= 1}
            <p class="small">
              Cloud runs on up to {billing.entitlements.maxThreads} threads. {hours(billing.usage.usedCoreSeconds)} of
              {hours(billing.entitlements.coreSeconds)} core-hours used this period, which ends {when(billing.usage.periodEnd)}.
            </p>
          {:else}
            <p class="small">No cloud runs on this account. Simulations run in this browser.</p>
          {/if}
          <p class="small">
            {billing.entitlements.slots} cloud character slots · hosted links {billing.entitlements.hostedShares ? 'included' : 'not included'}
          </p>
          {#if billing.subscriptions.length}
            <ul class="small">
              {#each billing.subscriptions as s (s.id)}
                <li>{s.lookupKeys.map(planName).join(', ')} · {s.status}{s.periodEnd ? ` · period ends ${when(s.periodEnd)}` : ''}</li>
              {/each}
            </ul>
          {/if}
          <ul>
            {#each PLANS as [key, title, blurb] (key)}
              <li class="spread">
                <span><strong>{title}</strong> <span class="xs muted">{blurb}</span></span>
                <button class="sm" disabled={!!busy} onclick={() => checkout(key)} aria-label="Subscribe to {title}">Subscribe</button>
              </li>
            {/each}
          </ul>
          <div class="row">
            <button class="sm" disabled={!!busy} onclick={portal}>Manage billing</button>
            <span class="xs muted">Prices and included core-hours show at checkout.</span>
          </div>
        </section>
      {/if}

      {#if cloud}
        <section class="stack-sm" aria-labelledby="acct-chars">
          <h3 id="acct-chars">Cloud characters <span class="xs muted">{cloud.characters.length} of {cloud.slots} slots</span></h3>
          {#if cloud.characters.length}
            <ul>
              {#each cloud.characters as c (c.id)}
                <li class="spread">
                  <span>{c.label} <span class="xs muted">{fmtBytes(c.bytes)} · {when(c.updatedAt)}</span></span>
                  <span class="row-tight">
                    <button class="sm" disabled={!!busy} onclick={() => download(c.id)} aria-label="Download {c.label} to this device">Download to this device</button>
                    <button class="sm" disabled={!!busy || !character} onclick={() => saveToCloud(c)} aria-label="Replace {c.label} with the current character">Replace with current</button>
                    <button class="sm ghost" disabled={!!busy} onclick={() => removeCloud(c.id)} aria-label="Delete {c.label} from the cloud">Delete</button>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
          <div>
            <button class="sm" disabled={!!busy || !character || cloud.characters.length >= cloud.slots} onclick={() => saveToCloud()}>Save current character to cloud</button>
          </div>
        </section>
      {/if}

      {#if shares}
        <section class="stack-sm" aria-labelledby="acct-shares">
          <h3 id="acct-shares">Hosted report links</h3>
          {#if shares.length}
            <ul>
              {#each shares as s (s.id)}
                <li class="spread">
                  <span>
                    <a href="#/s/{s.id}" onclick={() => (account.open = false)}>{s.title}</a>
                    <span class="xs muted">{when(s.createdAt)}{s.expiresAt ? ` · expires ${when(s.expiresAt)}` : ''}</span>
                  </span>
                  <button class="sm ghost" disabled={!!busy} onclick={() => revoke(s.id)} aria-label="Revoke {s.title}">Revoke</button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="small muted">None yet. Create one from a report's Share button.</p>
          {/if}
        </section>
      {/if}

      <section class="stack-sm" aria-labelledby="acct-apps">
        <h3 id="acct-apps">Connected apps</h3>
        <label class="row-tight">
          <input
            type="checkbox"
            checked={me.integrations.includes('loothing')}
            disabled={!!busy}
            onchange={(e) => {
              // One-way `checked`: after a failed request `me` is unchanged, so put the box back to what the server has.
              const box = e.currentTarget
              void loothing(box.checked).then(() => (box.checked = !!account.me?.integrations.includes('loothing')))
            }}
          />
          Allow Loothing
        </label>
        <p class="xs muted">Lets Loothing's Discord bot run simulations of your cloud characters on your plan. Needs a linked Discord sign-in.</p>
      </section>

      <section class="stack-sm" aria-labelledby="acct-data">
        <h3 id="acct-data">Your data</h3>
        <div><button class="sm" disabled={!!busy} onclick={exportData}>Export account data</button></div>
        <details class="disclosure">
          <summary>Delete account</summary>
          <form class="stack-sm" onsubmit={(e) => { e.preventDefault(); void deleteAccount() }}>
            <p class="small">
              Deletes the account, its cloud characters and hosted links, and cancels its subscriptions. Characters and reports saved
              on this device stay.
            </p>
            <label class="field"><span>Type DELETE to confirm</span><input type="text" bind:value={confirm} autocomplete="off" /></label>
            <div><button type="submit" class="danger" disabled={!!busy || confirm !== 'DELETE'}>Delete account</button></div>
          </form>
        </details>
      </section>
    {/if}
  </div>
  {#snippet footer()}
    {#if me}<button class="ghost" disabled={!!busy} onclick={signOut}>Sign out</button>{/if}
    <button onclick={() => (account.open = false)}>Close</button>
  {/snippet}
</Dialog>

<style>
  h3 { font-size: 15px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s2); }
  .err { color: var(--bad); }
</style>
