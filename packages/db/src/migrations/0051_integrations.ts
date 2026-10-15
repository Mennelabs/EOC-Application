/**
 * 0051 outbound integrations (layer-6 task H; SCL-09, ADM-05, GATE-04):
 *
 * - api_key: a per-tenant key with scopes for the read-only feature
 *   service. Only a SHA-256 hash of the key is kept (the key is 32 random
 *   bytes, so no salt or stretching is needed); the prefix finds the row.
 *   One administrator asks for it and sees it once; it works only after a
 *   second administrator approves it (never the one who asked). It always
 *   expires (at most a year) and can be revoked.
 * - webhook: an HTTPS receiver for named events, with its signing secret
 *   encrypted under the tenant's key (SEC-10, needed again to sign). Like
 *   a key, it sends nothing until a second administrator approves it.
 * - webhook_delivery: one signed delivery of one event to one webhook,
 *   retried with backoff by the worker; the payload names records, never
 *   people.
 *
 * Every column is in the dictionary; RLS. Nothing is deleted: a key is
 * revoked, a webhook disabled, a delivery kept as the record of what was
 * sent.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.api_key (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      name text not null check (char_length(name) between 1 and 120),
      prefix text not null unique check (prefix ~ '^[a-z0-9]{12}$'),
      secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
      scopes text[] not null
        check (cardinality(scopes) between 1 and 8 and scopes <@ array['pda.read']::text[]),
      status text not null default 'pending'
        check (status in ('pending', 'active', 'declined', 'revoked')),
      expires_at timestamptz not null,
      created_by uuid not null,
      decided_by uuid,
      decided_at timestamptz,
      decision_reason text check (char_length(decision_reason) <= 500),
      revoked_by uuid,
      revoked_at timestamptz,
      revoked_reason text check (char_length(revoked_reason) <= 500),
      last_used_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      -- ADM-05: a second administrator decides; never the one who asked.
      check (decided_by is null or decided_by <> created_by),
      check ((decided_at is null) = (decided_by is null)),
      -- A key still waiting may be withdrawn (revoked) by either administrator.
      check (status in ('pending', 'revoked') or decided_at is not null),
      check ((status = 'revoked') = (revoked_at is not null)),
      check ((revoked_at is null) = (revoked_by is null)),
      check (expires_at <= created_at + interval '366 days')
    )`.execute(db);
  await sql`create index api_key_tenant on cg.api_key (tenant_id, status)`.execute(db);

  await sql`
    create table cg.webhook (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      name text not null check (char_length(name) between 1 and 120),
      url text not null check (url ~ '^https://[^\\s]+$' and char_length(url) <= 500),
      events text[] not null
        check (cardinality(events) between 1 and 8
          and events <@ array['official_report.issued', 'export.ready']::text[]),
      secret_enc bytea not null,
      status text not null default 'pending'
        check (status in ('pending', 'active', 'declined', 'disabled')),
      created_by uuid not null,
      decided_by uuid,
      decided_at timestamptz,
      decision_reason text check (char_length(decision_reason) <= 500),
      disabled_by uuid,
      disabled_at timestamptz,
      disabled_reason text check (char_length(disabled_reason) <= 500),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (decided_by is null or decided_by <> created_by),
      check ((decided_at is null) = (decided_by is null)),
      check (status in ('pending', 'disabled') or decided_at is not null),
      check ((status = 'disabled') = (disabled_at is not null))
    )`.execute(db);

  await sql`
    create table cg.webhook_delivery (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      webhook_id uuid not null references cg.webhook(id),
      event text not null check (event in ('official_report.issued', 'export.ready')),
      subject_id uuid not null,
      payload jsonb not null,
      status text not null default 'pending'
        check (status in ('pending', 'delivered', 'failed')),
      attempts integer not null default 0 check (attempts between 0 and 20),
      next_attempt_at timestamptz,
      last_attempt_at timestamptz,
      last_status integer,
      last_error text check (char_length(last_error) <= 300),
      delivered_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((status = 'delivered') = (delivered_at is not null)),
      check (status <> 'pending' or next_attempt_at is not null)
    )`.execute(db);
  // One delivery per webhook, event and record: a retried job does not send twice (FR-00.06).
  await sql`create unique index webhook_delivery_once on cg.webhook_delivery (webhook_id, event, subject_id)`.execute(
    db,
  );
  await sql`create index webhook_delivery_due on cg.webhook_delivery (next_attempt_at) where status = 'pending'`.execute(
    db,
  );

  // A key's version moves with what administrators change, not with its use:
  // recording the last use must never make a revoke stale (FR-00.05).
  await sql`
    create trigger api_key_touch before update of name, scopes, status, expires_at,
      decided_by, decided_at, decision_reason, revoked_by, revoked_at, revoked_reason
    on cg.api_key for each row execute function cg.touch()`.execute(db);
  for (const t of ['webhook', 'webhook_delivery']) {
    await sql`create trigger ${sql.raw(`${t}_touch`)} before update on ${sql.raw(`cg.${t}`)} for each row execute function cg.touch()`.execute(
      db,
    );
  }
  for (const t of ['api_key', 'webhook', 'webhook_delivery']) {
    await sql`select cg.apply_tenant_rls(${`cg.${t}`})`.execute(db);
    await sql`drop policy tenant_delete on ${sql.raw(`cg.${t}`)}`.execute(db);
  }
  // Deliveries are queued and sent by the system only.
  await sql`drop policy tenant_insert on cg.webhook_delivery`.execute(db);
  await sql`drop policy tenant_update on cg.webhook_delivery`.execute(db);
  await sql`create policy system_insert on cg.webhook_delivery for insert with check (cg.is_system())`.execute(
    db,
  );
  await sql`create policy system_update on cg.webhook_delivery for update using (cg.is_system()) with check (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.webhook_delivery`.execute(db);
  await sql`drop table if exists cg.webhook`.execute(db);
  await sql`drop table if exists cg.api_key`.execute(db);
  await loadDictionary(db);
}
