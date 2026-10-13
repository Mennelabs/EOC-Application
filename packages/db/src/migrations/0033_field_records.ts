/**
 * 0033 field records (layer-4 plan §2, task B; FL-06, FL-15, FL:FR-01, FR-04,
 * FR-05, FR-06, FR-08, FR-09, FR-14, FR-15, FR-17, FR-19, FR-20, FR-21, FR-22,
 * FR-24, FR-26, FR-28, CON-16, EQ-13): the one-tap service counters with a
 * client id so a retry never counts twice; job aids per role and language,
 * exercise drafts until the county approves them; and one small record per
 * frontline role. Restricted fields are encrypted: right-of-entry signatures,
 * children's records (the minimum data, no photos, a guardian pickup code),
 * health notes for health roles only, shelter access needs. A background
 * check is a status only (plan §12.7). Every column is in the dictionary
 * (SEC-11); children's records keep one year (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';
import { FIELD_RECORDS_ROW, retentionFunction } from './0028_field_roster.ts';
import { SAFETY_COMMS_ROWS } from './0031_hazards_safety_comms.ts';
import { BADGES_ROW } from './0032_reminders_badges.ts';

export const CHILD_RECORDS_ROW = `,\n        (p_tenant, 'child_records', interval '1 year', 'duration', 'FL:FR-26: the minimum data about a child, kept no longer than needed', p_actor)`;

const stamped = `
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid`;

async function stampedTable(db: Kysely<unknown>, name: string, body: string): Promise<void> {
  await sql.raw(`create table cg.${name} (${body},${stamped})`).execute(db);
  await sql
    .raw(
      `create trigger ${name}_touch before update on cg.${name} for each row execute function cg.touch()`,
    )
    .execute(db);
  await sql.raw(`select cg.apply_tenant_rls('cg.${name}')`).execute(db);
  await sql.raw(`drop policy tenant_delete on cg.${name}`).execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // One-tap counters (FL-06, FR-17, FR-22): append-only; the client id makes a resend a no-op.
  await sql`
    create table cg.service_log (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      client_uuid uuid not null,
      kind text not null check (kind in ('meal', 'water_case', 'tarp', 'voucher', 'cot', 'ride', 'car_served', 'person_served', 'supplies_per_car', 'pet_food', 'other')),
      count integer not null default 1 check (count between -1000 and 1000),
      site_id uuid references cg.site(id),
      mission_id uuid references cg.mission(id),
      team_id uuid references cg.team(id),
      personnel_id uuid references cg.personnel(id),
      note text,
      occurred_at timestamptz not null default now(),
      created_by uuid,
      created_at timestamptz not null default now(),
      unique (tenant_id, client_uuid)
    )`.execute(db);
  await sql`create index service_log_site_idx on cg.service_log (tenant_id, site_id, kind, occurred_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.service_log')`.execute(db);
  await sql`drop policy tenant_update on cg.service_log`.execute(db);
  await sql`drop policy tenant_delete on cg.service_log`.execute(db);

  // Job aids (FL-15): per role and language; exercise drafts until approved.
  await stampedTable(
    db,
    'job_aid',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      key text not null,
      role_key text,
      lang text not null default 'en',
      kind text not null check (kind in ('checklist', 'matrix', 'standard', 'briefing', 'guidance')),
      title text not null,
      body_html text not null,
      status text not null default 'exercise_draft' check (status in ('draft', 'exercise_draft', 'approved', 'retired')),
      approved_by uuid,
      approved_at timestamptz,
      unique (tenant_id, key, lang)`,
  );

  // Search marking per structure (FL:FR-01): the X-code facts, so no block is searched twice.
  await stampedTable(
    db,
    'search_mark',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      mission_id uuid references cg.mission(id),
      location_id uuid references cg.location(id),
      parcel_id text,
      team_id uuid references cg.team(id),
      personnel_id uuid references cg.personnel(id),
      searched_at timestamptz not null default now(),
      entry_type text not null default 'primary' check (entry_type in ('primary', 'secondary', 'exterior_only')),
      occupants_found integer not null default 0 check (occupants_found >= 0),
      occupants_removed integer not null default 0 check (occupants_removed >= 0),
      victims_count integer not null default 0 check (victims_count >= 0),
      hazards text[] not null default '{}',
      mark_code text,
      note text,
      photo_id uuid references cg.photo(id),
      usng text,
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Safety placards (FL:FR-04): the posted placard, a photo, and the resident's explanation message.
  await stampedTable(
    db,
    'placard',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      location_id uuid references cg.location(id),
      parcel_id text,
      report_id uuid references cg.report(id),
      kind text not null check (kind in ('inspected', 'restricted_use', 'unsafe')),
      posted_at timestamptz not null default now(),
      inspector_personnel_id uuid references cg.personnel(id),
      photo_id uuid references cg.photo(id),
      note text,
      resident_message_id uuid references cg.message(id),
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Road status (FL:FR-05): one tap; exported to Waze through the adapter (Q-04).
  await stampedTable(
    db,
    'road_status',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      name text not null,
      geom geometry(Geometry, 4326) check (geom is null or GeometryType(geom) in ('POINT', 'LINESTRING', 'MULTILINESTRING')),
      status text not null check (status in ('open', 'closed', 'one_lane', 'impassable', 'cleared')),
      reason text,
      reported_by uuid,
      reported_personnel_id uuid references cg.personnel(id),
      reported_at timestamptz not null default now(),
      cleared_at timestamptz,
      exported_at timestamptz,
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Debris load tickets (FL:FR-05): FEMA Public Assistance records.
  await stampedTable(
    db,
    'debris_ticket',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      ticket_number text not null,
      load_location_id uuid references cg.location(id),
      disposal_site text,
      truck_id text,
      truck_capacity_cy numeric(8, 2) check (truck_capacity_cy >= 0),
      load_percent integer check (load_percent between 0 and 100),
      cubic_yards numeric(8, 2) check (cubic_yards >= 0),
      debris_type text not null check (debris_type in ('vegetative', 'construction', 'mixed', 'white_goods', 'hazardous', 'electronic', 'other')),
      loaded_at timestamptz not null default now(),
      unloaded_at timestamptz,
      monitor_personnel_id uuid references cg.personnel(id),
      photo_id uuid references cg.photo(id),
      client_uuid uuid,
      unique (tenant_id, ticket_number),
      unique (tenant_id, client_uuid)`,
  );

  // Inspections (FL:FR-06): checklist answers; illness counts in aggregate only (EQ-13).
  await stampedTable(
    db,
    'inspection',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      site_id uuid references cg.site(id),
      kind text not null check (kind in ('shelter', 'feeding_site', 'pod', 'warehouse', 'other')),
      checklist jsonb not null default '{}'::jsonb,
      result text not null default 'pass' check (result in ('pass', 'corrective', 'fail')),
      illness_count integer check (illness_count >= 0),
      inspector_personnel_id uuid references cg.personnel(id),
      inspected_at timestamptz not null default now(),
      note text,
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Pet intake (FL:FR-08): linked to the owner's reference code, never to the owner's name here.
  await stampedTable(
    db,
    'pet_intake',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      site_id uuid references cg.site(id),
      owner_reference_code text,
      species text not null,
      description text,
      photo_id uuid references cg.photo(id),
      status text not null default 'sheltered' check (status in ('sheltered', 'reunited', 'transferred', 'lost_report', 'found_report', 'deceased')),
      intake_at timestamptz not null default now(),
      released_at timestamptz,
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Facility walk-throughs (FL:FR-09).
  await stampedTable(
    db,
    'site_walkthrough',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      phase text not null check (phase in ('before', 'after')),
      walked_at timestamptz not null default now(),
      photo_ids uuid[] not null default '{}',
      key_holders text,
      issues text,
      personnel_id uuid references cg.personnel(id),
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Right of entry and release (FL:FR-19): signed on the phone; the signer's role and the
  // drawn signature are restricted; a renter's work needs the landlord's consent.
  await stampedTable(
    db,
    'right_of_entry',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      mission_id uuid references cg.mission(id),
      need_id uuid references cg.need(id),
      report_id uuid references cg.report(id),
      location_id uuid references cg.location(id),
      signer_role text not null check (signer_role in ('owner', 'landlord', 'tenant', 'agent')),
      signer_name_enc bytea,
      signature_key text,
      scope text not null,
      landlord_consent boolean not null default false,
      signed_at timestamptz not null default now(),
      release_signed_at timestamptz,
      release_signature_key text,
      witness_personnel_id uuid references cg.personnel(id),
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Volunteer reception (FL:FR-20): waiver, skills, background-check status only.
  await stampedTable(
    db,
    'volunteer_registration',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      personnel_id uuid not null references cg.personnel(id),
      waiver_signed_at timestamptz,
      waiver_version text,
      skills text[] not null default '{}',
      background_check_status text not null default 'not_required' check (background_check_status in ('not_required', 'pending', 'cleared', 'not_cleared', 'expired')),
      background_check_checked_at timestamptz,
      assigned_team_id uuid references cg.team(id),
      badge_id uuid references cg.badge(id),
      registered_by uuid,
      registered_at timestamptz not null default now(),
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Stock (FL:FR-21, FR-22): items per site and append-only movements with a client id.
  await stampedTable(
    db,
    'stock_item',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      sku text not null,
      name text not null,
      unit text not null default 'each',
      quantity numeric(12, 2) not null default 0,
      barcode text,
      photo_id uuid references cg.photo(id),
      reorder_at numeric(12, 2),
      unique (tenant_id, site_id, sku)`,
  );
  await sql`
    create table cg.stock_movement (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      stock_item_id uuid not null references cg.stock_item(id),
      kind text not null check (kind in ('received', 'issued', 'counted', 'transferred', 'adjusted', 'requested')),
      quantity numeric(12, 2) not null,
      to_site_id uuid references cg.site(id),
      mission_id uuid references cg.mission(id),
      client_uuid uuid not null,
      occurred_at timestamptz not null default now(),
      actor_account_id uuid,
      note text,
      created_at timestamptz not null default now(),
      unique (tenant_id, client_uuid)
    )`.execute(db);
  await sql`create index stock_movement_item_idx on cg.stock_movement (stock_item_id, occurred_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.stock_movement')`.execute(db);
  await sql`drop policy tenant_update on cg.stock_movement`.execute(db);
  await sql`drop policy tenant_delete on cg.stock_movement`.execute(db);

  // Interpreter requests (FL:FR-24): language support logged.
  await stampedTable(
    db,
    'interpreter_request',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      language text not null,
      mode text not null default 'phone' check (mode in ('in_person', 'phone', 'video')),
      site_id uuid references cg.site(id),
      mission_id uuid references cg.mission(id),
      requested_by uuid,
      requested_personnel_id uuid references cg.personnel(id),
      requested_at timestamptz not null default now(),
      state text not null default 'open' check (state in ('open', 'accepted', 'in_progress', 'done', 'canceled')),
      interpreter_personnel_id uuid references cg.personnel(id),
      accepted_at timestamptz,
      done_at timestamptz,
      minutes integer check (minutes >= 0),
      note text,
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Child-friendly spaces (FL:FR-26, plan §12.6): the minimum data, encrypted; no photos;
  // the guardian pickup code is hashed.
  await stampedTable(
    db,
    'child_check_in',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      child_enc bytea not null,
      age_band text not null check (age_band in ('0-2', '3-5', '6-9', '10-13', '14-17')),
      guardian_enc bytea not null,
      pickup_code_hash bytea not null,
      needs_enc bytea,
      checked_in_at timestamptz not null default now(),
      checked_out_at timestamptz,
      checked_out_to_enc bytea,
      staff_personnel_id uuid references cg.personnel(id),
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Canvass visits (FL:FR-28): outcomes; "no one home" schedules a revisit reminder.
  await stampedTable(
    db,
    'canvass_visit',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      mission_id uuid references cg.mission(id),
      location_id uuid references cg.location(id),
      parcel_id text,
      team_id uuid references cg.team(id),
      personnel_id uuid references cg.personnel(id),
      outcome text not null check (outcome in ('spoke_with_resident', 'assisted_report', 'no_one_home', 'refused', 'vacant', 'unsafe', 'referred')),
      report_id uuid references cg.report(id),
      door_hanger_left boolean not null default false,
      language text,
      revisit_at timestamptz,
      reminder_id uuid references cg.reminder(id),
      visited_at timestamptz not null default now(),
      note text,
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  // Shelter registration (CON-16, FL:FR-14): household, cots, needs, census; the quiet
  // incident log; access needs restricted to their roles (ADM-05 G7).
  await stampedTable(
    db,
    'shelter_stay',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      event_id uuid not null references cg.event(id),
      household_party_id uuid references cg.party(id),
      household_enc bytea,
      wristband_code_hash bytea,
      household_size integer not null default 1 check (household_size >= 1),
      adults integer not null default 1 check (adults >= 0),
      children integer not null default 0 check (children >= 0),
      cots text[] not null default '{}',
      dietary_needs text,
      access_needs_enc bytea,
      pets integer not null default 0 check (pets >= 0),
      language text,
      checked_in_at timestamptz not null default now(),
      checked_out_at timestamptz,
      checked_out_reason text,
      registered_by uuid,
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );
  await sql`create index shelter_stay_site_idx on cg.shelter_stay (tenant_id, site_id, checked_out_at)`.execute(
    db,
  );
  await sql`create index shelter_stay_wristband_idx on cg.shelter_stay (tenant_id, wristband_code_hash) where wristband_code_hash is not null`.execute(
    db,
  );
  await sql`
    create table cg.shelter_incident (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      occurred_at timestamptz not null default now(),
      kind text not null check (kind in ('medical', 'behavioral', 'safety', 'security', 'facility', 'other')),
      summary_enc bytea not null,
      reported_by uuid,
      client_uuid uuid,
      created_at timestamptz not null default now(),
      unique (tenant_id, client_uuid)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.shelter_incident')`.execute(db);
  await sql`drop policy tenant_update on cg.shelter_incident`.execute(db);
  await sql`drop policy tenant_delete on cg.shelter_incident`.execute(db);

  // Health notes (FL:FR-15): the restricted health section; every view is audited (SEC-18).
  await stampedTable(
    db,
    'health_note',
    `
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid references cg.site(id),
      shelter_stay_id uuid references cg.shelter_stay(id),
      subject_party_id uuid references cg.party(id),
      kind text not null check (kind in ('medication_request', 'equipment_replacement', 'assessment', 'follow_up', 'other')),
      note_enc bytea not null,
      request_status text check (request_status in ('open', 'ordered', 'delivered', 'closed')),
      author_personnel_id uuid references cg.personnel(id),
      client_uuid uuid,
      unique (tenant_id, client_uuid)`,
  );

  await sql
    .raw(retentionFunction(FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS + BADGES_ROW + CHILD_RECORDS_ROW))
    .execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'health_note',
    'shelter_incident',
    'shelter_stay',
    'canvass_visit',
    'child_check_in',
    'interpreter_request',
    'stock_movement',
    'stock_item',
    'volunteer_registration',
    'right_of_entry',
    'site_walkthrough',
    'pet_intake',
    'inspection',
    'debris_ticket',
    'road_status',
    'placard',
    'search_mark',
    'job_aid',
    'service_log',
  ]) {
    await sql.raw(`drop table if exists cg.${t} cascade`).execute(db);
  }
  await sql`delete from cg.retention_policy where data_category = 'child_records' and note like '%:%'`.execute(
    db,
  );
  await sql.raw(retentionFunction(FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS + BADGES_ROW)).execute(db);
}
