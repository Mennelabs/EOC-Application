/**
 * 0107 resource requests to the state (CON-13; the ICS 213 RR blocks). A
 * county asks the state, or a local supplier, for what it cannot meet itself:
 * each line an item with quantity, kind, type and description; the delivery
 * or reporting location; who asked and in which position; priority;
 * substitutes and suggested sources; cost and finance's reply; where it was
 * placed and the state's tracking number; when it is due and when it came.
 *
 * - The flow is draft, submitted (with a reason), approved by a second person
 *   as section chief (never the one who submitted it: ADM-05 G4, and the
 *   table refuses it too), placed with the state or locally, en route,
 *   received; or cancelled before it is received. Every step is a row in
 *   cg.resource_request_step: who, when, from and to which state, the reason
 *   and the state's number, so the history reads without the audit log.
 * - A request may be raised from a site's supply request (FL:FR-21), keeping
 *   the link. Lines come from a form, never from a resident: a household's
 *   need reaches a request only as a count (layer-8 plan §12).
 * - Requests and their steps are public records of the event and are kept
 *   with it (SEC-13, the default category): cancelled, never deleted.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.resource_request (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      request_number text not null check (char_length(request_number) between 3 and 40),
      status text not null default 'draft'
        check (status in ('draft', 'submitted', 'approved', 'placed', 'en_route', 'received', 'cancelled')),
      priority text not null default 'high' check (priority in ('urgent', 'high', 'low')),
      supply_request_id uuid references cg.supply_request(id),
      delivery_location text check (char_length(delivery_location) <= 500),
      requested_by_name text not null check (char_length(requested_by_name) between 1 and 120),
      requested_by_position text check (char_length(requested_by_position) <= 120),
      substitutes text check (char_length(substitutes) <= 2000),
      suggested_sources text check (char_length(suggested_sources) <= 2000),
      notes text check (char_length(notes) <= 4000),
      cost_estimate numeric(12, 2) check (cost_estimate >= 0),
      finance_reply text check (char_length(finance_reply) <= 2000),
      finance_replied_at timestamptz,
      finance_replied_by uuid,
      submitted_at timestamptz,
      submitted_by uuid,
      approved_at timestamptz,
      approved_by uuid,
      placed_at timestamptz,
      placed_by uuid,
      placed_with text check (placed_with in ('state', 'local')),
      state_tracking_number text check (char_length(state_tracking_number) <= 80),
      supplier text check (char_length(supplier) <= 200),
      logistics_order_number text check (char_length(logistics_order_number) <= 80),
      eta timestamptz,
      arrived_at timestamptz,
      received_at timestamptz,
      received_by uuid,
      cancelled_at timestamptz,
      cancelled_by uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, request_number),
      -- ADM-05 G4: the person who submitted a request never approves it.
      check (approved_by is null or submitted_by is null or approved_by <> submitted_by),
      check (status = 'cancelled' or (status <> 'draft') = (submitted_at is not null)),
      check (status = 'cancelled' or (status in ('approved', 'placed', 'en_route', 'received')) = (approved_at is not null)),
      check (status = 'cancelled' or (status in ('placed', 'en_route', 'received')) = (placed_at is not null)),
      check ((placed_at is null) = (placed_with is null)),
      check ((status = 'received') = (received_at is not null)),
      check ((status = 'cancelled') = (cancelled_at is not null)),
      check ((finance_reply is null) = (finance_replied_at is null))
    )`.execute(db);
  await sql`create index resource_request_event_idx
    on cg.resource_request (tenant_id, event_id, status, updated_at desc)`.execute(db);
  await sql`create trigger resource_request_touch before update on cg.resource_request for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.resource_request')`.execute(db);
  // Requests are cancelled, never deleted by the application.
  await sql`drop policy tenant_delete on cg.resource_request`.execute(db);

  await sql`
    create table cg.resource_request_line (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      request_id uuid not null references cg.resource_request(id) on delete cascade,
      line_no integer not null check (line_no between 1 and 200),
      quantity numeric(12, 2) not null check (quantity > 0),
      unit text check (char_length(unit) <= 40),
      kind text not null check (char_length(kind) between 1 and 120),
      type text check (char_length(type) <= 120),
      description text check (char_length(description) <= 1000),
      eta timestamptz,
      cost numeric(12, 2) check (cost >= 0),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (request_id, line_no)
    )`.execute(db);
  await sql`create trigger resource_request_line_touch before update on cg.resource_request_line for each row execute function cg.touch()`.execute(
    db,
  );
  // Lines of a draft are replaced as a set, so this table keeps the tenant delete policy.
  await sql`select cg.apply_tenant_rls('cg.resource_request_line')`.execute(db);

  await sql`
    create table cg.resource_request_step (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      request_id uuid not null references cg.resource_request(id),
      step text not null check (step in (
        'drafted', 'changed', 'submitted', 'approved', 'finance_replied', 'placed',
        'en_route', 'received', 'cancelled', 'state_update')),
      from_status text,
      to_status text,
      reason text check (char_length(reason) <= 500),
      state_tracking_number text check (char_length(state_tracking_number) <= 80),
      occurred_at timestamptz not null default now(),
      actor_account_id uuid,
      actor_kind text not null default 'account' check (actor_kind in ('account', 'api_key', 'system')),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index resource_request_step_idx
    on cg.resource_request_step (request_id, occurred_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.resource_request_step')`.execute(db);
  // The history is never rewritten.
  await sql`drop policy tenant_delete on cg.resource_request_step`.execute(db);
  await sql`drop policy tenant_update on cg.resource_request_step`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.resource_request_step`.execute(db);
  await sql`drop table if exists cg.resource_request_line`.execute(db);
  await sql`drop table if exists cg.resource_request`.execute(db);
  await loadDictionary(db);
}
