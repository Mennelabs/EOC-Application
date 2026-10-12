/**
 * 0005 permissions (ADM-04, ADM-05, SEC-06, SEC-08):
 * - roles are versioned data; every change creates a new role_version;
 * - assignments are applied only through a permission_change_request that a
 *   second administrator approves (ADM-05 guardrail 6);
 * - break-glass sessions are time-boxed and recorded with who was notified.
 * The policy engine (packages/authz) evaluates these; the guardrails that no
 * county can turn off live in code, not here.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.role (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      key text not null,
      name text not null,
      description text,
      template_key text,
      current_version integer not null default 1,
      status text not null default 'active' check (status in ('active', 'retired')),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, key)
    )`.execute(db);
  await sql`create trigger role_touch before update on cg.role for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.role')`.execute(db);
  await sql`drop policy tenant_delete on cg.role`.execute(db);

  await sql`
    create table cg.role_version (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      role_id uuid not null references cg.role(id),
      version integer not null,
      grants jsonb not null,
      change_reason text,
      created_at timestamptz not null default now(),
      created_by uuid,
      unique (role_id, version)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.role_version')`.execute(db);
  // Role versions are immutable history.
  await sql`drop policy tenant_update on cg.role_version`.execute(db);
  await sql`drop policy tenant_delete on cg.role_version`.execute(db);

  await sql`
    create table cg.role_assignment (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      account_id uuid not null references cg.account(id),
      role_id uuid not null references cg.role(id),
      scope jsonb not null default '{}'::jsonb,
      valid_from timestamptz not null default now(),
      valid_to timestamptz,
      status text not null default 'active' check (status in ('active', 'revoked')),
      granted_by uuid not null,
      approved_by uuid not null,
      change_request_id uuid,
      revoked_at timestamptz,
      revoked_by uuid,
      revoke_reason text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (granted_by <> approved_by)
    )`.execute(db);
  await sql`create index role_assignment_account_idx on cg.role_assignment (account_id, status)`.execute(
    db,
  );
  await sql`create trigger role_assignment_touch before update on cg.role_assignment for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.role_assignment')`.execute(db);
  await sql`drop policy tenant_delete on cg.role_assignment`.execute(db);

  await sql`
    create table cg.permission_change_request (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      kind text not null check (kind in ('assign_role', 'revoke_role', 'publish_role_version')),
      payload jsonb not null,
      requested_by uuid not null,
      requested_at timestamptz not null default now(),
      status text not null default 'pending'
        check (status in ('pending', 'approved', 'rejected', 'applied', 'expired', 'withdrawn')),
      decided_by uuid,
      decided_at timestamptz,
      decision_reason text,
      applied_at timestamptz,
      expires_at timestamptz not null default now() + interval '7 days',
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (decided_by is null or decided_by <> requested_by)
    )`.execute(db);
  await sql`create index pcr_tenant_status_idx on cg.permission_change_request (tenant_id, status)`.execute(
    db,
  );
  await sql`create trigger pcr_touch before update on cg.permission_change_request for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.permission_change_request')`.execute(db);
  await sql`drop policy tenant_delete on cg.permission_change_request`.execute(db);

  await sql`
    create table cg.break_glass_session (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      account_id uuid not null references cg.account(id),
      reason text not null check (length(reason) >= 20),
      started_at timestamptz not null default now(),
      expires_at timestamptz not null,
      ended_at timestamptz,
      ended_by uuid,
      notified_at timestamptz,
      notified_to citext,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (expires_at > started_at and expires_at <= started_at + interval '24 hours')
    )`.execute(db);
  await sql`create index break_glass_active_idx on cg.break_glass_session (account_id, expires_at)
            where ended_at is null`.execute(db);
  await sql`create trigger break_glass_touch before update on cg.break_glass_session for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.break_glass_session')`.execute(db);
  await sql`drop policy tenant_delete on cg.break_glass_session`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'break_glass_session',
    'permission_change_request',
    'role_assignment',
    'role_version',
    'role',
  ]) {
    await sql`drop table if exists ${sql.table(`cg.${t}`)} cascade`.execute(db);
  }
}
