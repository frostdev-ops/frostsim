// Privacy boundary (P00.6): sample invented; test name/realm never leak into tracked files.

import { describe, expect, it } from 'vitest';
import { sanitizeExport } from './sanitize-export.mjs';

const EXPORT = `# Nightpaw - Demonology - 2026-09-13 23:05 - US/Moonglade
# SimC Addon 12.1.0-03
# WoW 12.1.0.69814, TOC 120100

warlock=Nightpaw
level=90
race=dracthyr
region=us
server=moonglade
spec=demonology
talents=CoQAMrNP5kak+EBqLfUa3dMm

# Saved Loadout: M+
head=,id=271546,enchant_id=8017,bonus_id=13334/6652
### Gear from Bags
#
# Overseer's Diadem (318)
`;

describe('sanitizeExport', () => {
  it('removes the character name everywhere, including the header comment', () => {
    const { text } = sanitizeExport(EXPORT);
    expect(text).not.toMatch(/nightpaw/i);
    expect(text).toContain('warlock=Testchar');
    expect(text).toContain('# Testchar - Demonology');
  });

  it('removes the realm in both the casings it appears in', () => {
    const { text } = sanitizeExport(EXPORT);
    // "server=moonglade" lower-case and "US/Moonglade" capitalized are the same realm.
    expect(text).not.toMatch(/moonglade/i);
    expect(text).toContain('server=testrealm');
    expect(text).toContain('US/testrealm');
  });

  it('keeps region, item, talent and loadout data untouched', () => {
    const { text } = sanitizeExport(EXPORT);
    expect(text).toContain('region=us');
    expect(text).toContain('head=,id=271546,enchant_id=8017,bonus_id=13334/6652');
    expect(text).toContain('talents=CoQAMrNP5kak+EBqLfUa3dMm');
    expect(text).toContain('# Saved Loadout: M+');
    expect(text).toContain("# Overseer's Diadem (318)");
  });

  it('marks the output as sanitized so a fixture cannot be mistaken for a real export', () => {
    expect(sanitizeExport(EXPORT).text.startsWith('# Sanitized fixture.')).toBe(true);
  });

  it('handles a name that also occurs as a substring of game data', () => {
    // A character called "Frost" must not corrupt "frostbolt" or "Frostfire".
    const tricky = EXPORT.replace(/Nightpaw/g, 'Frost').replace('warlock=Frost', 'warlock=Frost')
      + 'actions=frostbolt\n# Frostfire Bolt\n';
    const { text } = sanitizeExport(tricky);
    expect(text).toContain('actions=frostbolt');
    expect(text).toContain('# Frostfire Bolt');
    expect(text).toContain('warlock=Testchar');
  });

  it('refuses an export with no character declaration', () => {
    expect(() => sanitizeExport('level=90\nregion=us\n')).toThrow(/addon export/);
  });

  it('still sanitizes when the export has no realm line', () => {
    const noRealm = EXPORT.split('\n').filter((l) => !l.startsWith('server=')).join('\n');
    const { text, replacements } = sanitizeExport(noRealm);
    expect(text).not.toMatch(/nightpaw/i);
    expect(replacements).toHaveLength(1);
  });
});
