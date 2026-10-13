/**
 * 0038 field record photos (layer-4 task J; FLD-07, FL:FR-05, FL:FR-06,
 * FL:FR-08, FL:FR-09, FL:FR-28): a field photo may also document a pet
 * intake, a facility walk-through, a debris load ticket, an inspection, a
 * road status or a canvass visit. No new columns (SEC-11 unchanged). The
 * rollback turns photos linked to the new kinds into unlinked field photos
 * (the photo is kept; only the link goes), then restores the narrower check.
 */
import { sql, type Kysely } from 'kysely';

const BASE = `'field_assessment', 'hazard', 'mission', 'need', 'search_mark', 'placard', 'site'`;
const ADDED = `'pet_intake', 'site_walkthrough', 'debris_ticket', 'inspection', 'road_status', 'canvass_visit'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${BASE}, ${ADDED}))`,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Row security is forced on cg.photo; the owner lifts it for this one update (as in 0037).
  await sql`alter table cg.photo no force row level security`.execute(db);
  await sql
    .raw(
      `update cg.photo set field_record_type = null, field_record_id = null where field_record_type in (${ADDED})`,
    )
    .execute(db);
  await sql`alter table cg.photo force row level security`.execute(db);
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${BASE}))`,
    )
    .execute(db);
}
