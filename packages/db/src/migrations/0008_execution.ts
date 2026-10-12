/**
 * 0008 execution rules:
 * - idempotency_key (BRD:FR-00.06, AC-00C): one business effect per execution id;
 * - governed_definition (BRD:FR-00.10, FR-18.05): versioned shared definitions;
 * - outbox (ADR-0007): events written in the same transaction as the business
 *   change and relayed to the queue by the worker.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.idempotency_key (
      tenant_id uuid not null references cg.tenant(id),
      scope text not null,
      key text not null,
      request_hash bytea not null,
      status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
      response_status integer,
      response_body jsonb,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null default now() + interval '24 hours',
      primary key (tenant_id, scope, key)
    )`.execute(db);
  await sql`create index idempotency_expiry_idx on cg.idempotency_key (expires_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.idempotency_key')`.execute(db);

  await sql`
    create table cg.governed_definition (
      tenant_id uuid not null references cg.tenant(id),
      key text not null,
      version integer not null,
      value jsonb not null,
      reason text,
      effective_from timestamptz not null default now(),
      created_at timestamptz not null default now(),
      created_by uuid,
      primary key (tenant_id, key, version)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.governed_definition')`.execute(db);
  // Definitions are versioned, never edited or removed.
  await sql`drop policy tenant_update on cg.governed_definition`.execute(db);
  await sql`drop policy tenant_delete on cg.governed_definition`.execute(db);
  await sql`
    create view cg.governed_definition_current as
      select distinct on (tenant_id, key) tenant_id, key, version, value, reason, effective_from, created_at, created_by
      from cg.governed_definition
      where effective_from <= now()
      order by tenant_id, key, version desc`.execute(db);
  await sql`grant select on cg.governed_definition_current to cg_app, cg_worker`.execute(db);

  await sql`
    create table cg.outbox (
      id bigserial primary key,
      tenant_id uuid not null references cg.tenant(id),
      topic text not null,
      payload jsonb not null,
      execution_id uuid,
      created_at timestamptz not null default now(),
      published_at timestamptz,
      attempts integer not null default 0,
      last_error text
    )`.execute(db);
  await sql`create index outbox_pending_idx on cg.outbox (id) where published_at is null`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.outbox')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.outbox cascade`.execute(db);
  await sql`drop view if exists cg.governed_definition_current`.execute(db);
  await sql`drop table if exists cg.governed_definition cascade`.execute(db);
  await sql`drop table if exists cg.idempotency_key cascade`.execute(db);
}
