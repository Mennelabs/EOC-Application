/**
 * AI use register (AIG-01, AIG-06, AIG-08, AIG-12): what each AI feature
 * sends, what it informs, who checks it, and whether it is on for this
 * tenant. Enabling is consequential and refused for a provider that is not
 * compliant or not evaluated for the tenant's languages. The open health
 * alerts (AIG-09 as decided: alert, never switch off) and reviewer agreement
 * with the severity suggestion by group (PHO-13) are read here too.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { canEnable, DEFAULT_PROVIDER, providerByName, type EvaluationSummary } from '@cg/ai';
import { diffForAudit } from '@cg/audit';
import {
  AGREEMENT_DEFAULTS,
  agreementByModel,
  loadSeverityAgreement,
  type AgreementSettings,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, enqueueOutbox, iso, stamped } from './helpers.ts';

const entryOut = z.object({
  ...stamped,
  feature: z.string(),
  provider: z.string(),
  model: z.string(),
  modelVersion: z.string().nullable(),
  dataSent: z.string(),
  decisionInformed: z.string(),
  humanCheckpoint: z.string(),
  owner: z.string(),
  usRegion: z.boolean(),
  zeroRetention: z.boolean(),
  noTraining: z.boolean(),
  evaluation: z.unknown(),
  enabled: z.boolean(),
});

type Row = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  feature: string;
  provider: string;
  model: string;
  model_version: string | null;
  data_sent: string;
  decision_informed: string;
  human_checkpoint: string;
  owner: string;
  us_region: boolean;
  zero_retention: boolean;
  no_training: boolean;
  evaluation: unknown;
  enabled: boolean;
};

const toEntry = (r: Row): z.infer<typeof entryOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  feature: r.feature,
  provider: r.provider,
  model: r.model,
  modelVersion: r.model_version,
  dataSent: r.data_sent,
  decisionInformed: r.decision_informed,
  humanCheckpoint: r.human_checkpoint,
  owner: r.owner,
  usRegion: r.us_region,
  zeroRetention: r.zero_retention,
  noTraining: r.no_training,
  evaluation: r.evaluation,
  enabled: r.enabled,
});

const alertOut = z.object({
  ...stamped,
  feature: z.string(),
  /** A language for corrections and failures; `dimension:group` for fairness. */
  scope: z.string(),
  kind: z.enum(['corrections', 'failures', 'fairness']),
  counted: z.number().int(),
  flagged: z.number().int(),
  rate: z.number(),
  threshold: z.number(),
  raisedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
});

const sliceOut = z.object({
  dimension: z.enum(['hazard', 'home_type', 'income_band']),
  group: z.string(),
  decisions: z.number().int(),
  agreed: z.number().int(),
  rate: z.number(),
  behind: z.boolean(),
});

const agreementOut = z.object({
  minimum: z.number().int(),
  margin: z.number(),
  models: z.array(
    z.object({
      model: z.string(),
      decisions: z.number().int(),
      agreed: z.number().int(),
      rate: z.number(),
      slices: z.array(sliceOut),
    }),
  ),
});

export const aiRegisterRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/ai-register',
    { schema: { tags: ['ai'], response: { 200: z.array(entryOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('ai_register.read', {
        type: 'ai_use_register',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.ai_use_register')
          .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
          .selectAll()
          .orderBy('feature')
          .execute(),
      );
      return rows.map(toEntry);
    },
  );

  // AIG-08, ADR-0043: run the labelled set against the tenant's provider (OpenAI) in the
  // worker; the result lands on the register. It calls a paid service, so it is confirmed.
  app.post(
    '/ai-register/evaluate',
    { schema: { tags: ['ai'], response: { 202: z.object({ queued: z.literal(true) }) } } },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('ai_register.write', {
        type: 'ai_use_register',
        tenantId: s.tenantId,
      });
      const { reason } = request.confirmation();
      await request.tx(async (trx) => {
        const cfg = await trx
          .selectFrom('cg.tenant_config')
          .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
          .select('value')
          .where('key', '=', 'ai.provider')
          .executeTakeFirst();
        const name = typeof cfg?.value === 'string' ? cfg.value : DEFAULT_PROVIDER;
        if (!providerByName(name))
          throw new ApiError(
            409,
            'provider_not_configured',
            'No AI provider is configured here (OPENAI_API_KEY is not set), so nothing can be evaluated.',
          );
        await enqueueOutbox(trx, s.tenantId, 'ai.evaluate', { reason }, request.executionId);
        await request.audit(trx, {
          action: 'ai_register.evaluate_requested',
          targetType: 'tenant',
          targetId: s.tenantId,
          reason,
        });
      });
      return reply.code(202).send({ queued: true });
    },
  );

  // AIG-09 as decided 2026-10-15: health alerts tell the administrator; nothing switches off.
  app.get(
    '/ai-register/alerts',
    { schema: { tags: ['ai'], response: { 200: z.array(alertOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('ai_register.read', {
        type: 'ai_use_register',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.ai_health_alert')
          .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
          .where('cleared_at', 'is', null)
          .selectAll()
          .orderBy('raised_at', 'desc')
          .execute(),
      );
      return rows.map((r) => ({
        id: r.id,
        version: r.version,
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        feature: r.feature,
        scope: r.language,
        kind: r.kind,
        counted: r.counted,
        flagged: r.flagged,
        rate: Number(r.rate),
        threshold: Number(r.threshold),
        raisedAt: iso(r.raised_at)!,
        acknowledgedAt: iso(r.acknowledged_at),
      }));
    },
  );

  // An administrator marks an open alert seen; it stays open until the numbers recover.
  app.post(
    '/ai-register/alerts/:id/acknowledge',
    {
      schema: {
        tags: ['ai'],
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('ai_register.write', {
        type: 'ai_use_register',
        tenantId: s.tenantId,
      });
      const { reason } = request.confirmation();
      await request.tx(async (trx) => {
        const row = await trx
          .updateTable('cg.ai_health_alert')
          .set({
            acknowledged_by: s.accountId,
            acknowledged_at: new Date(),
            updated_by: s.accountId,
          })
          .where('id', '=', request.params.id)
          .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
          .where('cleared_at', 'is', null)
          .where('acknowledged_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!row) throw errors.notFound();
        await request.audit(trx, {
          action: 'ai.health_alert_acknowledged',
          targetType: 'ai_health_alert',
          targetId: row.id,
          reason,
        });
      });
      return reply.code(204).send(null);
    },
  );

  // PHO-13 as decided 2026-10-15: per model version, how often reviewers' degrees matched the
  // severity suggestion, overall and by hazard, home type and neighbourhood income band.
  app.get(
    '/ai-register/severity-agreement',
    { schema: { tags: ['ai'], response: { 200: agreementOut } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('ai_register.read', {
        type: 'ai_use_register',
        tenantId: s.tenantId,
      });
      return request.tx(async (trx) => {
        const cfg = await trx
          .selectFrom('cg.tenant_config')
          .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
          .select('value')
          .where('key', '=', 'ai.fairness')
          .executeTakeFirst();
        const settings: AgreementSettings = {
          ...AGREEMENT_DEFAULTS,
          ...((cfg?.value ?? {}) as Partial<AgreementSettings>),
        };
        const models = agreementByModel(await loadSeverityAgreement(trx, s.tenantId), settings);
        return { ...settings, models };
      });
    },
  );

  app.patch(
    '/ai-register/:feature',
    {
      schema: {
        tags: ['ai'],
        params: z.object({ feature: z.string().min(1).max(60) }),
        body: z.object({ enabled: z.boolean() }),
        response: { 200: entryOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.ai_use_register')
          .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
          .selectAll()
          .where('feature', '=', request.params.feature)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      await request.authorize('ai_register.write', {
        type: 'ai_use_register',
        id: row.id,
        tenantId: s.tenantId,
      });
      const expected = request.expectedVersion();
      if (request.body.enabled) {
        const provider = providerByName(row.provider);
        const tenant = await request.tx((trx) =>
          trx
            .selectFrom('cg.tenant')
            .select('locales')
            .where('id', '=', s.tenantId)
            .executeTakeFirstOrThrow(),
        );
        const check = provider
          ? canEnable(
              provider,
              tenant.locales,
              row.evaluation as unknown as EvaluationSummary | null,
            )
          : // ADR-0043: the provider is not configured here (no OPENAI_API_KEY): AI stays off.
            { ok: false, reasons: ['provider_not_configured'] };
        if (!check.ok)
          throw new ApiError(
            409,
            'provider_not_enableable',
            'This provider cannot be enabled for this organization.',
            { details: { reasons: check.reasons } },
          );
      }
      const updated = await request.tx(async (trx) => {
        const next = assertUpdated(
          await trx
            .updateTable('cg.ai_use_register')
            .set({ enabled: request.body.enabled, updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toEntry(row),
        );
        await request.audit(trx, {
          action: 'ai_register.write',
          targetType: 'ai_use_register',
          targetId: row.id,
          targetVersion: expected,
          reason: request.confirmation().reason,
          ...diffForAudit(
            { enabled: row.enabled },
            { enabled: request.body.enabled },
            classifierFor('ai_use_register'),
          ),
        });
        return next;
      });
      return toEntry(updated);
    },
  );
};
