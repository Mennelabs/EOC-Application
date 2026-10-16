/**
 * 0099 a reviewer sends a report to the field (CON-05). "Send to the field"
 * is a review decision of its own: the report stays in review and waits for a
 * team's visit, which is recorded on the report as when and by whom it was
 * asked. The reports waiting for a visit are grouped by route area so a
 * verification route can be opened for them; a resident's typed address is
 * matched to the county's parcel of record by its street line, hence the
 * index.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

const DECISIONS = [
  'approve',
  'reject',
  'needs_information',
  'duplicate',
  'supersede',
  'reopen',
  'verify',
  'set_degree',
];

const decisionCheck = (db: Kysely<unknown>, decisions: string[], validate = true) =>
  sql`alter table cg.review_decision add constraint review_decision_decision_check
    check (decision in (${sql.join(decisions.map((d) => sql.lit(d)))}))${
      validate ? sql`` : sql` not valid`
    }`.execute(db);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.report
    add column field_visit_requested_at timestamptz,
    add column field_visit_requested_by uuid`.execute(db);
  await sql`create index report_field_visit_idx on cg.report (tenant_id, event_id)
    where field_visit_requested_at is not null`.execute(db);
  await sql`create index parcel_address_idx on cg.parcel (tenant_id, lower(line1))
    where line1 is not null`.execute(db);
  await sql`alter table cg.review_decision drop constraint review_decision_decision_check`.execute(
    db,
  );
  await decisionCheck(db, [...DECISIONS, 'field_visit']);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Decisions already recorded stay as they were (they are the review's record); only new ones
  // are held to the older list.
  await sql`alter table cg.review_decision drop constraint review_decision_decision_check`.execute(
    db,
  );
  await decisionCheck(db, DECISIONS, false);
  await sql`drop index if exists cg.parcel_address_idx`.execute(db);
  await sql`drop index if exists cg.report_field_visit_idx`.execute(db);
  await sql`alter table cg.report
    drop column if exists field_visit_requested_by,
    drop column if exists field_visit_requested_at`.execute(db);
  await loadDictionary(db);
}
