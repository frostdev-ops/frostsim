// Creates the Stripe Products and Prices for the plan table (src/lib/account/plans.ts; CLAUDE.md D15, DESIGN.md C6), one Price per
// plan and term with lookup key `<plan>_<term>`. Dry run by default; --apply writes. A changed amount gets a new Price that takes
// over the lookup key (transfer_lookup_key), so existing subscribers keep theirs. Plans without a price in the table are skipped.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-catalog.mjs [--apply] [--live]

import { PLANS, TERMS, lookupKey, termsOf } from '../src/lib/account/plans.ts';

const API = 'https://api.stripe.com/v1';

/** Every Price the table asks for. */
export function desiredPrices(plans = PLANS) {
  return plans.flatMap((plan) => termsOf(plan).flatMap((term) => {
    const usd = plan.usd?.[term];
    if (usd === undefined) return [];
    const { interval, intervalCount } = TERMS[term];
    return [{ plan: plan.id, name: plan.kind === 'guild' ? `Frostsim ${plan.title}` : `Frostsim Cloud ${plan.title}`, lookupKey: lookupKey(plan, term), unitAmount: Math.round(usd * 100), currency: 'usd', interval, intervalCount }];
  }));
}

/** What to do for each desired Price, given the active Prices Stripe has under those lookup keys. */
export function plan(desired, existing) {
  return desired.map((want) => {
    const have = existing.find((p) => p.lookup_key === want.lookupKey);
    const same = have && have.unit_amount === want.unitAmount && have.currency === want.currency
      && have.recurring?.interval === want.interval && (have.recurring?.interval_count ?? 1) === want.intervalCount;
    return { action: same ? 'keep' : have ? 'replace' : 'create', ...want };
  });
}

function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') form(v, key, out);
    else if (v !== undefined) out.append(key, String(v));
  }
  return out;
}

/** GET, or POST (the only write this script makes). */
async function stripe(key, method, path, params) {
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' };
  const res = method === 'GET'
    ? await fetch(`${API}${path}${params ? `?${form(params)}` : ''}`, { headers })
    : await fetch(`${API}${path}`, { method: 'POST', headers, body: form(params ?? {}) });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${res.status} ${body.error?.code ?? ''}`);
  return body;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Set STRIPE_SECRET_KEY.');
  if (/^[rs]k_live_/.test(key) && !process.argv.includes('--live')) throw new Error('This is a live key; pass --live to use it.');
  const desired = desiredPrices();
  const existing = [];
  for (let i = 0; i < desired.length; i += 10) {
    const page = await stripe(key, 'GET', '/prices', { active: true, limit: 100, lookup_keys: desired.slice(i, i + 10).map((d) => d.lookupKey) });
    existing.push(...page.data);
  }
  const products = (await stripe(key, 'GET', '/products', { active: true, limit: 100 })).data;
  for (const step of plan(desired, existing)) {
    console.log(`${step.action.padEnd(7)} ${step.lookupKey.padEnd(26)} $${(step.unitAmount / 100).toFixed(2)} / ${step.intervalCount} ${step.interval}`);
    if (!apply || step.action === 'keep') continue;
    let product = products.find((p) => p.metadata?.frostsim_plan === step.plan);
    if (!product) {
      // statement_descriptor: what subscription charges show on a card statement, instead of the Stripe account's own name.
      product = await stripe(key, 'POST', '/products', { name: step.name, statement_descriptor: 'FROSTSIM', metadata: { frostsim_plan: step.plan } });
      products.push(product);
    }
    await stripe(key, 'POST', '/prices', {
      product: product.id, currency: step.currency, unit_amount: step.unitAmount, lookup_key: step.lookupKey, transfer_lookup_key: true,
      recurring: { interval: step.interval, interval_count: step.intervalCount },
    });
  }
  for (const p of PLANS.filter((p) => p.usd?.monthly === undefined)) console.log(`skip    ${lookupKey(p, 'monthly').padEnd(26)} no price in the plan table; set it on Stripe`);
  if (!apply) console.log('\nDry run. Pass --apply to write.');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err.message); process.exit(1); });
