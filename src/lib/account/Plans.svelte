<script lang="ts">
  // Frostsim Cloud plans page, #/plans (CLAUDE.md D15; DESIGN.md C6). Prices and allowances come from plans.ts, the table the server
  // grants from; Stripe checkout shows the amount charged.
  import { ChartLine, Check, CloudUpload, Link2, MessagesSquare, Minus, Sparkles, Zap } from '@lucide/svelte'
  import { SOURCE_URL } from '../source'
  import { navigate } from '../router.svelte'
  import { account, checkout, currentPlans, portal } from './state.svelte'
  import { FREE_SLOTS, PLANS, TERMS, UNLIMITED_SLOTS, approxSims, discountPercent, lookupKey, perMonth, type Plan, type Term } from './plans'

  const SOLD = PLANS.filter((p) => p.kind === 'compute')
  const GUILD = PLANS.find((p) => p.kind === 'guild')!
  /** Most sims per dollar, so "Best value" is a fact rather than a nudge. */
  const BEST = SOLD.reduce((a, b) => ((b.coreHoursPerMonth ?? 0) / (b.usd?.monthly ?? 1) > (a.coreHoursPerMonth ?? 0) / (a.usd?.monthly ?? 1) ? b : a))
  const TERM_SAVE = (t: Term) => Math.max(...SOLD.map((p) => discountPercent(p, t)))

  let term = $state<Term>('yearly')
  let busy = $state('')
  let error = $state('')

  const current = $derived(currentPlans(account.billing))
  const sims = (p: Plan) => approxSims((p.coreHoursPerMonth ?? 0) * 3600).toLocaleString()
  const money = (n: number | undefined) => (n === undefined ? '' : Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)

  async function act(p: Plan): Promise<void> {
    if (!account.me) {
      account.open = true
      return
    }
    busy = p.id
    error = ''
    try {
      await (current.size ? portal() : checkout(lookupKey(p, term)))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = ''
    }
  }
  const cta = (p: Plan) => (current.has(p.id) ? 'Your plan' : current.size ? 'Switch plan' : account.me ? `Get ${p.title}` : 'Sign in to subscribe')
</script>

<div class="page">
  <section class="hero">
    <span class="eyebrow"><Sparkles size={14} aria-hidden="true" /> Frostsim Cloud</span>
    <h1>Sim on our servers.<br />Keep your PC for the game.</h1>
    <p class="lede">Frostsim is free and runs in your browser. Cloud plans move the heavy runs to 16-core servers, keep your characters on every device and turn reports into links for your guild.</p>
    <div class="row cta">
      <a class="button primary" href="#plans-grid" onclick={(e) => { e.preventDefault(); document.getElementById('plans-grid')?.scrollIntoView({ behavior: 'smooth' }) }}>See plans</a>
      <span class="small muted">From $3 a month · cancel any time</span>
    </div>
  </section>

  <ul class="perks">
    <li class="panel">
      <span class="icon"><Zap size={20} /></span>
      <h2>Cloud runs</h2>
      <p>Top Gear, Droptimizer and Quick Sim run on our servers. No fan noise, no dropped frames while you play.</p>
    </li>
    <li class="panel">
      <span class="icon"><CloudUpload size={20} /></span>
      <h2>Your characters, anywhere</h2>
      <p>Save your main and alts to character slots. Load them on your laptop, your desktop or a friend's PC.</p>
    </li>
    <li class="panel">
      <span class="icon"><ChartLine size={20} /></span>
      <h2>Track your progress</h2>
      <p>Every slot charts your item level and DPS over time. When a patch lands, we re-sim your characters so you see what changed.</p>
    </li>
    <li class="panel">
      <span class="icon"><Link2 size={20} /></span>
      <h2>Report links</h2>
      <p>Share a finished report as one short link. Drop it in Discord and everyone sees the same numbers.</p>
    </li>
  </ul>

  <section id="plans-grid" class="pricing" aria-labelledby="pricing-title">
    <div class="pricing-head">
      <div>
        <h2 id="pricing-title">Pick your cloud compute</h2>
        <p class="small muted">You pay for server time. Every tier also gets more character slots.</p>
      </div>
      <div class="segmented" role="radiogroup" aria-label="Billing term">
        {#each Object.entries(TERMS) as [t, spec] (t)}
          <label>
            <input type="radio" name="plans-term" value={t} checked={term === t} onchange={() => (term = t as Term)} />
            {spec.label}{#if TERM_SAVE(t as Term)}<span class="save">−{TERM_SAVE(t as Term)}%</span>{/if}
          </label>
        {/each}
      </div>
    </div>
    {#if error}<p class="small err" role="alert">{error}</p>{/if}

    <div class="cards">
      <article class="card panel">
        <p class="spec">Your own PC</p>
        <h3>Free</h3>
        <p class="tag">Sims in your browser</p>
        <p class="price"><span class="amount">$0</span></p>
        <p class="note">forever</p>
        <p class="sims">Unlimited sims <span>in your browser</span></p>
        <ul>
          <li><Check size={16} />Every tool, no limits</li>
          <li><Check size={16} />{FREE_SLOTS} character slot with gear and DPS history</li>
          <li class="no"><Minus size={16} />Cloud runs</li>
          <li class="no"><Minus size={16} />Patch re-sims</li>
          <li class="no"><Minus size={16} />Report links</li>
        </ul>
        <button onclick={() => navigate('quick')}>Start simming</button>
      </article>

      {#each SOLD as p (p.id)}
        {@const off = discountPercent(p, term)}
        <article class="card panel" class:best={p === BEST} class:mine={current.has(p.id)}>
          {#if current.has(p.id)}<span class="ribbon">Your plan</span>{:else if p === BEST}<span class="ribbon">Best value</span>{/if}
          <p class="spec">{p.maxThreads} cores · {p.coreHoursPerMonth} core-hours a month</p>
          <h3>{p.title}</h3>
          <p class="tag">{p.blurb}</p>
          <p class="price"><span class="amount">{money(perMonth(p, term))}</span><span class="per">/month</span></p>
          <p class="note">{term === 'monthly' ? 'billed monthly' : term === 'yearly' ? `${money(p.usd?.[term])} billed yearly` : `${money(p.usd?.[term])} every ${TERMS[term].months} months`}{#if off} · <span class="good">save {off}%</span>{/if}</p>
          <p class="sims">≈ {sims(p)} sims <span>a month in the cloud</span></p>
          <ul>
            <li><Check size={16} />{p.maxThreads}-core cloud runs</li>
            <li><Check size={16} />{(p.extraSlots ?? 0) >= UNLIMITED_SLOTS ? 'Unlimited' : FREE_SLOTS + (p.extraSlots ?? 0)} character slots with history</li>
            <li><Check size={16} />Patch re-sims of every slot</li>
            {#if p.id === 'compute_l'}<li><Check size={16} />Hybrid runs: your PC and the cloud on one sim</li>{/if}
            <li><Check size={16} />Report links</li>
            <li><Check size={16} />Browser sims stay unlimited</li>
          </ul>
          <button class:primary={p === BEST || current.has(p.id)} disabled={!!busy || current.has(p.id)} onclick={() => act(p)}>
            {busy === p.id ? 'Opening checkout…' : cta(p)}
          </button>
        </article>
      {/each}
    </div>
    <p class="xs muted fine">
      Prices in US dollars; checkout shows the exact amount. A sim here is a Quick Sim at 4,000 iterations. Big Top Gear runs and
      heavy fights count as several.
    </p>
  </section>

  <section class="guild panel" aria-labelledby="guild-title">
    <span class="icon big"><MessagesSquare size={26} /></span>
    <div class="grow">
      <h2 id="guild-title">For your guild's Discord</h2>
      <p>Add the Frostsim bot and anyone in your server can type <code>/sim</code>. One shared pool of ≈ {sims(GUILD)} sims a month, for {money(GUILD.usd?.monthly)}/month.</p>
    </div>
    <div class="how stack-sm">
      <a class="button discord" href="/api/v1/discord/install">Add Frostsim to Discord</a>
      <p class="small muted">Then run <code>/frostsim subscribe</code> in your server to start its pool.</p>
    </div>
  </section>

  <section class="faq" aria-labelledby="faq-title">
    <h2 id="faq-title">Questions</h2>
    <details><summary>Do I need a plan to use Frostsim?</summary><p>No. Every tool is free and runs in your browser. A plan adds cloud runs, more character slots and report links.</p></details>
    <details><summary>What happens when I run out of cloud sims?</summary><p>Your sims run in your browser again, like on the free plan, until your allowance resets next month.</p></details>
    <details><summary>What are patch re-sims?</summary><p>When a new game build reaches Frostsim, we sim each of your slotted characters once on a Patchwerk dummy and add the result to its DPS history. Each re-sim uses a little of your cloud allowance.</p></details>
    <details><summary>What are hybrid runs?</summary><p>With Avalanche, a run with many candidates (Top Gear, Droptimizer, compares) splits between your PC and a cloud server at once, then comes back as one report. Only the cloud share uses your allowance.</p></details>
    <details><summary>What if I switch to a smaller plan?</summary><p>Your saved characters stay. You can load, overwrite or clear them, and save new ones once you are back within your slots.</p></details>
    <details><summary>Can I cancel?</summary><p>Yes, any time, from Manage billing in your account.</p></details>
    <details><summary>Is it open source?</summary><p>Yes. Frostsim, the cloud server and the cloud workers are GPL-3.0. <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Read the code</a>.</p></details>
  </section>
</div>

<style>
  .page { display: grid; gap: clamp(2rem, 6vw, 4rem); padding-bottom: var(--s6); }
  .hero { display: grid; justify-items: center; text-align: center; gap: var(--s4); padding-top: clamp(1rem, 5vw, 3rem); }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 99px;
    border: 1px solid var(--accent-border); color: var(--accent); font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  }
  .hero h1 { font-size: clamp(2rem, 6vw, 3.5rem); line-height: 1.05; margin: 0; }
  .lede { max-width: 38rem; margin: 0; color: var(--text-muted); font-size: clamp(1rem, 2vw, 1.15rem); }
  .cta { justify-content: center; }
  .button { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 1.4rem; border-radius: var(--r2); font-weight: 650; text-decoration: none; }
  .button.primary { background: var(--grad); color: #04121f; box-shadow: 0 10px 30px -10px var(--accent-glow); }
  .button.primary:hover { filter: brightness(1.08); }
  .button:focus-visible { box-shadow: var(--focus); }

  .perks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(15rem, 100%), 1fr)); gap: var(--s4); }
  .perks li { padding: var(--s5); display: grid; gap: var(--s2); align-content: start; }
  .perks h2 { font-size: 18px; margin: 0; }
  .perks p { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
  .icon { display: grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: var(--r3); background: var(--accent-soft); color: var(--accent); }
  .icon.big { width: 3.5rem; height: 3.5rem; flex: none; background: #5865f2; color: #fff; }

  .pricing { display: grid; gap: var(--s4); scroll-margin-top: calc(var(--header-h) + 1rem); }
  .pricing-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s3); }
  .pricing-head h2 { margin: 0; font-size: 26px; }
  .pricing-head p { margin: 2px 0 0; }
  .save { margin-left: 5px; font-size: var(--fs-xs); color: var(--good); font-weight: 650; }
  .err { color: var(--bad); margin: 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr)); gap: var(--s4); align-items: stretch; }
  .card { display: flex; flex-direction: column; gap: var(--s2); padding: var(--s5); }
  .card h3 { margin: 0; font-size: 20px; }
  .card p { margin: 0; }
  .tag { color: var(--text-muted); font-size: var(--fs-sm); min-height: 1.3em; }
  .spec { font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: var(--accent); }
  .price { display: flex; align-items: baseline; gap: 4px; margin-top: var(--s3) !important; }
  .amount { font: 700 40px/1 var(--font-display); letter-spacing: -0.02em; }
  .per { color: var(--text-muted); }
  .note { font-size: var(--fs-xs); color: var(--text-muted); min-height: 1.4em; }
  .good { color: var(--good); font-weight: 600; }
  .sims { margin: var(--s3) 0 !important; padding: var(--s2) var(--s3); border-radius: var(--r2); background: var(--well); font-weight: 650; }
  .sims span { font-weight: 400; color: var(--text-muted); font-size: var(--fs-sm); }
  .card ul { list-style: none; margin: 0 0 var(--s4); padding: 0; display: grid; gap: var(--s2); font-size: var(--fs-sm); flex: 1; align-content: start; }
  .card li { display: flex; align-items: center; gap: var(--s2); }
  .card li :global(svg) { flex: none; color: var(--good); }
  .card li.no { color: var(--text-faint); }
  .card li.no :global(svg) { color: var(--text-faint); }
  .card button { width: 100%; min-height: 2.75rem; }
  .best { border-color: transparent; background: linear-gradient(var(--glass-strong), var(--glass-strong)) padding-box, var(--grad) border-box; border: 1px solid transparent; box-shadow: 0 20px 50px -24px var(--accent-glow); }
  .mine { outline: 2px solid var(--accent); outline-offset: -1px; }
  .ribbon {
    position: absolute; top: -11px; right: var(--s4); padding: 2px 10px; border-radius: 99px; font-size: var(--fs-xs); font-weight: 700;
    background: var(--grad); color: #04121f; letter-spacing: 0.03em;
  }
  .fine { margin: 0; text-align: center; }

  .guild { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s4); padding: var(--s5); }
  .guild h2 { margin: 0 0 var(--s1); font-size: 20px; }
  .guild p { margin: 0; }
  .guild .grow { flex: 1 1 18rem; }
  .how { flex: 0 1 16rem; }
  .how p { margin: 0; }
  .button.discord { justify-content: center; background: #5865f2; color: #fff; }
  .button.discord:hover { filter: brightness(1.1); }

  .faq { display: grid; gap: var(--s2); max-width: 46rem; width: 100%; justify-self: center; }
  .faq h2 { font-size: 22px; margin: 0 0 var(--s2); text-align: center; }
  .faq details { border-bottom: 1px solid var(--border); padding: var(--s3) 0; }
  .faq summary { cursor: pointer; font-weight: 600; }
  .faq p { margin: var(--s2) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
</style>
