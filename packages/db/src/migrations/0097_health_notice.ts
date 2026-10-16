/**
 * 0097 targeted health notices (FL:FR-06): public health drafts a boil-water,
 * do-not-use-water or safety notice for an area (ZIP codes, a circle, or
 * both), in English and, when given, Spanish. A second person approves it
 * (ADM-05 G4); from then it shows on the public "Find help" page, first for
 * visitors in its area, and residents in the area who agreed to be contacted
 * (a text only with SMS opt-in, an email only when email is how they asked to
 * be reached) are told once. When the notice ends, the same residents can be
 * told it has ended. The recipient ledger names a party and the phase only,
 * never a contact, and makes each resident's message happen once per phase.
 * Notices are kept as publications; the ledger as communications (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.health_notice (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid references cg.event(id),
      kind text not null check (kind in ('boil_water', 'do_not_use_water', 'safety')),
      title_en text not null check (length(title_en) between 3 and 100),
      body_en text not null check (length(body_en) between 3 and 2000),
      title_es text check (title_es is null or length(title_es) between 3 and 100),
      body_es text check (body_es is null or length(body_es) between 3 and 2000),
      area_label text not null check (length(area_label) between 2 and 80),
      zips text[] not null default '{}',
      center geometry(Point, 4326),
      radius_m integer check (radius_m is null or radius_m between 100 and 50000),
      status text not null default 'draft' check (status in ('draft', 'active', 'ended')),
      expires_at timestamptz,
      approved_by uuid,
      approved_at timestamptz,
      ended_by uuid,
      ended_at timestamptz,
      end_reason text check (end_reason in ('lifted', 'withdrawn')),
      tell_ended boolean not null default false,
      sent_sms integer not null default 0,
      sent_email integer not null default 0,
      sent_at timestamptz,
      ended_sent_sms integer not null default 0,
      ended_sent_email integer not null default 0,
      ended_sent_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (cardinality(zips) > 0 or center is not null),
      check ((center is null) = (radius_m is null)),
      check ((title_es is null) = (body_es is null)),
      check ((status = 'draft') = (approved_at is null)),
      check ((status = 'ended') = (ended_at is not null)),
      check ((status = 'ended') = (end_reason is not null))
    )`.execute(db);
  await sql`create index health_notice_status_idx
    on cg.health_notice (tenant_id, status, created_at desc)`.execute(db);
  await sql`create trigger health_notice_touch before update on cg.health_notice for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.health_notice')`.execute(db);
  // Notices end; the application never deletes them. The worker sweeps them past the period.
  await sql`drop policy tenant_delete on cg.health_notice`.execute(db);
  await sql`create policy retention_delete on cg.health_notice for delete using (cg.is_system())`.execute(
    db,
  );

  await sql`
    create table cg.health_notice_recipient (
      tenant_id uuid not null references cg.tenant(id),
      notice_id uuid not null references cg.health_notice(id),
      party_id uuid not null references cg.party(id),
      phase text not null check (phase in ('issued', 'ended')),
      channel text not null check (channel in ('sms', 'email')),
      created_at timestamptz not null default now(),
      primary key (notice_id, party_id, phase)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.health_notice_recipient')`.execute(db);
  await sql`drop policy tenant_delete on cg.health_notice_recipient`.execute(db);
  await sql`drop policy tenant_update on cg.health_notice_recipient`.execute(db);
  await sql`create policy retention_delete on cg.health_notice_recipient for delete using (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.health_notice_recipient`.execute(db);
  await sql`drop table if exists cg.health_notice`.execute(db);
  await loadDictionary(db);
}
