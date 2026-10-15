/**
 * 0072 near-identical photos (layer-7 task I; PHO-15). Each processed photo
 * keeps a 64-bit difference hash of its oriented image: two photos whose hashes
 * differ in only a few bits look the same to a person even when their bytes
 * differ (resized, recompressed, screenshotted). Another report with such a
 * photo is flagged for a person to judge; nothing is merged or rejected on it.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.photo add column phash bigint`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.photo drop column if exists phash`.execute(db);
  await loadDictionary(db);
}
