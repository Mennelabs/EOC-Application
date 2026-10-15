/**
 * 0070 live translation in the field joins the AI use register (layer-7 task
 * H; FL-14, FL:FR-24, AIG-01, AIG-06, AIG-08). Every tenant that already has a
 * register gets the row with the provider of its extraction row, switched off
 * and not evaluated. Nothing is stored about what was said: each call's
 * record (AIG-01) holds the languages, the outcome and the model only. No new
 * columns. The migrator owns the table, so row security is lifted for these
 * statements and forced again.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`
    insert into cg.ai_use_register (
      tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
      human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
    select r.tenant_id, 'field.translation', r.provider, r.model, r.model_version,
           ${'What a worker or a survivor says in a general conversation, one turn at a time; never consent, legal or medical conversations'},
           ${'A labelled machine translation shown on the phone between worker and survivor (FL-14); nothing is kept'},
           ${'One tap brings in a human interpreter; consent, legal and medical conversations always use one'},
           'Equity lead',
           r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
      from cg.ai_use_register r
     where r.feature = 'intake.extraction'
       and not exists (
         select 1 from cg.ai_use_register x
          where x.tenant_id = r.tenant_id and x.feature = 'field.translation')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register where feature = 'field.translation'`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}
