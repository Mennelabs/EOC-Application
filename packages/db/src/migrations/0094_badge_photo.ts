/**
 * 0094 badge photos (BRD:FR-13.01, FR-13.04): a photo taken at the desk or
 * uploaded waits as pending until a second person approves it; only an
 * approved photo is printed on a badge. Each step keeps who and when. The
 * image is re-encoded on upload, which drops its location and camera
 * details. A pending photo's file is swept with the person's record (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.personnel
    add column photo_pending_key text,
    add column photo_pending_by uuid,
    add column photo_pending_at timestamptz,
    add column photo_approved_by uuid,
    add column photo_approved_at timestamptz,
    add constraint personnel_photo_pending check ((photo_pending_key is null) = (photo_pending_at is null))`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.personnel
    drop constraint if exists personnel_photo_pending,
    drop column if exists photo_approved_at,
    drop column if exists photo_approved_by,
    drop column if exists photo_pending_at,
    drop column if exists photo_pending_by,
    drop column if exists photo_pending_key`.execute(db);
  await loadDictionary(db);
}
