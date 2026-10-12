/**
 * Filing a resident submission (BRD:FR-11.01/11.04, AC-11B, SCL-06, INT-22,
 * NED-01/03, PHO-15, SEC-10, SEC-17). The queue consumer and the stored-row
 * sweep call the same idempotent function, keyed on the execution id: one
 * submission becomes exactly one report with its parties, location, needs,
 * consent, after-saving answers and photos; the reference code is bound to
 * the report; the confirmation goes out through the outbox; what a reviewer
 * must see is recorded as flags, never as a decision (a person decides).
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { normalisePhone } from '@cg/crypto';
import { countFreeCodes, generateCodes, type Database, type ReportFlag } from '@cg/db';
import {
  needSignals,
  parseGraph,
  type AnswerPayload,
  type Answers,
  type AnswerValue,
  type QuestionGraph,
  type QuestionNode,
} from '@cg/intake';
import { allTenantIds, asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

const answerValueSchema: z.ZodType<AnswerValue> = z.union([
  z.object({ kind: z.literal('unknown') }),
  z.object({ kind: z.literal('skipped') }),
  z.object({
    kind: z.literal('value'),
    value: z.union([
      z.string(),
      z.array(z.string()),
      z.number(),
      z.boolean(),
      z.record(z.string(), z.string()),
    ]),
  }),
]);

/** What the API encrypted into the queue message and the fallback row (public/routes.ts). */
export const submissionPayloadSchema = z.object({
  executionId: z.uuid(),
  channel: z.enum(['web', 'assisted', 'sms', 'voice']).default('web'),
  language: z.string().min(2).max(10).default('en'),
  graphKey: z.string().min(1),
  graphVersion: z.number().int().positive(),
  relationship: z.enum(['own_home', 'helper', 'witness', 'organization']),
  answers: z.record(z.string(), answerValueSchema),
  ownWords: z.string().optional(),
  needs: z.array(z.string()).default([]),
  consent: z.record(z.string(), z.boolean()).default({}),
  photoIds: z.array(z.string()).default([]),
  afterSubmission: z.record(z.string(), answerValueSchema).default({}),
  smsOptIn: z.boolean().default(false),
  aiAssisted: z.boolean().default(false),
  extractionId: z.uuid().optional(),
  assisted: z
    .object({ helperAccountId: z.uuid().optional(), consentRecorded: z.boolean() })
    .optional(),
  eventId: z.uuid().nullable().optional(),
  hazards: z.array(z.string()).default([]),
  risk: z
    .object({ decision: z.enum(['allow', 'verify', 'deny']) })
    .loose()
    .optional(),
  receivedAt: z.string().optional(),
  /** A text or voice session already told the resident their code in the same conversation (CHN-03). */
  confirmationSent: z.boolean().default(false),
});
export type SubmissionPayload = z.infer<typeof submissionPayloadSchema>;

export interface FilingInput {
  tenantId: string;
  executionId: string;
  referenceCode: string;
  eventId: string | null;
  channel: SubmissionPayload['channel'];
  payloadEnc: Buffer;
  /** How the submission reached the worker; recorded in the audit log. */
  path: 'queue' | 'stored';
}

export interface FilingResult {
  reportId: string;
  created: boolean;
  flags: ReportFlag[];
}

/** Answers about people go to party records, never into the clear answers JSON (SEC-10). */
const PARTY_QUESTIONS = new Set([
  'contact',
  'contact_name',
  'helper_name',
  'subject_name',
  'org_name',
]);
const LOCATION_QUESTIONS = new Set(['address']);
/** Give up on a stored row after this many filing failures; the row stays for a person to look at. */
export const MAX_FILING_ATTEMPTS = 20;

// ---------------------------------------------------------------- helpers

function valueOf(a: AnswerValue | undefined): AnswerPayload | undefined {
  return a && a.kind === 'value' ? a.value : undefined;
}

function stringOf(a: AnswerValue | undefined): string | null {
  const v = valueOf(a);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function recordOf(a: AnswerValue | undefined): Record<string, string> | null {
  const v = valueOf(a);
  return v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function yesNo(a: AnswerValue | undefined): boolean | null {
  const v = valueOf(a);
  if (v === 'yes' || v === true) return true;
  if (v === 'no' || v === false) return false;
  return null;
}

/** Same recipe as the API's abuse scorer: the answers without anything that names a person. */
export function contentHashOf(answers: Answers): Buffer {
  const h = createHash('sha256');
  const parts = Object.entries(answers)
    .filter(([k]) => !PARTY_QUESTIONS.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  for (const p of parts) h.update(p).update('\u0000');
  return h.digest();
}

/** Normalised "same place" key: street line, unit and ZIP (or city when there is no ZIP). */
export function addressKeyOf(addr: Record<string, string>): string | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const line1 = norm(addr['line1'] ?? '');
  if (!line1) return null;
  const unit = norm(addr['unit'] ?? '');
  const postal = (addr['postal'] ?? '').replace(/\D/g, '').slice(0, 5);
  const city = norm(addr['city'] ?? '');
  return [line1, unit, postal || city].filter(Boolean).join('|');
}

function questionIndex(graph: QuestionGraph): Map<string, QuestionNode> {
  const map = new Map<string, QuestionNode>();
  for (const n of graph.nodes) if (n.kind === 'question') map.set(n.id, n);
  for (const q of graph.afterSubmission) map.set(q.id, q);
  return map;
}

/** Restricted answers are encrypted; anything the graph does not define is dropped. */
export function partitionAnswers(
  answers: Answers,
  questions: Map<string, QuestionNode>,
  skip: ReadonlySet<string>,
): { clear: Answers; restricted: Answers } {
  const clear: Answers = {};
  const restricted: Answers = {};
  for (const [id, value] of Object.entries(answers)) {
    if (skip.has(id)) continue;
    const q = questions.get(id);
    if (!q) continue;
    if (q.classification === 'restricted') restricted[id] = value;
    else clear[id] = value;
  }
  return { clear, restricted };
}

async function loadGraph(
  trx: Transaction<Database>,
  key: string,
  version: number,
  fallback: QuestionGraph,
): Promise<QuestionGraph> {
  const row = await trx
    .selectFrom('cg.intake_graph')
    .select('graph')
    .where('key', '=', key)
    .where('graph_version', '=', version)
    .executeTakeFirst();
  if (row) return parseGraph(row.graph);
  if (key === fallback.key && version === fallback.version) return fallback;
  throw new Error(`question graph ${key}@${version} is not available`);
}

interface PartyInput {
  kind: 'resident' | 'helper' | 'witness' | 'organization';
  name: string | null;
  phone: string | null;
  email: string | null;
  preferred?: string;
  language: string;
  smsOptIn: boolean;
  channel: string;
  at: Date;
}

async function insertParty(
  ctx: JobContext,
  trx: Transaction<Database>,
  tenantId: string,
  p: PartyInput,
): Promise<string> {
  const contact =
    p.phone || p.email
      ? {
          ...(p.phone ? { phone: p.phone } : {}),
          ...(p.email ? { email: p.email } : {}),
          ...(p.preferred ? { preferred: p.preferred } : {}),
        }
      : null;
  const optIn = p.smsOptIn && Boolean(p.phone);
  const row = await trx
    .insertInto('cg.party')
    .values({
      tenant_id: tenantId,
      kind: p.kind,
      display_name_enc: p.name ? await ctx.crypto.encrypt(tenantId, p.name) : null,
      contact_enc: contact ? await ctx.crypto.encrypt(tenantId, JSON.stringify(contact)) : null,
      phone_bidx: p.phone ? await ctx.crypto.blindIndex(tenantId, 'phone', p.phone) : null,
      email_bidx: p.email ? await ctx.crypto.blindIndex(tenantId, 'email', p.email) : null,
      language: p.language,
      sms_opt_in: optIn,
      // docs/06: how and when the resident agreed is recorded before any message is sent.
      sms_opt_in_evidence: optIn
        ? JSON.stringify({
            channel: p.channel,
            at: p.at.toISOString(),
            method:
              p.channel === 'web' ? 'unchecked box on the report form' : `${p.channel} keyword`,
          })
        : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertLocation(
  trx: Transaction<Database>,
  tenantId: string,
  answer: AnswerValue | undefined,
): Promise<{ id: string | null; addressKey: string | null }> {
  const addr = recordOf(answer);
  if (!addr) return { id: null, addressKey: null };
  const addressKey = addressKeyOf(addr);
  const field = (k: string) => (addr[k] && addr[k].trim() !== '' ? addr[k].trim() : null);
  const row = await trx
    .insertInto('cg.location')
    .values({
      tenant_id: tenantId,
      line1: field('line1'),
      unit: field('unit'),
      city: field('city'),
      state: field('state'),
      postal: field('postal'),
      landmark: field('landmark'),
      note: field('note'),
      no_fixed_address: !field('line1'), // any address form counts (EQ-03)
      address_key: addressKey,
      precision: 'unknown', // the geocoder (maps profile) sets geometry later; intake never waits for it (SCL-06)
      source: 'resident',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, addressKey };
}

async function markProcessed(db: Kysely<Database> | Transaction<Database>, executionId: string) {
  await db
    .updateTable('cg.intake_submission')
    .set({ status: 'processed', processed_at: new Date() })
    .where('execution_id', '=', executionId)
    .where('status', '<>', 'processed')
    .execute();
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ------------------------------------------------------------------ filing

/** Files one submission; a second call with the same execution id changes nothing (AC-11B). */
export async function fileSubmission(ctx: JobContext, input: FilingInput): Promise<FilingResult> {
  const { tenantId, executionId } = input;
  const now = ctx.now ?? (() => new Date());
  const already = await ctx.db
    .selectFrom('cg.report')
    .select(['id', 'flags'])
    .where('execution_id', '=', executionId)
    .executeTakeFirst();
  if (already) {
    await markProcessed(ctx.db, executionId);
    return { reportId: already.id, created: false, flags: already.flags };
  }

  const payload = submissionPayloadSchema.parse(
    JSON.parse(await ctx.crypto.decrypt(tenantId, input.payloadEnc)),
  );
  if (payload.executionId !== executionId)
    throw new Error(`payload execution id does not match ${executionId}`);

  try {
    return await asSystem(ctx.db, tenantId, async (trx) => {
      const graph = await loadGraph(trx, payload.graphKey, payload.graphVersion, ctx.defaultGraph);
      const questions = questionIndex(graph);
      const answers = payload.answers;
      const after = payload.afterSubmission;
      const receivedAt = payload.receivedAt ? new Date(payload.receivedAt) : now();
      const at = receivedAt.toISOString();
      const enc = (text: string) => ctx.crypto.encrypt(tenantId, text);

      // People: who reported, and whose home it is (own_home → the same party).
      const contact = recordOf(answers['contact']);
      const phone = contact?.['phone'] ? normalisePhone(contact['phone']) : null;
      const email = contact?.['email'] ? contact['email'].trim().toLowerCase() : null;
      const reporterName =
        payload.relationship === 'helper'
          ? stringOf(answers['helper_name'])
          : payload.relationship === 'organization'
            ? stringOf(answers['org_name'])
            : stringOf(answers['contact_name']);
      const reporterKind = payload.relationship === 'own_home' ? 'resident' : payload.relationship;
      const reporterId = await insertParty(ctx, trx, tenantId, {
        kind: reporterKind,
        name: reporterName,
        phone,
        email,
        ...(contact?.['preferred'] ? { preferred: contact['preferred'] } : {}),
        language: payload.language,
        smsOptIn: payload.smsOptIn,
        channel: payload.channel,
        at: receivedAt,
      });
      let subjectId = reporterId;
      if (payload.relationship === 'helper' || payload.relationship === 'witness') {
        subjectId = await insertParty(ctx, trx, tenantId, {
          kind: 'resident',
          name: stringOf(answers['subject_name']),
          phone: null,
          email: null,
          language: payload.language,
          smsOptIn: false,
          channel: payload.channel,
          at: receivedAt,
        });
      }
      const location = await insertLocation(trx, tenantId, answers['address']);

      // Answers: restricted ones encrypted, the rest as queryable JSON (SEC-10).
      const skip = new Set([...PARTY_QUESTIONS, ...LOCATION_QUESTIONS]);
      const main = partitionAnswers(answers, questions, skip);
      const extra = partitionAnswers(after, questions, new Set());
      const signals = needSignals(graph, { ...answers, ...after }, payload.needs);
      const dangerNow = valueOf(answers['danger_now']);
      const danger = dangerNow === 'yes' || dangerNow === 'not_sure';
      const contentHash = contentHashOf(answers);

      // What a reviewer must see (flags are information, never a decision).
      const flags: ReportFlag[] = [];
      if (payload.risk?.decision === 'verify')
        flags.push({ kind: 'verify_suggested', reason: 'abuse score: verify before acting', at });
      if (payload.aiAssisted)
        flags.push({
          kind: 'ai_assisted',
          reason: 'answers drafted from free text and confirmed by the resident',
          at,
        });
      let dupQuery = trx
        .selectFrom('cg.report')
        .select('id')
        .where('content_hash', '=', contentHash)
        .where('withdrawn_at', 'is', null)
        .limit(3);
      if (payload.eventId) dupQuery = dupQuery.where('event_id', '=', payload.eventId);
      for (const r of await dupQuery.execute())
        flags.push({ kind: 'possible_duplicate', reason: 'same_answers', reportId: r.id, at });
      if (location.addressKey) {
        let q = trx
          .selectFrom('cg.report')
          .innerJoin('cg.location', 'cg.location.id', 'cg.report.location_id')
          .select('cg.report.id as id')
          .where('cg.location.address_key', '=', location.addressKey)
          .where('cg.report.withdrawn_at', 'is', null)
          .limit(5);
        if (payload.eventId) q = q.where('cg.report.event_id', '=', payload.eventId);
        for (const r of await q.execute())
          if (!flags.some((f) => f.reportId === r.id))
            flags.push({ kind: 'possible_duplicate', reason: 'same_address', reportId: r.id, at });
      }
      const dupPhotos = await sql<{ photo_id: string; other_report_id: string | null }>`
        select p.id as photo_id, o.report_id as other_report_id
        from cg.photo p
        join cg.photo o on o.tenant_id = p.tenant_id and o.sha256 = p.sha256 and o.execution_id <> p.execution_id
        where p.tenant_id = ${tenantId} and p.execution_id = ${executionId} and p.sha256 is not null
        limit 5`.execute(trx);
      for (const d of dupPhotos.rows)
        flags.push({
          kind: 'duplicate_photo',
          reason: 'same photo bytes as another report',
          photoId: d.photo_id,
          ...(d.other_report_id ? { reportId: d.other_report_id } : {}),
          at,
        });

      const report = await trx
        .insertInto('cg.report')
        .values({
          tenant_id: tenantId,
          reference_code: input.referenceCode,
          execution_id: executionId,
          event_id: payload.eventId ?? input.eventId,
          graph_key: payload.graphKey,
          graph_version: payload.graphVersion,
          channel_of_origin: payload.channel,
          channels_used: [payload.channel],
          relationship: payload.relationship,
          reporter_party_id: reporterId,
          subject_party_id: subjectId,
          helper_party_id: payload.relationship === 'helper' ? reporterId : null,
          location_id: location.id,
          answers: JSON.stringify(main.clear),
          answers_enc:
            Object.keys(main.restricted).length > 0
              ? await enc(JSON.stringify(main.restricted))
              : null,
          original_text_enc: payload.ownWords ? await enc(payload.ownWords) : null,
          original_lang: payload.ownWords ? payload.language : null,
          extraction_id: payload.extractionId ?? null,
          is_primary_residence: yesNo(answers['primary_residence']),
          pre_existing_damage: yesNo(answers['pre_existing']),
          need_signals: JSON.stringify(signals),
          flags: JSON.stringify(flags),
          content_hash: contentHash,
          danger_flag: danger,
          told_to_call_911_at: danger ? receivedAt : null, // the app showed "call 911" (CON-10)
          submitted_at: receivedAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const categories = new Set(graph.needCategories.map((c) => c.value));
      for (const category of new Set(payload.needs)) {
        if (!categories.has(category)) continue;
        await trx
          .insertInto('cg.need')
          .values({
            tenant_id: tenantId,
            report_id: report.id,
            subject_party_id: subjectId,
            event_id: payload.eventId ?? input.eventId,
            category,
          })
          .execute();
      }
      const orgTypes = new Set(graph.consentOrgTypes.map((o) => o.value));
      for (const [orgType, granted] of Object.entries(payload.consent)) {
        if (!orgTypes.has(orgType)) continue;
        await trx
          .insertInto('cg.consent')
          .values({
            tenant_id: tenantId,
            party_id: reporterId,
            report_id: report.id,
            org_type: orgType,
            granted,
            granted_at: granted ? receivedAt : null,
            channel: payload.channel,
            evidence: JSON.stringify({ at, channel: payload.channel, form: 'intake consent step' }),
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      if (Object.keys(after).length > 0) {
        await trx
          .insertInto('cg.post_submission_answers')
          .values({
            tenant_id: tenantId,
            report_id: report.id,
            aggregate_answers: JSON.stringify(extra.clear),
            restricted_answers_enc:
              Object.keys(extra.restricted).length > 0
                ? await enc(JSON.stringify(extra.restricted))
                : null,
          })
          .execute();
      }
      await trx
        .updateTable('cg.photo')
        .set({ report_id: report.id })
        .where('execution_id', '=', executionId)
        .where('report_id', 'is', null)
        .execute();

      // The code the resident already holds now names this report (INT-22).
      const bound = await trx
        .updateTable('cg.reference_code')
        .set({ state: 'used', report_id: report.id, execution_id: executionId })
        .where('tenant_id', '=', tenantId)
        .where('code', '=', input.referenceCode)
        .executeTakeFirst();
      if (Number(bound.numUpdatedRows ?? 0) === 0) {
        await trx
          .insertInto('cg.reference_code')
          .values({
            tenant_id: tenantId,
            code: input.referenceCode,
            state: 'used',
            report_id: report.id,
            execution_id: executionId,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }

      // Confirmation (docs/06): texts only with opt-in; otherwise email; the screen showed the code anyway.
      const outgoing: { template: string; channel: 'sms' | 'email'; to: string }[] = [];
      if (payload.confirmationSent) {
        // The channel replied with the code already; a second text would cost the resident a segment.
      } else if (phone && payload.smsOptIn)
        outgoing.push(
          { template: 'opt_in_confirmation', channel: 'sms', to: phone },
          { template: 'confirmation', channel: 'sms', to: phone },
        );
      else if (email) outgoing.push({ template: 'confirmation', channel: 'email', to: email });
      for (const m of outgoing) {
        await enqueueOutbox(trx, tenantId, 'message.send', {
          template: m.template,
          channel: m.channel,
          toEnc: (await enc(m.to)).toString('base64'),
          language: payload.language,
          reportId: report.id,
          partyId: reporterId,
          variables: { referenceCode: input.referenceCode },
        });
      }

      await systemAudit(trx, tenantId, 'intake.file', {
        action: 'report.filed',
        targetType: 'report',
        targetId: report.id,
        executionId,
        changes: {
          fields: [
            { name: 'channel', to: payload.channel },
            { name: 'relationship', to: payload.relationship },
            { name: 'needs', to: payload.needs.length },
            { name: 'flags', to: flags.map((f) => `${f.kind}:${f.reason}`) },
            { name: 'path', to: input.path },
          ],
        },
      });
      await markProcessed(trx, executionId);
      return { reportId: report.id, created: true, flags };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Another worker filed it between our check and our insert: same outcome.
      const existing = await ctx.db
        .selectFrom('cg.report')
        .select(['id', 'flags'])
        .where('execution_id', '=', executionId)
        .executeTakeFirst();
      if (existing) {
        await markProcessed(ctx.db, executionId);
        return { reportId: existing.id, created: false, flags: existing.flags };
      }
    }
    throw err;
  }
}

// --------------------------------------------------------------- schedules

/**
 * Stored rows (queue was down) and queued rows nobody filed within two minutes
 * (lost message) are filed from the database copy (SCL-06). A row that keeps
 * failing is kept with its error for a person; nothing is ever dropped.
 */
export async function sweepStoredSubmissions(ctx: JobContext, limit = 50): Promise<number> {
  const stale = new Date((ctx.now ?? (() => new Date()))().getTime() - 2 * 60_000);
  const rows = await ctx.db
    .selectFrom('cg.intake_submission')
    .select([
      'execution_id',
      'tenant_id',
      'event_id',
      'channel',
      'reference_code',
      'payload_enc',
      'status',
      'attempts',
    ])
    .where((eb) =>
      eb.or([
        eb('status', '=', 'stored'),
        eb.and([eb('status', '=', 'queued'), eb('received_at', '<', stale)]),
      ]),
    )
    .where('attempts', '<', MAX_FILING_ATTEMPTS)
    .orderBy('received_at')
    .limit(limit)
    .execute();
  let filed = 0;
  for (const row of rows) {
    try {
      const result = await fileSubmission(ctx, {
        tenantId: row.tenant_id,
        executionId: row.execution_id,
        referenceCode: row.reference_code,
        eventId: row.event_id,
        channel: row.channel,
        payloadEnc: row.payload_enc,
        path: 'stored',
      });
      if (result.created) filed++;
    } catch (err) {
      const attempts = row.attempts + 1;
      await ctx.db
        .updateTable('cg.intake_submission')
        .set({
          attempts,
          last_error: String(err instanceof Error ? err.message : err).slice(0, 500),
          status: attempts >= MAX_FILING_ATTEMPTS ? 'failed' : row.status,
        })
        .where('execution_id', '=', row.execution_id)
        .execute();
      ctx.log.error(
        { err, executionId: row.execution_id, attempts },
        attempts >= MAX_FILING_ATTEMPTS
          ? 'SUBMISSION NEEDS A PERSON: filing failed repeatedly'
          : 'filing a stored submission failed; will retry',
      );
    }
  }
  if (filed > 0) ctx.log.info({ filed }, 'stored submissions filed');
  return filed;
}

/** Keeps at least `floor` free reference codes per tenant so the API never generates on the hot path. */
export async function topUpReferenceCodes(
  ctx: JobContext,
  floor = 500,
  batch = 1000,
): Promise<void> {
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const free = await countFreeCodes(trx, tenantId);
      if (free >= floor) return;
      const n = await generateCodes(trx, tenantId, batch);
      ctx.log.info({ tenantId, generated: n }, 'reference codes generated');
    });
  }
}
