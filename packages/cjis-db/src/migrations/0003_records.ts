/**
 * 0003 law-enforcement records (SEC-12, PPL-01, BRD:D02, BRD:D07,
 * BRD:FR-07.01–07.06, BRD:FR-04.01): the criminal-justice information that
 * belongs to a platform mission, keyed by the opaque `cji_ref` the platform
 * holds. Identifying and free-text values are encrypted under the owning
 * agency's key (`*_enc`, SEC-10); codes the enclave filters on stay plain and
 * are classified `cji` like everything else here.
 * - record: one per linked mission, the declared platform context, origin,
 *   classification, offense codes, case number, disposition with reviewer;
 * - record_person: people involved in law-enforcement roles (one
 *   authoritative representation, BRD:FR-07.02);
 * - record_weapon, record_bodycam: weapon details and body-camera references
 *   (references only: no video is stored in the enclave);
 * - record_event: the append-only timeline with narratives and amendments;
 * - idempotency_key: replays of creates, with the stored response encrypted.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from '../dictionary.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cjis.record (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      cji_ref text not null,
      platform_county text,
      platform_mission_reference text,
      origin text check (origin in ('911', 'non_emergency', 'officer_initiated', 'walk_in', 'text', 'radio', 'other')),
      classification text check (classification in ('welfare_check', 'disturbance', 'assault', 'theft', 'burglary', 'looting', 'trespass', 'traffic', 'missing_person', 'death_investigation', 'domestic', 'weapons_offense', 'warrant_service', 'other')),
      offense_codes text[] not null default '{}',
      case_number_enc bytea,
      summary_enc bytea,
      state text not null default 'open' check (state in ('open', 'closed')),
      disposition text check (disposition in ('arrest_made', 'citation_issued', 'report_filed', 'no_action_taken', 'transported', 'referred', 'completed')),
      disposition_note_enc bytea,
      disposition_by uuid references cjis.person(id),
      disposition_at timestamptz,
      reviewed_by uuid references cjis.person(id),
      reviewed_at timestamptz,
      closed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cjis.person(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cjis.person(id),
      unique (agency_id, cji_ref),
      check (cji_ref ~ '^[A-Za-z0-9_-]{32,64}$'),
      check (state <> 'closed' or disposition is not null),
      check ((disposition is null) = (disposition_at is null))
    )`.execute(db);
  await sql`create index record_agency_idx on cjis.record (agency_id, state, updated_at desc)`.execute(
    db,
  );
  await sql`create trigger record_touch before update on cjis.record for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.record')`.execute(db);
  // Records leave only through the retention job (system role); callers never delete.
  await sql`drop policy agency_delete on cjis.record`.execute(db);
  await sql`create policy record_retention_delete on cjis.record for delete using (cjis.is_system())`.execute(
    db,
  );

  await sql`
    create table cjis.record_person (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      record_id uuid not null references cjis.record(id) on delete cascade,
      role text not null check (role in ('suspect', 'arrestee', 'victim', 'witness', 'complainant', 'subject', 'reporting_party', 'other')),
      name_enc bytea not null,
      birth_date_enc bytea,
      demographics_enc bytea,
      contact_enc bytea,
      address_enc bytea,
      identifiers_enc bytea,
      notes_enc bytea,
      status text not null default 'active' check (status in ('active', 'removed')),
      removed_reason text,
      removed_by uuid references cjis.person(id),
      removed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cjis.person(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cjis.person(id),
      check ((status = 'removed') = (removed_at is not null))
    )`.execute(db);
  await sql`create index record_person_record_idx on cjis.record_person (record_id, status)`.execute(
    db,
  );
  await sql`create trigger record_person_touch before update on cjis.record_person for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.record_person')`.execute(db);
  await sql`drop policy agency_delete on cjis.record_person`.execute(db);

  await sql`
    create table cjis.record_weapon (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      record_id uuid not null references cjis.record(id) on delete cascade,
      person_id uuid references cjis.record_person(id),
      kind text not null check (kind in ('firearm', 'edged', 'blunt', 'explosive', 'other', 'unknown')),
      description_enc bytea,
      serial_enc bytea,
      disposition text not null default 'observed' check (disposition in ('observed', 'seized', 'returned', 'unknown')),
      status text not null default 'active' check (status in ('active', 'removed')),
      removed_reason text,
      removed_by uuid references cjis.person(id),
      removed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cjis.person(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cjis.person(id),
      check ((status = 'removed') = (removed_at is not null))
    )`.execute(db);
  await sql`create index record_weapon_record_idx on cjis.record_weapon (record_id, status)`.execute(
    db,
  );
  await sql`create trigger record_weapon_touch before update on cjis.record_weapon for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.record_weapon')`.execute(db);
  await sql`drop policy agency_delete on cjis.record_weapon`.execute(db);

  await sql`
    create table cjis.record_bodycam (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      record_id uuid not null references cjis.record(id) on delete cascade,
      camera_label text not null,
      officer_person_id uuid references cjis.person(id),
      recorded_from timestamptz,
      recorded_to timestamptz,
      evidence_reference_enc bytea not null,
      notes_enc bytea,
      status text not null default 'active' check (status in ('active', 'removed')),
      removed_reason text,
      removed_by uuid references cjis.person(id),
      removed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cjis.person(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cjis.person(id),
      check ((status = 'removed') = (removed_at is not null)),
      check (recorded_to is null or recorded_from is null or recorded_to >= recorded_from)
    )`.execute(db);
  await sql`create index record_bodycam_record_idx on cjis.record_bodycam (record_id, status)`.execute(
    db,
  );
  await sql`create trigger record_bodycam_touch before update on cjis.record_bodycam for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.record_bodycam')`.execute(db);
  await sql`drop policy agency_delete on cjis.record_bodycam`.execute(db);

  await sql`
    create table cjis.record_event (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      record_id uuid not null references cjis.record(id) on delete cascade,
      kind text not null check (kind in ('created', 'updated', 'narrative', 'amendment', 'person_added', 'person_updated', 'person_removed', 'weapon_added', 'weapon_updated', 'weapon_removed', 'bodycam_added', 'bodycam_updated', 'bodycam_removed', 'disposition', 'reviewed', 'reopened')),
      narrative_role text check (narrative_role in ('officer', 'supervisor', 'records')),
      body_enc bytea,
      amends_event_id uuid references cjis.record_event(id),
      actor_person_id uuid references cjis.person(id),
      detail jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      check (kind not in ('narrative', 'amendment') or (body_enc is not null and narrative_role is not null)),
      check ((kind = 'amendment') = (amends_event_id is not null))
    )`.execute(db);
  await sql`create index record_event_record_idx on cjis.record_event (record_id, occurred_at)`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.record_event')`.execute(db);
  // Append-only (BRD:FR-07.01/07.03): a narrative is amended by a new event, never edited.
  await sql`drop policy agency_update on cjis.record_event`.execute(db);
  await sql`drop policy agency_delete on cjis.record_event`.execute(db);
  await sql`create policy record_event_retention_delete on cjis.record_event for delete using (cjis.is_system())`.execute(
    db,
  );
  await sql`revoke update on cjis.record_event from cjis_app, cjis_job`.execute(db);

  await sql`
    create table cjis.idempotency_key (
      agency_id uuid not null references cjis.agency(id),
      scope text not null,
      key uuid not null,
      request_hash bytea not null,
      status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
      response_status integer,
      response_body_enc bytea,
      expires_at timestamptz not null default now() + interval '24 hours',
      created_at timestamptz not null default now(),
      primary key (agency_id, scope, key)
    )`.execute(db);
  await sql`select cjis.apply_agency_rls('cjis.idempotency_key')`.execute(db);

  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cjis.idempotency_key`.execute(db);
  await sql`drop table if exists cjis.record_event`.execute(db);
  await sql`drop table if exists cjis.record_bodycam`.execute(db);
  await sql`drop table if exists cjis.record_weapon`.execute(db);
  await sql`drop table if exists cjis.record_person`.execute(db);
  await sql`drop table if exists cjis.record`.execute(db);
  await loadDictionary(db);
}
