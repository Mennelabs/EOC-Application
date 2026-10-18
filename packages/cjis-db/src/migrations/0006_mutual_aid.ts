/**
 * 0006 mutual aid between agencies (SEC-12, SEC-18, ADM-05; decision
 * 2026-10-15, replacing the layer-5 default of no sharing). One agency owns a
 * record. Its supervisor or administrator may grant a helping agency read
 * access to one record, for one mission, for a set period; the grant names
 * why. While it stands, the helping agency's CJIS-qualified officers read the
 * record and its entries (never write), every read lands in their own
 * agency's audit chain, and the grant ends by itself at its end time, by a
 * revoke, or when the record is deleted. Writes stay with the owner: the
 * shared-read policies are select-only, and the owner's insert, update and
 * delete policies are unchanged.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from '../dictionary.ts';

const KINDS = [
  'created',
  'updated',
  'narrative',
  'amendment',
  'person_added',
  'person_updated',
  'person_removed',
  'weapon_added',
  'weapon_updated',
  'weapon_removed',
  'bodycam_added',
  'bodycam_updated',
  'bodycam_removed',
  'disposition',
  'reviewed',
  'reopened',
  'shared',
  'share_revoked',
  'share_ended',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cjis.record_share (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      record_id uuid not null references cjis.record(id) on delete cascade,
      to_agency_id uuid not null references cjis.agency(id),
      platform_mission_reference text,
      purpose text not null check (char_length(purpose) between 3 and 300),
      starts_at timestamptz not null default now(),
      ends_at timestamptz not null,
      status text not null default 'active' check (status in ('active', 'revoked', 'ended')),
      granted_by uuid references cjis.person(id),
      revoked_by uuid references cjis.person(id),
      revoked_at timestamptz,
      revoke_reason text check (char_length(revoke_reason) <= 300),
      ended_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (ends_at > starts_at),
      check (to_agency_id <> agency_id),
      check ((status = 'revoked') = (revoked_at is not null)),
      check ((status = 'ended') = (ended_at is not null))
    )`.execute(db);
  await sql`create index record_share_record_idx on cjis.record_share (record_id, status)`.execute(
    db,
  );
  await sql`create index record_share_to_idx on cjis.record_share (to_agency_id, status, ends_at)`.execute(
    db,
  );
  await sql`create trigger record_share_touch before update on cjis.record_share for each row execute function cjis.touch()`.execute(
    db,
  );
  // The owner's agency holds the row; the helping agency reads it, nothing more.
  await sql`select cjis.apply_agency_rls('cjis.record_share')`.execute(db);
  await sql`drop policy agency_delete on cjis.record_share`.execute(db);
  await sql`
    create policy share_select_helper on cjis.record_share for select using (
      to_agency_id = cjis.current_agency_id())`.execute(db);

  // The directory: every enclave user sees the name and identifier of the enclave's active
  // agencies, so an owner can choose whom to share with and a helper can name the owner.
  // Agencies are organizations, not people; their people and records stay hidden (0001).
  await sql`
    create policy agency_directory on cjis.agency for select using (status = 'active')`.execute(db);

  // A standing grant to the current agency for this record, now.
  await sql`
    create or replace function cjis.record_shared_with_me(rid uuid) returns boolean
    language sql stable as $$
      select exists (
        select 1 from cjis.record_share s
        where s.record_id = rid
          and s.to_agency_id = cjis.current_agency_id()
          and s.status = 'active'
          and now() >= s.starts_at and now() < s.ends_at)
    $$`.execute(db);
  await sql`create policy shared_select on cjis.record for select using (cjis.record_shared_with_me(id))`.execute(
    db,
  );
  for (const tbl of ['record_person', 'record_weapon', 'record_bodycam', 'record_event'])
    await sql`create policy shared_select on ${sql.table(`cjis.${tbl}`)} for select using (cjis.record_shared_with_me(record_id))`.execute(
      db,
    );

  // The timeline records a share, a revoke and an end (append-only as before).
  await sql`alter table cjis.record_event drop constraint record_event_kind_check`.execute(db);
  await sql`alter table cjis.record_event add constraint record_event_kind_check check (kind in (${sql.join(
    KINDS.map((k) => sql.lit(k)),
  )}))`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const tbl of ['record', 'record_person', 'record_weapon', 'record_bodycam', 'record_event'])
    await sql`drop policy if exists shared_select on ${sql.table(`cjis.${tbl}`)}`.execute(db);
  await sql`drop function if exists cjis.record_shared_with_me(uuid)`.execute(db);
  await sql`drop policy if exists agency_directory on cjis.agency`.execute(db);
  await sql`drop table if exists cjis.record_share`.execute(db);
}
