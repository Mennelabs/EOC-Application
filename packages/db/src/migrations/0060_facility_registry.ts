/**
 * 0060 facility registry (layer-7 task D; REC-01, REC-10, docs/02 "How the
 * console recommends places and setups", PUB-05). The places a county lines
 * up before a disaster: schools, places of worship, community centers,
 * parking lots and others, with what a shelter, POD or MARC decision needs
 * (square footage, ADA, generator or transfer switch, kitchen, showers, pet
 * policy, parking, truck access, floodplain, agreement status, contacts,
 * the communities that use it). Unknown is recorded as unknown, never
 * guessed (REC-10). Entries are approved by county EM; an owning partner
 * keeps its own entry current; proposals (COAD, self-registration,
 * discovery) wait in cg.facility_change for a named approver. Each entry is
 * re-checked every 12 months; past that it is stale until confirmed.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.facility (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      name text not null check (length(name) between 2 and 200),
      kind text not null check (kind in ('school', 'place_of_worship', 'community_center',
        'parking_lot', 'government', 'commercial', 'other')),
      location_id uuid references cg.location(id),
      status text not null default 'approved' check (status in ('approved', 'retired')),
      sqft integer check (sqft is null or sqft between 0 and 10000000),
      ada boolean,
      power_backup text check (power_backup in ('none', 'generator', 'transfer_switch')),
      kitchen boolean,
      showers integer check (showers is null or showers between 0 and 1000),
      pet_policy text check (pet_policy in ('none', 'service_animals', 'pets_inside', 'pets_outside_area')),
      parking_spaces integer check (parking_spaces is null or parking_spaces between 0 and 100000),
      truck_access boolean,
      floodplain text check (floodplain in ('in', 'out')),
      mou_status text not null default 'none' check (mou_status in ('none', 'pending', 'signed', 'expired')),
      mou_expires_on date,
      contacts_enc bytea,
      communities text[] not null default '{}',
      notes text,
      owner_tenant_id uuid references cg.tenant(id),
      source text not null check (source in ('county', 'owner', 'coad', 'self_registration', 'discovery', 'import')),
      approved_by uuid,
      approved_at timestamptz,
      last_confirmed_at timestamptz not null default now(),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index facility_tenant_idx on cg.facility (tenant_id, status, kind)`.execute(db);
  await sql`create trigger facility_touch before update on cg.facility
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.facility')`.execute(db);
  await sql`drop policy tenant_delete on cg.facility`.execute(db);

  await sql`
    create table cg.facility_change (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      facility_id uuid references cg.facility(id),
      change text not null check (change in ('create', 'update', 'retire')),
      proposed jsonb not null default '{}'::jsonb,
      contacts_enc bytea,
      source text not null check (source in ('coad', 'owner', 'self_registration', 'discovery', 'county')),
      proposed_by uuid,
      proposed_by_tenant_id uuid references cg.tenant(id),
      submitter_enc bytea,
      state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'withdrawn')),
      decided_by uuid,
      decided_at timestamptz,
      decision_reason text,
      execution_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      constraint facility_change_target check ((change = 'create') = (facility_id is null))
    )`.execute(db);
  await sql`create index facility_change_queue_idx on cg.facility_change (tenant_id, state, created_at)`.execute(
    db,
  );
  await sql`create unique index facility_change_execution on cg.facility_change (tenant_id, execution_id)
    where execution_id is not null`.execute(db);
  await sql`create trigger facility_change_touch before update on cg.facility_change
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.facility_change')`.execute(db);
  await sql`drop policy tenant_delete on cg.facility_change`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.facility_change`.execute(db);
  await sql`drop table if exists cg.facility`.execute(db);
}
