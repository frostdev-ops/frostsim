// Audit log writer (CLAUDE.md D15, DESIGN.md C5): admin actions, account deletion and every integration call leave a row.

import type postgres from 'postgres';
import type { Db } from './db';

export interface AuditEntry {
  /** The user the action is about; null when there is none. Set to null by Postgres if that user is deleted later. */
  userId: string | null;
  /** Who acted: `user:<id>`, `admin:<id>`, `system`, `stripe`, `loothing`, `discord`. */
  actor: string;
  action: string;
  /** Never a token, cookie or upstream body. */
  detail?: postgres.JSONValue;
}

export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db`insert into audit_log (user_id, actor, action, detail)
    values (${entry.userId}, ${entry.actor}, ${entry.action}, ${entry.detail === undefined ? null : db.json(entry.detail)})`;
}
