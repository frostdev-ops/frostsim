// Reads local dev secrets from .dev.vars (DEVELOPMENT AND TEST ONLY). Never printed, logged, or in args. Reports mode not content.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEV_VARS_PATH = resolve(process.cwd(), '.dev.vars');

/**
 * @param {string} [path]
 * @returns {{ present: boolean, path: string, names: string[], get(name: string): string | undefined, warnings: string[] }}
 */
export function loadDevVars(path = DEV_VARS_PATH) {
  const warnings = [];
  if (!existsSync(path)) {
    return { present: false, path, names: [], get: () => undefined, warnings };
  }

  // Report mode, never content. 0o177 catches group/other access.
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(`${path} is mode ${mode.toString(8)}; it should be 600 so only the owner can read it`);
    }
  } catch {
    warnings.push(`could not stat ${path}`);
  }

  /** @type {Map<string, string>} */
  const values = new Map();
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // Message names path, never contents.
    warnings.push(`could not read ${path}: ${err instanceof Error ? err.name : 'error'}`);
    return { present: true, path, names: [], get: () => undefined, warnings };
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }

  // VITE_ prefix inlines secret into client bundle.
  for (const name of values.keys()) {
    if (name.startsWith('VITE_')) {
      warnings.push(`${name} is VITE_ prefixed, which inlines it into the CLIENT BUNDLE — rename it`);
    }
  }

  return {
    present: true,
    path,
    names: [...values.keys()],
    get: (name) => values.get(name),
    warnings,
  };
}

/** Credentials as in-memory object or null. Caller must not print; use describeCredentials instead. */
export function blizzardCredentials(devVars = loadDevVars()) {
  const clientId = devVars.get('BLIZZARD_CLIENT_ID') ?? process.env.BLIZZARD_CLIENT_ID;
  const clientSecret = devVars.get('BLIZZARD_CLIENT_SECRET') ?? process.env.BLIZZARD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Safe to print: says credentials exist and their length, never what they are. */
export function describeCredentials(credentials) {
  if (!credentials) return 'absent';
  return `present (id ${credentials.clientId.length} chars, secret ${credentials.clientSecret.length} chars)`;
}
