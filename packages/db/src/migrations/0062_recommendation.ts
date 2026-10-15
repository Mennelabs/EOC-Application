/**
 * 0062 recommendations and their decisions (layer-7 task E; REC-03, REC-04,
 * REC-10, REC-11, REC-12). Each request keeps what the engine was given and
 * what it answered (top three with reasons, excluded places with why, what
 * would change the top pick, the age of every input, the equity check), the
 * engine version, weights and planning factors in force, so the answer can
 * be explained later exactly as it was shown. A named person accepts, edits
 * or rejects it with a reason; the decision is logged and audited (REC-04).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.recommendation (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      kind text not null check (kind in ('shelter', 'feeding', 'pod', 'walkup', 'marc')),
      engine_version text not null,
      result jsonb not null,
      requested_by uuid,
      state text not null default 'open' check (state in ('open', 'accepted', 'edited', 'rejected')),
      decided_by uuid,
      decided_at timestamptz,
      decision_reason text,
      chosen_facility_id uuid references cg.facility(id),
      decision_note text,
      execution_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index recommendation_event_idx on cg.recommendation (tenant_id, event_id, kind, created_at desc)`.execute(
    db,
  );
  await sql`create unique index recommendation_execution on cg.recommendation (tenant_id, execution_id)
    where execution_id is not null`.execute(db);
  await sql`create trigger recommendation_touch before update on cg.recommendation
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.recommendation')`.execute(db);
  await sql`drop policy tenant_delete on cg.recommendation`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.recommendation`.execute(db);
}
