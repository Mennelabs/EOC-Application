/**
 * 0024 published resources (layer-3 plan §2; BRD:FR-16.01–16.05, AC-16A/B/C,
 * PUB-18, RULE-12): hotlines, programs, deadlines and guidance with review
 * and expiry dates, link checks, targeting that never implies availability or
 * eligibility, and per-locale text that a person reviewed. Every column is in
 * the dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.resource (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      slug text not null,
      type text not null check (type in ('hotline', 'program', 'deadline', 'guidance', 'link', 'document')),
      category text not null default 'general',
      ordering integer not null default 100,
      owner_account_id uuid,
      status text not null default 'draft' check (status in ('draft', 'published', 'expired', 'removed')),
      review_at date,
      expires_at timestamptz,
      reference_url text,
      link_status text not null default 'unchecked' check (link_status in ('unchecked', 'ok', 'broken')),
      link_checked_at timestamptz,
      targeting jsonb not null default '{}'::jsonb,
      published_version integer,
      published_at timestamptz,
      unpublished_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, slug)
    )`.execute(db);
  await sql`create index resource_public_idx on cg.resource (tenant_id, status, category, ordering)`.execute(
    db,
  );
  await sql`create trigger resource_touch before update on cg.resource for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.resource')`.execute(db);

  await sql`
    create table cg.resource_text (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      resource_id uuid not null references cg.resource(id),
      locale text not null,
      title text not null,
      summary text,
      body_html text not null default '',
      human_reviewed_by uuid,
      reviewed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (resource_id, locale)
    )`.execute(db);
  await sql`create trigger resource_text_touch before update on cg.resource_text for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.resource_text')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.resource_text cascade`.execute(db);
  await sql`drop table if exists cg.resource cascade`.execute(db);
}
