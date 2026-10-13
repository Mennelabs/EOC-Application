/**
 * The one submission path for every channel (CHN-01, BRD:FR-11.01/11.04,
 * AC-11B, SCL-03/06, SEC-17): validate the answers against the graph, score
 * abuse risk, encrypt the payload, lease a reference code, publish to the
 * intake queue with publisher confirms and keep the database copy as the
 * durable fallback. The web route, the text and voice sessions and assisted
 * intake all end here, so one report record exists whatever the channel.
 */
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { QueueConnection } from '@cg/adapters';
import type { AuditInput } from '@cg/audit';
import type { FieldCrypto } from '@cg/crypto';
import { normalisePhone } from '@cg/crypto';
import type { Database } from '@cg/db';
import {
  hazardsForEvent,
  isAsked,
  parseGraph,
  validateAnswer,
  visibleNodes,
  type AnswerValue,
  type Answers,
  type Hazard,
  type QuestionGraph,
  type QuestionNode,
  type SessionContext,
} from '@cg/intake';
import { ApiError } from '../errors.ts';
import { RiskScorer, type RiskResult } from './abuse.ts';
import type { ReferenceCodeLeaser } from './reference-codes.ts';

export const INTAKE_QUEUE = 'intake.submissions';

/** Event hazard types (CON-02 templates) → graph hazards that open branches. */
export function hazardsFor(eventHazard: string): Hazard[] {
  return hazardsForEvent(eventHazard);
}

export const answerValueSchema: z.ZodType<AnswerValue> = z.union([
  z.object({ kind: z.literal('unknown') }),
  z.object({ kind: z.literal('skipped') }),
  z.object({
    kind: z.literal('value'),
    value: z.union([
      z.string().max(4000),
      z.array(z.string().max(200)).max(50),
      z.number(),
      z.boolean(),
      z.record(z.string(), z.string().max(500)),
    ]),
  }),
]);

export const submissionSchema = z.object({
  executionId: z.uuid(),
  channel: z.enum(['web', 'assisted']).default('web'),
  language: z.string().min(2).max(10).default('en'),
  graphKey: z.string().min(1),
  graphVersion: z.number().int().positive(),
  relationship: z.enum(['own_home', 'helper', 'witness', 'organization']),
  answers: z.record(z.string(), answerValueSchema),
  ownWords: z.string().max(10_000).optional(),
  needs: z.array(z.string().max(60)).max(20).default([]),
  consent: z.record(z.string(), z.boolean()).default({}),
  photoIds: z.array(z.uuid()).max(30).default([]),
  afterSubmission: z.record(z.string(), answerValueSchema).default({}),
  smsOptIn: z.boolean().default(false),
  aiAssisted: z.boolean().default(false),
  extractionId: z.uuid().optional(),
  /** Assisted mode: who helped and whether the affected person agreed (CHN-06). */
  assisted: z
    .object({ helperAccountId: z.uuid().optional(), consentRecorded: z.boolean() })
    .optional(),
});
export type SubmissionBody = z.infer<typeof submissionSchema>;

/** What a channel hands to the submission path: the web body, or the same from a text or voice session. */
export type SubmitBody = Omit<SubmissionBody, 'channel'> & {
  channel: 'web' | 'assisted' | 'sms' | 'voice';
};

export interface IntakeQueueMessage {
  v: 1;
  tenantId: string;
  executionId: string;
  referenceCode: string;
  eventId: string | null;
  channel: SubmitBody['channel'];
  payloadEnc: string;
}

export function sha(parts: string[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\u0000');
  return h.digest();
}

export async function configValue<T>(
  trx: Transaction<Database>,
  key: string,
): Promise<T | undefined> {
  const row = await trx
    .selectFrom('cg.tenant_config')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  return row ? (row.value as T) : undefined;
}

/** Latest published graph for a key, or the shipped default so intake never depends on configuration. */
export async function loadGraph(
  trx: Transaction<Database>,
  key: string,
  version: number | undefined,
  fallback: QuestionGraph,
): Promise<QuestionGraph> {
  let q = trx
    .selectFrom('cg.intake_graph')
    .select(['graph'])
    .where('key', '=', key)
    .where('status', '=', 'published')
    .orderBy('graph_version', 'desc')
    .limit(1);
  if (version !== undefined) q = q.where('graph_version', '=', version);
  const row = await q.executeTakeFirst();
  if (!row) {
    if (key === fallback.key && (version === undefined || version === fallback.version))
      return fallback;
    throw new ApiError(
      404,
      'graph_not_found',
      'This version of the questions is no longer available.',
    );
  }
  return parseGraph(row.graph);
}

export function contactFrom(
  a: AnswerValue | undefined,
): { phone?: string; email?: string; preferred?: string } | null {
  if (!a || a.kind !== 'value' || typeof a.value !== 'object' || Array.isArray(a.value))
    return null;
  const v = a.value as Record<string, string>;
  return {
    ...(v['phone'] ? { phone: v['phone'] } : {}),
    ...(v['email'] ? { email: v['email'] } : {}),
    ...(v['preferred'] ? { preferred: v['preferred'] } : {}),
  };
}

/** Shape validation only: every answer belongs to a known question and fits it; required visible questions are answered (BRD:FR-11.02, INT-05). */
export function validateAnswers(
  graph: QuestionGraph,
  ctx: SessionContext,
  answers: Answers,
  after: Answers,
  options: { requireAll?: boolean } = {},
): void {
  const questions = new Map<string, QuestionNode>();
  for (const n of graph.nodes) if (n.kind === 'question') questions.set(n.id, n);
  const afterQuestions = new Map(graph.afterSubmission.map((q) => [q.id, q]));
  const fields: { name: string; message: string }[] = [];
  for (const [id, value] of Object.entries(answers)) {
    const q = questions.get(id);
    if (!q) {
      // Step markers ("done"/"skipped" on free_text, photos, needs, consent, review) are not questions.
      if (graph.nodes.some((n) => n.id === id && n.kind !== 'question')) continue;
      fields.push({ name: id, message: 'unknown question' });
      continue;
    }
    for (const e of validateAnswer(q, value)) fields.push({ name: id, message: e.message });
  }
  for (const [id, value] of Object.entries(after)) {
    const q = afterQuestions.get(id);
    if (!q) {
      fields.push({ name: id, message: 'unknown question' });
      continue;
    }
    for (const e of validateAnswer(q, value)) fields.push({ name: id, message: e.message });
  }
  for (const node of options.requireAll === false ? [] : visibleNodes(graph, ctx, answers)) {
    if (node.kind !== 'question' || !node.required || !isAsked(node, ctx, answers)) continue;
    const a = answers[node.id];
    if (!a || a.kind === 'skipped')
      fields.push({ name: node.id, message: 'needs an answer or "I don\'t know"' });
  }
  if (fields.length > 0)
    throw new ApiError(400, 'validation_failed', 'Some answers need another look.', { fields });
}

/** Publishes with publisher confirms; resolves false when there is no connection. */
export async function publishWithConfirm(
  queue: QueueConnection | undefined,
  message: IntakeQueueMessage,
  timeoutMs = 5000,
): Promise<boolean> {
  if (!queue) return false;
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('publish confirm timed out')), timeoutMs);
    queue.channel.sendToQueue(
      INTAKE_QUEUE,
      Buffer.from(JSON.stringify(message)),
      { persistent: true, contentType: 'application/json', messageId: message.executionId },
      (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(true);
      },
    );
  });
}

export interface SubmitDeps {
  codes: ReferenceCodeLeaser;
  risk: RiskScorer;
  getQueue: () => QueueConnection | undefined;
  defaultGraph: QuestionGraph;
  crypto: FieldCrypto;
  now: () => Date;
}

/** What a request offers the submission path; a Fastify request satisfies it. */
export interface SubmitRequest {
  tx<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T>;
  audit(
    trx: Transaction<Database>,
    input: Omit<AuditInput, 'tenantId' | 'actorKind' | 'actorAccountId' | 'requestId'>,
  ): Promise<unknown>;
  log: { warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  ip?: string | undefined;
}

export interface SubmitInput {
  tenantId: string;
  /** The event by public slug (web) or id (sessions); it must be active. */
  eventSlug?: string;
  eventId?: string;
  body: SubmitBody;
  /** A text or voice session already told the resident their code (no second confirmation). */
  confirmationSent?: boolean;
  /** A need without a damage report (NED-02): only the answers given are checked; the worker files needs, not a report. */
  needsOnly?: boolean;
}

export interface SubmitResult {
  referenceCode: string;
  verificationSuggested: boolean;
  eventId: string;
  status: 'received';
}

export async function submitIntake(
  deps: SubmitDeps,
  req: SubmitRequest,
  input: SubmitInput,
): Promise<SubmitResult> {
  const { body, tenantId } = input;
  const prepared = await req.tx(async (trx) => {
    let q = trx
      .selectFrom('cg.event')
      .select(['id', 'hazard_type', 'status'])
      .where('status', '=', 'active');
    if (input.eventSlug) q = q.where('intake_slug', '=', input.eventSlug);
    else if (input.eventId) q = q.where('id', '=', input.eventId);
    else throw new ApiError(404, 'not_found', 'Not found.');
    const event = await q.executeTakeFirst();
    if (!event) throw new ApiError(404, 'not_found', 'Not found.');
    const graph = await loadGraph(trx, body.graphKey, body.graphVersion, deps.defaultGraph);
    const ctx: SessionContext = {
      hazards: hazardsFor(event.hazard_type),
      channel: body.channel,
      relationship: body.relationship,
    };
    validateAnswers(graph, ctx, body.answers, body.afterSubmission, {
      requireAll: !input.needsOnly,
    });
    if (input.needsOnly) {
      const categories = new Set(graph.needCategories.map((c) => c.value));
      const orgTypes = new Set(graph.consentOrgTypes.map((o) => o.value));
      const fields: { name: string; message: string }[] = [];
      if (body.needs.length === 0) fields.push({ name: 'needs', message: 'pick at least one' });
      for (const n of body.needs)
        if (!categories.has(n)) fields.push({ name: 'needs', message: `unknown need ${n}` });
      for (const o of Object.keys(body.consent))
        if (!orgTypes.has(o))
          fields.push({ name: 'consent', message: `unknown organization type ${o}` });
      if (fields.length > 0)
        throw new ApiError(400, 'validation_failed', 'Some answers need another look.', { fields });
    }

    // Contact details for the party record and the risk score.
    const contact = contactFrom(body.answers['contact']);
    const phone = contact?.phone ? normalisePhone(contact.phone) : null;
    const email = contact?.email ? contact.email.trim().toLowerCase() : null;
    const contactBidx = phone
      ? await deps.crypto.blindIndex(tenantId, 'phone', phone)
      : email
        ? await deps.crypto.blindIndex(tenantId, 'email', email)
        : null;
    const contentHash = sha(
      Object.entries(body.answers)
        .filter(([k]) => !['contact', 'contact_name', 'helper_name', 'subject_name'].includes(k))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    );
    const riskInput = {
      ip: req.ip,
      contactBidx,
      contentHash,
      hasContact: Boolean(phone || email),
    };
    const result: RiskResult = await deps.risk.score(trx, tenantId, riskInput);
    if (result.decision === 'deny') {
      await deps.risk
        .record(trx, tenantId, body.executionId, riskInput, result)
        .catch(() => undefined);
      throw new ApiError(
        429,
        'too_many_submissions',
        'Too many reports from this connection. Please wait and try again, or call the county help line.',
        { retryable: true },
      );
    }
    if (result.decision !== 'allow')
      await deps.risk.record(trx, tenantId, body.executionId, riskInput, result);
    else
      await deps.risk
        .record(trx, tenantId, body.executionId, riskInput, result)
        .catch(() => undefined);

    const payload = {
      ...body,
      eventId: event.id,
      hazards: ctx.hazards,
      risk: result,
      receivedAt: deps.now().toISOString(),
      confirmationSent: input.confirmationSent ?? false,
      needsOnly: input.needsOnly ?? false,
    };
    const payloadEnc = await deps.crypto.encrypt(tenantId, JSON.stringify(payload));
    return { eventId: event.id, payloadEnc, risk: result };
  });

  const referenceCode = await deps.codes.lease(tenantId);
  const message: IntakeQueueMessage = {
    v: 1,
    tenantId,
    executionId: body.executionId,
    referenceCode,
    eventId: prepared.eventId,
    channel: body.channel,
    payloadEnc: prepared.payloadEnc.toString('base64'),
  };

  // Queue first with publisher confirms; the database row is the durable fallback (SCL-06).
  const published = await publishWithConfirm(deps.getQueue(), message).catch((err: unknown) => {
    req.log.warn({ err }, 'intake queue publish failed; storing submission');
    return false;
  });
  let stored = false;
  try {
    await req.tx(async (trx) => {
      await trx
        .insertInto('cg.intake_submission')
        .values({
          execution_id: body.executionId,
          tenant_id: tenantId,
          event_id: prepared.eventId,
          channel: body.channel,
          reference_code: referenceCode,
          payload_enc: prepared.payloadEnc,
          status: published ? 'queued' : 'stored',
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await req.audit(trx, {
        action: 'intake.submit',
        targetType: 'intake_submission',
        targetId: body.executionId,
        executionId: body.executionId,
        changes: {
          fields: [
            { name: 'channel', to: body.channel },
            { name: 'relationship', to: body.relationship },
            { name: 'risk', to: prepared.risk.decision },
            { name: 'path', to: published ? 'queue' : 'stored' },
          ],
        },
      });
    });
    stored = true;
  } catch (err) {
    req.log.error({ err }, 'intake submission row failed');
  }
  if (!published && !stored) {
    throw new ApiError(
      503,
      'intake_unavailable',
      'We could not save your report right now. Keep it on this device; we will retry.',
      { retryable: true },
    );
  }
  return {
    referenceCode,
    status: 'received',
    verificationSuggested: prepared.risk.decision === 'verify',
    eventId: prepared.eventId,
  };
}
