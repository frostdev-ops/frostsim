// Postgres pool for the account server (CLAUDE.md D15, DESIGN.md C4). Postgres is the record; Redis only caches it.
// Rows come back snake_case (no transform: a camel transform would also rewrite jsonb contents); alias in SQL when a camelCase shape is wanted.

import postgres from 'postgres';

export type Sql = postgres.Sql;
/** A pool or a transaction: helpers that may run inside `sql.begin` take this. */
export type Db = postgres.ISql;

export function connectDb(url: string, options: postgres.Options<{}> = {}): Sql {
  // Silence notices: `create ... if not exists` on every startup would log one per object.
  return postgres(url, { max: 5, connect_timeout: 5, onnotice: () => {}, ...options });
}
