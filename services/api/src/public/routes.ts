/**
 * Public intake API (no staff session): the published question graph, the
 * submission path that never fails (rule 8), paused drafts, photo uploads,
 * reference-code lookup with a one-time code, and the resident's own report.
 * Everything here runs as the public subject under the tenant named in the
 * URL; guardrail G2 limits public subjects to the public actions in the
 * catalog. (BRD:FR-11.01–11.07, INT-20/22, SEC-09, SEC-17, RES-01/02,
 * RULE-17, SCL-03/04/06, CHN-08, PHO-05)
 */
import { randomInt } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { QueueConnection } from '@cg/adapters';
import { renderPdf } from '@cg/pdf';
import {
  callAi,
  extractionQuestions,
  recordAiOutput,
  redact,
  validateExtraction,
  type AiProvider,
} from '@cg/ai';
import type { Database } from '@cg/db';
import { normalisePhone } from '@cg/crypto';
import { upsertAfterAnswers } from '@cg/db';
import { validateAnswer, type QuestionGraph, type QuestionNode } from '@cg/intake';
import { ApiError, errors } from '../errors.ts';
import { enqueueOutbox } from '../routes/helpers.ts';
import { RiskScorer, WindowCounter } from './abuse.ts';
import { aiComplaintRoutes } from './ai-complaint.ts';
import { dictationOn, dictationRoutes } from './dictation.ts';
import { facilityRegistrationRoutes } from './facility-registration.ts';
import { volunteerSignupRoutes } from './volunteer-signup.ts';
import {
  CODE_DIGITS,
  CODE_LETTERS,
  normaliseCode,
  type ReferenceCodeLeaser,
} from './reference-codes.ts';
import { helpRoutes, langOf } from './help.ts';
import { wazeFeedRoutes } from './waze.ts';
import { loadResidentCopy } from './my-copy.ts';
import { residentCopyPdf } from './pdf.ts';
import { signResidentToken, verifyResidentToken } from './resident-token.ts';
import {
  answerValueSchema,
  configValue,
  hazardsFor,
  loadGraph,
  sha,
  submissionSchema,
  submitIntake,
  type SubmitDeps,
} from './submit.ts';
export {
  INTAKE_QUEUE,
  publishWithConfirm,
  submissionSchema,
  validateAnswers,
  type IntakeQueueMessage,
  type SubmissionBody,
} from './submit.ts';
import type { TenantResolver } from './tenant-resolver.ts';

export interface PublicRouteDeps {
  resolver: TenantResolver;
  codes: ReferenceCodeLeaser;
  risk?: RiskScorer;
  getQueue: () => QueueConnection | undefined;
  /** presignClient signs URLs browsers can reach (S3_PUBLIC_ENDPOINT); client talks to storage internally. */
  objects?: { client: S3Client; presignClient?: S3Client; bucket: string; maxBytes: number };
  residentTokenSecret: string;
  defaultGraph: QuestionGraph;
  /** Provider in force for a tenant (AIG-12); absent means no AI anywhere (INT-16). */
  ai?: { providerFor(tenantId: string, trx: Transaction<Database>): Promise<AiProvider | null> };
  now?: () => Date;
  /** The public site's base URL, for links the help endpoints hand out. */
  publicBase?: string | undefined;
}

const tenantParam = z.object({ tenant: z.string().min(2).max(60) });
const tenantEventParam = tenantParam.extend({ event: z.string().min(1).max(60) });

function randomDraftCode(): string {
  const alphabet = CODE_LETTERS + CODE_DIGITS;
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function otpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export const publicRoutes =
  (deps: PublicRouteDeps): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();
    const risk = deps.risk ?? new RiskScorer();
    const lookupLimiter = new WindowCounter(10 * 60_000);
    const now = deps.now ?? (() => new Date());
    const submitDeps: SubmitDeps = {
      codes: deps.codes,
      risk,
      getQueue: deps.getQueue,
      defaultGraph: deps.defaultGraph,
      crypto: app.fieldCrypto,
      now,
    };

    // Every public route names its tenant: resolve it once and scope RLS to it.
    app.addHook('preValidation', async (request) => {
      const params = request.params as { tenant?: string } | undefined;
      if (!params?.tenant) return;
      const tenant = await deps.resolver.bySlug(params.tenant);
      if (tenant.status !== 'active' && tenant.status !== 'provisioning') throw errors.notFound();
      const s = request.subject;
      if (s.kind === 'public') request.subject = { ...s, tenantId: tenant.id };
      (request as FastifyRequest & { publicTenant?: typeof tenant }).publicTenant = tenant;
    });

    const tenantOf = (request: FastifyRequest) => {
      const t = (
        request as FastifyRequest & {
          publicTenant?: {
            id: string;
            name: string;
            locales: string[];
            branding: Record<string, unknown>;
            slug: string;
          };
        }
      ).publicTenant;
      if (!t) throw errors.notFound();
      return t;
    };

    const ipOf = (request: FastifyRequest) => request.ip || undefined;

    function guessLookups(request: FastifyRequest, limit = 30) {
      const ip = ipOf(request);
      if (ip && lookupLimiter.hit(ip) > limit)
        throw new ApiError(
          429,
          'too_many_attempts',
          'Too many attempts. Please wait a few minutes and try again.',
          { retryable: true },
        );
    }

    // Public "Find help": sites, resources, feeds, widget and media sheet (PUB-*), same tenant hook.
    await app.register(helpRoutes({ publicBase: deps.publicBase }));
    // FL:FR-05, Q-04: the Waze for Cities closure feed, when the county has switched it on.
    await app.register(wazeFeedRoutes);
    // REC-01: a place offered through the public form waits for county approval.
    await app.register(facilityRegistrationRoutes);
    // FL:FR-20: walk-up volunteers sign up through the code at the desk.
    await app.register(volunteerSignupRoutes);
    await app.register(dictationRoutes({ ...(deps.ai ? { ai: deps.ai } : {}) }));
    // AIG-09: a resident says the computer help went wrong (fixed reasons, no words).
    await app.register(aiComplaintRoutes);

    // ---------------------------------------------------------------- graph
    app.get(
      '/intake/:tenant/:event',
      {
        schema: {
          tags: ['public intake'],
          params: tenantEventParam,
          querystring: z.object({ lang: z.string().min(2).max(10).optional() }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.read', { type: 'intake_graph', tenantId: tenant.id });
        return request.tx(async (trx) => {
          const event = await trx
            .selectFrom('cg.event')
            .select(['id', 'name', 'hazard_type', 'status', 'intake_keywords'])
            .where('intake_slug', '=', request.params.event)
            .executeTakeFirst();
          if (!event || event.status !== 'active') throw errors.notFound();
          const graph = await loadGraph(trx, deps.defaultGraph.key, undefined, deps.defaultGraph);
          const emergency = await configValue<Record<string, string>>(
            trx,
            'intake.emergency_instructions',
          );
          const faith = await configValue<boolean>(trx, 'intake.faith_partners');
          const helpPhone = await configValue<string>(trx, 'intake.help_phone');
          const smsTerms = await configValue<string>(trx, 'sms.terms_url');
          const smsPrivacy = await configValue<string>(trx, 'sms.privacy_url');
          const languages = graph.languages.filter((l) => tenant.locales.includes(l));
          return {
            tenant: { slug: tenant.slug, name: tenant.name, branding: tenant.branding },
            event: {
              id: event.id,
              name: event.name,
              hazardType: event.hazard_type,
              hazards: hazardsFor(event.hazard_type),
              keywords: event.intake_keywords,
            },
            languages: languages.length > 0 ? languages : ['en'],
            helpPhone: helpPhone ?? null,
            // docs/06: the opt-in box links to the county's SMS terms and privacy pages.
            sms: { termsUrl: smsTerms ?? null, privacyUrl: smsPrivacy ?? null },
            graph: {
              ...graph,
              emergencyInstructions: emergency ?? graph.emergencyInstructions,
              consentOrgTypes: graph.consentOrgTypes.filter((o) => !o.optIn || faith === true),
            },
            uploads: deps.objects
              ? { maxBytes: deps.objects.maxBytes, enabled: true }
              : { enabled: false },
            // INT-12: speaking instead of typing, through the tenant's provider only.
            dictation: await dictationOn(deps, trx, tenant.id),
          };
        });
      },
    );

    // ----------------------------------------------------------- submission
    app.post(
      '/intake/:tenant/:event/submissions',
      {
        config: { idempotent: true },
        schema: { tags: ['public intake'], params: tenantEventParam, body: submissionSchema },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const body = request.body;
        if (request.executionId !== body.executionId)
          throw new ApiError(
            400,
            'execution_id_mismatch',
            'The Idempotency-Key must equal executionId.',
          );
        await request.authorize('intake.submit', { type: 'report', tenantId: tenant.id });
        const result = await submitIntake(submitDeps, request, {
          tenantId: tenant.id,
          eventSlug: request.params.event,
          body,
        });
        return reply.code(202).send({
          referenceCode: result.referenceCode,
          status: result.status,
          verificationSuggested: result.verificationSuggested,
        });
      },
    );

    // ------------------------------------------------ a need, no damage report
    /**
     * NED-02/03: a household that needs help but has no damage to report (or
     * not yet). Categories, a place in any form, how to reach them and consent
     * per organization type, through the same queue as a report; the worker
     * files needs with their own reference code and the partner grants follow.
     */
    const needsOnlySchema = z.object({
      executionId: z.uuid(),
      language: z.string().min(2).max(10).default('en'),
      needs: z.array(z.string().max(60)).min(1).max(20),
      note: z.string().max(500).optional(),
      address: z.record(z.string(), z.string().max(500)).optional(),
      contactName: z.string().max(200).optional(),
      contact: z.object({
        phone: z.string().max(40).optional(),
        email: z.string().max(200).optional(),
        preferred: z.string().max(20).optional(),
      }),
      consent: z.record(z.string(), z.boolean()).default({}),
      smsOptIn: z.boolean().default(false),
    });
    app.post(
      '/needs/:tenant/:event',
      {
        config: { idempotent: true },
        schema: { tags: ['public needs'], params: tenantEventParam, body: needsOnlySchema },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const body = request.body;
        if (request.executionId !== body.executionId)
          throw new ApiError(
            400,
            'execution_id_mismatch',
            'The Idempotency-Key must equal executionId.',
          );
        if (!body.contact.phone && !body.contact.email)
          throw errors.validation([
            { name: 'contact', message: 'a phone number or an email address is needed' },
          ]);
        await request.authorize('need.create_public', { type: 'need', tenantId: tenant.id });
        const graph = await request.tx((trx) =>
          loadGraph(trx, deps.defaultGraph.key, undefined, deps.defaultGraph),
        );
        const contact: Record<string, string> = {};
        if (body.contact.phone) contact['phone'] = body.contact.phone;
        if (body.contact.email) contact['email'] = body.contact.email;
        if (body.contact.preferred) contact['preferred'] = body.contact.preferred;
        const result = await submitIntake(submitDeps, request, {
          tenantId: tenant.id,
          eventSlug: request.params.event,
          needsOnly: true,
          body: {
            executionId: body.executionId,
            channel: 'web',
            language: body.language,
            graphKey: graph.key,
            graphVersion: graph.version,
            relationship: 'own_home',
            answers: {
              contact: { kind: 'value', value: contact },
              ...(body.contactName
                ? { contact_name: { kind: 'value', value: body.contactName } }
                : {}),
              ...(body.address ? { address: { kind: 'value', value: body.address } } : {}),
            },
            ...(body.note ? { ownWords: body.note } : {}),
            needs: body.needs,
            consent: body.consent,
            photoIds: [],
            afterSubmission: {},
            smsOptIn: body.smsOptIn,
            aiAssisted: false,
          },
        });
        return reply.code(202).send({ referenceCode: result.referenceCode, status: result.status });
      },
    );

    // --------------------------------------------- after the report is saved
    /** "Text this number to me" on the confirmation screen (INT-22, ACC-30): up to three times, within a day. */
    app.post(
      '/intake/:tenant/submissions/:executionId/text-code',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam.extend({ executionId: z.uuid() }),
          body: z.object({
            phone: z.string().min(7).max(30),
            language: z.string().min(2).max(10).default('en'),
          }),
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        guessLookups(request);
        await request.authorize('intake.submit', { type: 'report', tenantId: tenant.id });
        const phone = normalisePhone(request.body.phone);
        const executionId = request.params.executionId;
        await request.tx(async (trx) => {
          const row = await trx
            .selectFrom('cg.intake_submission')
            .select(['reference_code', 'received_at', 'confirmation_texts'])
            .where('execution_id', '=', executionId)
            .executeTakeFirst();
          // The answer is the same whether or not anything matched (RULE-17).
          if (
            !row ||
            row.received_at.getTime() < now().getTime() - 24 * 3600_000 ||
            row.confirmation_texts >= 3
          )
            return;
          await trx
            .updateTable('cg.intake_submission')
            .set({ confirmation_texts: row.confirmation_texts + 1 })
            .where('execution_id', '=', executionId)
            .execute();
          await enqueueOutbox(
            trx,
            tenant.id,
            'message.send',
            {
              template: 'confirmation',
              channel: 'sms',
              toEnc: (await app.fieldCrypto.encrypt(tenant.id, phone)).toString('base64'),
              language: request.body.language,
              variables: { referenceCode: row.reference_code },
            },
            null,
          );
          await request.audit(trx, {
            action: 'intake.text_code',
            targetType: 'intake_submission',
            targetId: executionId,
            changes: { fields: [{ name: 'texts', to: row.confirmation_texts + 1 }] },
          });
        });
        return reply.code(202).send({ status: 'sent' });
      },
    );

    /** Optional questions answered after the report is safely saved (INT-19, EQ-13). */
    app.post(
      '/intake/:tenant/submissions/:executionId/after',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam.extend({ executionId: z.uuid() }),
          body: z.object({
            graphKey: z.string().min(1),
            graphVersion: z.number().int().positive(),
            answers: z.record(z.string(), answerValueSchema),
          }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.submit', { type: 'report', tenantId: tenant.id });
        const executionId = request.params.executionId;
        return request.tx(async (trx) => {
          const row = await trx
            .selectFrom('cg.intake_submission')
            .select(['execution_id'])
            .where('execution_id', '=', executionId)
            .executeTakeFirst();
          if (!row) throw errors.notFound();
          const graph = await loadGraph(
            trx,
            request.body.graphKey,
            request.body.graphVersion,
            deps.defaultGraph,
          );
          const after = new Map(graph.afterSubmission.map((q) => [q.id, q]));
          const fields: { name: string; message: string }[] = [];
          for (const [id, value] of Object.entries(request.body.answers)) {
            const q = after.get(id);
            if (!q) fields.push({ name: id, message: 'unknown question' });
            else
              for (const e of validateAnswer(q, value))
                fields.push({ name: id, message: e.message });
          }
          if (fields.length > 0)
            throw new ApiError(400, 'validation_failed', 'Some answers need another look.', {
              fields,
            });
          const answers = request.body.answers;
          await trx
            .updateTable('cg.intake_submission')
            .set({
              after_enc: await app.fieldCrypto.encrypt(tenant.id, JSON.stringify(answers)),
              after_merged_at: null,
            })
            .where('execution_id', '=', executionId)
            .execute();
          // Filed already? Then the answers go straight onto the report; otherwise the worker merges them.
          const report = await trx
            .selectFrom('cg.report')
            .select('id')
            .where('execution_id', '=', executionId)
            .executeTakeFirst();
          if (report) {
            await upsertAfterAnswers(trx, {
              tenantId: tenant.id,
              reportId: report.id,
              answers,
              isRestricted: (id) => after.get(id)?.classification === 'restricted',
              encrypt: (text) => app.fieldCrypto.encrypt(tenant.id, text),
            });
            await trx
              .updateTable('cg.intake_submission')
              .set({ after_merged_at: now() })
              .where('execution_id', '=', executionId)
              .execute();
          }
          await request.audit(trx, {
            action: 'intake.after_answers',
            targetType: 'intake_submission',
            targetId: executionId,
            changes: { fields: [{ name: 'answers', to: Object.keys(answers).length }] },
          });
          return { status: report ? 'saved' : 'queued' };
        });
      },
    );

    // ------------------------------------------------------------ extraction
    app.post(
      '/intake/:tenant/extract',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({
            executionId: z.uuid(),
            text: z.string().min(1).max(10_000),
            language: z.string().min(2).max(10).optional(),
            graphKey: z.string().min(1),
            graphVersion: z.number().int().positive(),
          }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.extract', { type: 'extraction', tenantId: tenant.id });
        // INT-16: without AI the same graph runs; the client gets an honest "off" and continues.
        const off = () =>
          new ApiError(
            409,
            'ai_off',
            'Help from a computer is switched off here. Please answer the questions directly.',
          );
        if (!deps.ai) throw off();
        // The provider is called outside any transaction: a slow reply holds no connection.
        const setup = await request.tx(async (trx) => {
          const feature = await trx
            .selectFrom('cg.ai_use_register')
            .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
            .select(['enabled', 'provider'])
            .where('feature', '=', 'intake.extraction')
            .executeTakeFirst();
          if (!feature?.enabled) throw off();
          const provider = await deps.ai!.providerFor(tenant.id, trx);
          if (!provider?.llm || provider.info.provider !== feature.provider) throw off();
          const graph = await loadGraph(
            trx,
            request.body.graphKey,
            request.body.graphVersion,
            deps.defaultGraph,
          );
          return { provider, llm: provider.llm, graph };
        });
        const { text } = redact(request.body.text); // AIG-05
        const call = await callAi(() =>
          setup.llm.extract({
            text,
            ...(request.body.language ? { language: request.body.language } : {}),
            questions: extractionQuestions(setup.graph),
          }),
        );
        if (!call.ok) {
          // AI-10: a failed call is recorded and the resident answers directly.
          await request.tx((trx) =>
            recordAiOutput(trx, {
              tenantId: tenant.id,
              feature: 'intake.extraction',
              provider: setup.provider.info,
              outcome: call.outcome,
              latencyMs: call.latencyMs,
              language: request.body.language ?? null,
              executionId: request.body.executionId,
            }),
          );
          throw new ApiError(
            409,
            'ai_unavailable',
            'Help from a computer is not available right now. Please answer the questions directly.',
          );
        }
        return request.tx(async (trx) => {
          const out = call.out;
          const valid = validateExtraction(setup.graph, out.output); // AIG-03
          const row = await trx
            .insertInto('cg.extraction')
            .values({
              tenant_id: tenant.id,
              execution_id: request.body.executionId,
              input_hash: sha([request.body.text]),
              provider: out.provider.provider,
              model: out.provider.model,
              output: JSON.stringify({
                candidates: valid.candidates,
                language: valid.language ?? null,
                injectionSuspected: valid.injectionSuspected,
              }),
              filtered_reasons: valid.dropped.map((d) => `${d.questionId}:${d.reason}`),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          // AIG-01: the call's record; the resident's choices later say whether it helped.
          await recordAiOutput(trx, {
            tenantId: tenant.id,
            feature: 'intake.extraction',
            provider: out.provider,
            outcome: valid.dropped.length > 0 ? 'filtered' : 'ok',
            latencyMs: out.latencyMs,
            language: valid.language ?? request.body.language ?? null,
            executionId: request.body.executionId,
            targetType: 'extraction',
            targetId: row.id,
          });
          await request.audit(trx, {
            action: 'intake.extract',
            targetType: 'extraction',
            targetId: row.id,
            changes: {
              fields: [
                { name: 'provider', to: `${out.provider.provider}/${out.provider.model}` },
                { name: 'candidates', to: valid.candidates.length },
                { name: 'injection_suspected', to: valid.injectionSuspected },
                { name: 'latency_ms', to: out.latencyMs },
              ],
            },
          });
          return {
            extractionId: row.id,
            candidates: valid.candidates,
            language: valid.language ?? null,
            injectionSuspected: valid.injectionSuspected,
            provider: out.provider,
            // AIG-10: the resident is told plainly; the client shows this and the off switch.
            notice: 'A computer helped fill in these answers. Please check them.',
          };
        });
      },
    );

    // --------------------------------------------------------------- drafts
    app.post(
      '/intake/:tenant/drafts',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({ executionId: z.uuid(), payload: z.unknown() }),
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.draft', { type: 'draft', tenantId: tenant.id });
        const json = JSON.stringify(request.body.payload ?? {});
        if (json.length > 65_536)
          throw new ApiError(413, 'draft_too_large', 'This draft is too large to save.');
        const code = randomDraftCode();
        const days =
          (await request.tx((trx) => configValue<number>(trx, 'intake.draft_days'))) ?? 7;
        const expiresAt = new Date(now().getTime() + days * 86_400_000);
        const payloadEnc = await app.fieldCrypto.encrypt(tenant.id, json);
        await request.tx(async (trx) => {
          await trx
            .insertInto('cg.draft')
            .values({
              tenant_id: tenant.id,
              resume_code_hash: sha([tenant.id, 'draft', code]),
              execution_id: request.body.executionId,
              payload_enc: payloadEnc,
              expires_at: expiresAt,
            })
            .execute();
          await request.audit(trx, {
            action: 'intake.draft',
            targetType: 'draft',
            targetId: request.body.executionId,
          });
        });
        return reply.code(201).send({ resumeCode: code, expiresAt: expiresAt.toISOString() });
      },
    );

    app.get(
      '/intake/:tenant/drafts/:code',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam.extend({ code: z.string().min(6).max(8) }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        guessLookups(request);
        await request.authorize('intake.draft', { type: 'draft', tenantId: tenant.id });
        const code = request.params.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const row = await request.tx((trx) =>
          trx
            .selectFrom('cg.draft')
            .select(['execution_id', 'payload_enc', 'expires_at'])
            .where('resume_code_hash', '=', sha([tenant.id, 'draft', code]))
            .where('expires_at', '>', now())
            .where('consumed_at', 'is', null)
            .executeTakeFirst(),
        );
        if (!row) throw errors.notFound();
        const payload = JSON.parse(
          await app.fieldCrypto.decrypt(tenant.id, row.payload_enc),
        ) as unknown;
        return { executionId: row.execution_id, payload, expiresAt: row.expires_at.toISOString() };
      },
    );

    // --------------------------------------------------------------- photos
    app.post(
      '/intake/:tenant/photos',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({
            executionId: z.uuid(),
            shot: z.string().min(1).max(40).default('other'),
            contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
            bytes: z.number().int().positive(),
            /** Read on the device from the picture's own data before it was stripped (PHO-06); suggestions only. */
            takenAt: z.iso.datetime().optional(),
            location: z
              .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
              .optional(),
          }),
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.upload', { type: 'photo', tenantId: tenant.id });
        const objects = deps.objects;
        if (!objects)
          throw new ApiError(
            503,
            'photos_unavailable',
            'Photos cannot be uploaded right now. Your report can still be sent without them.',
            { retryable: true },
          );
        if (request.body.bytes > objects.maxBytes)
          throw new ApiError(
            413,
            'photo_too_large',
            `Photos must be under ${Math.round(objects.maxBytes / 1_048_576)} MB.`,
          );
        const photo = await request.tx(async (trx) => {
          const count = await trx
            .selectFrom('cg.photo')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('execution_id', '=', request.body.executionId)
            .executeTakeFirst();
          if (Number(count?.n ?? 0) >= 30)
            throw new ApiError(
              429,
              'too_many_photos',
              'That is as many photos as one report can take.',
            );
          const row = await trx
            .insertInto('cg.photo')
            .values({
              tenant_id: tenant.id,
              execution_id: request.body.executionId,
              shot: request.body.shot,
              source: 'web',
              object_key_original: '',
              content_type: request.body.contentType,
              bytes: request.body.bytes,
              suggested_taken_at: request.body.takenAt ? new Date(request.body.takenAt) : null,
              suggested_geom: request.body.location
                ? sql`ST_SetSRID(ST_MakePoint(${request.body.location.lon}, ${request.body.location.lat}), 4326)`
                : null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const key = `tenants/${tenant.id}/originals/${request.body.executionId}/${row.id}`;
          await trx
            .updateTable('cg.photo')
            .set({ object_key_original: key })
            .where('id', '=', row.id)
            .execute();
          return { id: row.id, key };
        });
        const expiresIn = 900;
        const uploadUrl = await getSignedUrl(
          // The presigner's client type predates exactOptionalPropertyTypes; the runtime object is the same.
          (objects.presignClient ?? objects.client) as unknown as Parameters<
            typeof getSignedUrl
          >[0],
          new PutObjectCommand({
            Bucket: objects.bucket,
            Key: photo.key,
            ContentType: request.body.contentType,
            ContentLength: request.body.bytes,
          }),
          { expiresIn },
        );
        return reply.code(201).send({
          photoId: photo.id,
          method: 'PUT',
          uploadUrl,
          headers: { 'Content-Type': request.body.contentType },
          expiresAt: new Date(now().getTime() + expiresIn * 1000).toISOString(),
        });
      },
    );

    // Same-origin fallback for the direct upload (SCL-04, SCL-06): a browser that cannot
    // reach the objects host (another host name, its certificate, a strict network) sends
    // the bytes through the gateway instead. The ticket's photo id and execution id are the
    // credentials, the size cap is the same, and completion is the same call as before.
    const uploadBodyLimit = (deps.objects?.maxBytes ?? 6 * 1024 * 1024) + 1024;
    app.addContentTypeParser(
      ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
      { parseAs: 'buffer', bodyLimit: uploadBodyLimit },
      (_req, body, done) => done(null, body),
    );
    app.put(
      '/intake/:tenant/photos/:id/content',
      {
        bodyLimit: uploadBodyLimit,
        schema: {
          tags: ['public intake'],
          params: tenantParam.extend({ id: z.uuid() }),
          querystring: z.object({ executionId: z.uuid() }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.upload', { type: 'photo', tenantId: tenant.id });
        const objects = deps.objects;
        if (!objects)
          throw new ApiError(503, 'photos_unavailable', 'Photos cannot be uploaded right now.', {
            retryable: true,
          });
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0)
          throw new ApiError(
            400,
            'validation_failed',
            'Send the photo itself as the request body.',
          );
        if (body.length > objects.maxBytes)
          throw new ApiError(
            413,
            'photo_too_large',
            `Photos must be under ${Math.round(objects.maxBytes / 1_048_576)} MB.`,
          );
        const row = await request.tx((trx) =>
          trx
            .selectFrom('cg.photo')
            .select(['id', 'object_key_original', 'status', 'content_type'])
            .where('id', '=', request.params.id)
            .where('execution_id', '=', request.query.executionId)
            .executeTakeFirst(),
        );
        if (!row) throw errors.notFound();
        if (row.status !== 'uploading') return { photoId: row.id, status: row.status };
        await objects.client.send(
          new PutObjectCommand({
            Bucket: objects.bucket,
            Key: row.object_key_original,
            Body: body,
            ...(row.content_type ? { ContentType: row.content_type } : {}),
          }),
        );
        return { photoId: row.id, status: 'stored' };
      },
    );

    app.post(
      '/intake/:tenant/photos/:id/complete',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam.extend({ id: z.uuid() }),
          body: z.object({ executionId: z.uuid() }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.upload', { type: 'photo', tenantId: tenant.id });
        const objects = deps.objects;
        if (!objects)
          throw new ApiError(503, 'photos_unavailable', 'Photos cannot be uploaded right now.', {
            retryable: true,
          });
        const row = await request.tx((trx) =>
          trx
            .selectFrom('cg.photo')
            .select(['id', 'object_key_original', 'status', 'bytes'])
            .where('id', '=', request.params.id)
            .where('execution_id', '=', request.body.executionId)
            .executeTakeFirst(),
        );
        if (!row) throw errors.notFound();
        if (row.status !== 'uploading') return { photoId: row.id, status: row.status };
        const head = await objects.client
          .send(new HeadObjectCommand({ Bucket: objects.bucket, Key: row.object_key_original }))
          .catch(() => null);
        if (!head)
          throw new ApiError(409, 'upload_incomplete', 'The photo has not finished uploading.', {
            retryable: true,
          });
        if ((head.ContentLength ?? 0) > objects.maxBytes) {
          await request.tx((trx) =>
            trx
              .updateTable('cg.photo')
              .set({ status: 'rejected' })
              .where('id', '=', row.id)
              .execute(),
          );
          throw new ApiError(413, 'photo_too_large', 'That photo is too large.');
        }
        await request.tx(async (trx) => {
          await trx
            .updateTable('cg.photo')
            .set({ status: 'uploaded', bytes: head.ContentLength ?? row.bytes, uploaded_at: now() })
            .where('id', '=', row.id)
            .execute();
          await enqueueOutbox(
            trx,
            tenant.id,
            'photo.process',
            { photoId: row.id },
            request.body.executionId,
          );
          await request.audit(trx, {
            action: 'intake.upload',
            targetType: 'photo',
            targetId: row.id,
          });
        });
        return { photoId: row.id, status: 'uploaded' };
      },
    );

    // --------------------------------------------------------------- lookup
    app.post(
      '/intake/:tenant/lookup/start',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({
            referenceCode: z.string().min(8).max(12),
            contact: z.string().min(3).max(200),
          }),
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        guessLookups(request);
        await request.authorize('intake.lookup', { type: 'report', tenantId: tenant.id });
        const code = normaliseCode(request.body.referenceCode);
        // The answer is the same whether or not anything matched (RULE-17).
        const generic = {
          status: 'sent',
          message: 'If the details match a report, a code is on its way.',
        };
        if (!code) return reply.code(202).send(generic);
        const raw = request.body.contact.trim();
        const isEmail = raw.includes('@');
        const value = isEmail ? raw.toLowerCase() : normalisePhone(raw);
        const bidx = await app.fieldCrypto.blindIndex(
          tenant.id,
          isEmail ? 'email' : 'phone',
          value,
        );
        await request.tx(async (trx) => {
          const match = await trx
            .selectFrom('cg.report')
            .innerJoin('cg.party', 'cg.party.id', 'cg.report.reporter_party_id')
            .select([
              'cg.report.id as report_id',
              'cg.party.contact_enc as contact_enc',
              'cg.party.language as language',
            ])
            .where('cg.report.reference_code', '=', code)
            .where(isEmail ? 'cg.party.email_bidx' : 'cg.party.phone_bidx', '=', bidx)
            .executeTakeFirst();
          if (!match) return;
          const otp = otpCode();
          await trx
            .insertInto('cg.otp_challenge')
            .values({
              tenant_id: tenant.id,
              report_id: match.report_id,
              contact_bidx: bidx,
              channel: isEmail ? 'email' : 'sms',
              code_hash: sha([tenant.id, match.report_id, otp]),
              expires_at: new Date(now().getTime() + 10 * 60_000),
            })
            .execute();
          const toEnc = await app.fieldCrypto.encrypt(tenant.id, value);
          await enqueueOutbox(
            trx,
            tenant.id,
            'message.send',
            {
              template: 'otp',
              channel: isEmail ? 'email' : 'sms',
              toEnc: toEnc.toString('base64'),
              language: match.language,
              reportId: match.report_id,
              variables: { code: otp },
            },
            null,
          );
          await request.audit(trx, {
            action: 'intake.lookup',
            targetType: 'report',
            targetId: match.report_id,
            changes: { fields: [{ name: 'otp', to: 'sent' }] },
          });
        });
        return reply.code(202).send(generic);
      },
    );

    app.post(
      '/intake/:tenant/lookup/verify',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({
            referenceCode: z.string().min(8).max(12),
            code: z.string().regex(/^\d{6}$/),
          }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        guessLookups(request);
        await request.authorize('intake.lookup', { type: 'report', tenantId: tenant.id });
        const code = normaliseCode(request.body.referenceCode);
        const fail = () =>
          new ApiError(
            401,
            'code_invalid',
            'That code did not match. Check it and try again, or ask for a new one.',
          );
        if (!code) throw fail();
        const result = await request.tx(async (trx) => {
          const report = await trx
            .selectFrom('cg.report')
            .select('id')
            .where('reference_code', '=', code)
            .executeTakeFirst();
          if (!report) return null;
          const challenge = await trx
            .selectFrom('cg.otp_challenge')
            .select(['id', 'code_hash', 'attempts'])
            .where('report_id', '=', report.id)
            .where('consumed_at', 'is', null)
            .where('expires_at', '>', now())
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst();
          if (!challenge || challenge.attempts >= 5) return null;
          const ok = challenge.code_hash.equals(sha([tenant.id, report.id, request.body.code]));
          await trx
            .updateTable('cg.otp_challenge')
            .set(
              ok
                ? { consumed_at: now(), attempts: challenge.attempts + 1 }
                : { attempts: challenge.attempts + 1 },
            )
            .where('id', '=', challenge.id)
            .execute();
          if (!ok) return null;
          await request.audit(trx, {
            action: 'intake.lookup',
            targetType: 'report',
            targetId: report.id,
            changes: { fields: [{ name: 'otp', to: 'verified' }] },
          });
          return report.id;
        });
        if (!result) throw fail();
        const exp = Math.floor(now().getTime() / 1000) + 30 * 60;
        return {
          token: signResidentToken(deps.residentTokenSecret, {
            tenantId: tenant.id,
            reportId: result,
            exp,
          }),
          expiresAt: new Date(exp * 1000).toISOString(),
        };
      },
    );

    // ------------------------------------------------------------ my report
    function residentOf(request: FastifyRequest, tenantId: string): string {
      const header = request.headers['x-resident-token'];
      const claims =
        typeof header === 'string'
          ? verifyResidentToken(deps.residentTokenSecret, header, now().getTime())
          : null;
      if (!claims || claims.tenantId !== tenantId)
        throw errors.unauthorized('resident_token_invalid');
      const s = request.subject;
      if (s.kind === 'public') request.subject = { ...s, resident: { reportId: claims.reportId } };
      return claims.reportId;
    }

    const RESIDENT_STATE: Record<string, string> = {
      submitted: 'received',
      under_review: 'being_reviewed',
      needs_information: 'needs_your_answer',
      approved: 'reviewed',
      rejected: 'not_accepted',
      duplicate: 'already_reported',
      superseded: 'replaced',
    };

    app.get(
      '/intake/:tenant/me',
      { schema: { tags: ['public intake'], params: tenantParam } },
      async (request) => {
        const tenant = tenantOf(request);
        const reportId = residentOf(request, tenant.id);
        await request.authorize('report.self_read', {
          type: 'report',
          id: reportId,
          tenantId: tenant.id,
        });
        return request.tx(async (trx) => {
          const report = await trx
            .selectFrom('cg.report')
            .select([
              'id',
              'reference_code',
              'submitted_at',
              'review_state',
              'verification_level',
              'withdrawn_at',
              'reporter_party_id',
              'relationship',
              'version',
            ])
            .where('id', '=', reportId)
            .executeTakeFirst();
          if (!report) throw errors.notFound();
          const needs = await trx
            .selectFrom('cg.need')
            .select(['id', 'category', 'status'])
            .where('report_id', '=', reportId)
            .execute();
          const consent = report.reporter_party_id
            ? await trx
                .selectFrom('cg.consent')
                .select(['org_type', 'granted'])
                .where('party_id', '=', report.reporter_party_id)
                .execute()
            : [];
          const corrections = await trx
            .selectFrom('cg.correction_request')
            .select(['id', 'questions', 'message', 'requested_at'])
            .where('report_id', '=', reportId)
            .where('answered_at', 'is', null)
            .execute();
          await request.audit(trx, {
            action: 'report.self_read',
            targetType: 'report',
            targetId: reportId,
          });
          return {
            referenceCode: report.reference_code,
            submittedAt: report.submitted_at.toISOString(),
            status: RESIDENT_STATE[report.review_state] ?? report.review_state,
            verification: report.verification_level,
            withdrawnAt: report.withdrawn_at?.toISOString() ?? null,
            version: report.version,
            needs: needs.map((n) => ({ id: n.id, category: n.category, status: n.status })),
            consent: Object.fromEntries(consent.map((c) => [c.org_type, c.granted])),
            openQuestions: corrections.map((c) => ({
              id: c.id,
              questions: c.questions,
              message: c.message,
              askedAt: c.requested_at.toISOString(),
            })),
          };
        });
      },
    );

    // FL:FR-32: the resident's own copy, to keep or send to their insurer (English or Spanish).
    app.get(
      '/intake/:tenant/me/export.pdf',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          querystring: z.object({ lang: z.string().min(2).max(10).default('en') }),
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const reportId = residentOf(request, tenant.id);
        await request.authorize('report.self_read', {
          type: 'report',
          id: reportId,
          tenantId: tenant.id,
        });
        const lang = langOf(request.query.lang);
        const input = await request.tx(async (trx) => {
          const found = await loadResidentCopy(
            trx,
            { crypto: app.fieldCrypto, objects: deps.objects, defaultGraph: deps.defaultGraph },
            { tenantId: tenant.id, tenantName: tenant.name, reportId, lang, now: now() },
          );
          if (!found) throw errors.notFound();
          await request.audit(trx, {
            action: 'report.self_export',
            targetType: 'report',
            targetId: reportId,
            changes: { lang, photos: found.photos.length },
          });
          return found;
        });
        const pdf = await renderPdf(residentCopyPdf({ ...input, producer: tenant.name }));
        return reply
          .header('content-type', 'application/pdf')
          .header(
            'content-disposition',
            `attachment; filename="damage-report-${input.referenceCode}.pdf"`,
          )
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .send(pdf);
      },
    );

    app.patch(
      '/intake/:tenant/me/consent',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({ orgType: z.string().min(1).max(60), granted: z.boolean() }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        const reportId = residentOf(request, tenant.id);
        await request.authorize('report.self_update', {
          type: 'report',
          id: reportId,
          tenantId: tenant.id,
        });
        await request.tx(async (trx) => {
          const report = await trx
            .selectFrom('cg.report')
            .select(['reporter_party_id'])
            .where('id', '=', reportId)
            .executeTakeFirst();
          if (!report?.reporter_party_id) throw errors.notFound();
          const existing = await trx
            .selectFrom('cg.consent')
            .select(['id', 'granted'])
            .where('party_id', '=', report.reporter_party_id)
            .where('org_type', '=', request.body.orgType)
            .where('report_id', '=', reportId)
            .executeTakeFirst();
          const stamp = request.body.granted
            ? { granted: true, granted_at: now(), withdrawn_at: null }
            : { granted: false, withdrawn_at: now() };
          if (existing)
            await trx
              .updateTable('cg.consent')
              .set({ ...stamp, channel: 'web' })
              .where('id', '=', existing.id)
              .execute();
          else
            await trx
              .insertInto('cg.consent')
              .values({
                tenant_id: tenant.id,
                party_id: report.reporter_party_id,
                report_id: reportId,
                org_type: request.body.orgType,
                ...stamp,
                channel: 'web',
              })
              .execute();
          await request.audit(trx, {
            action: 'report.self_update',
            targetType: 'consent',
            targetId: reportId,
            changes: {
              fields: [
                {
                  name: request.body.orgType,
                  from: existing?.granted ?? false,
                  to: request.body.granted,
                },
              ],
            },
          });
          await enqueueOutbox(
            trx,
            tenant.id,
            'consent.changed',
            { reportId, orgType: request.body.orgType, granted: request.body.granted },
            null,
          );
        });
        return { orgType: request.body.orgType, granted: request.body.granted };
      },
    );

    app.post(
      '/intake/:tenant/me/corrections',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({
            answers: z.record(z.string(), answerValueSchema).default({}),
            ownWords: z.string().max(10_000).optional(),
            message: z.string().max(2000).optional(),
            correctionRequestId: z.uuid().optional(),
          }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        const reportId = residentOf(request, tenant.id);
        await request.authorize('report.self_update', {
          type: 'report',
          id: reportId,
          tenantId: tenant.id,
        });
        return request.tx(async (trx) => {
          const report = await trx
            .selectFrom('cg.report')
            .selectAll()
            .where('id', '=', reportId)
            .executeTakeFirst();
          if (!report) throw errors.notFound();
          if (report.withdrawn_at)
            throw new ApiError(409, 'report_withdrawn', 'This report was withdrawn.');
          const graph = await loadGraph(
            trx,
            report.graph_key,
            report.graph_version,
            deps.defaultGraph,
          );
          const questions = new Map(
            graph.nodes
              .filter((n): n is QuestionNode => n.kind === 'question')
              .map((q) => [q.id, q]),
          );
          const fields: { name: string; message: string }[] = [];
          for (const [id, value] of Object.entries(request.body.answers)) {
            const q = questions.get(id);
            if (!q) fields.push({ name: id, message: 'unknown question' });
            else
              for (const e of validateAnswer(q, value))
                fields.push({ name: id, message: e.message });
          }
          if (fields.length > 0)
            throw new ApiError(400, 'validation_failed', 'Some answers need another look.', {
              fields,
            });

          // Snapshot the current version, then apply (RES-02, RULE-09).
          await trx
            .insertInto('cg.report_version')
            .values({
              tenant_id: tenant.id,
              report_id: reportId,
              report_version: report.version,
              snapshot: JSON.stringify({
                answers: report.answers,
                review_state: report.review_state,
                verification_level: report.verification_level,
                fema_degree: report.fema_degree,
                location_id: report.location_id,
              }),
              changed_by_kind: 'resident',
              reason: request.body.message ?? 'resident correction',
            })
            .onConflict((oc) => oc.doNothing())
            .execute();
          const clear: Record<string, unknown> = { ...(report.answers as Record<string, unknown>) };
          const restricted: Record<string, unknown> = report.answers_enc
            ? (JSON.parse(await app.fieldCrypto.decrypt(tenant.id, report.answers_enc)) as Record<
                string,
                unknown
              >)
            : {};
          for (const [id, value] of Object.entries(request.body.answers)) {
            if (questions.get(id)?.classification === 'restricted') restricted[id] = value;
            else clear[id] = value;
          }
          const reopened =
            report.review_state === 'approved' || report.review_state === 'needs_information';
          await trx
            .updateTable('cg.report')
            .set({
              answers: JSON.stringify(clear),
              answers_enc:
                Object.keys(restricted).length > 0
                  ? await app.fieldCrypto.encrypt(tenant.id, JSON.stringify(restricted))
                  : report.answers_enc,
              ...(request.body.ownWords !== undefined
                ? {
                    original_text_enc: await app.fieldCrypto.encrypt(
                      tenant.id,
                      request.body.ownWords,
                    ),
                  }
                : {}),
              ...(reopened ? { review_state: 'submitted' } : {}),
            })
            .where('id', '=', reportId)
            .where('version', '=', report.version)
            .execute();
          if (request.body.correctionRequestId) {
            await trx
              .updateTable('cg.correction_request')
              .set({ answered_at: now(), resolution: 'answered' })
              .where('id', '=', request.body.correctionRequestId)
              .where('report_id', '=', reportId)
              .execute();
          }
          await request.audit(trx, {
            action: 'report.self_update',
            targetType: 'report',
            targetId: reportId,
            targetVersion: report.version,
            changes: {
              fields: Object.keys(request.body.answers).map((name) => ({
                name,
                to: '(corrected)',
              })),
            },
            reason: reopened
              ? 'changed after approval: back to review (RULE-09)'
              : 'resident correction',
          });
          await enqueueOutbox(trx, tenant.id, 'report.corrected', { reportId, reopened }, null);
          return {
            status: reopened
              ? 'received'
              : (RESIDENT_STATE[report.review_state] ?? report.review_state),
            version: report.version + 1,
          };
        });
      },
    );

    app.post(
      '/intake/:tenant/me/withdraw',
      {
        schema: {
          tags: ['public intake'],
          params: tenantParam,
          body: z.object({ reason: z.string().max(500).optional() }),
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        const reportId = residentOf(request, tenant.id);
        await request.authorize('report.self_update', {
          type: 'report',
          id: reportId,
          tenantId: tenant.id,
        });
        await request.tx(async (trx) => {
          const report = await trx
            .selectFrom('cg.report')
            .select(['version', 'withdrawn_at', 'answers', 'review_state'])
            .where('id', '=', reportId)
            .executeTakeFirst();
          if (!report) throw errors.notFound();
          if (report.withdrawn_at) return;
          await trx
            .insertInto('cg.report_version')
            .values({
              tenant_id: tenant.id,
              report_id: reportId,
              report_version: report.version,
              snapshot: JSON.stringify({
                answers: report.answers,
                review_state: report.review_state,
              }),
              changed_by_kind: 'resident',
              reason: request.body.reason ?? 'withdrawn by resident',
            })
            .onConflict((oc) => oc.doNothing())
            .execute();
          await trx
            .updateTable('cg.report')
            .set({ withdrawn_at: now() })
            .where('id', '=', reportId)
            .execute();
          await trx
            .updateTable('cg.need')
            .set({ status: 'withdrawn' })
            .where('report_id', '=', reportId)
            .where('status', 'in', ['open', 'claimed'])
            .execute();
          await request.audit(trx, {
            action: 'report.self_update',
            targetType: 'report',
            targetId: reportId,
            reason: `withdrawn: ${request.body.reason ?? ''}`,
          });
          await enqueueOutbox(trx, tenant.id, 'report.withdrawn', { reportId }, null);
        });
        return { status: 'withdrawn' };
      },
    );
  };
