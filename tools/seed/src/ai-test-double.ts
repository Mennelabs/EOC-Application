/**
 * The AI test double for automated tests only (ADR-0043): switches a test's own tenant to the
 * fake provider, evaluated and enabled, so database suites exercise the AI paths without a
 * network. Running systems never call this; the seed provisions OpenAI, switched off.
 * Features locked off (`AI_FEATURES[].lockedOff`) stay off.
 */
import type { Kysely } from 'kysely';
import { AI_FEATURES, evaluateProvider, fakeProvider } from '@cg/ai';
import { withTenant, type Database } from '@cg/db';

/** Returns a function that puts the tenant's register back as it was. */
export async function enableAiTestDouble(
  db: Kysely<Database>,
  tenantId: string,
): Promise<() => Promise<void>> {
  const evaluation = await evaluateProvider(fakeProvider);
  const before = await withTenant(db, { tenantId }, (trx) =>
    trx
      .selectFrom('cg.ai_use_register')
      .select(['feature', 'provider', 'model', 'model_version', 'evaluation', 'enabled'])
      .where('tenant_id', '=', tenantId)
      .execute(),
  );
  await withTenant(db, { tenantId }, async (trx) => {
    for (const f of AI_FEATURES)
      await trx
        .updateTable('cg.ai_use_register')
        .set({
          provider: fakeProvider.info.provider,
          model: fakeProvider.info.model,
          model_version: fakeProvider.info.version ?? null,
          evaluation: JSON.stringify(evaluation),
          enabled: !f.lockedOff,
        })
        .where('tenant_id', '=', tenantId)
        .where('feature', '=', f.feature)
        .execute();
  });
  return () =>
    withTenant(db, { tenantId }, async (trx) => {
      for (const r of before)
        await trx
          .updateTable('cg.ai_use_register')
          .set({
            provider: r.provider,
            model: r.model,
            model_version: r.model_version,
            evaluation: JSON.stringify(r.evaluation),
            enabled: r.enabled,
          })
          .where('tenant_id', '=', tenantId)
          .where('feature', '=', r.feature)
          .execute();
    });
}
