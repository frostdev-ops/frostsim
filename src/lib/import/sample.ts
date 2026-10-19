// Sample character offered on first visit (P12.1): same sanitized fixture as parser tests, imported not copied so cannot drift. scripts/sanitize-export.mjs produced it; no real character name/realm/region.
import text from '../../../tests/fixtures/addon-export-demonology.simc?raw'

export const SAMPLE_EXPORT: string = text
export const SAMPLE_LABEL = 'Sample: Demonology Warlock'

/** Provenance follows the exact bundled export through local storage and portable copies.
 * Never infer it from placeholder names: a real import can use the same name. */
export function isBundledSample(character: { raw: string }): boolean {
  return character.raw.trim() === SAMPLE_EXPORT.trim()
}
