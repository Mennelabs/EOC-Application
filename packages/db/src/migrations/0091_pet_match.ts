/**
 * 0091 lost-and-found matching for pets (FL:FR-08). A lost report and an
 * animal found or sheltered are linked when a person confirms they are the
 * same pet: each record names the other, with who confirmed it and when.
 * Candidates are only suggested (same event and kind of animal, words the
 * descriptions share); the link is always a person's decision. Reuniting
 * marks both records. No columns hold personal data: a pet is linked to its
 * owner by the owner's reference code only.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.pet_intake
    add column matched_with uuid references cg.pet_intake(id),
    add column matched_at timestamptz,
    add column matched_by uuid,
    add constraint pet_intake_matched check ((matched_with is null) = (matched_at is null))`.execute(
    db,
  );
  await sql`create index pet_intake_open_idx on cg.pet_intake (tenant_id, event_id, status)
    where matched_with is null`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists cg.pet_intake_open_idx`.execute(db);
  await sql`alter table cg.pet_intake
    drop constraint if exists pet_intake_matched,
    drop column if exists matched_by,
    drop column if exists matched_at,
    drop column if exists matched_with`.execute(db);
  await loadDictionary(db);
}
