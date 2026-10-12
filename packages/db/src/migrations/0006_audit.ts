/**
 * 0006 audit (SEC-18, BRD:FR-00.03, FR-08.01–08.05, RULE-07, ADM-05 guardrail 5).
 *
 * Append-only and tamper-evident, enforced in the database so no application
 * code path can weaken it (ADR-0012):
 * - UPDATE, DELETE and TRUNCATE are revoked from the application roles AND
 *   rejected by triggers for every role;
 * - a BEFORE INSERT trigger links each row to the previous one for the same
 *   tenant with sha256(prev_hash || canonical(row)) under an advisory lock, so
 *   the chain is strictly ordered per tenant;
 * - cg.audit_verify(tenant) re-walks the chain and reports the first bad row;
 * - occurred_at is what the actor reports; recorded_at is set here (AC-08A).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.audit_event (
      seq bigserial primary key,
      tenant_id uuid not null references cg.tenant(id),
      occurred_at timestamptz not null default now(),
      recorded_at timestamptz not null default now(),
      actor_account_id uuid,
      actor_kind text not null check (actor_kind in ('account', 'break_glass', 'public', 'system')),
      action text not null,
      target_type text not null,
      target_id text not null,
      target_version integer,
      changes jsonb,
      execution_id uuid,
      request_id text,
      classification_read text[] not null default '{}',
      reason text,
      prev_hash bytea,
      hash bytea not null
    )`.execute(db);
  await sql`create index audit_event_tenant_seq_idx on cg.audit_event (tenant_id, seq)`.execute(db);
  await sql`create index audit_event_target_idx on cg.audit_event (tenant_id, target_type, target_id)`.execute(
    db,
  );
  await sql`create index audit_event_actor_idx on cg.audit_event (tenant_id, actor_account_id, occurred_at)`.execute(
    db,
  );

  // Deterministic text for hashing: jsonb normalises key order; timestamps are
  // rendered explicitly in UTC so the result does not depend on session settings.
  await sql`
    create or replace function cg.audit_canonical(e cg.audit_event) returns text
    language sql immutable as $$
      select jsonb_build_object(
        'seq', e.seq,
        'tenant_id', e.tenant_id,
        'occurred_at', to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'recorded_at', to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actor_account_id', e.actor_account_id,
        'actor_kind', e.actor_kind,
        'action', e.action,
        'target_type', e.target_type,
        'target_id', e.target_id,
        'target_version', e.target_version,
        'changes', e.changes,
        'execution_id', e.execution_id,
        'request_id', e.request_id,
        'classification_read', to_jsonb(e.classification_read),
        'reason', e.reason
      )::text
    $$`.execute(db);

  await sql`
    create or replace function cg.audit_chain() returns trigger
    language plpgsql as $$
    declare prev bytea;
    begin
      perform pg_advisory_xact_lock(hashtext('cg.audit:' || new.tenant_id::text));
      select hash into prev from cg.audit_event
        where tenant_id = new.tenant_id order by seq desc limit 1;
      new.recorded_at := now();
      new.prev_hash := prev;
      new.hash := digest(coalesce(prev, '\\x'::bytea) || convert_to(cg.audit_canonical(new), 'UTF8'), 'sha256');
      return new;
    end $$`.execute(db);
  await sql`create trigger audit_chain before insert on cg.audit_event
            for each row execute function cg.audit_chain()`.execute(db);

  await sql`
    create or replace function cg.audit_immutable() returns trigger
    language plpgsql as $$
    begin
      raise exception 'audit records are immutable (FR-08.04)' using errcode = 'insufficient_privilege';
    end $$`.execute(db);
  await sql`create trigger audit_no_update before update or delete on cg.audit_event
            for each row execute function cg.audit_immutable()`.execute(db);
  await sql`create trigger audit_no_truncate before truncate on cg.audit_event
            for each statement execute function cg.audit_immutable()`.execute(db);
  await sql`revoke update, delete, truncate on cg.audit_event from cg_app, cg_worker`.execute(db);

  await sql`
    create or replace function cg.audit_verify(p_tenant uuid)
    returns table (ok boolean, checked bigint, first_bad_seq bigint)
    language plpgsql stable as $$
    declare
      r cg.audit_event;
      prev bytea := null;
      n bigint := 0;
    begin
      for r in select * from cg.audit_event e where e.tenant_id = p_tenant order by e.seq loop
        if r.prev_hash is distinct from prev
           or r.hash <> digest(coalesce(prev, '\\x'::bytea) || convert_to(cg.audit_canonical(r), 'UTF8'), 'sha256') then
          return query select false, n, r.seq;
          return;
        end if;
        prev := r.hash;
        n := n + 1;
      end loop;
      return query select true, n, null::bigint;
    end $$`.execute(db);

  // Audit rows are visible only to their own tenant (never through sharing agreements).
  await sql`alter table cg.audit_event enable row level security`.execute(db);
  await sql`alter table cg.audit_event force row level security`.execute(db);
  await sql`create policy audit_select on cg.audit_event for select using (
              tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(db);
  await sql`create policy audit_insert on cg.audit_event for insert with check (
              tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(db);

  // Periodic anchors: latest hash per tenant, written to object storage with
  // object lock by the worker so a database-level rewrite is detectable.
  await sql`
    create table cg.audit_anchor (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      through_seq bigint not null,
      hash bytea not null,
      anchored_at timestamptz not null default now(),
      object_key text
    )`.execute(db);
  await sql`create index audit_anchor_tenant_idx on cg.audit_anchor (tenant_id, through_seq)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.audit_anchor')`.execute(db);
  await sql`drop policy tenant_update on cg.audit_anchor`.execute(db);
  await sql`drop policy tenant_delete on cg.audit_anchor`.execute(db);
  await sql`revoke update, delete, truncate on cg.audit_anchor from cg_app, cg_worker`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.audit_anchor cascade`.execute(db);
  await sql`drop function if exists cg.audit_verify(uuid)`.execute(db);
  await sql`drop table if exists cg.audit_event cascade`.execute(db);
  await sql`drop function if exists cg.audit_immutable()`.execute(db);
  await sql`drop function if exists cg.audit_chain()`.execute(db);
  await sql`drop function if exists cg.audit_canonical(cg.audit_event)`.execute(db);
}
