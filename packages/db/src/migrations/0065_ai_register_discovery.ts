/**
 * 0065 resource discovery's web search joins the AI use register (layer-7
 * task F; REC-13, AIG-01, AIG-05, AIG-06, AIG-08, ADR-0043). Every tenant
 * that already has a register gets the `discovery.web_search` row with the
 * provider of its extraction row, switched off: the search runs only after the
 * provider passes the tenant's evaluation and an administrator enables it,
 * and only where the county lists web search as a source. New tenants get the
 * row from provisioning. Not evaluated yet: the evaluation runs again first.
 * No new columns. The migrator owns the table, so row
 * security is lifted for this one statement and forced again.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`
    insert into cg.ai_use_register (
      tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
      human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
    select r.tenant_id, 'discovery.web_search', r.provider, r.model, r.model_version,
           'The county''s area in words, the kinds of place sought, and the names and street addresses of public places already in the facility registry; never a person or anything a resident wrote',
           'Drafts candidate places, each with the pages that state it, for the review queue (REC-13); nothing enters, changes or leaves the registry on its own',
           'County EM qualifies each candidate in or out with a reason; planning may set candidates aside',
           'Planning and GIS lead',
           r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
      from cg.ai_use_register r
     where r.feature = 'intake.extraction'
       and not exists (
         select 1 from cg.ai_use_register x
          where x.tenant_id = r.tenant_id and x.feature = 'discovery.web_search')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register where feature = 'discovery.web_search'`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}
