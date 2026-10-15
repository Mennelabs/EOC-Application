/**
 * 0045 official reports (layer-6 plan §4, task E; F15, RULE-10, RPT-01,
 * CON-06, AC-15A/B/C, A7): situation reports and briefings drafted from the
 * records, reviewed by someone other than the author, issued by someone
 * other than the author, and frozen.
 * - `official_report`: one per report; kind, period with its time zone,
 *   cutoff, state draft → reviewed → issued (→ superseded by an amendment),
 *   or withdrawn before issue; who wrote, reviewed and issued it. The
 *   database itself refuses a reviewer or issuer who is the author.
 * - `official_report_section`: facts (computed from records, citing their
 *   definition and the records used), judgments (staff text, attributed)
 *   and narrative (drafted from the facts by template, labelled as drafted
 *   until a person edits it).
 * - `official_report_snapshot`: the issued report exactly as reviewed, the
 *   record versions and reference snapshots behind it, and its SHA-256.
 *   Append-only: no role may update or delete it (RULE-10).
 * - `official_report_lock`: the copy written to object storage under object
 *   lock (ADR-0010) by the worker; append-only, written by the system.
 * Every column is in the dictionary; RLS on every table.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';
import { systemWritten } from './0042_reference_data.ts';

export const REPORT_KINDS = [
  'sitrep',
  'briefing',
  'ida_package',
  'pda_package',
  'declaration_data',
  'media_sheet',
] as const;

const stamped = `
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid`;

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

async function frozen(db: Kysely<unknown>, name: string): Promise<void> {
  await sql
    .raw(
      `create trigger ${name}_no_change before update or delete on cg.${name}
       for each row execute function cg.issued_report_immutable()`,
    )
    .execute(db);
  await sql
    .raw(
      `create trigger ${name}_no_truncate before truncate on cg.${name}
       for each statement execute function cg.issued_report_immutable()`,
    )
    .execute(db);
  await sql.raw(`revoke update, delete, truncate on cg.${name} from cg_app, cg_worker`).execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `create table cg.official_report (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      client_uuid uuid not null,
      kind text not null check (kind in (${list(REPORT_KINDS)})),
      sequence integer not null check (sequence > 0),
      title text not null check (char_length(title) between 1 and 200),
      period_from timestamptz not null,
      period_to timestamptz not null,
      time_zone text not null,
      cutoff timestamptz not null,
      state text not null default 'draft'
        check (state in ('draft', 'reviewed', 'issued', 'superseded', 'withdrawn')),
      classification text not null default 'internal' check (classification in ('internal', 'public')),
      author_id uuid not null,
      reviewer_id uuid,
      reviewed_at timestamptz,
      reviewed_version integer,
      review_note text check (char_length(review_note) <= 2000),
      issuer_id uuid,
      issued_at timestamptz,
      amends uuid references cg.official_report(id),
      facts_at timestamptz not null,
      definitions jsonb not null default '[]'::jsonb,${stamped},
      unique (tenant_id, client_uuid),
      check (period_to > period_from),
      check (cutoff > period_from and cutoff <= period_to),
      check (reviewer_id is null or reviewer_id <> author_id),
      check (issuer_id is null or issuer_id <> author_id),
      check ((state in ('issued', 'superseded')) = (issued_at is not null and issuer_id is not null)),
      check (state <> 'reviewed' or (reviewer_id is not null and reviewed_version is not null))
    )`,
    )
    .execute(db);
  await sql`create index official_report_event_idx on cg.official_report (tenant_id, event_id, kind, sequence)`.execute(
    db,
  );
  // An issued report has at most one live amendment at a time.
  await sql`create unique index official_report_amends_once on cg.official_report (amends)
            where amends is not null and state <> 'withdrawn'`.execute(db);
  await sql`create trigger official_report_touch before update on cg.official_report for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.official_report')`.execute(db);
  await sql`drop policy tenant_delete on cg.official_report`.execute(db);

  await sql`
    create table cg.official_report_section (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.official_report(id),
      key text not null,
      position integer not null,
      kind text not null check (kind in ('fact', 'judgment', 'narrative')),
      title text not null,
      content jsonb not null default '{}'::jsonb,
      sources jsonb not null default '{}'::jsonb,
      drafted boolean not null default false,
      edited_by uuid,
      edited_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (report_id, key),
      check (kind = 'narrative' or not drafted)
    )`.execute(db);
  await sql`create trigger official_report_section_touch before update on cg.official_report_section for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.official_report_section')`.execute(db);
  await sql`drop policy tenant_delete on cg.official_report_section`.execute(db);

  await sql`
    create or replace function cg.issued_report_immutable() returns trigger
    language plpgsql as $$
    begin
      raise exception 'issued reports are immutable; correct them by amendment (RULE-10)'
        using errcode = 'insufficient_privilege';
    end $$`.execute(db);

  await sql`
    create table cg.official_report_snapshot (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null unique references cg.official_report(id),
      content jsonb not null,
      record_versions jsonb not null,
      reference_snapshots jsonb not null,
      content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
      issued_by uuid not null,
      issued_at timestamptz not null,
      reason text not null check (char_length(reason) >= 3),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.official_report_snapshot')`.execute(db);
  await sql`drop policy tenant_update on cg.official_report_snapshot`.execute(db);
  await sql`drop policy tenant_delete on cg.official_report_snapshot`.execute(db);
  await frozen(db, 'official_report_snapshot');

  await sql`
    create table cg.official_report_lock (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      snapshot_id uuid not null unique references cg.official_report_snapshot(id),
      object_key text not null,
      version_id text,
      lock_mode text not null check (lock_mode in ('GOVERNANCE', 'COMPLIANCE')),
      retain_until timestamptz not null,
      content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
      written_at timestamptz not null default now()
    )`.execute(db);
  await systemWritten(db, 'official_report_lock');
  await frozen(db, 'official_report_lock');

  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'official_report_lock',
    'official_report_snapshot',
    'official_report_section',
    'official_report',
  ])
    await sql.raw(`drop table if exists cg.${t}`).execute(db);
  await sql`drop function if exists cg.issued_report_immutable()`.execute(db);
  await loadDictionary(db);
}
