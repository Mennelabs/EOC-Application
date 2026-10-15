/**
 * 0061 the facility registry's 12-month re-check reminder joins the notice
 * ledger (layer-7 task D; REC-01): one notice per facility per confirmation
 * cycle, a month before the re-check falls due. No new columns.
 */
import { sql, type Kysely } from 'kysely';

const KINDS = `'site_reconfirm', 'site_hidden', 'resource_review', 'resource_link', 'resource_expired',
    'contact_reverify', 'publication', 'publication_withdrawn', 'ai_health'`;
const SUBJECTS = `'site', 'resource', 'partner_contact', 'publication', 'tenant', 'ai_health_alert'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.notice_log drop constraint notice_log_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_kind_check check (kind in (${KINDS}, 'facility_recheck'))`,
    )
    .execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_subject_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_subject_kind_check check (subject_kind in (${SUBJECTS}, 'facility'))`,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The migrator owns the table: row security is lifted for the delete, as in 0055.
  await sql`alter table cg.notice_log no force row level security`.execute(db);
  await sql`delete from cg.notice_log where kind = 'facility_recheck'`.execute(db);
  await sql`alter table cg.notice_log force row level security`.execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_kind_check check (kind in (${KINDS}))`,
    )
    .execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_subject_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_subject_kind_check check (subject_kind in (${SUBJECTS}))`,
    )
    .execute(db);
}
