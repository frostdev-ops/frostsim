#!/usr/bin/env node
// Live Battle.net API verification. Secrets in memory only; output = statuses/names/counts (never values).
// Usage: node scripts/battlenet/verify-live.mjs [--capture <dir>]
// Exits 0 unconfigured, safe to run anywhere.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { blizzardCredentials, describeCredentials, loadDevVars } from './dev-vars.mjs';

const args = process.argv.slice(2);
const captureDir = args.includes('--capture') ? args[args.indexOf('--capture') + 1] : null;

const devVars = loadDevVars();
for (const warning of devVars.warnings) process.stderr.write(`warning: ${warning}\n`);

process.stdout.write(`.dev.vars: ${devVars.present ? 'present' : 'absent'}\n`);
if (devVars.present) {
  // NAMES only, never values.
  process.stdout.write(`  variables defined: ${devVars.names.join(', ') || '(none)'}\n`);
}

const credentials = blizzardCredentials(devVars);
process.stdout.write(`credentials: ${describeCredentials(credentials)}\n`);
if (!credentials) {
  process.stdout.write('\nNot configured — nothing to verify live. This is not a failure.\n');
  process.exit(0);
}

const { BlizzardClient, parseItem, parseMedia, buildTooltip } = await import('../../functions/api/_lib/upstream.ts');

const REGION = 'us';
const LOCALE = 'en_US';
// Items from upstream MID2 profiles (current-content shapes).
const ITEM_IDS = [271564, 251136, 270167, 239649];
const JOURNAL_ENCOUNTER_PROBE = true;

let failures = 0;
const fail = (message) => { failures++; process.stderr.write(`FAIL: ${message}\n`); };

const client = new BlizzardClient({ credentials, cacheSeconds: 3600 });

function capture(name, body) {
  if (!captureDir) return;
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(join(captureDir, `${name}.json`), JSON.stringify(body, null, 2));
}

// Field names and types only (safe to print, never values).
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth > 1 ? `array[${value.length}]` : `array[${value.length}] of ${value.length ? shape(value[0], depth + 1) : 'nothing'}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (depth > 1) return `{${keys.length} keys}`;
    return `{ ${keys.map((k) => `${k}: ${shape(value[k], depth + 1)}`).join(', ')} }`;
  }
  return typeof value;
}

process.stdout.write('\n--- token ---\n');
try {
  // Exercised by first request; failure = auth failure.
  const probe = await client.get(`/data/wow/item/${ITEM_IDS[0]}`, REGION, LOCALE);
  process.stdout.write(`OAuth: ok (token held in memory: ${client.hasToken})\n`);
  capture('item-base', probe);
  process.stdout.write(`item top-level keys: ${Object.keys(probe).sort().join(', ')}\n`);
  if (probe.preview_item) {
    process.stdout.write(`preview_item keys: ${Object.keys(probe.preview_item).sort().join(', ')}\n`);
  }
} catch (err) {
  fail(`OAuth or first item request failed: ${err?.code ?? err?.name ?? 'error'} ${err?.status ?? ''}`);
  process.stderr.write('\nStopping: nothing else can be verified without a token.\n');
  process.exit(1);
}

process.stdout.write('\n--- item parsing ---\n');
for (const id of ITEM_IDS) {
  try {
    const body = await client.get(`/data/wow/item/${id}`, REGION, LOCALE);
    const item = parseItem(body, id);
    const missing = Object.entries(item)
      .filter(([k, v]) => v === null && k !== 'description')
      .map(([k]) => k);
    process.stdout.write(
      `item ${id}: name=${item.name ? 'set' : 'MISSING'} quality=${item.quality?.type ?? 'MISSING'} ` +
      `baseIlvl=${item.baseItemLevel ?? 'MISSING'} invType=${item.inventoryType?.type ?? 'MISSING'}` +
      `${missing.length ? ` | null fields: ${missing.join(',')}` : ''}` +
      `${item.unmodelledFields.length ? ` | unmodelled: ${item.unmodelledFields.join(',')}` : ''}\n`,
    );
    if (!item.name) fail(`item ${id} parsed no name`);
    if (item.id !== id) fail(`item ${id} parsed a different id (${item.id})`);
  } catch (err) {
    fail(`item ${id}: ${err?.code ?? 'error'}`);
  }
}

process.stdout.write('\n--- media parsing ---\n');
for (const id of ITEM_IDS) {
  try {
    const body = await client.get(`/data/wow/media/item/${id}`, REGION, null);
    capture(`media-${id}`, body);
    const media = parseMedia(body, id);
    process.stdout.write(
      `media ${id}: status=${media.status} assets=[${media.assetKeys.join(',')}] ` +
      `fileDataId=${media.fileDataId ?? 'none'} hostAllowed=${media.iconUrl !== null}\n`,
    );
    if (media.status === 'unavailable') {
      fail(`media ${id} resolved a URL that is not on the media host allowlist — the allowlist needs the real host added`);
      process.stdout.write(`  (raw asset keys present: ${Object.keys(body).join(',')})\n`);
    }
  } catch (err) {
    fail(`media ${id}: ${err?.code ?? 'error'}`);
  }
}

process.stdout.write('\n--- tooltip composition ---\n');
try {
  const id = ITEM_IDS[0];
  const [itemBody, mediaBody] = await Promise.all([
    client.get(`/data/wow/item/${id}`, REGION, LOCALE),
    client.get(`/data/wow/media/item/${id}`, REGION, null),
  ]);
  const tooltip = buildTooltip(itemBody, id, parseMedia(mediaBody, id), null, `/api/wow/icon/${id}`);
  capture('tooltip-source-item', itemBody);
  const populated = Object.entries(tooltip)
    .filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k]) => k);
  process.stdout.write(`tooltip fields populated: ${populated.join(', ')}\n`);
  process.stdout.write(`tooltip basis: ${tooltip.basis} (must be "base")\n`);
  process.stdout.write(`spells: ${tooltip.spells.length}, set: ${tooltip.set ? 'present' : 'none'}, binding: ${tooltip.bindingText ?? 'none'}\n`);
  if (tooltip.basis !== 'base') fail('tooltip basis is not "base"');
  if (!tooltip.name) fail('tooltip has no name');
} catch (err) {
  fail(`tooltip: ${err?.code ?? 'error'}`);
}

if (JOURNAL_ENCOUNTER_PROBE) {
  process.stdout.write('\n--- journal (loot ingestion) ---\n');
  try {
    const index = await client.get('/data/wow/journal-encounter/index', REGION, LOCALE);
    const encounters = index.encounters ?? [];
    process.stdout.write(`journal encounter index: ${encounters.length} encounters\n`);
    if (encounters.length === 0) fail('journal index returned no encounters');
    else {
      const first = encounters[0];
      const encounter = await client.get(`/data/wow/journal-encounter/${first.id}`, REGION, LOCALE);
      capture('journal-encounter', encounter);
      const items = encounter.items ?? [];
      process.stdout.write(`encounter ${first.id}: keys=${Object.keys(encounter).sort().join(',')} items=${items.length}\n`);
      if (items.length > 0) {
        process.stdout.write(`  item entry shape: ${shape(items[0])}\n`);
      }
      const { encounterToSource } = await import('../catalog/sources/blizzard-journal.mjs');
      const source = encounterToSource(encounter);
      process.stdout.write(
        source
          ? `adapter: produced source "${source.name}" with ${source.itemIds.length} items\n`
          : 'adapter: produced no source (encounter awards no usable items)\n',
      );
    }
  } catch (err) {
    fail(`journal: ${err?.code ?? 'error'}`);
  }
}

process.stdout.write(`\ncache entries held: ${client.cacheSize}\n`);
process.stdout.write(captureDir ? `raw captures written to ${captureDir}\n` : 'no raw captures written (pass --capture <dir> to save them outside the repo)\n');
process.stdout.write(failures === 0 ? '\nall live checks passed\n' : `\n${failures} live check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
