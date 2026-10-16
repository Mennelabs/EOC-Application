/**
 * 0096 a phone's location permission on the shift (BRD:FR-03.05). While
 * checked in with sharing on, the field app says whether the phone lets it
 * read location: granted, only while the app is open, denied, or unable to
 * get a position. Dispatch sees a blocked phone in words, instead of a
 * person who simply never appears on the map. Kept with the check-in it
 * belongs to (field records, SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.check_in
    add column location_permission text
      check (location_permission in ('granted', 'foreground_only', 'denied', 'unavailable')),
    add column location_permission_at timestamptz,
    add constraint check_in_location_permission_at
      check ((location_permission is null) = (location_permission_at is null))`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.check_in
    drop constraint if exists check_in_location_permission_at,
    drop column if exists location_permission_at,
    drop column if exists location_permission`.execute(db);
  await loadDictionary(db);
}
