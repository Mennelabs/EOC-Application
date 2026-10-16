/**
 * 0081 lets the retention sweep delete expired field records (SEC-13): the
 * records crews keep during an event (assessments, canvass visits, check-ins
 * and their status reports, assignments and their history, service logs,
 * search marks, placards, road reports, debris tickets, inspections, pet
 * intakes, interpreter requests, hand-overs and site walk-throughs). Most are
 * append-only or update-only. As in 0077 and 0080, only the worker role
 * passes `cg.is_system()`; the API still cannot delete them. No columns.
 */
import { sql, type Kysely } from 'kysely';

export const RETENTION_DELETE_FIELD_TABLES = [
  'shift_handover',
  'service_log',
  'search_mark',
  'placard',
  'road_status',
  'debris_ticket',
  'inspection',
  'pet_intake',
  'interpreter_request',
  'canvass_visit',
  'field_assessment',
  'assignment_event',
  'assignment',
  'team_status',
  'check_in',
  'site_walkthrough',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_FIELD_TABLES)
    await sql
      .raw(`create policy retention_delete on cg.${t} for delete using (cg.is_system())`)
      .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of RETENTION_DELETE_FIELD_TABLES)
    await sql.raw(`drop policy if exists retention_delete on cg.${t}`).execute(db);
}
