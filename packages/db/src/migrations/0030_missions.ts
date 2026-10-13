/**
 * 0030 missions and assignments (layer-4 plan §2, task B; MIS-01–04,
 * BRD:FR-02.01–02.06, FR-06.01–06.08, FR-07.01–07.06, PPL-01, CALL-01,
 * RULE-03, RULE-04, RULE-05, RULE-06, AC-02A/B/C, AC-06A/B/C/D, AC-07A/B/C):
 * a mission is any unit of field work inside an activated event, with an
 * immutable id and a human-readable reference from a per-tenant counter that
 * never reuses a number; its timeline is append-only and apart from the
 * editable summary; people involved are one record each with restricted
 * details encrypted; media are references only; an assignment is one row per
 * resource with each fact (assigned, dispatched, delivered, acknowledged,
 * en route, on scene, cleared, released) its own column, so nothing is
 * inferred from another. Every column is in the dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  // References: M-00001, M-00002, … per tenant; the row lock serialises concurrent
  // creations and a retry that failed before commit took no number (FR-02.04, AC-02A).
  await sql`
    create table cg.mission_counter (
      tenant_id uuid primary key references cg.tenant(id),
      next_value bigint not null default 1
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.mission_counter')`.execute(db);
  await sql`
    create or replace function cg.next_mission_reference(p_tenant uuid) returns text
    language plpgsql as $$
    declare
      n bigint;
    begin
      insert into cg.mission_counter (tenant_id) values (p_tenant) on conflict do nothing;
      update cg.mission_counter set next_value = next_value + 1
        where tenant_id = p_tenant returning next_value - 1 into n;
      return 'M-' || lpad(n::text, 5, '0');
    end $$`.execute(db);

  await sql`
    create table cg.mission (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      reference text not null,
      kind text not null check (kind in ('welfare_check', 'verification_route', 'cleanup_work_order', 'delivery', 'outreach_sweep', 'site_staffing', 'search', 'road_clearance', 'traffic_control', 'debris', 'other')),
      subcategory text,
      state text not null default 'draft' check (state in ('draft', 'open', 'en_route', 'on_scene', 'cleared', 'closed', 'canceled')),
      priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
      urgency text not null default 'routine' check (urgency in ('routine', 'soon', 'now')),
      source text not null check (source in ('need', 'report', 'call', 'walk_in', 'field', 'staff', 'board')),
      summary text,
      conditions text,
      caller_enc bytea,
      caller_language text,
      interpreter_needed boolean not null default false,
      location_id uuid references cg.location(id),
      location_state text not null default 'unknown' check (location_state in ('verified', 'approximate', 'manual', 'unknown')),
      need_id uuid references cg.need(id),
      report_id uuid references cg.report(id),
      site_id uuid references cg.site(id),
      route jsonb,
      owning_tenant_id uuid references cg.tenant(id),
      required_credentials text[] not null default '{}',
      lock_by uuid,
      lock_at timestamptz,
      lock_reason text,
      disposition text check (disposition in ('completed', 'referred', 'no_action_needed', 'unable_to_locate', 'canceled', 'duplicate', 'transferred', 'other')),
      disposition_note text,
      case_reference text,
      report_required boolean not null default false,
      report_generated boolean not null default false,
      reviewed_by uuid,
      reviewed_at timestamptz,
      opened_at timestamptz,
      cleared_at timestamptz,
      closed_at timestamptz,
      closed_reason text,
      reopened_count integer not null default 0,
      execution_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, reference),
      check (state <> 'closed' or disposition is not null)
    )`.execute(db);
  await sql`create index mission_event_state_idx on cg.mission (tenant_id, event_id, state, priority)`.execute(
    db,
  );
  await sql`create index mission_owner_idx on cg.mission (tenant_id, owning_tenant_id, state)`.execute(
    db,
  );
  await sql`create index mission_need_idx on cg.mission (need_id) where need_id is not null`.execute(
    db,
  );
  await sql`create index mission_execution_idx on cg.mission (execution_id) where execution_id is not null`.execute(
    db,
  );
  await sql`create trigger mission_touch before update on cg.mission for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.mission')`.execute(db);
  // Missions are canceled or closed, never deleted: the reference stays taken (FR-02.01, FR-02.04).
  await sql`drop policy tenant_delete on cg.mission`.execute(db);

  // The timeline, append-only (FR-07.01, FR-07.03, AC-07A): state changes, narratives by
  // role with attributable amendments, priority changes with their reason, locks.
  await sql`
    create table cg.mission_event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      mission_id uuid not null references cg.mission(id),
      kind text not null check (kind in ('created', 'updated', 'state_changed', 'priority_changed', 'locked', 'unlocked', 'narrative', 'amendment', 'disposition', 'person_added', 'person_updated', 'person_removed', 'media_added', 'media_removed', 'assignment', 'reopened', 'canceled', 'hazard', 'reminder')),
      narrative_role text check (narrative_role in ('call_taker', 'dispatcher', 'responder', 'supervisor', 'follow_up', 'system')),
      from_state text,
      to_state text,
      actor_account_id uuid,
      actor_personnel_id uuid,
      reason text,
      body text,
      amends_event_id uuid references cg.mission_event(id),
      detail jsonb not null default '{}'::jsonb,
      client_command_id uuid,
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index mission_event_mission_idx on cg.mission_event (mission_id, occurred_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.mission_event')`.execute(db);
  await sql`drop policy tenant_update on cg.mission_event`.execute(db);
  await sql`drop policy tenant_delete on cg.mission_event`.execute(db);

  // People involved (PPL-01, FR-07.02, D07): one record each; the details are restricted
  // and encrypted; behavioural-health details are restricted apart (AC-04C); law-
  // enforcement roles and details live in the CJIS enclave and are referenced only.
  await sql`
    create table cg.mission_person (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      mission_id uuid not null references cg.mission(id),
      role text not null check (role in ('survivor', 'reporting_party', 'witness', 'subject', 'victim', 'caregiver', 'property_owner', 'other', 'enclave_reference')),
      display_label text,
      details_enc bytea,
      injury text check (injury in ('none', 'minor', 'serious', 'critical', 'deceased', 'unknown')),
      injury_detail_enc bytea,
      transport text check (transport in ('none', 'ems', 'own', 'shelter_transport', 'other', 'unknown')),
      transport_destination text,
      transport_started_at timestamptz,
      transport_ended_at timestamptz,
      behavioral_health_enc bytea,
      party_id uuid references cg.party(id),
      enclave_reference text,
      status text not null default 'active' check (status in ('active', 'removed')),
      removed_reason text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index mission_person_mission_idx on cg.mission_person (mission_id, status)`.execute(
    db,
  );
  await sql`create trigger mission_person_touch before update on cg.mission_person for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.mission_person')`.execute(db);
  await sql`drop policy tenant_delete on cg.mission_person`.execute(db);

  // Media references (FR-07.04, D08, AC-07B): never a public URL; downloads go through an
  // authorized route; removal keeps the row with its reason (FR-07.06).
  await sql`
    create table cg.mission_media (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      mission_id uuid not null references cg.mission(id),
      kind text not null check (kind in ('photo', 'document', 'audio', 'video', 'bodycam_reference', 'live_feed_reference')),
      photo_id uuid references cg.photo(id),
      object_key text,
      original_name text,
      content_type text,
      bytes bigint check (bytes >= 0),
      sha256 bytea,
      description text,
      source text not null default 'field' check (source in ('field', 'console', 'resident', 'partner', 'external')),
      access_class text not null default 'internal' check (access_class in ('internal', 'restricted')),
      retention_category text not null default 'records',
      uploaded_by uuid,
      uploaded_at timestamptz not null default now(),
      removed_at timestamptz,
      removed_by uuid,
      removed_reason text,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index mission_media_mission_idx on cg.mission_media (mission_id)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.mission_media')`.execute(db);
  await sql`drop policy tenant_delete on cg.mission_media`.execute(db);

  // Assignments (FR-06.01–06.07, MIS-04, RULE-03, RULE-06): one row per resource on a
  // mission; each fact has its own column and time; the dispatch method is apart from
  // the proof of delivery (FR-06.06); nothing is inferred (AC-06B).
  await sql`
    create table cg.assignment (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      mission_id uuid not null references cg.mission(id),
      resource_kind text not null check (resource_kind in ('person', 'team')),
      personnel_id uuid references cg.personnel(id),
      team_id uuid references cg.team(id),
      state text not null default 'assigned' check (state in ('assigned', 'dispatched', 'acknowledged', 'declined', 'en_route', 'on_scene', 'cleared', 'released')),
      assigned_at timestamptz not null default now(),
      assigned_by uuid,
      suggested boolean not null default false,
      suggestion_reasons text[] not null default '{}',
      conflicts jsonb not null default '[]'::jsonb,
      override_reason text,
      override_by uuid,
      dispatched_at timestamptz,
      dispatched_by uuid,
      dispatch_method text check (dispatch_method in ('app', 'text', 'radio', 'phone', 'in_person')),
      delivered_at timestamptz,
      delivery_evidence jsonb,
      acknowledged_at timestamptz,
      acknowledged_by uuid,
      declined_at timestamptz,
      declined_reason text,
      en_route_at timestamptz,
      on_scene_at timestamptz,
      on_scene_confirmed_by uuid,
      cleared_at timestamptz,
      released_at timestamptz,
      released_by uuid,
      release_reason text,
      execution_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check ((resource_kind = 'person') = (personnel_id is not null)),
      check ((resource_kind = 'team') = (team_id is not null)),
      check (dispatched_at is null or dispatch_method is not null)
    )`.execute(db);
  await sql`create unique index assignment_active_person_idx on cg.assignment (mission_id, personnel_id) where personnel_id is not null and released_at is null`.execute(
    db,
  );
  await sql`create unique index assignment_active_team_idx on cg.assignment (mission_id, team_id) where team_id is not null and released_at is null`.execute(
    db,
  );
  await sql`create index assignment_person_open_idx on cg.assignment (tenant_id, personnel_id, state) where released_at is null`.execute(
    db,
  );
  await sql`create index assignment_team_open_idx on cg.assignment (tenant_id, team_id, state) where released_at is null`.execute(
    db,
  );
  await sql`create index assignment_execution_idx on cg.assignment (execution_id) where execution_id is not null`.execute(
    db,
  );
  await sql`create trigger assignment_touch before update on cg.assignment for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.assignment')`.execute(db);
  // Closing a mission releases its resources and keeps the deployment history (FR-06.07, AC-06D).
  await sql`drop policy tenant_delete on cg.assignment`.execute(db);

  // Per-assignment history (FR-06.01): every fact as it was recorded, with method and evidence.
  await sql`
    create table cg.assignment_event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      assignment_id uuid not null references cg.assignment(id),
      kind text not null check (kind in ('assigned', 'dispatched', 'delivered', 'acknowledged', 'declined', 'en_route', 'on_scene', 'cleared', 'released', 'reopened', 'override', 'suggested_status')),
      from_state text,
      to_state text,
      actor_account_id uuid,
      actor_personnel_id uuid,
      method text,
      evidence jsonb,
      reason text,
      client_command_id uuid,
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index assignment_event_idx on cg.assignment_event (assignment_id, occurred_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.assignment_event')`.execute(db);
  await sql`drop policy tenant_update on cg.assignment_event`.execute(db);
  await sql`drop policy tenant_delete on cg.assignment_event`.execute(db);

  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.assignment_event cascade`.execute(db);
  await sql`drop table if exists cg.assignment cascade`.execute(db);
  await sql`drop table if exists cg.mission_media cascade`.execute(db);
  await sql`drop table if exists cg.mission_person cascade`.execute(db);
  await sql`drop table if exists cg.mission_event cascade`.execute(db);
  await sql`drop table if exists cg.mission cascade`.execute(db);
  await sql`drop function if exists cg.next_mission_reference(uuid)`.execute(db);
  await sql`drop table if exists cg.mission_counter cascade`.execute(db);
}
