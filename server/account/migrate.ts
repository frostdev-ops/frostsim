// Plain .sql migrations applied at startup (CLAUDE.md D15, DESIGN.md C4). All pending files run in ONE transaction under a
// transaction-scoped advisory lock: concurrent starts serialise, and a failing file rolls the whole batch back.
// Every file must keep the previous release working: rollback is a symlink switch and cannot undo a migration.

import { readdirSync, readFileSync } from 'node:fs';
import type { Sql } from './db';

/** Arbitrary constant naming this runner's lock ("fros"). */
const LOCK_KEY = 0x66726f73;
const FILE = /^(\d{3}_[a-z0-9_]+)\.sql$/;

/** Applies what schema_migrations lacks, in file-name order. Returns the versions applied now. */
export async function migrate(sql: Sql, dir: URL): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => FILE.test(f)).sort();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY}::bigint)`;
    await tx`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx`select version from schema_migrations`).map((r) => r.version as string));
    const applied: string[] = [];
    for (const file of files) {
      const version = FILE.exec(file)![1];
      if (done.has(version)) continue;
      // No parameters, so postgres.js uses the simple protocol, which allows many statements per file.
      await tx.unsafe(readFileSync(new URL(file, dir), 'utf8'));
      await tx`insert into schema_migrations (version) values (${version})`;
      applied.push(version);
    }
    return applied;
  });
}
