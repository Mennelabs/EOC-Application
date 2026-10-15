/**
 * 0064 proactive resource discovery (layer-7 task F; REC-13, REC-14). The
 * county's own sources (an HSDS service directory, an open-data CSV or
 * GeoJSON feed, OpenAI web search) are listed per tenant; each run is
 * recorded with what it found; each place found is a candidate in the
 * administrator's review queue with its source links, what could be
 * confirmed, what is unknown and the pre-check against the registry
 * criteria. Nothing enters, changes or leaves the registry without a person's
 * decision. A candidate's fingerprint (its name and ZIP code, or the
 * registered place and the change) and content hash let a rejected candidate
 * stay rejected until something about it changes. The digest and the alert
 * for a high-value candidate near unmet need join the notice ledger (REC-14).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

const KINDS = `'site_reconfirm', 'site_hidden', 'resource_review', 'resource_link', 'resource_expired',
    'contact_reverify', 'publication', 'publication_withdrawn', 'ai_health', 'facility_recheck'`;
const SUBJECTS = `'site', 'resource', 'partner_contact', 'publication', 'tenant', 'ai_health_alert', 'facility'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.discovery_source (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      kind text not null check (kind in ('hsds', 'csv', 'geojson', 'web_search')),
      name text not null,
      url text,
      enabled boolean not null default true,
      last_run_at timestamptz,
      last_outcome text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check ((kind = 'web_search') = (url is null))
    )`.execute(db);
  await sql`create unique index discovery_source_web_search on cg.discovery_source (tenant_id)
    where kind = 'web_search'`.execute(db);
  await sql`create trigger discovery_source_touch before update on cg.discovery_source
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.discovery_source')`.execute(db);

  await sql`
    create table cg.discovery_run (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      state text not null default 'requested' check (state in ('requested', 'running', 'done', 'failed')),
      requested_by uuid,
      started_at timestamptz,
      finished_at timestamptz,
      summary jsonb not null default '{}'::jsonb,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index discovery_run_idx on cg.discovery_run (tenant_id, created_at desc)`.execute(
    db,
  );
  await sql`create trigger discovery_run_touch before update on cg.discovery_run
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.discovery_run')`.execute(db);
  await sql`drop policy tenant_delete on cg.discovery_run`.execute(db);

  await sql`
    create table cg.discovery_candidate (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      run_id uuid references cg.discovery_run(id),
      source_kind text not null check (source_kind in ('partner_post', 'hsds', 'csv', 'geojson', 'web_search')),
      source_id uuid references cg.discovery_source(id),
      change text not null default 'new' check (change in ('new', 'update', 'closed')),
      facility_id uuid references cg.facility(id),
      name text not null,
      kind text not null check (kind in ('school', 'place_of_worship', 'community_center', 'parking_lot',
        'government', 'commercial', 'other')),
      address jsonb,
      lat double precision,
      lon double precision,
      attributes jsonb not null default '{}'::jsonb,
      unknown text[] not null default '{}',
      source_links text[] not null default '{}',
      precheck jsonb not null default '{}'::jsonb,
      note text,
      fingerprint text not null,
      content_hash text not null,
      state text not null default 'pending' check (state in ('pending', 'accepted', 'rejected')),
      decided_by uuid,
      decided_at timestamptz,
      decision_reason text,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      seen_count integer not null default 1,
      near_unmet_need boolean not null default false,
      ai_output_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create unique index discovery_candidate_pending on cg.discovery_candidate (tenant_id, fingerprint)
    where state = 'pending'`.execute(db);
  await sql`create index discovery_candidate_seen on cg.discovery_candidate (tenant_id, fingerprint, created_at desc)`.execute(
    db,
  );
  await sql`create index discovery_candidate_queue on cg.discovery_candidate (tenant_id, state, created_at desc)`.execute(
    db,
  );
  await sql`create trigger discovery_candidate_touch before update on cg.discovery_candidate
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.discovery_candidate')`.execute(db);
  await sql`drop policy tenant_delete on cg.discovery_candidate`.execute(db);

  // REC-14: the digest and the alert join the notice ledger, once per cycle each.
  await sql`alter table cg.notice_log drop constraint notice_log_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_kind_check check (kind in (${KINDS}, 'discovery_digest', 'discovery_alert'))`,
    )
    .execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_subject_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_subject_kind_check check (subject_kind in (${SUBJECTS}, 'discovery_candidate'))`,
    )
    .execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The migrator owns the table: row security is lifted for the delete, as in 0055.
  await sql`alter table cg.notice_log no force row level security`.execute(db);
  await sql`delete from cg.notice_log where kind in ('discovery_digest', 'discovery_alert')`.execute(
    db,
  );
  await sql`alter table cg.notice_log force row level security`.execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_kind_check check (kind in (${KINDS}))`,
    )
    .execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_subject_kind_check`.execute(db);
  await sql
    .raw(
      `alter table cg.notice_log add constraint notice_log_subject_kind_check check (subject_kind in (${SUBJECTS}))`,
    )
    .execute(db);
  await sql`drop table if exists cg.discovery_candidate`.execute(db);
  await sql`drop table if exists cg.discovery_run`.execute(db);
  await sql`drop table if exists cg.discovery_source`.execute(db);
}
