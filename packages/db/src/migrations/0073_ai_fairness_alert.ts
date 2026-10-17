/**
 * 0073 fairness alerts on the AI severity suggestion (layer-7 task I; PHO-13
 * as decided 2026-10-15, AIG-09 alerts only). The AI health alert gains the
 * kind `fairness`: a group of decisions (a hazard, a home type or an income
 * band, named in `language` as `dimension:group`) whose agreement with the
 * suggestion falls behind the model's overall agreement. No new columns.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_health_alert drop constraint ai_health_alert_kind_check`.execute(db);
  await sql`alter table cg.ai_health_alert add constraint ai_health_alert_kind_check
    check (kind in ('corrections', 'failures', 'fairness'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_health_alert no force row level security`.execute(db);
  await sql`delete from cg.ai_health_alert where kind = 'fairness'`.execute(db);
  await sql`alter table cg.ai_health_alert force row level security`.execute(db);
  await sql`alter table cg.ai_health_alert drop constraint ai_health_alert_kind_check`.execute(db);
  await sql`alter table cg.ai_health_alert add constraint ai_health_alert_kind_check
    check (kind in ('corrections', 'failures'))`.execute(db);
}
