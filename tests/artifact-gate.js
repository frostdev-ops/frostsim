// Some suites read generated build artifacts — catalogs from `npm run catalog:build`, the
// upstream checkout from `npm run engine:bootstrap` — and those are gitignored on purpose, so
// a clean clone cannot run them. Gate on the artifact itself rather than on an env var: a
// developer who has it keeps the coverage without opting in.
//
// The skip is never silent. The marker goes in the suite name and on stderr, and
// .github/workflows/engine.yml fails the build if it appears there, because that is the one
// job where every artifact is supposed to exist. A gate that quietly stops matching anything
// is how this coverage would rot.
import { existsSync } from 'node:fs'

export const MISSING_ARTIFACT = 'MISSING ARTIFACT'

/**
 * Empty string when every path is present — otherwise a loud suite-name suffix naming what is
 * missing and the npm script that regenerates it. Truthy, so it doubles as the `skipIf` test.
 *
 * @param {string | string[]} paths files the suite reads
 * @param {string} regenerate npm script that produces them
 * @returns {string}
 */
export function artifactGate(paths, regenerate) {
  const absent = (Array.isArray(paths) ? paths : [paths]).filter((p) => !existsSync(p))
  if (absent.length === 0) return ''
  const note = `${MISSING_ARTIFACT}: ${absent.join(', ')} — regenerate with \`${regenerate}\``
  console.warn(note)
  return ` [${note}]`
}
