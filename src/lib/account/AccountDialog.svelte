<script lang="ts">
  // Account dialog (CLAUDE.md D15; DESIGN.md C10, P4-P6): sign-in, then three tabs: plan and usage, hosted links, settings. Plans are
  // sold on #/plans and cloud characters live on the Character page. Sign-in, checkout and the billing portal are top-level
  // navigations (CSP form-action 'none', COOP), and forms only ever run fetch from onsubmit.
  import { untrack } from 'svelte'
  import { Cloud, Link2, Settings, Sparkles } from '@lucide/svelte'
  import Dialog from '../ui/Dialog.svelte'
  import { toast } from '../app.svelte'
  import { fmtDateTime } from '../format'
  import { navigate } from '../router.svelte'
  import { api, AccountError } from './api'
  import { account, checkout, currentPlans, guildOf, portal, refresh, signedOut, startUrl, type Me } from './state.svelte'
  import { FREE_SLOTS, PLANS, TERMS, approxSims, discountPercent, lookupKey, slotsLabel, termsOf, type Term } from './plans'

  interface Provider { id: string; label: string }
  interface Share { id: string; title: string; bytes: number | null; createdAt: string; expiresAt: string | null }

  const GUILD = PLANS.find((p) => p.kind === 'guild')!
  const TABS = [
    { id: 'plan', label: 'Plan', icon: Cloud },
    { id: 'links', label: 'Links', icon: Link2 },
    { id: 'settings', label: 'Settings', icon: Settings },
  ] as const

  let tab = $state<(typeof TABS)[number]['id']>('plan')
  let term = $state<Term>('monthly')
  let providers = $state<Provider[]>([])
  let shares = $state<Share[] | null>(null)
  let busy = $state('')
  let error = $state('')
  let name = $state('')
  let confirm = $state('')

  const me = $derived(account.me)
  const billing = $derived(account.billing)
  const ent = $derived(billing?.entitlements)
  const current = $derived(currentPlans(billing))
  const plan = $derived(PLANS.find((p) => current.has(p.id)))
  const sub = $derived(billing?.subscriptions.find((s) => !s.guildId && s.lookupKeys.some((k) => plan && k.startsWith(`${plan.id}_`))))
  const left = $derived(ent && billing ? Math.max(0, ent.coreSeconds - billing.usage.usedCoreSeconds) : 0)
  const usedPct = $derived(ent?.coreSeconds ? Math.min(100, (100 * (billing?.usage.usedCoreSeconds ?? 0)) / ent.coreSeconds) : 0)
  const linked = $derived(new Set(me?.identities.map((i) => i.provider)))
  const guildId = $derived(account.guildToken ? guildOf(account.guildToken) : null)
  const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')
  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id
  const termOf = (key: string | undefined) => (Object.keys(TERMS) as Term[]).find((t) => key?.endsWith(`_${t}`))

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
    // Hosted links are a server feature; switched off, the tab says so.
    if (account.me) shares = (await api<{ shares: Share[] }>('/shares').catch(() => null))?.shares ?? null
  })

  const plans = () => {
    account.open = false
    navigate('plans')
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
  const revoke = (id: string) => run('revoke', async () => {
    await api(`/shares/${id}`, 'DELETE')
    shares = shares?.filter((s) => s.id !== id) ?? null
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

<Dialog bind:open={account.open} title={account.guildToken ? 'Discord server plan' : me ? 'Account' : 'Sign in'} width="30rem" onclose={() => (account.open = false)}>
  <div class="stack">
    {#if account.notice}<p class="small err" role="alert">{account.notice}</p>{/if}
    {#if error}<p class="small err" role="alert">{error}</p>{/if}

    {#if !me}
      <div class="hello">
        <span class="mark" aria-hidden="true"><Sparkles size={22} /></span>
        <p>Keep your characters on every device, share reports as links and run sims in the cloud.</p>
      </div>
      {#if account.guildToken}<p class="small">Sign in to subscribe your Discord server. You come back here afterwards.</p>{/if}
      <div class="providers">
        {#each providers as p (p.id)}
          <button class="provider" data-provider={p.id} onclick={() => location.assign(startUrl(p.id, 'login'))}>Continue with {p.label}</button>
        {:else}
          {#if !busy && !error}<p class="small muted">No sign-in method is set up on this server.</p>{/if}
        {/each}
      </div>
      <p class="xs muted center">Frostsim is free without an account. <button class="linkish" onclick={plans}>See plans</button></p>
    {:else if account.guildToken}
      <div class="card stack-sm">
        <p class="small">Gives the Discord server <span class="mono">{guildId ?? 'unknown'}</span> its own pool for /sim, billed to you.</p>
        <p class="big">≈ {approxSims((GUILD.coreHoursPerMonth ?? 0) * 3600).toLocaleString()} <span class="small muted">sims a month, shared</span></p>
        <div class="segmented" role="radiogroup" aria-label="Billing term">
          {#each termsOf(GUILD) as t (t)}
            <label><input type="radio" name="guild-term" value={t} checked={term === t} onchange={() => (term = t)} />
              {TERMS[t].label}{#if discountPercent(GUILD, t)}<span class="save">−{discountPercent(GUILD, t)}%</span>{/if}</label>
          {/each}
        </div>
        <p class="xs muted">Only works for the account linked to the Discord user who ran /frostsim subscribe.</p>
      </div>
      <div class="row">
        <button class="primary" disabled={!!busy} onclick={() => run('checkout', () => checkout(lookupKey(GUILD, term), account.guildToken ?? undefined))}>
          Continue · ${GUILD.usd?.[term]}{term === 'monthly' ? '/month' : ` for ${TERMS[term].months} months`}
        </button>
        <button class="ghost" onclick={() => (account.guildToken = null)}>Not now</button>
      </div>
    {:else}
      <div class="who">
        <span class="avatar" aria-hidden="true">{me.user.displayName.slice(0, 1).toUpperCase()}</span>
        <span class="grow">
          <strong class="truncate">{me.user.displayName}</strong>
          <span class="xs muted">{me.identities.map((i) => providerLabel(i.provider)).join(' · ')}</span>
        </span>
        <span class="chip" class:accent={!!plan}>{plan?.title ?? 'Free'}</span>
      </div>

      <div class="tabs" role="tablist" aria-label="Account">
        {#each TABS as t (t.id)}
          <button role="tab" id="acct-tab-{t.id}" aria-selected={tab === t.id} aria-controls="acct-panel" class:on={tab === t.id} onclick={() => (tab = t.id)}>
            <t.icon size={15} aria-hidden="true" />{t.label}
          </button>
        {/each}
      </div>

      <div id="acct-panel" role="tabpanel" aria-labelledby="acct-tab-{tab}" class="stack-sm">
        {#if tab === 'plan'}
          {#if ent && ent.maxThreads >= 1}
            <div class="card">
              <p class="big">≈ {approxSims(left).toLocaleString()} <span class="small muted">sims left</span></p>
              <div class="meter" role="meter" aria-label="Cloud allowance used" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(usedPct)}><span style="width: {usedPct}%"></span></div>
              <p class="xs muted">{((billing?.usage.usedCoreSeconds ?? 0) / 3600).toFixed(1)} of {(ent.coreSeconds / 3600).toFixed(0)} core-hours used · resets {date(billing?.usage.periodEnd)}</p>
            </div>
          {:else}
            <div class="card">
              <p><strong>Free</strong> <span class="small muted">· sims run in this browser</span></p>
              <p class="xs muted">Cloud runs, more character slots and report links come with a plan, from $3 a month.</p>
            </div>
          {/if}
          <ul class="facts">
            {#if ent && ent.maxThreads >= 1}<li><strong>{ent.maxThreads}</strong> threads</li>{/if}
            <li><strong>{slotsLabel(ent?.slots ?? FREE_SLOTS)}</strong> character slot{(ent?.slots ?? FREE_SLOTS) === 1 ? '' : 's'}</li>
            <li><strong>{ent?.hostedShares ? 'Yes' : 'No'}</strong> report links</li>
          </ul>
          {#if sub}
            <p class="xs muted">
              {plan?.title}, {TERMS[termOf(sub.lookupKeys[0]) ?? 'monthly'].label.toLowerCase()}{sub.status === 'past_due' ? ' · payment failed, update your card' : sub.periodEnd ? ` · renews ${date(sub.periodEnd)}` : ''}
            </p>
          {/if}
          <div class="row">
            {#if plan}
              <button class="sm" disabled={!!busy} onclick={() => run('portal', portal)}>Manage billing</button>
              <button class="sm ghost" onclick={plans}>Compare plans</button>
            {:else}
              <button class="primary" onclick={plans}><Sparkles size={16} /> See plans</button>
              {#if billing?.subscriptions.length}<button class="sm ghost" disabled={!!busy} onclick={() => run('portal', portal)}>Billing history</button>{/if}
            {/if}
          </div>
        {:else if tab === 'links'}
          {#if shares?.length}
            <ul class="list">
              {#each shares as s (s.id)}
                <li>
                  <a class="grow truncate" href="#/s/{s.id}" onclick={() => (account.open = false)}>{s.title}</a>
                  <span class="xs muted nowrap">{date(s.createdAt)}{s.expiresAt ? ` → ${date(s.expiresAt)}` : ''}</span>
                  <button class="sm ghost" disabled={!!busy} onclick={() => revoke(s.id)} aria-label="Revoke {s.title}">Revoke</button>
                </li>
              {/each}
            </ul>
          {:else if ent?.hostedShares}
            <p class="small muted">No links yet. Use Share on any report to make one.</p>
          {:else}
            <p class="small muted">Share a report as a short link. <button class="linkish" onclick={plans}>Comes with every plan.</button></p>
          {/if}
        {:else}
          <form class="row" onsubmit={(e) => { e.preventDefault(); void rename() }}>
            <label class="field grow"><span>Display name</span><input type="text" bind:value={name} maxlength="64" required /></label>
            <button type="submit" class="sm end" disabled={!!busy || !name.trim() || name.trim() === me.user.displayName}>Save</button>
          </form>
          <div class="stack-sm">
            <span class="label">Sign-in methods</span>
            <ul class="list">
              {#each me.identities as id (id.provider)}
                <li>
                  <span class="grow">{providerLabel(id.provider)} <span class="xs muted">{id.displayName ?? ''}</span></span>
                  <button class="sm ghost" disabled={!!busy || me.identities.length < 2} title={me.identities.length < 2 ? 'Your only sign-in method' : 'Unlinking signs out your other devices'} onclick={() => unlink(id.provider)}>Unlink</button>
                </li>
              {/each}
              {#each providers.filter((p) => !linked.has(p.id)) as p (p.id)}
                <li><span class="grow muted">{p.label}</span><button class="sm" onclick={() => location.assign(startUrl(p.id, 'link'))}>Link</button></li>
              {/each}
            </ul>
          </div>
          <label class="check small" title="Lets Loothing's Discord bot sim your cloud characters on your plan. Needs a linked Discord sign-in.">
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
            Allow Loothing's Discord bot to sim my cloud characters
          </label>
          <p class="small row-tight">Frostsim's own Discord bot: <a href="/api/v1/discord/install">add it to a server</a>{#if billing?.subscriptions.some((s) => s.guildId)} · <a href="#/discord" onclick={() => (account.open = false)}>server settings</a>{/if}</p>
          <div class="row">
            <button class="sm" disabled={!!busy} onclick={exportData}>Export my data</button>
            <details class="disclosure grow">
              <summary class="small">Delete account</summary>
              <form class="stack-sm" onsubmit={(e) => { e.preventDefault(); void deleteAccount() }}>
                <p class="xs muted">Removes cloud characters and links and cancels plans. This device keeps its own data.</p>
                <label class="field"><span>Type DELETE to confirm</span><input type="text" bind:value={confirm} autocomplete="off" /></label>
                <div><button type="submit" class="sm danger" disabled={!!busy || confirm !== 'DELETE'}>Delete account</button></div>
              </form>
            </details>
          </div>
        {/if}
      </div>
    {/if}
  </div>
  {#snippet footer()}
    {#if me}<button class="ghost" disabled={!!busy} onclick={signOut}>Sign out</button><span class="grow"></span>{/if}
    <button onclick={() => (account.open = false)}>Close</button>
  {/snippet}
</Dialog>

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  .err { color: var(--bad); }
  .center { text-align: center; }
  .label { font-weight: 550; font-size: var(--fs-sm); }
  .end { align-self: flex-end; }
  .hello { display: grid; justify-items: center; gap: var(--s3); text-align: center; padding: var(--s3) var(--s4) 0; }
  .hello p { margin: 0; color: var(--text-muted); max-width: 22rem; }
  .mark {
    display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: 50%;
    background: var(--grad); color: #04121f; box-shadow: 0 0 40px -8px var(--accent-glow);
  }
  .providers { display: grid; gap: var(--s2); }
  .provider { width: 100%; min-height: 2.75rem; font-weight: 600; }
  .provider[data-provider='discord'] { background: #5865f2; border-color: #5865f2; color: #fff; }
  .provider[data-provider='battlenet'] { background: #148eff; border-color: #148eff; color: #fff; }
  .linkish { all: unset; color: var(--accent); cursor: pointer; }
  .linkish:hover { text-decoration: underline; }
  .linkish:focus-visible { box-shadow: var(--focus); border-radius: 2px; }
  .who { display: flex; align-items: center; gap: var(--s3); }
  .who > .grow { display: grid; min-width: 0; }
  .avatar {
    flex: none; display: grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: 50%;
    font: 700 18px var(--font-display); background: var(--grad); color: #04121f;
  }
  .tabs { display: flex; gap: var(--s1); border-bottom: 1px solid var(--border); }
  .tabs button {
    all: unset; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; margin-bottom: -1px;
    font-size: var(--fs-sm); color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent;
  }
  .tabs button:hover { color: var(--text); }
  .tabs button.on { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
  .tabs button:focus-visible { box-shadow: var(--focus); border-radius: 4px; }
  .card { display: grid; gap: var(--s2); padding: var(--s4); border-radius: var(--r3); background: var(--well); border: 1px solid var(--border); }
  .card p { margin: 0; }
  .big { font: 700 26px var(--font-display); letter-spacing: -0.01em; }
  .meter { height: 8px; border-radius: 99px; background: var(--bar-track); overflow: hidden; }
  .meter span { display: block; height: 100%; min-width: 3px; border-radius: inherit; background: var(--grad); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: var(--s2); }
  .facts li { display: grid; padding: var(--s2) var(--s3); border: 1px solid var(--border); border-radius: var(--r2); font-size: var(--fs-xs); color: var(--text-muted); }
  .facts strong { color: var(--text); font-family: var(--font-display); font-size: 18px; }
  .list { display: grid; }
  .list li { display: flex; align-items: center; gap: var(--s2); padding: 6px 0; border-bottom: 1px solid var(--border); min-width: 0; }
  .list li:last-child { border-bottom: 0; }
  .save { margin-left: 4px; font-size: var(--fs-xs); color: var(--good); font-weight: 600; }
</style>
