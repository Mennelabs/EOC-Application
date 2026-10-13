/**
 * 0021 needs board (layer-3 plan §2; CON-08, CON-15, NED-02, NED-07, AC-17B):
 * claims, assignment, release and done on cg.need with an append-only history;
 * needs that stand alone without a damage report; per-event visibility of
 * partners' claims. Every column is in the dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.need
      add column claimed_by_tenant_id uuid references cg.tenant(id),
      add column claimed_by_account_id uuid,
      add column claimed_at timestamptz,
      add column assigned_by_account_id uuid,
      add column released_at timestamptz,
      add column done_at timestamptz,
      add column done_note text,
      add column source text not null default 'report' check (source in ('report', 'standalone', 'staff')),
      add column location_id uuid references cg.location(id),
      add column contact_party_id uuid references cg.party(id),
      add column reference_code text,
      add column execution_id uuid`.execute(db);
  await sql`alter table cg.need drop constraint need_status_check`.execute(db);
  await sql`
    alter table cg.need add constraint need_status_check
      check (status in ('open', 'claimed', 'in_progress', 'met', 'closed', 'withdrawn'))`.execute(
    db,
  );
  await sql`create index need_claim_idx on cg.need (tenant_id, claimed_by_tenant_id, status)`.execute(
    db,
  );
  await sql`create index need_execution_idx on cg.need (execution_id) where execution_id is not null`.execute(
    db,
  );

  // The board's history, append-only (CON-08, AC-17B).
  await sql`
    create table cg.need_event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      need_id uuid not null references cg.need(id),
      kind text not null check (kind in ('created', 'claimed', 'assigned', 'released', 'done', 'reopened', 'overlap_warned', 'exported', 'withdrawn')),
      actor_account_id uuid,
      actor_tenant_id uuid references cg.tenant(id),
      note text,
      detail jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index need_event_need_idx on cg.need_event (need_id, created_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.need_event')`.execute(db);
  await sql`drop policy tenant_update on cg.need_event`.execute(db);
  await sql`drop policy tenant_delete on cg.need_event`.execute(db);

  // Who sees whose claims (CON-15): per event or as the tenant default; set with a reason.
  await sql`
    create table cg.board_visibility (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid references cg.event(id),
      scope text not null check (scope in ('role', 'agency', 'person')),
      subject_key text not null,
      sees text not null check (sees in ('own', 'consented', 'all')),
      reason text not null,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create unique index board_visibility_unique_idx on cg.board_visibility (tenant_id, coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid), scope, subject_key)`.execute(
    db,
  );
  await sql`create trigger board_visibility_touch before update on cg.board_visibility for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.board_visibility')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.board_visibility cascade`.execute(db);
  await sql`drop table if exists cg.need_event cascade`.execute(db);
  await sql`drop index if exists cg.need_claim_idx`.execute(db);
  await sql`drop index if exists cg.need_execution_idx`.execute(db);
  await sql`alter table cg.need drop constraint need_status_check`.execute(db);
  await sql`update cg.need set status = 'claimed' where status = 'in_progress'`.execute(db);
  await sql`
    alter table cg.need add constraint need_status_check
      check (status in ('open', 'claimed', 'met', 'closed', 'withdrawn'))`.execute(db);
  await sql`
    alter table cg.need
      drop column claimed_by_tenant_id,
      drop column claimed_by_account_id,
      drop column claimed_at,
      drop column assigned_by_account_id,
      drop column released_at,
      drop column done_at,
      drop column done_note,
      drop column source,
      drop column location_id,
      drop column contact_party_id,
      drop column reference_code,
      drop column execution_id`.execute(db);
}
