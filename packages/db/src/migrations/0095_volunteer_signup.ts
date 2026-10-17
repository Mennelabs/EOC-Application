/**
 * 0095 walk-up volunteers register themselves by QR (FL:FR-20). Reception
 * opens a link for an event; its code is printed or shown at the desk. The
 * link's token is stored only as its SHA-256; it expires, and reception can
 * close it. The link carries the county's waiver: its version and, when the
 * county gives it, the text in each language the volunteer reads and accepts
 * on the phone (otherwise they sign at the desk).
 *
 * A volunteer's request waits at the desk with a short desk code. Their name
 * and contact are encrypted; the skills they name come from a fixed list and
 * are recorded, never verified. Reception turns the request into a
 * registration through the usual reception step, which sets the background-
 * check status (never its contents), or declines it. Either way the
 * encrypted details are erased at once: a registered volunteer's details
 * live in the roster. Requests and links are swept as drafts (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.volunteer_signup_link (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      token_hash bytea not null unique,
      waiver_version text not null check (length(waiver_version) between 1 and 40),
      waiver_text jsonb not null default '{}'::jsonb check (jsonb_typeof(waiver_text) = 'object'),
      expires_at timestamptz not null,
      closed_at timestamptz,
      closed_by uuid,
      created_at timestamptz not null default now(),
      created_by uuid,
      check (expires_at > created_at)
    )`.execute(db);
  await sql`create index volunteer_signup_link_event_idx
    on cg.volunteer_signup_link (tenant_id, event_id, created_at desc)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.volunteer_signup_link')`.execute(db);
  await sql`drop policy tenant_delete on cg.volunteer_signup_link`.execute(db);
  await sql`create policy retention_delete on cg.volunteer_signup_link for delete using (cg.is_system())`.execute(
    db,
  );

  await sql`
    create table cg.volunteer_signup (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      link_id uuid not null references cg.volunteer_signup_link(id),
      execution_id uuid not null,
      desk_code text not null check (desk_code ~ '^[2-9A-HJ-NP-Z]{4}$'),
      status text not null default 'waiting' check (status in ('waiting', 'registered', 'declined')),
      details_enc bytea,
      skills text[] not null default '{}',
      waiver_version text not null,
      waiver_accepted_at timestamptz,
      registration_id uuid references cg.volunteer_registration(id),
      decided_at timestamptz,
      decided_by uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, execution_id),
      unique (link_id, desk_code),
      check ((status = 'waiting') = (decided_at is null)),
      check ((status = 'waiting') = (details_enc is not null)),
      check ((status = 'registered') = (registration_id is not null))
    )`.execute(db);
  await sql`create index volunteer_signup_waiting_idx
    on cg.volunteer_signup (tenant_id, event_id, created_at) where status = 'waiting'`.execute(db);
  await sql`create trigger volunteer_signup_touch before update on cg.volunteer_signup for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.volunteer_signup')`.execute(db);
  await sql`drop policy tenant_delete on cg.volunteer_signup`.execute(db);
  await sql`create policy retention_delete on cg.volunteer_signup for delete using (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.volunteer_signup`.execute(db);
  await sql`drop table if exists cg.volunteer_signup_link`.execute(db);
  await loadDictionary(db);
}
