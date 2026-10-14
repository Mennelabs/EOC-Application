/**
 * 0041 the platform's side of the CJIS enclave (layer-5 task D; SEC-12,
 * PPL-01, BRD:FR-07.02, BRD:FR-07.04, ADR-0021, ADR-0038). The platform holds
 * a pointer, never criminal-justice information:
 * - mission.cji_ref: a random 256-bit opaque reference (43 base64url
 *   characters), set once when a liaison links the mission to the enclave,
 *   with who and when; the enclave keys its record by it;
 * - the placeholder person role `enclave_reference` and its column are
 *   retired: law-enforcement people are recorded once, in the enclave
 *   ("one authoritative representation");
 * - body-camera references are refused for new media rows (they are CJI and
 *   belong in the enclave); rows written before this migration on a
 *   development database stay as they are (the check is NOT VALID).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.mission
    add column cji_ref text unique,
    add column cji_linked_at timestamptz,
    add column cji_linked_by uuid,
    add constraint mission_cji_ref_opaque check (cji_ref is null or cji_ref ~ '^[A-Za-z0-9_-]{43}$'),
    add constraint mission_cji_link_facts check ((cji_ref is null) = (cji_linked_at is null))`.execute(
    db,
  );
  // An enclave placeholder row on a development database becomes a plain "other" row first.
  await sql`update cg.mission_person set role = 'other' where role = 'enclave_reference'`.execute(
    db,
  );
  await sql`alter table cg.mission_person drop column enclave_reference`.execute(db);
  await sql`alter table cg.mission_person drop constraint mission_person_role_check`.execute(db);
  await sql`alter table cg.mission_person add constraint mission_person_role_check
    check (role in ('survivor', 'reporting_party', 'witness', 'subject', 'victim', 'caregiver', 'property_owner', 'other'))`.execute(
    db,
  );
  await sql`alter table cg.mission_media add constraint mission_media_no_bodycam
    check (kind <> 'bodycam_reference') not valid`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.mission_media drop constraint if exists mission_media_no_bodycam`.execute(
    db,
  );
  await sql`alter table cg.mission_person drop constraint mission_person_role_check`.execute(db);
  await sql`alter table cg.mission_person add constraint mission_person_role_check
    check (role in ('survivor', 'reporting_party', 'witness', 'subject', 'victim', 'caregiver', 'property_owner', 'other', 'enclave_reference'))`.execute(
    db,
  );
  await sql`alter table cg.mission_person add column enclave_reference text`.execute(db);
  await sql`alter table cg.mission
    drop constraint if exists mission_cji_link_facts,
    drop constraint if exists mission_cji_ref_opaque,
    drop column if exists cji_linked_by,
    drop column if exists cji_linked_at,
    drop column if exists cji_ref`.execute(db);
  // The retired entry describes the restored column again (SEC-11: no column undocumented at any step).
  await loadDictionary(db);
}
