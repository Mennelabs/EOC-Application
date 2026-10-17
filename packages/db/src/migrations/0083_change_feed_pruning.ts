/**
 * 0083 the field change feed is pruned (SEC-13, retention category
 * `sessions`). The worker deletes feed entries older than the tenant's
 * period and records, per tenant, the highest sequence number it removed. A
 * phone whose cursor is below that mark has missed changes it can no longer
 * read, so the sync answers "cursor expired" and the phone downloads its area
 * package again (FLD-14). Sequence numbers are shared by all tenants and can
 * skip, so the oldest entry left cannot tell a phone what it missed; the mark
 * can. Only the worker role deletes from the feed.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.change_feed_pruned (
      tenant_id uuid primary key references cg.tenant(id),
      through_seq bigint not null,
      pruned_at timestamptz not null default now()
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.change_feed_pruned')`.execute(db);
  await sql`create policy retention_delete on cg.change_feed for delete using (cg.is_system())`.execute(
    db,
  );
  await sql`create index if not exists change_feed_tenant_created_idx
    on cg.change_feed (tenant_id, created_at)`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists cg.change_feed_tenant_created_idx`.execute(db);
  await sql`drop policy if exists retention_delete on cg.change_feed`.execute(db);
  await sql`drop table if exists cg.change_feed_pruned`.execute(db);
  await loadDictionary(db);
}
