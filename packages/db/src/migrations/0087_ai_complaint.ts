/**
 * 0087 lets a resident say that computer help went wrong (AIG-09: complaints
 * are monitored with corrections and failures). The complaint is one of a
 * few fixed reasons, kept on the AI output it is about, with when it was
 * made; no words are kept, so nothing personal is added. The health job
 * raises a `complaints` alert when too many of a feature's recent outputs
 * drew one.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export const COMPLAINT_REASONS = [
  'wrong',
  'not_my_language',
  'hard_to_understand',
  'other',
] as const;
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `alter table cg.ai_output
         add column complaint text check (complaint in (${list(COMPLAINT_REASONS)})),
         add column complained_at timestamptz,
         add constraint ai_output_complaint_pair check ((complaint is null) = (complained_at is null))`,
    )
    .execute(db);
  await sql`alter table cg.ai_health_alert drop constraint ai_health_alert_kind_check`.execute(db);
  await sql`alter table cg.ai_health_alert add constraint ai_health_alert_kind_check
    check (kind in ('corrections', 'failures', 'fairness', 'complaints'))`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_health_alert drop constraint ai_health_alert_kind_check`.execute(db);
  await sql`alter table cg.ai_health_alert no force row level security`.execute(db);
  await sql`delete from cg.ai_health_alert where kind = 'complaints'`.execute(db);
  await sql`alter table cg.ai_health_alert force row level security`.execute(db);
  await sql`alter table cg.ai_health_alert add constraint ai_health_alert_kind_check
    check (kind in ('corrections', 'failures', 'fairness'))`.execute(db);
  await sql`alter table cg.ai_output
    drop constraint if exists ai_output_complaint_pair,
    drop column if exists complained_at,
    drop column if exists complaint`.execute(db);
  await loadDictionary(db);
}
