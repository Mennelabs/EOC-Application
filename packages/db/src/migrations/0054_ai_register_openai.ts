/**
 * 0054 the AI use register moves to OpenAI (ADR-0043, decided 2026-10-15;
 * AIG-01, AIG-06, AIG-08). No running system uses the fake provider any more:
 * every register row that named it now names OpenAI, switched off and not
 * evaluated, until the tenant's languages pass the evaluation against OpenAI
 * and an administrator enables the feature. The migrator owns the table, so
 * row security is lifted for this one statement and forced again.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`
    update cg.ai_use_register
       set provider = 'openai', model = 'gpt-5-mini', model_version = null,
           us_region = true, zero_retention = true, no_training = true,
           evaluation = '{}'::jsonb, enabled = false
     where provider = 'fake'`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
}

export async function down(): Promise<void> {
  // The fake provider is not restored to running systems (ADR-0043).
}
