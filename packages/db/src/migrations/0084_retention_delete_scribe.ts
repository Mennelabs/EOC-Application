/**
 * 0084 lets the retention sweep delete expired conversation-note records
 * (SEC-13, FL-04): a confirmed note, or a session that was discarded or
 * expired, once the `field_records` period has passed since it was
 * confirmed or last changed. The audio was already deleted when the note was
 * confirmed or the session expired. As in 0077, 0080 and 0081, only the
 * worker role passes `cg.is_system()`. No columns.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create policy retention_delete on cg.scribe_session for delete using (cg.is_system())`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists retention_delete on cg.scribe_session`.execute(db);
}
