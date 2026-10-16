/**
 * 0102 a thumbnail on a published resource (BRD:FR-16.01 "maintain title,
 * description, type, content/reference, thumbnail, …"). The picture is
 * decorative: the title and text carry everything (FR-16.04), so it is shown
 * with empty alternative text. Staff upload it to the resource; it reaches the
 * public only when the resource is next published, so a picture nobody
 * approved is never shown. Removing it takes effect at once. Only the storage
 * keys are kept here; the image is re-encoded on upload, which drops its
 * location and camera details.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.resource
      add column thumbnail_key text,
      add column thumbnail_at timestamptz,
      add column thumbnail_by uuid,
      add column published_thumbnail_key text`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.resource
      drop column if exists published_thumbnail_key,
      drop column if exists thumbnail_by,
      drop column if exists thumbnail_at,
      drop column if exists thumbnail_key`.execute(db);
  await loadDictionary(db);
}
