import { describe, expect, it } from 'vitest';
import { MAX_RETENTION_SECONDS, type CharacterMatch } from '../../../src/lib/battlenet/contract';
import { CharacterIndex, matchFromSummary } from './character-index';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const c = (name: string, over: Partial<CharacterMatch> = {}): CharacterMatch => ({
  region: 'us', name, realm: 'Area 52', realmSlug: 'area-52', className: 'rogue', spec: 'Subtlety', level: 90, itemLevel: 700,
  seenAt: NOW, ...over,
});

describe('CharacterIndex', () => {
  it('finds names by prefix, ignoring case and accents, exact names first, then most recently seen', () => {
    const index = new CharacterIndex(() => NOW);
    index.add(c('Ellesmére', { seenAt: NOW - 3 }));
    index.add(c('Ellesmer', { seenAt: NOW - 2 }));
    index.add(c('Ellesmereth', { seenAt: NOW - 1 }));
    index.add(c('Other'));
    expect(index.search('us', 'ELLESME', null).map((m) => m.name)).toEqual(['Ellesmereth', 'Ellesmer', 'Ellesmére']);
    expect(index.search('us', 'ellesmere', null).map((m) => m.name)).toEqual(['Ellesmére', 'Ellesmereth']);
  });

  it('filters by region and realm, and replaces a character seen again rather than listing it twice', () => {
    const index = new CharacterIndex(() => NOW);
    index.add(c('Messer', { spec: 'Assassination' }));
    index.add(c('Messer', { realm: 'Illidan', realmSlug: 'illidan' }));
    index.add(c('Messer', { region: 'eu' }));
    index.add(c('Messer', { spec: 'Subtlety' }));
    expect(index.size).toBe(3);
    expect(index.search('us', 'mes', 'area-52')).toEqual([c('Messer', { spec: 'Subtlety' })]);
    expect(index.search('us', 'mes', null)).toHaveLength(2);
  });

  it('drops entries past Blizzard\'s retention limit and evicts the least recently seen past its bound', () => {
    const index = new CharacterIndex(() => NOW, 2);
    index.add(c('Stale', { seenAt: NOW - MAX_RETENTION_SECONDS * 1000 }));
    index.add(c('Fresh'));
    expect(index.search('us', 's', null)).toEqual([]);
    expect(index.toJSON().map((m) => m.name)).toEqual(['Fresh']);
    index.add(c('Newer'));
    index.add(c('Newest'));
    expect(index.size).toBe(2);
    expect(index.search('us', 'fresh', null)).toEqual([]);
  });

  it('round-trips a snapshot and ignores malformed entries', () => {
    const index = new CharacterIndex(() => NOW);
    index.add(c('Kept'));
    const copy = new CharacterIndex(() => NOW);
    copy.load([...JSON.parse(JSON.stringify(index)), { name: 5 }, null]);
    expect(copy.search('us', 'kept', null)).toEqual([c('Kept')]);
    expect(copy.dirty).toBe(false);
  });

  it('builds an entry from a profile summary, or nothing without a name, realm or known class', () => {
    const summary = { name: 'Messer', level: 90, equipped_item_level: 712, character_class: { id: 4 }, active_spec: { name: 'Subtlety' },
      realm: { name: 'Area 52', slug: 'area-52' } };
    expect(matchFromSummary('us', summary, NOW)).toEqual(c('Messer', { itemLevel: 712 }));
    expect(matchFromSummary('us', { ...summary, character_class: { id: 99 } }, NOW)).toBeNull();
    expect(matchFromSummary('us', { ...summary, realm: {} }, NOW)).toBeNull();
  });
});
