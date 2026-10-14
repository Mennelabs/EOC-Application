/**
 * 0005 subject lookup (SEC-12, ADR-0036): the API resolves a verified token
 * to its enclave account before it knows the agency. A request sets
 * `app.subject` to the token's subject for one transaction; this policy lets
 * it read that one account row, and nothing else, so row security per agency
 * stays in force for every other read. No new columns (SEC-11 unchanged).
 *
 * The account's last-seen time (inactivity suspension, AC-2) is written by
 * requests; it is not a change to the account, so it neither bumps the
 * version (no false conflicts for administrators) nor the update time.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create policy person_by_subject on cjis.person for select using (
      idp_subject is not null
      and idp_subject = nullif(current_setting('app.subject', true), ''))`.execute(db);
  await sql`
    create or replace function cjis.person_touch() returns trigger
    language plpgsql as $$
    begin
      if (to_jsonb(new) - 'last_seen_at') = (to_jsonb(old) - 'last_seen_at') then
        return new;
      end if;
      new.updated_at := now();
      new.version := old.version + 1;
      return new;
    end $$`.execute(db);
  await sql`drop trigger person_touch on cjis.person`.execute(db);
  await sql`create trigger person_touch before update on cjis.person
            for each row execute function cjis.person_touch()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger person_touch on cjis.person`.execute(db);
  await sql`create trigger person_touch before update on cjis.person
            for each row execute function cjis.touch()`.execute(db);
  await sql`drop function if exists cjis.person_touch()`.execute(db);
  await sql`drop policy if exists person_by_subject on cjis.person`.execute(db);
}
