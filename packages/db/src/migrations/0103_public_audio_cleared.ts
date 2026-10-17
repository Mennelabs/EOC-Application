/**
 * 0103 AI radio audio is cleared for air by a person who heard it (PUB-14,
 * GATE-08 "AI confirmation", AIG-01). The register's human checkpoint for
 * the AI voice is that the PIO listens to the file before it goes on the air;
 * until now that was a procedure. The file can always be played to listen;
 * it can be downloaded for air only once someone with the right to publish
 * has played it to the end and cleared it, with a reason. Who and when are
 * kept here; the reason is in the audit record.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.public_audio
      add column cleared_by uuid,
      add column cleared_at timestamptz,
      add constraint public_audio_cleared_both check ((cleared_by is null) = (cleared_at is null))`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.public_audio
      drop constraint if exists public_audio_cleared_both,
      drop column if exists cleared_at,
      drop column if exists cleared_by`.execute(db);
  await loadDictionary(db);
}
