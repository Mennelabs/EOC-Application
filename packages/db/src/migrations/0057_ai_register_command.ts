/**
 * 0057 the command window's interpretation joins the AI use register
 * (layer-7 task B; AIG-01, AIG-06, AIG-08, ADR-0043, ADR-0044). Every tenant
 * that already has a register gets the `command.interpret` row with the
 * provider of its extraction row, switched off and not evaluated: plain-words
 * commands start only after the tenant's languages pass the evaluation (which
 * now includes the command cases) and an administrator enables the feature.
 * New tenants get the row from provisioning. No new columns. The migrator
 * owns the table, so row security is lifted for this one statement and forced
 * again.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`
    insert into cg.ai_use_register (
      tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
      human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
    select r.tenant_id, 'command.interpret', r.provider, r.model, r.model_version,
           'A staff member''s request to the command window, redacted of phone numbers, emails, street addresses, identifiers and names; the shorthand the person may use',
           'Turns the request into one line of shorthand that the server checks like typed shorthand; the plan is shown before anything changes (CMD-10, CMD-20)',
           'The person confirms every change on the plan screen; lookups only read what the person may see (CMD-21, CMD-22)',
           'Product owner (command window)',
           r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
      from cg.ai_use_register r
     where r.feature = 'intake.extraction'
       and not exists (
         select 1 from cg.ai_use_register x
          where x.tenant_id = r.tenant_id and x.feature = 'command.interpret')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register where feature = 'command.interpret'`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}
