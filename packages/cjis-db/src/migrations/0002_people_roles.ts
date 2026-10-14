/**
 * 0002 enclave people, screening and roles (SEC-12, ADM-05, layer-5 plan §4):
 * - agency_key: the agency's wrapped data keys (SEC-10, envelope encryption);
 * - person: enclave accounts with personnel screening as status and dates
 *   only (fingerprint-based check adjudicated, security awareness training
 *   with its expiry), never the screening results themselves;
 * - role_grant and permission_request: every grant or revoke is a request a
 *   second administrator approves; nobody approves their own (ADM-05);
 * - identity_outbox: identity changes the enclave worker applies to the
 *   enclave's Keycloak with retries (onboarding, suspension);
 * - idp_event_cursor: how far sign-in events have been copied into the audit.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from '../dictionary.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cjis.agency_key (
      agency_id uuid not null references cjis.agency(id),
      version integer not null,
      wrapped text not null,
      kek_name text not null,
      created_at timestamptz not null default now(),
      primary key (agency_id, version)
    )`.execute(db);
  await sql`select cjis.apply_agency_rls('cjis.agency_key')`.execute(db);
  // A data key is never changed or removed once written; rotation adds a version.
  await sql`drop policy agency_update on cjis.agency_key`.execute(db);
  await sql`drop policy agency_delete on cjis.agency_key`.execute(db);

  await sql`
    create table cjis.person (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      idp_subject text unique,
      email text not null,
      display_name text not null,
      status text not null default 'invited' check (status in ('invited', 'active', 'suspended', 'deactivated')),
      status_reason text,
      fingerprint_status text not null default 'not_started' check (fingerprint_status in ('not_started', 'pending', 'cleared', 'denied')),
      fingerprint_adjudicated_on date,
      fingerprint_recorded_by uuid,
      training_completed_on date,
      training_expires_on date,
      training_recorded_by uuid,
      identity_state text not null default 'none' check (identity_state in ('none', 'pending', 'created', 'failed')),
      last_seen_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (fingerprint_status <> 'cleared' or fingerprint_adjudicated_on is not null),
      check (training_completed_on is null or training_expires_on > training_completed_on)
    )`.execute(db);
  await sql`create unique index person_email_idx on cjis.person (lower(email))`.execute(db);
  await sql`create index person_agency_idx on cjis.person (agency_id, status)`.execute(db);
  await sql`create trigger person_touch before update on cjis.person for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.person')`.execute(db);
  // Accounts are deactivated, never deleted: the audit trail names them.
  await sql`drop policy agency_delete on cjis.person`.execute(db);

  await sql`
    create table cjis.permission_request (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      person_id uuid not null references cjis.person(id),
      role text not null check (role in ('officer', 'supervisor', 'records_clerk', 'agency_admin', 'security_officer', 'auditor')),
      change text not null check (change in ('grant', 'revoke')),
      status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
      reason text not null,
      requested_by uuid not null references cjis.person(id),
      requested_at timestamptz not null default now(),
      decided_by uuid references cjis.person(id),
      decided_at timestamptz,
      decision_reason text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      -- ADM-05: a second administrator decides; the database refuses the requester.
      check (decided_by is null or decided_by <> requested_by),
      check ((status = 'pending') = (decided_at is null))
    )`.execute(db);
  await sql`create index permission_request_agency_idx on cjis.permission_request (agency_id, status)`.execute(
    db,
  );
  await sql`create trigger permission_request_touch before update on cjis.permission_request for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.permission_request')`.execute(db);
  await sql`drop policy agency_delete on cjis.permission_request`.execute(db);

  await sql`
    create table cjis.role_grant (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      person_id uuid not null references cjis.person(id),
      role text not null check (role in ('officer', 'supervisor', 'records_clerk', 'agency_admin', 'security_officer', 'auditor')),
      status text not null default 'active' check (status in ('active', 'revoked')),
      request_id uuid references cjis.permission_request(id),
      granted_by uuid references cjis.person(id),
      granted_at timestamptz not null default now(),
      revoked_by uuid references cjis.person(id),
      revoked_at timestamptz,
      revoke_request_id uuid references cjis.permission_request(id),
      version integer not null default 1,
      updated_at timestamptz not null default now(),
      check ((status = 'revoked') = (revoked_at is not null))
    )`.execute(db);
  await sql`create unique index role_grant_active_idx on cjis.role_grant (person_id, role) where status = 'active'`.execute(
    db,
  );
  await sql`create trigger role_grant_touch before update on cjis.role_grant for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.role_grant')`.execute(db);
  await sql`drop policy agency_delete on cjis.role_grant`.execute(db);

  await sql`
    create table cjis.identity_outbox (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      person_id uuid not null references cjis.person(id),
      kind text not null check (kind in ('create_user', 'disable_user', 'enable_user')),
      payload_enc bytea,
      status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
      attempts integer not null default 0,
      last_error text,
      next_attempt_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      done_at timestamptz
    )`.execute(db);
  await sql`create index identity_outbox_due_idx on cjis.identity_outbox (status, next_attempt_at)`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.identity_outbox')`.execute(db);

  // One row: the time of the newest sign-in event already in the audit (system only).
  await sql`
    create table cjis.idp_event_cursor (
      id integer primary key check (id = 1),
      last_time_ms bigint not null default 0,
      updated_at timestamptz not null default now()
    )`.execute(db);
  await sql`revoke all on cjis.idp_event_cursor from cjis_app`.execute(db);

  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cjis.idp_event_cursor`.execute(db);
  await sql`drop table if exists cjis.identity_outbox`.execute(db);
  await sql`drop table if exists cjis.role_grant`.execute(db);
  await sql`drop table if exists cjis.permission_request`.execute(db);
  await sql`drop table if exists cjis.person`.execute(db);
  await sql`drop table if exists cjis.agency_key`.execute(db);
  await loadDictionary(db);
}
