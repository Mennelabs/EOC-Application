/**
 * 0004 enclave audit and retention (SEC-18, BRD:FR-08.04, ADM-05, SEC-13;
 * CJIS audit and accountability: what, when, who, outcome; weekly review;
 * retention): the enclave's own append-only, hash-chained audit, separate
 * from the platform's (same design as ADR-0012, its own chain per agency).
 * - audit_event: every read of a record, every write, every denial, every
 *   export and review, sign-in events copied from the enclave's Keycloak;
 *   UPDATE, DELETE and TRUNCATE are revoked and rejected by triggers for
 *   every role; values are never stored, only field names;
 * - audit_review: the weekly review a security officer records;
 * - retention_policy: per agency and category, with floors (records one
 *   year, audit seven years; legal holds override deletion);
 * - legal_hold and deletion_log.
 * Rows without an agency (a sign-in by someone the enclave does not know)
 * chain under the all-zero key and are readable by the system only.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from '../dictionary.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cjis.audit_event (
      seq bigserial primary key,
      agency_id uuid references cjis.agency(id),
      occurred_at timestamptz not null default now(),
      recorded_at timestamptz not null default now(),
      actor_person_id uuid,
      actor_kind text not null check (actor_kind in ('person', 'system', 'identity_provider', 'anonymous')),
      action text not null,
      target_type text not null,
      target_id text not null,
      target_version integer,
      outcome text not null check (outcome in ('success', 'denied', 'failure')),
      reason text,
      fields text[] not null default '{}',
      request_id text,
      source_ip text,
      prev_hash bytea,
      hash bytea not null
    )`.execute(db);
  await sql`create index audit_event_agency_seq_idx on cjis.audit_event (agency_id, seq)`.execute(
    db,
  );
  await sql`create index audit_event_target_idx on cjis.audit_event (agency_id, target_type, target_id)`.execute(
    db,
  );
  await sql`create index audit_event_actor_idx on cjis.audit_event (agency_id, actor_person_id, occurred_at)`.execute(
    db,
  );

  await sql`
    create or replace function cjis.audit_canonical(e cjis.audit_event) returns text
    language sql immutable as $$
      select jsonb_build_object(
        'seq', e.seq,
        'agency_id', e.agency_id,
        'occurred_at', to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'recorded_at', to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actor_person_id', e.actor_person_id,
        'actor_kind', e.actor_kind,
        'action', e.action,
        'target_type', e.target_type,
        'target_id', e.target_id,
        'target_version', e.target_version,
        'outcome', e.outcome,
        'reason', e.reason,
        'fields', to_jsonb(e.fields),
        'request_id', e.request_id,
        'source_ip', e.source_ip
      )::text
    $$`.execute(db);

  // The sequence number is drawn after the chain lock, so seq order is chain order
  // (the platform learned this in its migration 0040).
  await sql`
    create or replace function cjis.audit_chain() returns trigger
    language plpgsql as $$
    declare
      prev bytea;
      chain uuid := coalesce(new.agency_id, '00000000-0000-0000-0000-000000000000'::uuid);
    begin
      perform pg_advisory_xact_lock(hashtext('cjis.audit:' || chain::text));
      new.seq := nextval(pg_get_serial_sequence('cjis.audit_event', 'seq'));
      select hash into prev from cjis.audit_event
        where agency_id is not distinct from new.agency_id order by seq desc limit 1;
      new.recorded_at := now();
      new.prev_hash := prev;
      new.hash := digest(coalesce(prev, '\\x'::bytea) || convert_to(cjis.audit_canonical(new), 'UTF8'), 'sha256');
      return new;
    end $$`.execute(db);
  await sql`create trigger audit_chain before insert on cjis.audit_event
            for each row execute function cjis.audit_chain()`.execute(db);

  await sql`
    create or replace function cjis.audit_immutable() returns trigger
    language plpgsql as $$
    begin
      raise exception 'enclave audit records are immutable (BRD:FR-08.04)' using errcode = 'insufficient_privilege';
    end $$`.execute(db);
  await sql`create trigger audit_no_update before update or delete on cjis.audit_event
            for each row execute function cjis.audit_immutable()`.execute(db);
  await sql`create trigger audit_no_truncate before truncate on cjis.audit_event
            for each statement execute function cjis.audit_immutable()`.execute(db);
  await sql`revoke update, delete, truncate on cjis.audit_event from cjis_app, cjis_job`.execute(
    db,
  );

  await sql`
    create or replace function cjis.audit_verify(p_agency uuid)
    returns table (ok boolean, checked bigint, first_bad_seq bigint)
    language plpgsql stable as $$
    declare
      r cjis.audit_event;
      prev bytea := null;
      n bigint := 0;
    begin
      for r in select * from cjis.audit_event e
               where e.agency_id is not distinct from p_agency order by e.seq loop
        if r.prev_hash is distinct from prev
           or r.hash <> digest(coalesce(prev, '\\x'::bytea) || convert_to(cjis.audit_canonical(r), 'UTF8'), 'sha256') then
          return query select false, n, r.seq;
          return;
        end if;
        prev := r.hash;
        n := n + 1;
      end loop;
      return query select true, n, null::bigint;
    end $$`.execute(db);

  await sql`alter table cjis.audit_event enable row level security`.execute(db);
  await sql`alter table cjis.audit_event force row level security`.execute(db);
  await sql`create policy audit_select on cjis.audit_event for select using (
              agency_id = cjis.current_agency_id() or cjis.is_system())`.execute(db);
  // A denial before the caller's agency is known is written by the system path only.
  await sql`create policy audit_insert on cjis.audit_event for insert with check (
              agency_id = cjis.current_agency_id() or cjis.is_system())`.execute(db);

  await sql`
    create table cjis.audit_review (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      reviewer_person_id uuid not null references cjis.person(id),
      period_from timestamptz not null,
      period_to timestamptz not null,
      checked integer not null,
      chain_ok boolean not null,
      note text not null,
      created_at timestamptz not null default now(),
      check (period_to > period_from)
    )`.execute(db);
  await sql`select cjis.apply_agency_rls('cjis.audit_review')`.execute(db);
  await sql`drop policy agency_update on cjis.audit_review`.execute(db);
  await sql`drop policy agency_delete on cjis.audit_review`.execute(db);

  // SEC-13: CJIS and state records rules. Defaults are written per agency by
  // provisioning (records 7 years after closure, audit 7 years).
  await sql`
    create table cjis.retention_policy (
      agency_id uuid not null references cjis.agency(id),
      category text not null check (category in ('records', 'audit')),
      keep_days integer not null,
      basis text not null,
      version integer not null default 1,
      updated_at timestamptz not null default now(),
      updated_by uuid references cjis.person(id),
      primary key (agency_id, category),
      check (category <> 'records' or keep_days >= 365),
      check (category <> 'audit' or keep_days >= 2557)
    )`.execute(db);
  await sql`create trigger retention_policy_touch before update on cjis.retention_policy for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.retention_policy')`.execute(db);
  await sql`drop policy agency_delete on cjis.retention_policy`.execute(db);

  await sql`
    create table cjis.legal_hold (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      record_id uuid references cjis.record(id) on delete restrict,
      reason text not null,
      placed_by uuid not null references cjis.person(id),
      placed_at timestamptz not null default now(),
      released_by uuid references cjis.person(id),
      released_at timestamptz,
      release_reason text,
      version integer not null default 1,
      updated_at timestamptz not null default now(),
      check ((released_at is null) = (released_by is null)),
      check (released_at is null or release_reason is not null)
    )`.execute(db);
  await sql`create index legal_hold_active_idx on cjis.legal_hold (agency_id, record_id) where released_at is null`.execute(
    db,
  );
  await sql`create trigger legal_hold_touch before update on cjis.legal_hold for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`select cjis.apply_agency_rls('cjis.legal_hold')`.execute(db);
  await sql`drop policy agency_delete on cjis.legal_hold`.execute(db);

  await sql`
    create table cjis.deletion_log (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references cjis.agency(id),
      category text not null,
      cutoff timestamptz not null,
      deleted integer not null,
      held integer not null,
      ran_at timestamptz not null default now()
    )`.execute(db);
  await sql`select cjis.apply_agency_rls('cjis.deletion_log')`.execute(db);
  await sql`drop policy agency_update on cjis.deletion_log`.execute(db);
  await sql`drop policy agency_delete on cjis.deletion_log`.execute(db);

  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cjis.deletion_log`.execute(db);
  await sql`drop table if exists cjis.legal_hold`.execute(db);
  await sql`drop table if exists cjis.retention_policy`.execute(db);
  await sql`drop table if exists cjis.audit_review`.execute(db);
  await sql`drop function if exists cjis.audit_verify(uuid)`.execute(db);
  await sql`drop table if exists cjis.audit_event cascade`.execute(db);
  await sql`drop function if exists cjis.audit_immutable()`.execute(db);
  await sql`drop function if exists cjis.audit_chain()`.execute(db);
  await sql`drop function if exists cjis.audit_canonical(cjis.audit_event)`.execute(db);
  await loadDictionary(db);
}
