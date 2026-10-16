/**
 * 0079 facility owners keep their own entry current (REC-01). The yearly
 * re-check email to a facility's own contacts carries a single-use link; the
 * link's token is stored only as its SHA-256, expires, and is spent once
 * used. What the owner sends is a proposal (source `owner_link`) in the
 * county's approval queue, like any other change; nothing reaches the
 * registry until a named approver accepts it. Spent and expired links are
 * swept with one-time codes (retention category `otp`).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.facility_update_link (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      facility_id uuid not null references cg.facility(id),
      token_hash bytea not null unique,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index facility_update_link_facility_idx
    on cg.facility_update_link (tenant_id, facility_id)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.facility_update_link')`.execute(db);
  await sql`alter table cg.facility_change drop constraint facility_change_source_check`.execute(
    db,
  );
  await sql`alter table cg.facility_change add constraint facility_change_source_check
    check (source in ('coad', 'owner', 'self_registration', 'discovery', 'county', 'owner_link'))`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.facility_change no force row level security`.execute(db);
  await sql`delete from cg.facility_change where source = 'owner_link'`.execute(db);
  await sql`alter table cg.facility_change force row level security`.execute(db);
  await sql`alter table cg.facility_change drop constraint facility_change_source_check`.execute(
    db,
  );
  await sql`alter table cg.facility_change add constraint facility_change_source_check
    check (source in ('coad', 'owner', 'self_registration', 'discovery', 'county'))`.execute(db);
  await sql`drop table if exists cg.facility_update_link`.execute(db);
  await loadDictionary(db);
}
