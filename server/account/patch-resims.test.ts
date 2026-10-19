// Patch re-sims (server/account/characters.ts patchResims; DESIGN.md C5): one cloud Quick Sim per character when the newest pack's
// game build changes, a baseline without a run, a skipped build on a plan refusal, a retry on a full queue, and results as history.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCtx } from './app';
import { connectDb, type Sql } from './db';
import { migrate } from './migrate';

const enqueueJob = vi.fn();
const defaultPackInfo = vi.fn();
vi.mock('./compute/queue', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a) }));
vi.mock('./compute/packs', () => ({ defaultPackInfo: (...a: unknown[]) => defaultPackInfo(...a) }));
const { patchResims } = await import('./characters');

const EXPORT = readFileSync(new URL('../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8');
type Call = { query: string; values: unknown[] };

function app(rows: Record<string, unknown>[], done: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });
    if (query.includes('from compute_jobs j')) return Promise.resolve(done);
    if (query.includes('where c.patch_build <>')) return Promise.resolve(rows);
    if (query.includes('returning id')) return Promise.resolve([{ id: values.at(-2) }]);
    return Promise.resolve([]);
  }) as unknown as AppCtx['sql'];
  return { calls, ctx: { sql, now: () => new Date('2026-09-24T00:00:00Z'), log: () => {} } as unknown as AppCtx };
}

beforeEach(() => {
  enqueueJob.mockReset();
  defaultPackInfo.mockReset().mockResolvedValue({ id: 'pack1', build: '12.1.5.70000' });
});

describe('patchResims', () => {
  it('does nothing without a known build, and gives characters with none a baseline without a run', async () => {
    defaultPackInfo.mockResolvedValue({ id: 'pack1', build: null });
    const none = app([]);
    await patchResims(none.ctx);
    expect(none.calls.some((c) => c.query.includes('update cloud_characters'))).toBe(false);

    defaultPackInfo.mockResolvedValue({ id: 'pack1', build: '12.1.5.70000' });
    const base = app([]);
    await patchResims(base.ctx);
    expect(base.calls.find((c) => c.query.includes('where patch_build is null'))?.values).toEqual(['12.1.5.70000']);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('queues a Patchwerk Quick Sim as a patch job and tags it with the character', async () => {
    enqueueJob.mockResolvedValue({ ok: true, id: 'job1' });
    const a = app([{ id: 'c1', user_id: 'u1', raw: EXPORT, patch_build: '12.1.0.69814' }]);
    await patchResims(a.ctx);
    const [, job] = enqueueJob.mock.calls[0];
    expect(job).toMatchObject({ userId: 'u1', guildId: null, source: 'patch', packId: 'pack1' });
    expect(job.request.settings).toMatchObject({ fightStyle: 'Patchwerk', targets: 1 });
    expect(a.calls.find((c) => c.query.includes('update compute_jobs set character_id'))?.values).toEqual(['c1', 'job1']);
  });

  it('skips the build on a plan refusal, and puts it back and stops on a full queue or no capacity', async () => {
    const row = { id: 'c1', user_id: 'u1', raw: EXPORT, patch_build: 'old' };
    enqueueJob.mockResolvedValue({ ok: false, status: 402, code: 'not-entitled', message: '' });
    const refused = app([row]);
    await patchResims(refused.ctx);
    expect(refused.calls.filter((c) => c.query.includes('update cloud_characters set patch_build') && c.query.includes('where id ='))).toHaveLength(1);

    enqueueJob.mockResolvedValue({ ok: false, status: 503, code: 'capacity', message: '' });
    const busy = app([row, { ...row, id: 'c2' }]);
    await patchResims(busy.ctx);
    const restore = busy.calls.filter((c) => c.query.includes('update cloud_characters set patch_build') && c.query.includes('where id =')).at(-1)!;
    expect(restore.values).toEqual(['old', 'c1', '12.1.5.70000']);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
  });

  it('turns finished patch jobs into history points using their frozen engine build after the character advances', async () => {
    const finished = new Date('2026-09-23T00:00:00Z');
    const a = app([], [{ id: 'job1', character_id: 'c1', summary: { dps: 210000, dpsError: 300 }, request: { settings: { fightStyle: 'Patchwerk', targets: 1 } },
      payload: { engineIdentity: { clientDataVersion: '12.1.5.70000' } },
      finished_at: finished, patch_build: '12.2.0.80000' }, { id: 'job2', character_id: 'c1', summary: {}, request: {}, finished_at: finished, patch_build: 'x' }]);
    await patchResims(a.ctx);
    const inserts = a.calls.filter((c) => c.query.includes('insert into character_sims'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toEqual(['c1', finished, 210000, 300, 'Patchwerk', 1, '12.1.5.70000', 'job1']);
  });
});

const PG = process.env.FROSTSIM_TEST_PG;
describe.skipIf(!PG)('patch history immutable engine identity postgres integration', () => {
  const schema = `t_patch_history_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;
  beforeAll(async () => {
    admin = connectDb(PG!);
    await admin.unsafe(`create schema ${schema}`);
    sql = connectDb(PG!, { connection: { search_path: schema } });
    await migrate(sql, new URL('./migrations/', import.meta.url));
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });
  it('records the completed old job build after a newer pack already claimed its character', async () => {
    const [user] = await sql`insert into users (display_name) values ('Patch history') returning id`;
    const [character] = await sql`insert into cloud_characters (user_id, label, raw, bytes, patch_build)
      values (${user.id}, 'Character', ${EXPORT}, ${EXPORT.length}, '12.1.5.70000') returning id`;
    const [job] = await sql`insert into compute_jobs (user_id, source, pack_id, threads, status, character_id, finished_at, summary, payload, request)
      values (${user.id}, 'patch', 'old-pack', 1, 'done', ${character.id}, now(), ${sql.json({ dps: 1234 })},
        ${sql.json({ engineIdentity: { clientDataVersion: '12.1.5.70000' } })}, ${sql.json({ settings: { fightStyle: 'Patchwerk', targets: 1 } })}) returning id`;
    await sql`update cloud_characters set patch_build = '12.2.0.80000' where id = ${character.id}`;
    defaultPackInfo.mockResolvedValue(null);
    await patchResims({ sql, now: () => new Date(), log: () => {} } as unknown as AppCtx);
    expect(await sql`select game_build from character_sims where job_id = ${job.id}`).toEqual([{ game_build: '12.1.5.70000' }]);
  });
});
