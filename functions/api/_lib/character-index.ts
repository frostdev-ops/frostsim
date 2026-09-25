// Shared character search index: every character the Armory confirmed (a lookup, or an exact-name check while someone typed),
// so the next person typing the name sees it at once. Public Armory fields only; nothing about who looked it up. Entries
// expire at Blizzard's 30-day retention limit and are refreshed whenever the character is seen again.
// ponytail: a linear scan of up to MAX entries per search (a few ms at 100k); add a sorted name index if searches get slow.

import { MAX_RETENTION_SECONDS, type CharacterMatch, type Region } from '../../../src/lib/battlenet/contract';
import { CLASSES } from '../../../src/lib/import/armory';

const MAX = 100_000;

/** Accent- and case-insensitive form of a name, for matching what is typed ("ellesme" finds Ellesmére). */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const int = (v: unknown) => (Number.isSafeInteger(v) ? v as number : null);

/** The index entry for a profile API character summary (requested with locale en_US), or null when it lacks a name, realm or class. */
export function matchFromSummary(region: Region, summary: unknown, seenAt: number): CharacterMatch | null {
  const s = obj(summary);
  const realm = obj(s.realm);
  const name = str(s.name);
  const realmSlug = str(realm.slug);
  const className = CLASSES[int(obj(s.character_class).id) ?? -1];
  if (!name || !realmSlug || !className || name.length > 24) return null;
  return {
    region, name, realmSlug, realm: str(realm.name) ?? realmSlug, className,
    spec: str(obj(s.active_spec).name), level: int(s.level), itemLevel: int(s.equipped_item_level), seenAt,
  };
}

export class CharacterIndex {
  /** region/realmSlug/folded name -> entry, least recently seen first. */
  private readonly entries = new Map<string, CharacterMatch>();
  dirty = false;

  constructor(private readonly now: () => number = Date.now, private readonly max = MAX) {}

  add(c: CharacterMatch): void {
    const key = `${c.region}/${c.realmSlug}/${fold(c.name)}`;
    this.entries.delete(key);
    this.entries.set(key, c);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
    this.dirty = true;
  }

  /** Up to `limit` live entries in `region` whose name starts with `q`, in `realmSlug` when given: exact names first, then most
   *  recently seen. */
  search(region: Region, q: string, realmSlug: string | null, limit = 8): CharacterMatch[] {
    const needle = fold(q);
    const oldest = this.now() - MAX_RETENTION_SECONDS * 1000;
    const hits: CharacterMatch[] = [];
    for (const c of this.entries.values()) {
      if (c.region === region && c.seenAt > oldest && (!realmSlug || c.realmSlug === realmSlug) && fold(c.name).startsWith(needle)) hits.push(c);
    }
    const exact = (c: CharacterMatch) => (fold(c.name) === needle ? 0 : 1);
    return hits.sort((a, b) => exact(a) - exact(b) || b.seenAt - a.seenAt).slice(0, limit);
  }

  /** Live entries, oldest first, for a snapshot on disk. */
  toJSON(): CharacterMatch[] {
    const oldest = this.now() - MAX_RETENTION_SECONDS * 1000;
    return [...this.entries.values()].filter((c) => c.seenAt > oldest);
  }

  /** Restores a snapshot; entries past retention or of the wrong shape are dropped. */
  load(list: unknown): void {
    for (const raw of Array.isArray(list) ? list : []) {
      const c = obj(raw);
      if (typeof c.name === 'string' && typeof c.realmSlug === 'string' && typeof c.region === 'string' && typeof c.seenAt === 'number') {
        this.add(c as unknown as CharacterMatch);
      }
    }
    this.dirty = false;
  }

  get size(): number { return this.entries.size; }
}
