/**
 * 0074 retires `photo.quality` from the AI use register (AIG-01: the register
 * lists what is real). PHO-03 asks for the retake suggestion on the device,
 * before upload, so it works on slow connections; the resident app's check
 * does that without AI, and nothing ever sent a photo to a provider for it.
 * The sensitive-region detector (`photo.sensitive_regions`) is unchanged. No
 * call was ever recorded under the feature. Down puts the row back, switched
 * off and not evaluated, with the provider of each tenant's extraction row.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register where feature = 'photo.quality'`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`
    insert into cg.ai_use_register (
      tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
      human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
    select r.tenant_id, 'photo.quality', r.provider, r.model, r.model_version,
           'A resident photo', 'One plain retake suggestion (PHO-03)',
           'Resident decides whether to retake', 'Product owner (intake)',
           r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
      from cg.ai_use_register r
     where r.feature = 'intake.extraction'
       and not exists (
         select 1 from cg.ai_use_register x
          where x.tenant_id = r.tenant_id and x.feature = 'photo.quality')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}
