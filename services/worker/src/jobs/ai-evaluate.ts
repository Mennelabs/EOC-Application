/**
 * ai.evaluate (layer-7 task A; AIG-06, AIG-08, ADR-0043): an administrator
 * asked for the tenant's provider to be evaluated. The labelled set runs
 * against the provider the tenant is configured for (OpenAI), the result is
 * written to every register row of that provider with the model that
 * answered, and the run is audited. Nothing is switched on: the administrator
 * enables each feature afterwards, and the register refuses it unless every
 * tenant language passed. Without a configured provider the run is recorded
 * as not possible.
 */
import { evaluateProvider } from '@cg/ai';
import { asSystem, systemAudit } from '../system.ts';
import type { TopicHandler } from './types.ts';

export const aiEvaluate: TopicHandler = async (ctx, msg) => {
  const tenantId = msg.tenantId;
  const provider = await asSystem(ctx.db, tenantId, (trx) => ctx.ai.providerFor(tenantId, trx));
  if (!provider?.llm) {
    await asSystem(ctx.db, tenantId, (trx) =>
      systemAudit(trx, tenantId, 'ai-evaluate', {
        action: 'ai_register.evaluate',
        targetType: 'tenant',
        targetId: tenantId,
        reason: 'no provider configured (OPENAI_API_KEY is not set)',
        executionId: msg.executionId,
      }),
    );
    return;
  }
  // The provider is called outside any transaction: the whole set takes a while.
  const report = await evaluateProvider(provider);
  const summary = {
    accuracy: report.accuracy,
    injectionResistance: report.injectionResistance,
    passed: report.passed,
    thresholds: report.thresholds,
    cases: report.cases.length,
    model: provider.info.model,
    evaluatedAt: new Date().toISOString(),
  };
  await asSystem(ctx.db, tenantId, async (trx) => {
    await trx
      .updateTable('cg.ai_use_register')
      .set({ evaluation: JSON.stringify(summary), model: provider.info.model })
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', provider.info.provider)
      .execute();
    await systemAudit(trx, tenantId, 'ai-evaluate', {
      action: 'ai_register.evaluate',
      targetType: 'tenant',
      targetId: tenantId,
      changes: {
        fields: [
          { name: 'provider', to: `${provider.info.provider}/${provider.info.model}` },
          { name: 'passed', to: report.passed },
          { name: 'accuracy', to: report.accuracy },
          { name: 'injection_resistance', to: report.injectionResistance },
        ],
      },
      executionId: msg.executionId,
    });
  });
};
