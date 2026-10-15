/**
 * 0059 command aliases (layer-7 task C; CMD-04, BRD:FR-18.05, FR-00.10,
 * Section 30.2). A short name for one line of shorthand: personal (for
 * lookups and drafts only) or for the whole organization (set by an
 * administrator with the explicit `command_alias.manage`, confirmed with a
 * reason, versioned and audited). A name never shadows a command verb, and
 * an alias never names a consequential command; the server checks both and
 * shows the expansion with every plan. Retired aliases stay for the history.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.command_alias (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      scope text not null check (scope in ('personal', 'organization')),
      account_id uuid,
      name text not null check (name ~ '^[a-z][a-z0-9_-]{1,29}$'),
      expansion text not null check (length(expansion) between 2 and 500 and left(expansion, 1) = '/'),
      command text not null,
      retired_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      constraint command_alias_owner check ((scope = 'personal') = (account_id is not null))
    )`.execute(db);
  // One live alias per name in each scope (and per person for personal ones).
  await sql`create unique index command_alias_live_name on cg.command_alias
    (tenant_id, scope, coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
    where retired_at is null`.execute(db);
  await sql`create trigger command_alias_touch before update on cg.command_alias
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.command_alias')`.execute(db);
  await sql`drop policy tenant_delete on cg.command_alias`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.command_alias`.execute(db);
}
