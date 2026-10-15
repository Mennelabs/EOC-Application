/**
 * 0066 AI drafting joins the AI use register (layer-7 task G; CMD-16,
 * DCL:DEC-14, PUB-11, PUB-12, PUB-14, AIG-01, AIG-06, AIG-08, ADR-0043).
 * Every tenant that already has a register gets the three drafting rows with
 * the provider of its extraction row, switched off and not evaluated: drafts
 * come only after the evaluation runs again and an administrator enables each.
 * New tenants get the rows from provisioning. No new columns. The migrator
 * owns the table, so row security is lifted for these statements and forced
 * again.
 */
import { sql, type Kysely } from 'kysely';

const FEATURES: [string, string, string, string, string][] = [
  [
    'report.drafting',
    "A situation report's or briefing's computed figures with their labels, and the rules' own summary; counts only, never a person",
    'Rewrites the summary from the figures, each sentence citing its facts; refused when it states a figure the facts do not hold (CMD-16, AI-04)',
    'Labelled as drafted and unapprovable until a person reads and saves it; review and issue by others (RULE-10)',
    'Planning and GIS lead',
  ],
  [
    'declaration.drafting',
    'The declaration figures (damage counts by degree, tenure and insurance, outages, tract profile aggregates); counts only (DEC-17)',
    'Drafts Boxes 8 and 9 of FEMA Form 010-0-13 from the figures, each sentence citing its facts (DCL:DEC-14)',
    'Staff edit and save the text; the state, not the county, files the request',
    'County EM director',
  ],
  [
    'public.drafting',
    "A site's public details (name, address, hours, services) or published figures; never a resident",
    'Drafts public posts, radio scripts and alert text sized for the channel (PUB-11, PUB-12, PUB-14)',
    'Nothing is sent or published until its named approver approves it (PUB-06)',
    'Public information officer',
  ],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  for (const [feature, dataSent, decision, checkpoint, owner] of FEATURES)
    await sql`
      insert into cg.ai_use_register (
        tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
        human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
      select r.tenant_id, ${feature}, r.provider, r.model, r.model_version,
             ${dataSent}, ${decision}, ${checkpoint}, ${owner},
             r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
        from cg.ai_use_register r
       where r.feature = 'intake.extraction'
         and not exists (
           select 1 from cg.ai_use_register x
            where x.tenant_id = r.tenant_id and x.feature = ${feature})`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register
    where feature in ('report.drafting', 'declaration.drafting', 'public.drafting')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}
