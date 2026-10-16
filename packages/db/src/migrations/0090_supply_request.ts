/**
 * 0090 requests for supplies from a site (FL:FR-21, FL:FR-22). A
 * distribution point or shelter asks the warehouse for items, line by line
 * (the stock item, its name and unit, how many). A request is a draft until
 * a person sends it. When an item at a site reaches its reorder point, the
 * site's draft gains a line, created if there is none, with a suggested
 * quantity from how fast the item went out over the last day. Nothing is
 * sent on its own. The warehouse marks a sent request filled, optionally
 * naming the delivery mission that carried it, or a person cancels it.
 * One draft per site at a time. Like stock, these are equipment records,
 * not personal data, and follow the core records they are used for
 * (SEC-13); there is no delete policy for the application.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.supply_request (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      client_uuid uuid,
      status text not null default 'draft' check (status in ('draft', 'sent', 'filled', 'canceled')),
      drafted_automatically boolean not null default false,
      lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
      note text,
      sent_at timestamptz,
      sent_by uuid,
      filled_at timestamptz,
      filled_by uuid,
      mission_id uuid references cg.mission(id),
      canceled_at timestamptz,
      canceled_by uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid),
      check ((status in ('sent', 'filled')) = (sent_at is not null) or status = 'canceled'),
      check ((status = 'filled') = (filled_at is not null)),
      check ((status = 'canceled') = (canceled_at is not null))
    )`.execute(db);
  await sql`create unique index supply_request_one_draft
    on cg.supply_request (tenant_id, site_id) where status = 'draft'`.execute(db);
  await sql`create index supply_request_status_idx
    on cg.supply_request (tenant_id, status, updated_at desc)`.execute(db);
  await sql`create trigger supply_request_touch before update on cg.supply_request for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.supply_request')`.execute(db);
  // Requests are canceled, never deleted by the application.
  await sql`drop policy tenant_delete on cg.supply_request`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.supply_request`.execute(db);
  await loadDictionary(db);
}
