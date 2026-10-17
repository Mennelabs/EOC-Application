/**
 * 0088 a private way for a worker to ask for peer support (FL-16). A request
 * holds who asked, how they want to be reached (a call, a text or in person)
 * and when (now or after their shift), and where it stands; no words, no
 * reason. Only the peer-support role sees it (the counseling category, ADM-05
 * guardrail 7): never the worker's lead, dispatch or coordinators. A closed
 * request is deleted after the `peer_support` period, 30 days by default
 * (SEC-13); only the worker role passes `cg.is_system()` for that delete.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';
import { FIELD_RECORDS_ROW, retentionFunction } from './0028_field_roster.ts';
import { SAFETY_COMMS_ROWS } from './0031_hazards_safety_comms.ts';
import { BADGES_ROW } from './0032_reminders_badges.ts';
import { CHILD_RECORDS_ROW } from './0033_field_records.ts';
import { REFERENCE_DATA_ROW } from './0042_reference_data.ts';

export const PEER_SUPPORT_ROW = `,\n        (p_tenant, 'peer_support', interval '30 days', 'duration', 'FL-16: a closed peer-support request; who asked is private to the peer-support role', p_actor)`;

const EARLIER_ROWS =
  FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS + BADGES_ROW + CHILD_RECORDS_ROW + REFERENCE_DATA_ROW;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.peer_support_request (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      personnel_id uuid not null references cg.personnel(id),
      event_id uuid references cg.event(id),
      client_uuid uuid not null,
      reach_by text not null check (reach_by in ('call', 'text', 'in_person')),
      reach_when text not null check (reach_when in ('now', 'after_shift')),
      status text not null default 'open' check (status in ('open', 'contacted', 'closed')),
      requested_at timestamptz not null default now(),
      contacted_at timestamptz,
      contacted_by uuid,
      closed_at timestamptz,
      closed_by uuid,
      closed_by_requester boolean not null default false,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid),
      check ((status = 'closed') = (closed_at is not null))
    )`.execute(db);
  await sql`create index peer_support_request_open_idx
    on cg.peer_support_request (tenant_id, status, requested_at)`.execute(db);
  await sql`create trigger peer_support_request_touch before update on cg.peer_support_request for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.peer_support_request')`.execute(db);
  // Requests are closed, never deleted by the application; only the retention sweep removes them.
  await sql`drop policy tenant_delete on cg.peer_support_request`.execute(db);
  await sql`create policy retention_delete on cg.peer_support_request for delete using (cg.is_system())`.execute(
    db,
  );
  await sql.raw(retentionFunction(EARLIER_ROWS + PEER_SUPPORT_ROW)).execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.peer_support_request`.execute(db);
  await sql`delete from cg.retention_policy where data_category = 'peer_support'`.execute(db);
  await sql.raw(retentionFunction(EARLIER_ROWS)).execute(db);
  await loadDictionary(db);
}
