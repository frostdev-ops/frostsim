// Default engine pack for Discord and Loothing jobs (CLAUDE.md D14; DESIGN.md P2). Temp index file, fake R2.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { createR2 } from '../r2';
import { defaultPack } from './packs';

const dir = mkdtempSync(join(tmpdir(), 'frostsim-packs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pack = (id: string, compat: string, commitDate: string) =>
  ({ id, baseUrl: `/engine/versions/${id}/`, compat, upstreamCommit: 'a'.repeat(40), commitDate, publishedAt: commitDate });

function setup(native: string[]) {
  const config = loadConfig({ R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' });
  const heads: string[] = [];
  const r2 = createR2(config, (async (req: Request) => {
    const id = new URL(req.url).pathname.split('/')[3];
    heads.push(id);
    return native.includes(id) ? new Response(null, { headers: { 'x-amz-meta-sha256': 'c'.repeat(64) } }) : new Response(null, { status: 404 });
  }) as typeof fetch);
  return { app: { config, r2, redis: null, log: () => {} }, heads };
}

describe('defaultPack', () => {
  const index = join(dir, 'engine-versions.json');
  writeFileSync(index, JSON.stringify({
    schemaVersion: 2,
    status: null,
    packs: [
      pack('aaa-mine-old', 'mine', '2026-09-01T00:00:00Z'),
      pack('bbb-other', 'other', '2026-09-20T00:00:00Z'),
      pack('ccc-mine-new', 'mine', '2026-09-10T00:00:00Z'),
      pack('ddd-mine-newest', 'mine', '2026-09-15T00:00:00Z'),
    ],
  }));
  const env = { ENGINE_INDEX_PATH: index, ENGINE_COMPAT: 'mine' };

  it('picks the newest pack of this compat that has a native build', async () => {
    const { app, heads } = setup(['aaa-mine-old', 'ccc-mine-new', 'bbb-other']);
    expect(await defaultPack(app, env)).toBe('ccc-mine-new');
    expect(heads).toEqual(['ddd-mine-newest', 'ccc-mine-new']);
  });

  it('is null without a native build, a readable index or a compat', async () => {
    expect(await defaultPack(setup([]).app, env)).toBeNull();
    expect(await defaultPack(setup(['ddd-mine-newest']).app, { ...env, ENGINE_INDEX_PATH: join(dir, 'missing.json') })).toBeNull();
    expect(await defaultPack(setup(['ddd-mine-newest']).app, { ENGINE_INDEX_PATH: index })).toBeNull();
  });
});
