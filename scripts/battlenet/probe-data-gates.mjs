#!/usr/bin/env node
// Probes the Blizzard Game Data API for the data the catalog is still missing.
//
//   node scripts/battlenet/probe-data-gates.mjs
//
// Every gap in `remaining-catalog-scope.md` marked "data-gated" is an assertion
// about what an API does not expose. This asks it rather than asserting it, and
// prints SHAPES — endpoint, status, which keys came back — never values a user
// supplied and never the credentials. If a gate turns out to be open, the catalog
// can stop reporting that field as unavailable.
//
// Read-only. Nothing here writes to an account or changes anything upstream.

import { blizzardCredentials, loadDevVars } from './dev-vars.mjs';

const REGION = process.env.BLIZZARD_REGION ?? 'us';
const LOCALE = process.env.BLIZZARD_LOCALE ?? 'en_US';
const HOST = `https://${REGION}.api.blizzard.com`;
const STATIC = `static-${REGION}`;
const DYNAMIC = `dynamic-${REGION}`;

const credentials = blizzardCredentials(loadDevVars());
if (!credentials) {
  console.error('No Blizzard credentials configured. Nothing to probe.');
  process.exit(2);
}

async function accessToken() {
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`OAuth failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('OAuth returned no access token');
  return body.access_token;
}

const token = await accessToken();
console.log('OAuth: ok (token held in memory)\n');

async function get(path, namespace = STATIC) {
  const url = `${HOST}${path}${path.includes('?') ? '&' : '?'}namespace=${namespace}&locale=${LOCALE}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: await res.json() };
}

/** Key names only, one level deep, so a shape can be judged without dumping data. */
function shape(value, depth = 2) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.length} x ${depth > 0 ? shape(value[0], depth - 1) : '...'}]`;
  }
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value);
  if (depth <= 0) return `{${keys.length} keys}`;
  return `{ ${keys.slice(0, 14).map((k) => `${k}: ${shape(value[k], depth - 1)}`).join(', ')}${keys.length > 14 ? ', ...' : ''} }`;
}

async function probe(label, path, namespace, look) {
  process.stdout.write(`${label}\n  GET ${path}\n`);
  let result;
  try {
    result = await get(path, namespace);
  } catch (err) {
    console.log(`  ERROR ${err.message}\n`);
    return null;
  }
  if (!result.body) {
    console.log(`  HTTP ${result.status} — not available\n`);
    return null;
  }
  console.log(`  HTTP ${result.status}`);
  console.log(`  shape: ${shape(result.body)}`);
  if (look) {
    for (const line of look(result.body)) console.log(`  ${line}`);
  }
  console.log();
  return result.body;
}

// --- 1. Crafting reagents: the only gate never actually checked --------------

console.log('=== GATE: crafting reagent requirements ===\n');

const professions = await probe(
  'profession index',
  '/data/wow/profession/index',
  STATIC,
  (b) => [`professions: ${(b.professions ?? []).length}`],
);

let recipeId = null;
if (professions?.professions?.length) {
  // Walk profession -> skill tier -> category -> first recipe, so the id comes from
  // the API rather than from a number typed in here.
  for (const p of professions.professions) {
    const prof = await get(`/data/wow/profession/${p.id}`);
    const tiers = prof.body?.skill_tiers ?? [];
    if (!tiers.length) continue;
    const tier = await get(`/data/wow/profession/${p.id}/skill-tier/${tiers[tiers.length - 1].id}`);
    const categories = tier.body?.categories ?? [];
    const first = categories.flatMap((c) => c.recipes ?? [])[0];
    if (first) { recipeId = first.id; console.log(`  first recipe found under ${p.name}: id ${recipeId}\n`); break; }
  }
}

if (recipeId) {
  await probe(
    'recipe detail — does it carry reagents?',
    `/data/wow/recipe/${recipeId}`,
    STATIC,
    (b) => {
      const lines = [];
      const reagents = b.reagents ?? b.required_reagents ?? null;
      lines.push(reagents ? `REAGENTS PRESENT: ${reagents.length} entries` : 'no `reagents` key');
      if (reagents?.length) lines.push(`  first reagent shape: ${shape(reagents[0])}`);
      for (const key of ['modified_crafting_slots', 'crafted_item', 'crafted_quantity', 'alliance_crafted_item']) {
        if (key in b) lines.push(`has ${key}`);
      }
      return lines;
    },
  );
} else {
  console.log('Could not reach a recipe id through the profession index.\n');
}

// --- 2. The other gates, re-asked rather than re-asserted --------------------

console.log('=== GATES: upgrade costs, Catalyst, Vault, difficulty item levels ===\n');

// Currency costs for item upgrades (crests, valorstones).
await probe('currency index — is there anything upgrade-cost shaped?', '/data/wow/currency/index', STATIC,
  (b) => [`currencies: ${(b.currencies ?? []).length}`,
    'NOTE: a currency LIST is not a cost table. A cost needs item + track step -> amount.']);

// Great Vault / mythic keystone season.
await probe('mythic keystone season index', '/data/wow/mythic-keystone/season/index', DYNAMIC,
  (b) => [`seasons: ${(b.seasons ?? []).length}`,
    'NOTE: periods and seasons, not reward item levels.']);

// Journal instance: difficulty names vs item levels.
const instances = await probe('journal instance index', '/data/wow/journal-instance/index', STATIC,
  (b) => [`instances: ${(b.instances ?? []).length}`]);
if (instances?.instances?.length) {
  const id = instances.instances[0].id;
  await probe(`journal instance ${id} — difficulty shape`, `/data/wow/journal-instance/${id}`, STATIC, (b) => {
    const modes = b.modes ?? [];
    return [
      `modes: ${modes.length}`,
      modes.length ? `first mode: ${shape(modes[0])}` : 'no modes',
      'LOOKING FOR: an item level per difficulty. A mode with only a name and type does not carry one.',
    ];
  });
}

// Item upgrade / conversion endpoints, asked by name in case they exist unlisted.
for (const [label, path] of [
  ['item upgrade (speculative)', '/data/wow/item-upgrade/index'],
  ['item conversion / Catalyst (speculative)', '/data/wow/item-conversion/index'],
  ['item set index (for comparison — a known-good static endpoint)', '/data/wow/item-set/index'],
]) {
  await probe(label, path, STATIC);
}

console.log('Probe complete. A 404 here is evidence the endpoint does not exist, not');
console.log('evidence the data does not exist somewhere else — but it is what the');
console.log('catalog can and cannot be built from today.');
