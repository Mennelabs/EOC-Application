/**
 * Damage reports for staff (BRD:FR-10.01–10.07, FR-12.01–12.06, CON-05,
 * CON-10, PHO-07, PHO-14, DCL:DEC-02/03, EQ-08, RULE-09, SEC-18): the review
 * queue ordered by need signals then age, the report with what the role may
 * see (contact, exact location, free text, household and access-needs
 * answers are categories, read audited), photos with signed links, versions
 * and decisions; decisions change the state with a reason and a snapshot;
 * verification level and FEMA degree are set by reviewers only; assisted
 * intake goes through the one submission path.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { decide } from '@cg/authz';
import type { FieldDescriptor } from '@cg/authz';
import { diffForAudit } from '@cg/audit';
import { callAi, recordAiOutput } from '@cg/ai';
import type { Database, ReportFlag } from '@cg/db';
import { normaliseCode } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { answerValueSchema, submissionSchema, type SubmitBody } from '../public/submit.ts';
import { classifierFor, enqueueOutbox, iso, listQuery, uuidParam } from './helpers.ts';

type ReportRow = Selectable<Database['cg.report']>;
type Trx = Transaction<Database>;

/** Field categories a role may or may not see on a report (RULE-16, SEC-18). */
const FIELDS: FieldDescriptor[] = [
  { name: 'contact', category: 'contact', classification: 'restricted' },
  { name: 'location', category: 'location_exact', classification: 'sensitive' },
  { name: 'ownWords', category: 'free_text', classification: 'sensitive' },
  { name: 'household', category: 'household', classification: 'sensitive' },
  { name: 'accessNeeds', category: 'access_needs', classification: 'restricted' },
];

const reviewStates = [
  'submitted',
  'under_review',
  'needs_information',
  'approved',
  'rejected',
  'duplicate',
  'superseded',
] as const;
const verificationLevels = [
  'self_reported',
  'desktop_verified',
  'field_verified',
  'cannot_verify',
] as const;
const degrees = ['affected', 'minor', 'major', 'destroyed', 'no_damage', 'cannot_tell'] as const;

const flagOut = z.object({
  kind: z.string(),
  reason: z.string(),
  reportId: z.string().optional(),
  photoId: z.string().optional(),
  at: z.string(),
});

const summaryOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  referenceCode: z.string(),
  eventId: z.uuid().nullable(),
  channelOfOrigin: z.string(),
  relationship: z.string(),
  reviewState: z.enum(reviewStates),
  verificationLevel: z.enum(verificationLevels),
  femaDegree: z.enum(degrees).nullable(),
  isPrimaryResidence: z.boolean().nullable(),
  preExistingDamage: z.boolean().nullable(),
  needSignals: z.record(z.string(), z.boolean()),
  flags: z.array(flagOut),
  dangerFlag: z.boolean(),
  toldToCall911At: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime(),
  withdrawnAt: z.iso.datetime().nullable(),
  homeType: z.string().nullable(),
  city: z.string().nullable(),
  postal: z.string().nullable(),
  aiAssisted: z.boolean(),
});

const detailOut = summaryOut.extend({
  executionId: z.uuid(),
  graphKey: z.string(),
  graphVersion: z.number().int(),
  channelsUsed: z.array(z.string()),
  duplicateOf: z.uuid().nullable(),
  supersedes: z.uuid().nullable(),
  answers: z.record(z.string(), z.unknown()),
  originalLang: z.string().nullable(),
  translationProvider: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Present only when the role's categories allow it; null means "not shown to you". */
  reporter: z
    .object({
      kind: z.string(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      preferred: z.string().nullable(),
      smsOptIn: z.boolean(),
      language: z.string(),
    })
    .nullable(),
  subjectName: z.string().nullable(),
  location: z
    .object({
      line1: z.string().nullable(),
      unit: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postal: z.string().nullable(),
      landmark: z.string().nullable(),
      note: z.string().nullable(),
      noFixedAddress: z.boolean(),
      precision: z.string(),
    })
    .nullable(),
  ownWords: z.string().nullable(),
  translation: z.string().nullable(),
  household: z.record(z.string(), z.unknown()).nullable(),
  accessNeeds: z.record(z.string(), z.unknown()).nullable(),
  hidden: z.array(z.string()),
  needs: z.array(
    z.object({
      id: z.uuid(),
      category: z.string(),
      detail: z.string().nullable(),
      status: z.string(),
    }),
  ),
  consent: z.array(z.object({ orgType: z.string(), granted: z.boolean() })),
  decisions: z.array(
    z.object({
      id: z.uuid(),
      reportVersion: z.number().int(),
      reviewerAccountId: z.uuid(),
      decision: z.string(),
      reason: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  openCorrections: z.array(
    z.object({
      id: z.uuid(),
      questions: z.unknown(),
      message: z.string().nullable(),
      sentVia: z.string().nullable(),
      requestedAt: z.iso.datetime(),
    }),
  ),
  versions: z.number().int(),
  reReview: z.boolean(),
});

function homeTypeOf(answers: unknown): string | null {
  const a = (answers as Record<string, { kind?: string; value?: unknown }>)['home_type'];
  return a?.kind === 'value' && typeof a.value === 'string' ? a.value : null;
}

function toSummary(
  r: ReportRow & { city?: string | null; postal?: string | null },
): z.infer<typeof summaryOut> {
  const flags = (r.flags as ReportFlag[]) ?? [];
  return {
    id: r.id,
    version: r.version,
    referenceCode: r.reference_code,
    eventId: r.event_id,
    channelOfOrigin: r.channel_of_origin,
    relationship: r.relationship,
    reviewState: r.review_state,
    verificationLevel: r.verification_level,
    femaDegree: r.fema_degree,
    isPrimaryResidence: r.is_primary_residence,
    preExistingDamage: r.pre_existing_damage,
    needSignals: r.need_signals,
    flags,
    dangerFlag: r.danger_flag,
    toldToCall911At: iso(r.told_to_call_911_at),
    submittedAt: iso(r.submitted_at)!,
    withdrawnAt: iso(r.withdrawn_at),
    homeType: homeTypeOf(r.answers),
    city: r.city ?? null,
    postal: r.postal ?? null,
    aiAssisted: flags.some((f) => f.kind === 'ai_assisted'),
  };
}

export interface ReportDeps {
  objects?:
    | {
        client: import('@aws-sdk/client-s3').S3Client;
        presignClient?: import('@aws-sdk/client-s3').S3Client;
        bucket: string;
      }
    | undefined;
  ai?:
    | {
        providerFor(tenantId: string, trx: Trx): Promise<import('@cg/ai').AiProvider | null>;
      }
    | undefined;
  submit?:
    | ((
        req: import('../public/submit.ts').SubmitRequest,
        input: import('../public/submit.ts').SubmitInput,
      ) => Promise<import('../public/submit.ts').SubmitResult>)
    | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    reportDeps: ReportDeps;
  }
}

/** Append-only history before any change (BRD:FR-10.06, AC-10B). */
async function snapshot(
  trx: Trx,
  row: ReportRow,
  by: { kind: 'reviewer' | 'system'; accountId: string | null },
  reason: string,
) {
  await trx
    .insertInto('cg.report_version')
    .values({
      tenant_id: row.tenant_id,
      report_id: row.id,
      report_version: row.version,
      snapshot: JSON.stringify({
        answers: row.answers,
        review_state: row.review_state,
        verification_level: row.verification_level,
        fema_degree: row.fema_degree,
        location_id: row.location_id,
        duplicate_of: row.duplicate_of,
        supersedes: row.supersedes,
      }),
      changed_by_kind: by.kind,
      changed_by: by.accountId,
      reason,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export const reportRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const deps = (): ReportDeps => (app.hasDecorator('reportDeps') ? app.reportDeps : {});

  async function load(request: FastifyRequest, id: string): Promise<ReportRow> {
    const row = await request.tx((trx) =>
      trx.selectFrom('cg.report').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!row) throw errors.notFound();
    return row;
  }

  const resourceOf = (row: ReportRow, fields?: FieldDescriptor[]) => ({
    type: 'report',
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.event_id ? { eventId: row.event_id } : {}),
    ...(row.created_by ? { recordedBy: row.created_by } : {}),
    ...(fields ? { fields } : {}),
  });

  // ------------------------------------------------------------------ queue
  app.get(
    '/reports',
    {
      schema: {
        tags: ['reports'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          state: z.enum(reviewStates).optional(),
          verification: z.enum(verificationLevels).optional(),
          channel: z.enum(['web', 'sms', 'voice', 'assisted']).optional(),
          flagged: z.coerce.boolean().optional(),
          danger: z.coerce.boolean().optional(),
          reference: z.string().min(6).max(12).optional(),
          includeWithdrawn: z.coerce.boolean().default(false),
        }),
        response: { 200: z.array(summaryOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('report.read', {
        type: 'report',
        tenantId: s.tenantId,
        ...(request.query.eventId ? { eventId: request.query.eventId } : {}),
      });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let query = trx
          .selectFrom('cg.report as r')
          .leftJoin('cg.location as l', 'l.id', 'r.location_id')
          .selectAll('r')
          .select(['l.city as city', 'l.postal as postal'])
          // PHO-14: people first (unsafe, no shelter, medical, displaced), then the oldest waiting.
          .orderBy(sql`coalesce((r.need_signals->>'unsafe')::boolean, false)`, 'desc')
          .orderBy(sql`coalesce((r.need_signals->>'no_shelter')::boolean, false)`, 'desc')
          .orderBy(sql`coalesce((r.need_signals->>'medical')::boolean, false)`, 'desc')
          .orderBy(sql`coalesce((r.need_signals->>'displaced')::boolean, false)`, 'desc')
          .orderBy('r.submitted_at', 'asc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) query = query.where('r.event_id', '=', q.eventId);
        if (q.state) query = query.where('r.review_state', '=', q.state);
        if (q.verification) query = query.where('r.verification_level', '=', q.verification);
        if (q.channel) query = query.where('r.channel_of_origin', '=', q.channel);
        if (q.flagged) query = query.where(sql`jsonb_array_length(r.flags)`, '>', 0);
        if (q.danger) query = query.where('r.danger_flag', '=', true);
        if (q.reference) {
          const code = normaliseCode(q.reference);
          query = query.where('r.reference_code', '=', code ?? '-');
        }
        if (!q.includeWithdrawn) query = query.where('r.withdrawn_at', 'is', null);
        return query.execute();
      });
      // Event-scoped grants (canvassers) see only their events: filter what the policy allows.
      const visible = [];
      for (const r of rows) {
        const d = await request
          .authorize('report.read', resourceOf(r as ReportRow), { asNotFound: true })
          .catch(() => null);
        if (d)
          visible.push(toSummary(r as ReportRow & { city: string | null; postal: string | null }));
      }
      return visible;
    },
  );

  // ----------------------------------------------------------------- detail
  app.get(
    '/reports/:id',
    { schema: { tags: ['reports'], params: uuidParam, response: { 200: detailOut } } },
    async (request) => {
      const row = await load(request, request.params.id);
      const decision = await request.authorize('report.read', resourceOf(row, FIELDS), {
        asNotFound: true,
      });
      const can = (f: string) => decision.fields.includes(f);
      const out = await request.tx(async (trx) => {
        const location = row.location_id
          ? await trx
              .selectFrom('cg.location')
              .selectAll()
              .where('id', '=', row.location_id)
              .executeTakeFirst()
          : undefined;
        const reporter = row.reporter_party_id
          ? await trx
              .selectFrom('cg.party')
              .selectAll()
              .where('id', '=', row.reporter_party_id)
              .executeTakeFirst()
          : undefined;
        const subject =
          row.subject_party_id && row.subject_party_id !== row.reporter_party_id
            ? await trx
                .selectFrom('cg.party')
                .select(['display_name_enc'])
                .where('id', '=', row.subject_party_id)
                .executeTakeFirst()
            : undefined;
        const after = await trx
          .selectFrom('cg.post_submission_answers')
          .selectAll()
          .where('report_id', '=', row.id)
          .executeTakeFirst();
        const needs = (await request
          .authorize('need.read', { type: 'need', tenantId: row.tenant_id })
          .catch(() => null))
          ? await trx
              .selectFrom('cg.need')
              .select(['id', 'category', 'detail', 'status'])
              .where('report_id', '=', row.id)
              .execute()
          : [];
        const consent = (await request
          .authorize('consent.read', { type: 'consent', tenantId: row.tenant_id })
          .catch(() => null))
          ? await trx
              .selectFrom('cg.consent')
              .select(['org_type', 'granted'])
              .where('report_id', '=', row.id)
              .execute()
          : [];
        const decisions = await trx
          .selectFrom('cg.review_decision')
          .select([
            'id',
            'report_version',
            'reviewer_account_id',
            'decision',
            'reason',
            'created_at',
          ])
          .where('report_id', '=', row.id)
          .orderBy('created_at', 'desc')
          .execute();
        const corrections = await trx
          .selectFrom('cg.correction_request')
          .select(['id', 'questions', 'message', 'sent_via', 'requested_at'])
          .where('report_id', '=', row.id)
          .where('answered_at', 'is', null)
          .execute();
        const versions = await trx
          .selectFrom('cg.report_version')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('report_id', '=', row.id)
          .executeTakeFirst();
        const lastApproval = decisions.find((d) => d.decision === 'approve');
        const crypto = app.fieldCrypto;
        const dec = (b: Buffer | null | undefined) =>
          b ? crypto.decrypt(row.tenant_id, b) : Promise.resolve(null);
        const contact =
          can('contact') && reporter?.contact_enc
            ? (JSON.parse((await dec(reporter.contact_enc))!) as Record<string, string>)
            : null;
        const restrictedAfter =
          can('accessNeeds') && after?.restricted_answers_enc
            ? (JSON.parse((await dec(after.restricted_answers_enc))!) as Record<string, unknown>)
            : null;
        const hidden = FIELDS.map((f) => f.name).filter((f) => !can(f));
        return {
          ...toSummary({ ...row, city: location?.city ?? null, postal: location?.postal ?? null }),
          executionId: row.execution_id,
          graphKey: row.graph_key,
          graphVersion: row.graph_version,
          channelsUsed: row.channels_used,
          duplicateOf: row.duplicate_of,
          supersedes: row.supersedes,
          answers: row.answers,
          originalLang: row.original_lang,
          translationProvider: row.translation_provider,
          createdAt: iso(row.created_at)!,
          updatedAt: iso(row.updated_at)!,
          reporter:
            reporter && can('contact')
              ? {
                  kind: reporter.kind,
                  name: await dec(reporter.display_name_enc),
                  phone: contact?.['phone'] ?? null,
                  email: contact?.['email'] ?? null,
                  preferred: contact?.['preferred'] ?? null,
                  smsOptIn: reporter.sms_opt_in,
                  language: reporter.language,
                }
              : null,
          subjectName: subject && can('contact') ? await dec(subject.display_name_enc) : null,
          location:
            location && can('location')
              ? {
                  line1: location.line1,
                  unit: location.unit,
                  city: location.city,
                  state: location.state,
                  postal: location.postal,
                  landmark: location.landmark,
                  note: location.note,
                  noFixedAddress: location.no_fixed_address,
                  precision: location.precision,
                }
              : null,
          ownWords: can('ownWords') ? await dec(row.original_text_enc) : null,
          translation: can('ownWords') ? await dec(row.translation_enc) : null,
          household: can('household') && after ? after.aggregate_answers : null,
          accessNeeds: restrictedAfter,
          hidden,
          needs: needs.map((n) => ({
            id: n.id,
            category: n.category,
            detail: n.detail,
            status: n.status,
          })),
          consent: consent.map((c) => ({ orgType: c.org_type, granted: c.granted })),
          decisions: decisions.map((d) => ({
            id: d.id,
            reportVersion: d.report_version,
            reviewerAccountId: d.reviewer_account_id,
            decision: d.decision,
            reason: d.reason,
            createdAt: iso(d.created_at)!,
          })),
          openCorrections: corrections.map((c) => ({
            id: c.id,
            questions: c.questions,
            message: c.message,
            sentVia: c.sent_via,
            requestedAt: iso(c.requested_at)!,
          })),
          versions: Number(versions?.n ?? 0),
          // FR-12.05: an approved report that changed since the approval needs another look.
          reReview: Boolean(
            lastApproval &&
            row.review_state !== 'approved' &&
            lastApproval.report_version < row.version,
          ),
        };
      });
      if (decision.restrictedRead.length > 0 || out.ownWords !== null || out.location !== null) {
        // SEC-18: every read of restricted or sensitive categories is audited.
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'report.read',
            targetType: 'report',
            targetId: row.id,
            targetVersion: row.version,
            classificationRead: decision.restrictedRead,
          }),
        );
      }
      return out;
    },
  );

  // ----------------------------------------------------------------- photos
  app.get(
    '/reports/:id/photos',
    {
      schema: {
        tags: ['reports'],
        params: uuidParam,
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              shot: z.string(),
              source: z.string(),
              status: z.string(),
              blurStatus: z.string(),
              width: z.number().nullable(),
              height: z.number().nullable(),
              uploadedAt: z.iso.datetime().nullable(),
              suggestedTakenAt: z.iso.datetime().nullable(),
              /** Signed links to the review-size and thumbnail derivatives, when the role may see them (PHO-07). */
              reviewUrl: z.string().nullable(),
              thumbUrl: z.string().nullable(),
              restricted: z.boolean(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const row = await load(request, request.params.id);
      const decision = await request.authorize(
        'photo.read',
        {
          type: 'photo',
          tenantId: row.tenant_id,
          ...(row.event_id ? { eventId: row.event_id } : {}),
          fields: [{ name: 'original', category: 'evidence', classification: 'restricted' }],
        },
        { asNotFound: true },
      );
      const evidence = decision.fields.includes('original');
      const photos = await request.tx((trx) =>
        trx
          .selectFrom('cg.photo')
          .selectAll()
          .where('report_id', '=', row.id)
          .orderBy('created_at')
          .execute(),
      );
      const objects = deps().objects;
      const sign = async (key: string | undefined) => {
        if (!key || !objects) return null;
        return getSignedUrl(
          (objects.presignClient ?? objects.client) as unknown as Parameters<
            typeof getSignedUrl
          >[0],
          new GetObjectCommand({ Bucket: objects.bucket, Key: key }),
          { expiresIn: 900 },
        );
      };
      const out = [];
      let restrictedShown = false;
      for (const p of photos) {
        // Until a detector has blurred faces, plates and documents, derivatives stay with the evidence category.
        const restricted = p.blur_status !== 'applied';
        const show = p.status === 'processed' && (!restricted || evidence);
        if (show && restricted) restrictedShown = true;
        const keys = (p.derivative_keys ?? {}) as Record<string, string>;
        out.push({
          id: p.id,
          shot: p.shot,
          source: p.source,
          status: p.status,
          blurStatus: p.blur_status,
          width: p.width,
          height: p.height,
          uploadedAt: iso(p.uploaded_at),
          suggestedTakenAt: iso(p.suggested_taken_at),
          reviewUrl: show ? await sign(keys['review']) : null,
          thumbUrl: show ? await sign(keys['thumb']) : null,
          restricted,
        });
      }
      if (restrictedShown)
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'photo.read',
            targetType: 'report',
            targetId: row.id,
            classificationRead: ['evidence'],
          }),
        );
      return out;
    },
  );

  // --------------------------------------------------------------- versions
  app.get(
    '/reports/:id/versions',
    {
      schema: {
        tags: ['reports'],
        params: uuidParam,
        response: {
          200: z.array(
            z.object({
              reportVersion: z.number().int(),
              changedByKind: z.string(),
              changedBy: z.uuid().nullable(),
              reason: z.string().nullable(),
              snapshot: z.unknown(),
              createdAt: z.iso.datetime(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const row = await load(request, request.params.id);
      await request.authorize('report.read', resourceOf(row), { asNotFound: true });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.report_version')
          .selectAll()
          .where('report_id', '=', row.id)
          .orderBy('report_version')
          .execute(),
      );
      return rows.map((v) => ({
        reportVersion: v.report_version,
        changedByKind: v.changed_by_kind,
        changedBy: v.changed_by,
        reason: v.reason,
        snapshot: v.snapshot,
        createdAt: iso(v.created_at)!,
      }));
    },
  );

  // ------------------------------------------------------------------ claim
  /** Takes a submitted report into review (FR-12.01); no decision yet. */
  app.post(
    '/reports/:id/claim',
    {
      config: { requiresVersion: true },
      schema: { tags: ['reports'], params: uuidParam, response: { 200: summaryOut } },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const current = await load(request, request.params.id);
      await request.authorize('report.update', resourceOf(current), { asNotFound: true });
      if (current.review_state !== 'submitted' && current.review_state !== 'needs_information')
        throw errors.conflict(toSummary(current));
      const expected = request.expectedVersion();
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.report')
            .set({ review_state: 'under_review', updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toSummary(current),
        );
        await request.audit(trx, {
          action: 'report.claim',
          targetType: 'report',
          targetId: row.id,
          targetVersion: row.version,
          changes: {
            fields: [{ name: 'review_state', from: current.review_state, to: 'under_review' }],
          },
        });
        return row;
      });
      return toSummary(updated);
    },
  );

  // -------------------------------------------------------------- decisions
  const decisionBody = z.object({
    decision: z.enum([
      'approve',
      'reject',
      'needs_information',
      'duplicate',
      'supersede',
      'reopen',
    ]),
    reason: z.string().min(3).max(2000),
    duplicateOf: z.uuid().optional(),
    supersedes: z.uuid().optional(),
    questions: z.array(z.string().min(1).max(60)).max(20).optional(),
    message: z.string().max(2000).optional(),
    evidenceRefs: z.array(z.string().max(200)).max(20).default([]),
  });

  async function requestInformation(
    request: FastifyRequest,
    trx: Trx,
    row: ReportRow,
    accountId: string,
    questions: string[],
    message: string | undefined,
  ): Promise<string> {
    const req = await trx
      .insertInto('cg.correction_request')
      .values({
        tenant_id: row.tenant_id,
        report_id: row.id,
        questions: JSON.stringify(questions),
        message: message ?? null,
        requested_by: accountId,
        created_by: accountId,
        updated_by: accountId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await enqueueOutbox(
      trx,
      row.tenant_id,
      'correction.requested',
      { correctionRequestId: req.id },
      null,
    );
    await request.audit(trx, {
      action: 'report.request_information',
      targetType: 'correction_request',
      targetId: req.id,
      changes: {
        fields: [
          { name: 'questions', to: questions },
          { name: 'report', to: row.id },
        ],
      },
    });
    return req.id;
  }

  app.post(
    '/reports/:id/decisions',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['reports'],
        params: uuidParam,
        body: decisionBody,
        response: { 200: summaryOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const current = await load(request, request.params.id);
      // RULE-14 and guardrail G4 (no self-review) both run inside authorize.
      await request.authorize('report.review', resourceOf(current), { asNotFound: true });
      const { reason: confirmReason } = request.confirmation();
      const body = request.body;
      const expected = request.expectedVersion();
      if (current.withdrawn_at)
        throw new ApiError(409, 'report_withdrawn', 'The resident withdrew this report.');

      const from = current.review_state;
      let to: ReportRow['review_state'];
      const patch: { duplicate_of?: string | null; supersedes?: string | null } = {};
      switch (body.decision) {
        case 'approve':
          if (!['submitted', 'under_review', 'needs_information'].includes(from))
            throw errors.conflict(toSummary(current));
          to = 'approved';
          break;
        case 'reject':
          if (!['submitted', 'under_review', 'needs_information'].includes(from))
            throw errors.conflict(toSummary(current));
          to = 'rejected';
          break;
        case 'needs_information':
          if (!body.questions?.length && !body.message)
            throw new ApiError(400, 'validation_failed', 'Say what you need from the resident.', {
              fields: [
                { name: 'questions', message: 'name at least one question or write a message' },
              ],
            });
          to = 'needs_information';
          break;
        case 'duplicate': {
          if (!body.duplicateOf || body.duplicateOf === current.id)
            throw new ApiError(400, 'validation_failed', 'Name the report this one duplicates.', {
              fields: [{ name: 'duplicateOf', message: 'required' }],
            });
          const other = await request.tx((trx) =>
            trx
              .selectFrom('cg.report')
              .select('id')
              .where('id', '=', body.duplicateOf!)
              .executeTakeFirst(),
          );
          if (!other)
            throw new ApiError(400, 'validation_failed', 'That report was not found.', {
              fields: [{ name: 'duplicateOf', message: 'unknown report' }],
            });
          to = 'duplicate';
          patch.duplicate_of = body.duplicateOf;
          break;
        }
        case 'supersede': {
          if (!body.supersedes || body.supersedes === current.id)
            throw new ApiError(
              400,
              'validation_failed',
              'Name the older report this one replaces.',
              {
                fields: [{ name: 'supersedes', message: 'required' }],
              },
            );
          to = from === 'submitted' ? 'under_review' : from;
          patch.supersedes = body.supersedes;
          break;
        }
        case 'reopen':
          if (!['approved', 'rejected', 'duplicate'].includes(from))
            throw errors.conflict(toSummary(current));
          to = 'under_review';
          patch.duplicate_of = null;
          break;
      }

      const updated = await request.tx(async (trx) => {
        await snapshot(
          trx,
          current,
          { kind: 'reviewer', accountId: s.accountId },
          `${body.decision}: ${body.reason}`,
        );
        const row = assertUpdated(
          await trx
            .updateTable('cg.report')
            .set({ ...patch, review_state: to, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toSummary(current),
        );
        if (body.decision === 'supersede' && body.supersedes) {
          const older = await trx
            .selectFrom('cg.report')
            .selectAll()
            .where('id', '=', body.supersedes)
            .executeTakeFirst();
          if (!older)
            throw new ApiError(400, 'validation_failed', 'That report was not found.', {
              fields: [{ name: 'supersedes', message: 'unknown report' }],
            });
          await snapshot(
            trx,
            older,
            { kind: 'reviewer', accountId: s.accountId },
            `superseded by ${current.reference_code}`,
          );
          await trx
            .updateTable('cg.report')
            .set({ review_state: 'superseded', updated_by: s.accountId })
            .where('id', '=', older.id)
            .execute();
        }
        // FR-12.02: reviewer, time, reason, record version and evidence, in their own row.
        await trx
          .insertInto('cg.review_decision')
          .values({
            tenant_id: current.tenant_id,
            report_id: current.id,
            report_version: row.version,
            reviewer_account_id: s.accountId,
            decision: body.decision,
            reason: body.reason,
            evidence_refs: JSON.stringify(body.evidenceRefs),
          })
          .execute();
        if (body.decision === 'needs_information')
          await requestInformation(
            request,
            trx,
            row,
            s.accountId,
            body.questions ?? [],
            body.message,
          );
        await request.audit(trx, {
          action: 'report.decide',
          targetType: 'report',
          targetId: row.id,
          targetVersion: row.version,
          reason: confirmReason ?? body.reason,
          changes: {
            fields: [
              { name: 'decision', to: body.decision },
              { name: 'review_state', from, to },
              ...(patch.duplicate_of !== undefined
                ? [{ name: 'duplicate_of', to: patch.duplicate_of }]
                : []),
              ...(patch.supersedes ? [{ name: 'supersedes', to: patch.supersedes }] : []),
            ],
          },
        });
        return row;
      });
      return toSummary(updated);
    },
  );

  /** A question for the resident without changing the decision (BRD:FR-12.03). */
  app.post(
    '/reports/:id/corrections',
    {
      schema: {
        tags: ['reports'],
        params: uuidParam,
        body: z.object({
          questions: z.array(z.string().min(1).max(60)).max(20).default([]),
          message: z.string().min(1).max(2000),
        }),
        response: { 201: z.object({ id: z.uuid() }) },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const current = await load(request, request.params.id);
      await request.authorize('report.request_information', resourceOf(current), {
        asNotFound: true,
      });
      const id = await request.tx((trx) =>
        requestInformation(
          request,
          trx,
          current,
          s.accountId,
          request.body.questions,
          request.body.message,
        ),
      );
      return reply.code(201).send({ id });
    },
  );

  // ------------------------------------------------- verification and degree
  app.post(
    '/reports/:id/verification',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['reports'],
        params: uuidParam,
        body: z.object({ level: z.enum(verificationLevels), reason: z.string().min(3).max(2000) }),
        response: { 200: summaryOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const current = await load(request, request.params.id);
      await request.authorize('report.verify', resourceOf(current), { asNotFound: true });
      const expected = request.expectedVersion();
      const updated = await request.tx(async (trx) => {
        await snapshot(
          trx,
          current,
          { kind: 'reviewer', accountId: s.accountId },
          `verification: ${request.body.reason}`,
        );
        const row = assertUpdated(
          await trx
            .updateTable('cg.report')
            .set({ verification_level: request.body.level, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toSummary(current),
        );
        await trx
          .insertInto('cg.review_decision')
          .values({
            tenant_id: current.tenant_id,
            report_id: current.id,
            report_version: row.version,
            reviewer_account_id: s.accountId,
            decision: 'verify',
            reason: request.body.reason,
            evidence_refs: '[]',
          })
          .execute();
        await request.audit(trx, {
          action: 'report.verify',
          targetType: 'report',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(current, row, classifierFor('report')),
        });
        return row;
      });
      return toSummary(updated);
    },
  );

  /** DCL:DEC-02: residents never pick a degree; a reviewer sets it from the FEMA matrix for the home type. */
  app.post(
    '/reports/:id/fema-degree',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['reports'],
        params: uuidParam,
        body: z.object({ degree: z.enum(degrees), reason: z.string().min(3).max(2000) }),
        response: { 200: summaryOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const current = await load(request, request.params.id);
      await request.authorize('report.set_degree', resourceOf(current), { asNotFound: true });
      const expected = request.expectedVersion();
      const updated = await request.tx(async (trx) => {
        await snapshot(
          trx,
          current,
          { kind: 'reviewer', accountId: s.accountId },
          `degree: ${request.body.reason}`,
        );
        const row = assertUpdated(
          await trx
            .updateTable('cg.report')
            .set({
              fema_degree: request.body.degree,
              fema_degree_set_by: s.accountId,
              fema_degree_set_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toSummary(current),
        );
        // PHO-11, PHO-13: the decision says whether the reviewer agreed with the suggestion they had.
        const suggestion = await trx
          .selectFrom('cg.damage_suggestion')
          .select(['id', 'degree', 'ai_output_id'])
          .where('report_id', '=', current.id)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        const agreed = suggestion ? suggestion.degree === request.body.degree : null;
        await trx
          .insertInto('cg.review_decision')
          .values({
            tenant_id: current.tenant_id,
            report_id: current.id,
            report_version: row.version,
            reviewer_account_id: s.accountId,
            decision: 'set_degree',
            reason: request.body.reason,
            evidence_refs: '[]',
            ai_suggestion_id: suggestion?.id ?? null,
            agreed_with_ai: agreed,
          })
          .execute();
        if (suggestion?.ai_output_id)
          await trx
            .updateTable('cg.ai_output')
            .set({
              human_action: agreed ? 'accepted' : 'rejected',
              acted_by: s.accountId,
              acted_at: new Date(),
            })
            .where('id', '=', suggestion.ai_output_id)
            .where('human_action', 'is', null)
            .execute();
        await request.audit(trx, {
          action: 'report.set_degree',
          targetType: 'report',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(current, row, classifierFor('report')),
        });
        return row;
      });
      return toSummary(updated);
    },
  );

  // ------------------------------------------------------------- AI severity suggestion
  /**
   * PHO-09, PHO-10, PHO-12 as decided 2026-10-15: the latest suggestion for
   * reviewers only, labelled as not verified. Residents never see it; null
   * when there is none (the feature off, no photos, or not yet looked at).
   */
  app.get(
    '/reports/:id/suggestion',
    {
      schema: {
        tags: ['reports'],
        params: uuidParam,
        response: {
          200: z
            .object({
              id: z.uuid(),
              label: z.literal('AI suggestion — not verified'),
              degree: z.enum(['affected', 'minor', 'major', 'destroyed', 'cannot_tell']),
              confidence: z.number(),
              visibleFeatures: z.array(z.string()),
              photoCount: z.number().int(),
              provider: z.string(),
              model: z.string(),
              createdAt: z.string(),
            })
            .nullable(),
        },
      },
    },
    async (request) => {
      const current = await load(request, request.params.id);
      // Those who may set the degree read it; setting it is the step that asks for confirmation.
      await request.authorize('report.read', resourceOf(current), { asNotFound: true });
      const s = request.subject;
      if (
        s.kind !== 'account' ||
        decide(s, 'report.set_degree', resourceOf(current)).effect !== 'allow'
      )
        throw errors.notFound();
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.damage_suggestion')
          .selectAll()
          .where('report_id', '=', current.id)
          .orderBy('created_at', 'desc')
          .executeTakeFirst(),
      );
      if (!row) return null;
      return {
        id: row.id,
        label: 'AI suggestion — not verified' as const,
        degree: row.degree,
        confidence: Number(row.confidence),
        visibleFeatures: row.visible_features,
        photoCount: row.photo_ids.length,
        provider: row.provider,
        model: row.model,
        createdAt: new Date(row.created_at).toISOString(),
      };
    },
  );

  // ------------------------------------------------------------- translate
  /** EQ-08: the original stays; the reviewer sees a labelled machine translation, never decides on it alone. */
  app.post(
    '/reports/:id/translate',
    {
      schema: {
        tags: ['reports'],
        params: uuidParam,
        body: z.object({ to: z.string().min(2).max(10).default('en') }),
        response: { 200: z.object({ text: z.string(), provider: z.string(), label: z.string() }) },
      },
    },
    async (request) => {
      const row = await load(request, request.params.id);
      const decision = await request.authorize('report.read', resourceOf(row, FIELDS), {
        asNotFound: true,
      });
      if (!decision.fields.includes('ownWords')) throw errors.forbidden();
      const ai = deps().ai;
      if (!ai || !row.original_text_enc)
        throw new ApiError(409, 'nothing_to_translate', 'There are no words to translate.');
      // The provider is called outside any transaction: a slow reply holds no connection.
      const setup = await request.tx(async (trx) => {
        const feature = await trx
          .selectFrom('cg.ai_use_register')
          .select(['enabled', 'provider'])
          .where('feature', '=', 'review.translation')
          .executeTakeFirst();
        if (!feature?.enabled)
          throw new ApiError(
            409,
            'ai_off',
            'Machine translation is switched off for this organization.',
          );
        const provider = await ai.providerFor(row.tenant_id, trx);
        if (!provider?.translation || provider.info.provider !== feature.provider)
          throw new ApiError(
            409,
            'ai_off',
            'Machine translation is switched off for this organization.',
          );
        return { provider, translation: provider.translation };
      });
      const original = await app.fieldCrypto.decrypt(row.tenant_id, row.original_text_enc!);
      const call = await callAi(() =>
        setup.translation.translate(original, request.body.to, row.original_lang ?? undefined),
      );
      if (!call.ok) {
        // AI-10: recorded; the reviewer reads the original.
        await request.tx((trx) =>
          recordAiOutput(trx, {
            tenantId: row.tenant_id,
            feature: 'review.translation',
            provider: setup.provider.info,
            outcome: call.outcome,
            latencyMs: call.latencyMs,
            language: request.body.to,
            targetType: 'report',
            targetId: row.id,
          }),
        );
        throw new ApiError(
          409,
          'ai_unavailable',
          'Machine translation is not available right now. The original words are shown.',
        );
      }
      return request.tx(async (trx) => {
        const out = call.out;
        await recordAiOutput(trx, {
          tenantId: row.tenant_id,
          feature: 'review.translation',
          provider: out.provider,
          outcome: 'ok',
          latencyMs: out.latencyMs,
          language: request.body.to,
          targetType: 'report',
          targetId: row.id,
        });
        const label = `${out.provider.provider}/${out.provider.model}`;
        await trx
          .updateTable('cg.report')
          .set({
            translation_enc: await app.fieldCrypto.encrypt(row.tenant_id, out.output.text),
            translation_provider: label,
          })
          .where('id', '=', row.id)
          .execute();
        await request.audit(trx, {
          action: 'report.translate',
          targetType: 'report',
          targetId: row.id,
          targetVersion: row.version,
          classificationRead: ['free_text'],
          changes: { fields: [{ name: 'translation_provider', to: label }] },
        });
        return {
          text: out.output.text,
          provider: label,
          label: `Machine translation (${label}); the original is kept`,
        };
      });
    },
  );

  // -------------------------------------------------------- assisted intake
  /** CHN-05/06: a staff member enters a report with the person; the same path as every other channel. */
  app.post(
    '/reports',
    {
      config: { idempotent: true },
      schema: {
        tags: ['reports'],
        body: submissionSchema.extend({
          eventId: z.uuid(),
          consentRecorded: z.boolean().default(false),
        }),
        response: {
          202: z.object({
            referenceCode: z.string(),
            status: z.string(),
            verificationSuggested: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const submit = deps().submit;
      if (!submit)
        throw new ApiError(
          503,
          'intake_unavailable',
          'Assisted intake is not available right now.',
          { retryable: true },
        );
      await request.authorize('report.create_assisted', {
        type: 'report',
        tenantId: s.tenantId,
        eventId: request.body.eventId,
      });
      if (request.executionId !== request.body.executionId)
        throw new ApiError(
          400,
          'execution_id_mismatch',
          'The Idempotency-Key must equal executionId.',
        );
      const { eventId, consentRecorded, ...rest } = request.body;
      const body: SubmitBody = {
        ...rest,
        channel: 'assisted',
        assisted: { helperAccountId: s.accountId, consentRecorded },
      };
      // The call-taker's address is not the resident's: no risk scoring by IP for staff entry.
      const result = await submit(
        {
          tx: (fn) => request.tx(fn),
          audit: (trx, input) => request.audit(trx, input),
          log: request.log,
        },
        { tenantId: s.tenantId, eventId, body },
      );
      return reply.code(202).send({
        referenceCode: result.referenceCode,
        status: result.status,
        verificationSuggested: result.verificationSuggested,
      });
    },
  );
  void answerValueSchema;
};
