/**
 * 0011 intake graph, reference codes and the submission fallback table
 * (layer-2 plan §2; INT-01, INT-22, FL-01, BRD:FR-11.04, SCL-03, SCL-06).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Versioned, tenant-configurable question graphs (INT-01, CON-02, SCL-07).
  await sql`
    create table cg.intake_graph (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      key text not null,
      graph_version integer not null check (graph_version > 0),
      status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
      graph jsonb not null,
      hazards text[] not null default '{}',
      languages text[] not null default '{en}',
      change_reason text,
      published_at timestamptz,
      published_by uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, key, graph_version)
    )`.execute(db);
  await sql`create trigger intake_graph_touch before update on cg.intake_graph for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.intake_graph')`.execute(db);

  // Pre-generated reference codes leased to API instances (INT-22, FL-01).
  await sql`
    create table cg.reference_code (
      tenant_id uuid not null references cg.tenant(id),
      code text not null check (code ~ '^[A-HJ-NP-Z]{4}-[2-9]{4}$'),
      state text not null default 'free' check (state in ('free', 'leased', 'used')),
      leased_by text,
      leased_at timestamptz,
      execution_id uuid,
      report_id uuid,
      created_at timestamptz not null default now(),
      primary key (tenant_id, code)
    )`.execute(db);
  await sql`create index reference_code_free_idx on cg.reference_code (tenant_id) where state = 'free'`.execute(
    db,
  );
  await sql`create index reference_code_lease_idx on cg.reference_code (leased_at) where state = 'leased'`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.reference_code')`.execute(db);

  // Every accepted submission, and the durable fallback when the queue is down (SCL-06).
  await sql`
    create table cg.intake_submission (
      execution_id uuid primary key,
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid references cg.event(id),
      channel text not null check (channel in ('web', 'sms', 'voice', 'assisted')),
      reference_code text not null,
      payload_enc bytea not null,
      status text not null default 'queued' check (status in ('queued', 'stored', 'processed', 'failed')),
      attempts integer not null default 0,
      last_error text,
      received_at timestamptz not null default now(),
      processed_at timestamptz
    )`.execute(db);
  await sql`create index intake_submission_pending_idx on cg.intake_submission (received_at) where status in ('queued', 'stored')`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.intake_submission')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.intake_submission cascade`.execute(db);
  await sql`drop table if exists cg.reference_code cascade`.execute(db);
  await sql`drop table if exists cg.intake_graph cascade`.execute(db);
}
