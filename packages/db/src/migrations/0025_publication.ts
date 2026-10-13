/**
 * 0025 the publication log (layer-3 plan §2; PUB-06, AC-16A): nothing is
 * public without a row here. Each row keeps the exact snapshot that went out,
 * who approved it, when, and on which channels; unpublishing is recorded on
 * the same row. Append-only apart from that. Every column is in the
 * dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.publication (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      subject_kind text not null check (subject_kind in ('site', 'resource', 'alert_draft', 'poster', 'media_sheet')),
      subject_id uuid not null,
      subject_version integer not null,
      snapshot jsonb not null,
      approved_by uuid not null,
      approved_at timestamptz not null default now(),
      channels text[] not null default '{web,sms,voice,feed,widget,print}',
      reason text not null,
      unpublished_at timestamptz,
      unpublished_by uuid,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index publication_subject_idx on cg.publication (subject_kind, subject_id, approved_at desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.publication')`.execute(db);
  await sql`drop policy tenant_delete on cg.publication`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.publication cascade`.execute(db);
}
