// Generate Warlock consumable defaults from upstream source; grammar-specific, not arbitrary C++ (drift fails closed).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEEKLY = 'b845947a34429874433d8e9362326894650dd20a';
const SOURCE = 'engine/class_modules/apl/warlock.cpp';
const URL = `https://raw.githubusercontent.com/simulationcraft/simc/${WEEKLY}/${SOURCE}`;

function body(source, name) {
  const match = source.match(new RegExp(`std::string ${name}\\( const player_t\\* p \\)\\s*\\{([\\s\\S]*?)\\n  \\}`));
  if (!match) throw new Error(`Unknown ${name} default function grammar`);
  return match[1].replace(/\s+/g, ' ').trim();
}

function switchDefaults(source, option) {
  const text = body(source, option);
  const match = text.match(/^std::string (\w+) = "disabled"; switch \( p->specialization\(\) \) \{ (.*?) default: break; \} if \( p->true_level >= (\d+) \) return (\w+); return \( p->true_level >= (\d+) \) \? "([a-z0-9_:]+)" : "disabled";$/);
  if (!match || match[1] !== match[4]) throw new Error(`Unknown ${option} switch grammar`);
  const cases = [...match[2].matchAll(/case WARLOCK_([A-Z]+): (\w+) = "([a-z0-9_:]+)"; break;/g)];
  if (cases.length !== 3 || cases.map((c) => c[0]).join(' ') !== match[2] || cases.some((c) => c[2] !== match[1])) {
    throw new Error(`Unknown ${option} specialization branches`);
  }
  return { minLevel: Number(match[3]), lower: `${match[5]}:${match[6]}`,
    specs: Object.fromEntries(cases.map((c) => [c[1].toLowerCase(), c[3]])) };
}

export function differingDefaults(weekly, current) {
  // Identical functions need no override; new differences require deliberate extractor extension, not C++ approximation.
  for (const name of ['food', 'rune', 'temporary_enchant']) {
    if (body(weekly, name) !== body(current, name)) throw new Error(`Unhandled ${name} default difference`);
  }
  const rules = [];
  for (const option of ['potion', 'flask']) {
    const old = switchDefaults(weekly, option), now = switchDefaults(current, option);
    if (old.minLevel !== now.minLevel || old.lower !== now.lower || Object.keys(old.specs).join() !== Object.keys(now.specs).join()) {
      throw new Error(`Unhandled ${option} level/specification difference`);
    }
    for (const [spec, value] of Object.entries(old.specs)) {
      if (value !== now.specs[spec]) rules.push({ class: 'warlock', spec, minLevel: old.minLevel, option, value });
    }
  }
  return rules;
}

async function main() {
  const lock = JSON.parse(readFileSync(resolve(ROOT, 'engine.lock.json'), 'utf8'));
  const current = execFileSync('git', ['show', `${lock.upstream.commit}:${SOURCE}`], { cwd: resolve(ROOT, lock.upstream.path), encoding: 'utf8' });
  const response = await fetch(URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Weekly source: HTTP ${response.status}`);
  const weekly = await response.text();
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const output = {
    scope: 'Warlock consumable differences only; not a complete Weekly engine emulation',
    weekly: { commit: WEEKLY, source: URL, sha256: hash(weekly) },
    engine: { commit: lock.upstream.commit, source: SOURCE, sha256: hash(current) },
    rules: differingDefaults(weekly, current),
  };
  const path = resolve(ROOT, 'src/lib/simc/generated/weekly-defaults.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(`Generated ${output.rules.length} Weekly consumable override(s).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
