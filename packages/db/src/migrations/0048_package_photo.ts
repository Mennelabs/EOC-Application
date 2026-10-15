/**
 * 0048 representative photos for the IDA package (layer-6 task F; DCL:DEC-11,
 * DEC-13, PHO-06, PHO-07, PHO-08): a person chooses a photo of the event for
 * the package and writes its caption, confirming they looked at the blurred
 * image and saw no face, license plate, document, house number or street
 * sign. Only photos whose metadata is stripped and whose sensitive regions a
 * detector blurred can be chosen (checked by the API and again when the
 * package is built). A choice is withdrawn, never deleted. Every column is in
 * the dictionary; RLS.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.package_photo (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      photo_id uuid not null references cg.photo(id),
      caption text not null check (char_length(caption) between 10 and 200),
      checked boolean not null check (checked),
      chosen_by uuid not null,
      chosen_at timestamptz not null default now(),
      removed_at timestamptz,
      removed_by uuid,
      check ((removed_at is null) = (removed_by is null))
    )`.execute(db);
  await sql`create unique index package_photo_once on cg.package_photo (event_id, photo_id) where removed_at is null`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.package_photo')`.execute(db);
  // Withdrawn, never deleted.
  await sql`drop policy tenant_delete on cg.package_photo`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.package_photo`.execute(db);
  await loadDictionary(db);
}
