/**
 * 0004 identity: accounts (sign-in identities) kept separate from personnel
 * records (BRD:FR-01.05, ACCT-01). Deactivating an account never removes its
 * history (AC-01C, AC-08B). Personnel contact details are restricted data,
 * stored encrypted with a blind index for exact-match lookup (SEC-10).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.account (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      idp_subject text,
      email citext not null,
      display_name text not null,
      status text not null default 'invited'
        check (status in ('invited', 'active', 'suspended', 'deactivated')),
      invited_at timestamptz not null default now(),
      activated_at timestamptz,
      suspended_at timestamptz,
      deactivated_at timestamptz,
      last_login_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, email),
      unique (tenant_id, idp_subject)
    )`.execute(db);
  await sql`create trigger account_touch before update on cg.account for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.account')`.execute(db);
  // Accounts are deactivated, never deleted (attribution must survive).
  await sql`drop policy tenant_delete on cg.account`.execute(db);

  await sql`
    create table cg.account_lifecycle (
      id bigserial primary key,
      tenant_id uuid not null references cg.tenant(id),
      account_id uuid not null references cg.account(id),
      from_status text,
      to_status text not null,
      reason text,
      actor_account_id uuid,
      at timestamptz not null default now()
    )`.execute(db);
  await sql`create index account_lifecycle_idx on cg.account_lifecycle (account_id, at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.account_lifecycle')`.execute(db);
  await sql`drop policy tenant_update on cg.account_lifecycle`.execute(db);
  await sql`drop policy tenant_delete on cg.account_lifecycle`.execute(db);

  await sql`
    create table cg.personnel (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      account_id uuid unique references cg.account(id),
      name text not null,
      agency text,
      department text,
      operational_role text,
      skills text[] not null default '{}',
      duty_status text not null default 'off_duty'
        check (duty_status in ('off_duty', 'on_duty')),
      availability text not null default 'unavailable'
        check (availability in ('unavailable', 'available', 'assigned')),
      status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
      contact_enc bytea,
      phone_bidx bytea,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index personnel_tenant_idx on cg.personnel (tenant_id, status)`.execute(db);
  await sql`create index personnel_phone_bidx on cg.personnel (tenant_id, phone_bidx)`.execute(db);
  await sql`create trigger personnel_touch before update on cg.personnel for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.personnel')`.execute(db);
  // Personnel are archived, never deleted (BRD:FR-05.05).
  await sql`drop policy tenant_delete on cg.personnel`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.personnel cascade`.execute(db);
  await sql`drop table if exists cg.account_lifecycle cascade`.execute(db);
  await sql`drop table if exists cg.account cascade`.execute(db);
}
