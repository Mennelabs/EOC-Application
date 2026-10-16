/**
 * 0085 lets the retention sweep delete the roster past its period (SEC-13):
 * a person's entry the `records` period after they were archived, with their
 * credentials and team memberships; an archived team; a lapsed credential.
 * Every record that still points at a person or a team keeps them. As in
 * 0077, 0080, 0081 and 0084, only the worker role passes `cg.is_system()`;
 * the API still archives rather than deletes. No columns.
 */
import { sql, type Kysely } from 'kysely';

export const RETENTION_DELETE_ROSTER_TABLES = [
  'personnel',
  'credential',
  'team',
  'team_member',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_ROSTER_TABLES)
    await sql
      .raw(`create policy retention_delete on cg.${t} for delete using (cg.is_system())`)
      .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_ROSTER_TABLES)
    await sql.raw(`drop policy if exists retention_delete on cg.${t}`).execute(db);
}
