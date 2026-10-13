/**
 * 0040 audit chain order (BRD:FR-08.04, SEC-18, ADR-0012): the sequence
 * number is now drawn inside the chain trigger, after the per-tenant lock.
 * Before, `seq` came from the column default when the row was formed, before
 * the lock, so two writers in one tenant could take seq 100 and 101 and then
 * chain in the other order; the verifier walks by seq and reported a break
 * where nothing had been tampered with. Drawn after the lock, a tenant's seq
 * order is its chain order. The skipped default values leave gaps, which the
 * verifier does not mind (it checks hashes, not consecutive numbers). No new
 * columns (SEC-11 unchanged). Rows written before this migration keep their
 * order; a chain already broken by the race stays reported, as it should.
 */
import { sql, type Kysely } from 'kysely';

const body = (seqLine: string) => `
  create or replace function cg.audit_chain() returns trigger
  language plpgsql as $$
  declare prev bytea;
  begin
    perform pg_advisory_xact_lock(hashtext('cg.audit:' || new.tenant_id::text));
    ${seqLine}
    select hash into prev from cg.audit_event
      where tenant_id = new.tenant_id order by seq desc limit 1;
    new.recorded_at := now();
    new.prev_hash := prev;
    new.hash := digest(coalesce(prev, '\\x'::bytea) || convert_to(cg.audit_canonical(new), 'UTF8'), 'sha256');
    return new;
  end $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(body(`new.seq := nextval(pg_get_serial_sequence('cg.audit_event', 'seq'));`))
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(body('')).execute(db);
}
