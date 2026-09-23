import { describe, expect, it } from 'vitest';
import { issueAction, pickGreenRun, readIndex, retainedPacks, seasonBody } from './update-engines.mjs';
import { engineCompat } from './engine-compat.mjs';

const green = { status: 'completed', conclusion: 'success', event: 'push', head_branch: 'midnight', path: '.github/workflows/main.yml',
  repository: { full_name: 'simulationcraft/simc' }, head_repository: { full_name: 'simulationcraft/simc' }, head_sha: 'a'.repeat(40) };

describe('pickGreenRun', () => {
  it('takes the first successful upstream midnight push run and ignores forks, failures and other branches', () => {
    const fork = { ...green, head_sha: 'b'.repeat(40), head_repository: { full_name: 'someone/simc' } };
    const failed = { ...green, head_sha: 'c'.repeat(40), conclusion: 'failure' };
    const branch = { ...green, head_sha: 'd'.repeat(40), head_branch: 'thewarwithin' };
    expect(pickGreenRun([fork, failed, branch, green])).toBe(green);
    expect(pickGreenRun([fork, failed])).toBeUndefined();
    // The filtered listing has returned an older run first.
    const older = { ...green, head_sha: 'e'.repeat(40), created_at: '2026-09-06T15:33:10Z' };
    const newer = { ...green, created_at: '2026-09-23T19:00:45Z' };
    expect(pickGreenRun([older, newer])).toBe(newer);
  });
});

describe('readIndex', () => {
  it('migrates a v1 index: drops bundled, keeps packs under an unmatched compat', () => {
    const v1 = { schemaVersion: 1, defaultId: 'nightly-x', versions: [
      { id: 'bundled', channel: 'bundled', baseUrl: '/engine/' },
      { id: 'nightly-x', channel: 'nightly', baseUrl: '/engine/versions/nightly-x/', upstreamCommit: 'f'.repeat(40), publishedAt: '2026-09-15T10:00:00Z' },
    ] };
    const index = readIndex(v1);
    expect(index.schemaVersion).toBe(2);
    expect(index.packs).toEqual([expect.objectContaining({ id: 'nightly-x', compat: 'v1', commitDate: '2026-09-15T10:00:00Z' })]);
    expect(readIndex(null)).toEqual({ schemaVersion: 2, packs: [], status: null });
  });
});

describe('retainedPacks', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const pack = (id, compat, daysAgo) => {
    const at = new Date(now - daysAgo * 86400_000).toISOString();
    return { id, compat, commitDate: at, publishedAt: at };
  };
  it('keeps the 6 newest, the last 48 h, and the newest pack per recent compat, newest first', () => {
    const packs = [...Array.from({ length: 9 }, (_, i) => pack(`a${i}`, 'A', i + 1)), pack('old-b', 'B', 20), pack('ancient-c', 'C', 40)];
    const kept = retainedPacks(packs, now).map(p => p.id);
    expect(kept).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'old-b']);
  });
  it('keeps everything published in the last 48 h even beyond 6', () => {
    const packs = Array.from({ length: 8 }, (_, i) => pack(`n${i}`, 'A', i * 0.2));
    expect(retainedPacks(packs, now)).toHaveLength(8);
  });
});

describe('issueAction', () => {
  const failed = { state: 'failed', reason: 'boom' };
  it('opens once, comments only when the problem changes, closes on recovery', () => {
    expect(issueAction(undefined, null, failed)).toBe('open');
    expect(issueAction({ number: 1 }, failed, failed)).toBeNull();
    expect(issueAction({ number: 1 }, failed, { state: 'blocked', reason: 'gate' })).toBe('comment');
    expect(issueAction({ number: 1 }, failed, { state: 'current' })).toBe('close');
    expect(issueAction(undefined, failed, { state: 'current' })).toBeNull();
  });
});

describe('engineCompat', () => {
  it('is stable for one tree', () => {
    expect(engineCompat('.')).toMatch(/^[0-9a-f]{12}$/);
    expect(engineCompat('.')).toBe(engineCompat('.'));
  });
});

describe('seasonBody', () => {
  it('compares season data without build, commit and source stamps', () => {
    const a = { build: '12.1.0.69814', engineCommit: 'a', sources: [{ sha256: '1' }], season: { id: 17 }, tracks: [1] };
    const b = { ...a, build: '12.1.0.69952', engineCommit: 'b', sources: [{ sha256: '2' }] };
    expect(seasonBody(a)).toEqual(seasonBody(b));
    expect(seasonBody({ ...b, tracks: [2] })).not.toEqual(seasonBody(a));
  });
});
