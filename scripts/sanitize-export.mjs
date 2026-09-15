#!/usr/bin/env node
// Turn real /simc addon export into committable fixture (P00.6): replace character name/realm, keep item/bonus/talent/currency data (P00.6).
// Fixtures only form allowed in repo; raw stays gitignored. Tested in sanitize-export.test.mjs (silent replacement failure is critical bug).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CLASSES = [
  'death_knight', 'demon_hunter', 'druid', 'evoker', 'hunter', 'mage', 'monk',
  'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior',
];

const HEADER = '# Sanitized fixture. Character name and realm replaced by\n'
  + '# scripts/sanitize-export.mjs. Item, talent and currency data is unchanged game data.\n';

/** Sanitize export: replace name/realm (throws if no declaration or identifier survives replacement). */
export function sanitizeExport(text) {
  const value = (key) => text.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1].trim() ?? null;

  // First `class=Name` line is character declaration (simc has no dedicated `name=`).
  const declaration = text.match(new RegExp(`^(${CLASSES.join('|')})=(.+)$`, 'm'));
  if (!declaration) {
    throw new Error('no `<class>=<name>` line found; is this an addon export?');
  }

  // Region stays (continent not identifier, simc validates). Name/realm go (person-identifying).
  const replacements = /** @type {[string, string][]} */ ([
    [declaration[2].trim(), 'Testchar'],
    [value('server'), 'testrealm'],
  ].filter(([from]) => from));

  let out = text;
  for (const [from, to] of replacements) {
    // Whole-word case-insensitive (comment "US/Duskwood" vs option "server=duskwood").
    const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(pattern, to);
  }

  const leaked = replacements.filter(([from]) => new RegExp(`\\b${from}\\b`, 'i').test(out));
  if (leaked.length) {
    throw new Error(`${leaked.map(([f]) => f).join(', ')} still present after replacement`);
  }

  return { text: HEADER + out, replacements };
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node scripts/sanitize-export.mjs <export> <fixture>');
    process.exit(1);
  }
  try {
    const { text, replacements } = sanitizeExport(readFileSync(input, 'utf8'));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text);
    console.log(`sanitize-export: ${input} -> ${output} (${replacements.map(([f, t]) => `${f}->${t}`).join(', ')})`);
  } catch (err) {
    console.error(`sanitize-export: ${err.message}; refusing to write.`);
    process.exit(1);
  }
}
