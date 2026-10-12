/**
 * 0019 channel numbers (CHN-03/04/05, docs/06): one verified toll-free number
 * per county. Inbound webhooks name the number they were sent to before any
 * tenant context exists, so a second select policy admits the row whose
 * number equals the transaction-local setting `app.public_number` (same
 * pattern as 0017 for slugs). Every column is in the dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.channel_number (
      tenant_id uuid not null references cg.tenant(id),
      number text primary key check (number ~ '^\\+[1-9][0-9]{6,14}$'),
      capabilities text[] not null default '{sms,voice}',
      provider text not null default 'twilio' check (provider in ('twilio', 'simulator')),
      label text,
      verified_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index channel_number_tenant_idx on cg.channel_number (tenant_id)`.execute(db);
  await sql`create trigger channel_number_touch before update on cg.channel_number for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.channel_number')`.execute(db);
  await sql`
    create or replace function cg.public_number() returns text
    language sql stable as $$
      select nullif(current_setting('app.public_number', true), '')
    $$`.execute(db);
  await sql`
    create policy channel_number_public_select on cg.channel_number for select using (
      cg.public_number() is not null and number = cg.public_number())`.execute(db);
  // The tenant row itself is needed next (name, locales): admit it through its number.
  await sql`drop policy tenant_select on cg.tenant`.execute(db);
  await sql`
    create policy tenant_select on cg.tenant for select using (
      id = cg.current_tenant_id()
      or id = any(cg.visible_tenant_ids())
      or (cg.current_tenant_path() is not null and path <@ cg.current_tenant_path())
      or (cg.public_slug() is not null and slug = cg.public_slug())
      or (cg.public_number() is not null and id in (select tenant_id from cg.channel_number where number = cg.public_number()))
      or cg.is_system())`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy tenant_select on cg.tenant`.execute(db);
  await sql`
    create policy tenant_select on cg.tenant for select using (
      id = cg.current_tenant_id()
      or id = any(cg.visible_tenant_ids())
      or (cg.current_tenant_path() is not null and path <@ cg.current_tenant_path())
      or (cg.public_slug() is not null and slug = cg.public_slug())
      or cg.is_system())`.execute(db);
  await sql`drop table if exists cg.channel_number cascade`.execute(db);
  await sql`drop function if exists cg.public_number()`.execute(db);
}
