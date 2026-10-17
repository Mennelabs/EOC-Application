/**
 * 0080 lets the retention sweep delete expired communications and
 * publication approvals (SEC-13), which are otherwise append-only or
 * update-only: field messages and their receipts, the communications log
 * (ICS 309) and publication approvals. As in 0077, only the worker role
 * passes `cg.is_system()`; the API still cannot delete them. No columns.
 */
import { sql, type Kysely } from 'kysely';

export const RETENTION_DELETE_RECORD_TABLES = [
  'field_message',
  'field_message_receipt',
  'comms_log',
  'publication',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_RECORD_TABLES)
    await sql
      .raw(`create policy retention_delete on cg.${t} for delete using (cg.is_system())`)
      .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_RECORD_TABLES)
    await sql.raw(`drop policy if exists retention_delete on cg.${t}`).execute(db);
}
