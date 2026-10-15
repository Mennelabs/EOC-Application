/**
 * 0077 lets the retention sweep delete expired rows from tables that are
 * otherwise append-only or update-only (SEC-13). Only the worker role passes
 * `cg.is_system()`, so the API still cannot delete a badge, a child check-in,
 * a reminder, a safety alert or a device command; the sweep deletes them once
 * the tenant's retention has run out, logs the count and audits it, and a
 * legal hold keeps them. No column changes.
 */
import { sql, type Kysely } from 'kysely';

export const RETENTION_DELETE_TABLES = [
  'badge',
  'badge_event',
  'child_check_in',
  'client_command',
  'reminder',
  'reminder_event',
  'safety_alert',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_TABLES)
    await sql
      .raw(`create policy retention_delete on cg.${t} for delete using (cg.is_system())`)
      .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_TABLES)
    await sql.raw(`drop policy if exists retention_delete on cg.${t}`).execute(db);
}
