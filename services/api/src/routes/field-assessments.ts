/**
 * Field assessments and service counters (layer-4 task I; FLD-04, FLD-05,
 * FLD-08, FLD-10, FLD-12, FLD-13, FL-06, FR-17, FR-22, DCL:DEC-02/03, A7,
 * DSP-11, SEC-18):
 *
 * - A field team records what it saw at a property: the parcel the pin was
 *   snapped to, the position with its accuracy and a US National Grid
 *   coordinate (computed here from the position), the home type and the FEMA
 *   degree chosen from pictures, or "can't reach" from the street sweep. The
 *   phone's id makes a resend harmless. A second record for the same property
 *   in the same event is flagged for a reviewer, never merged (FLD-13). A
 *   resident report at the same parcel is linked, not changed.
 * - A reviewer accepts or rejects it; accepting verifies the linked report
 *   ("field verified") and sets its FEMA degree through the same review
 *   decisions the console records, and nobody accepts their own finding (A7).
 * - Service counters (meals, water, tarps, cots, rides…) are append-only with
 *   the phone's id, summed per kind for the site or mission.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@cg/db';
import { toUsng } from '@cg/field-core';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, listQuery, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;

const degrees = [
  'no_damage',
  'affected',
  'minor',
  'major',
  'destroyed',
  'cannot_tell',
  'cant_reach',
] as const;
const structures = [
  'single_family',
  'manufactured',
  'apartment_building',
  'commercial',
  'public',
  'other',
] as const;
const serviceKinds = [
  'meal',
  'water_case',
  'tarp',
  'voucher',
  'cot',
  'ride',
  'car_served',
  'person_served',
  'supplies_per_car',
  'pet_food',
  'other',
] as const;

const point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });

const assessmentOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  eventId: z.uuid(),
  missionId: z.uuid().nullable(),
  assignmentId: z.uuid().nullable(),
  teamId: z.uuid().nullable(),
  personnelId: z.uuid().nullable(),
  mode: z.enum(['sweep', 'detailed', 'validation']),
  parcelId: z.string().nullable(),
  position: point.nullable(),
  accuracyM: z.number().nullable(),
  usng: z.string().nullable(),
  landmark: z.string().nullable(),
  structure: z.enum(structures),
  degree: z.enum(degrees),
  observations: z.record(z.string(), z.unknown()),
  note: z.string().nullable(),
  reportId: z.uuid().nullable(),
  duplicateOf: z.uuid().nullable(),
  reviewState: z.enum(['new', 'accepted', 'rejected', 'superseded']),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewReason: z.string().nullable(),
  assessedAt: z.iso.datetime(),
  createdBy: z.uuid().nullable(),
});
type AssessmentOut = z.infer<typeof assessmentOut>;

export const fieldAssessmentRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  /** The caller's personnel record and current teams (FLD-14 own scope; the assessor on the record). */
  async function holder(trx: Trx, accountId: string) {
    const person = await trx
      .selectFrom('cg.personnel')
      .select(['id', 'tenant_id'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    const teams = person
      ? await trx
          .selectFrom('cg.team_member')
          .select('team_id')
          .where('personnel_id', '=', person.id)
          .where('left_at', 'is', null)
          .execute()
      : [];
    return { person: person ?? null, teamIds: teams.map((t) => t.team_id) };
  }

  const select = (trx: Trx) =>
    trx
      .selectFrom('cg.field_assessment')
      .selectAll()
      .select([sql<number | null>`ST_Y(geom)`.as('lat'), sql<number | null>`ST_X(geom)`.as('lon')]);
  type Row = Awaited<ReturnType<ReturnType<typeof select>['executeTakeFirstOrThrow']>>;
  const toOut = (r: Row): AssessmentOut => ({
    id: r.id,
    version: r.version,
    eventId: r.event_id,
    missionId: r.mission_id,
    assignmentId: r.assignment_id,
    teamId: r.team_id,
    personnelId: r.personnel_id,
    mode: r.mode,
    parcelId: r.parcel_id,
    position: r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
    accuracyM: r.accuracy_m,
    usng: r.usng,
    landmark: r.landmark,
    structure: r.structure,
    degree: r.degree,
    observations: r.observations,
    note: r.note,
    reportId: r.report_id,
    duplicateOf: r.duplicate_of,
    reviewState: r.review_state,
    reviewedBy: r.reviewed_by,
    reviewedAt: iso(r.reviewed_at),
    reviewReason: r.review_reason,
    assessedAt: iso(r.assessed_at)!,
    createdBy: r.created_by,
  });

  // --------------------------------------------------------------- record
  app.post(
    '/field-assessments',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          /** The phone's id for this record (FLD-13): a resend answers 200 with the stored record. */
          clientUuid: z.uuid(),
          eventId: z.uuid().optional(),
          missionId: z.uuid().optional(),
          assignmentId: z.uuid().optional(),
          mode: z.enum(['sweep', 'detailed', 'validation']).default('detailed'),
          parcelId: z.string().max(80).optional(),
          position: point
            .extend({ accuracyM: z.number().min(0).max(10_000).optional() })
            .optional(),
          landmark: z.string().max(300).optional(),
          structure: z.enum(structures).default('single_family'),
          degree: z.enum(degrees),
          /** Picture-based choices for the home type (FLD-08): water line, roof, walls, foundation… */
          observations: z
            .record(z.string(), z.union([z.string().max(80), z.number(), z.boolean()]))
            .default({}),
          note: z.string().max(1000).optional(),
          assessedAt: z.iso.datetime().optional(),
        }),
        response: { 201: assessmentOut, 200: assessmentOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('assessment.record', {
        type: 'field_assessment',
        tenantId: s.tenantId,
      });
      const b = request.body;
      if (!b.parcelId && !b.position && !b.landmark)
        throw errors.validation([
          {
            name: 'parcelId',
            message: 'a parcel, a position or a landmark note is needed (FLD-05)',
          },
        ]);
      const { row, created } = await request.tx(async (trx) => {
        const existing = await select(trx)
          .where('client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (existing) return { row: existing, created: false };
        const me = await holder(trx, s.accountId);
        if (!me.person)
          throw new ApiError(
            409,
            'no_personnel_record',
            'Your account is not linked to a personnel record; ask your coordinator.',
          );
        const open = await trx
          .selectFrom('cg.check_in')
          .select(['event_id', 'team_id'])
          .where('personnel_id', '=', me.person.id)
          .where('ended_at', 'is', null)
          .executeTakeFirst();
        const eventId = b.eventId ?? open?.event_id;
        if (!eventId)
          throw errors.validation([{ name: 'eventId', message: 'check in to an event first' }]);
        const usng = b.position ? toUsng(b.position.lat, b.position.lon) : null;
        // FLD-13: an earlier record for the same property is the one this one is flagged against.
        const earlier = b.parcelId
          ? await trx
              .selectFrom('cg.field_assessment')
              .select('id')
              .where('event_id', '=', eventId)
              .where('parcel_id', '=', b.parcelId)
              .where('review_state', 'in', ['new', 'accepted'])
              .orderBy('assessed_at')
              .executeTakeFirst()
          : undefined;
        // A resident report at the same parcel is linked for the reviewer, never changed here.
        const report = b.parcelId
          ? await trx
              .selectFrom('cg.report as r')
              .innerJoin('cg.location as l', 'l.id', 'r.location_id')
              .select('r.id')
              .where('l.parcel_id', '=', b.parcelId)
              .where('r.event_id', '=', eventId)
              .where('r.withdrawn_at', 'is', null)
              .where('r.duplicate_of', 'is', null)
              .orderBy('r.submitted_at', 'desc')
              .executeTakeFirst()
          : undefined;
        const location = await trx
          .insertInto('cg.location')
          .values({
            tenant_id: s.tenantId,
            landmark: b.landmark ?? null,
            geom: b.position
              ? sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`
              : null,
            precision: b.position
              ? (b.position.accuracyM ?? 0) <= 30
                ? 'exact'
                : 'approximate'
              : 'unknown',
            source: 'field',
            parcel_id: b.parcelId ?? null,
            usng,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const inserted = await trx
          .insertInto('cg.field_assessment')
          .values({
            tenant_id: s.tenantId,
            event_id: eventId,
            client_uuid: b.clientUuid,
            mission_id: b.missionId ?? null,
            assignment_id: b.assignmentId ?? null,
            team_id: open?.team_id ?? null,
            personnel_id: me.person.id,
            mode: b.mode,
            parcel_id: b.parcelId ?? null,
            location_id: location.id,
            geom: b.position
              ? sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`
              : null,
            accuracy_m: b.position?.accuracyM ?? null,
            usng,
            landmark: b.landmark ?? null,
            structure: b.structure,
            degree: b.degree,
            observations: JSON.stringify(b.observations),
            note: b.note ?? null,
            report_id: report?.id ?? null,
            duplicate_of: earlier?.id ?? null,
            assessed_at: b.assessedAt ? new Date(b.assessedAt) : new Date(),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.activity_entry')
          .values({
            tenant_id: s.tenantId,
            event_id: eventId,
            personnel_id: me.person.id,
            team_id: open?.team_id ?? null,
            kind: 'assessment',
            summary: `${b.parcelId ?? usng ?? b.landmark ?? 'property'}: ${b.degree.replace(/_/g, ' ')}${earlier ? ' (second record for this property, flagged for review)' : ''}`,
            ref_kind: 'field_assessment',
            ref_id: inserted.id,
            actor_account_id: s.accountId,
          })
          .execute();
        await request.audit(trx, {
          action: 'assessment.record',
          targetType: 'field_assessment',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'degree', to: b.degree },
              { name: 'parcel_id', to: b.parcelId ?? null },
              { name: 'duplicate_of', to: earlier?.id ?? null },
              { name: 'report_id', to: report?.id ?? null },
            ],
          },
        });
        return {
          row: await select(trx).where('id', '=', inserted.id).executeTakeFirstOrThrow(),
          created: true,
        };
      });
      return reply.code(created ? 201 : 200).send(toOut(row));
    },
  );

  // ----------------------------------------------------------------- list
  app.get(
    '/field-assessments',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          parcelId: z.string().max(80).optional(),
          missionId: z.uuid().optional(),
          reportId: z.uuid().optional(),
          reviewState: z.enum(['new', 'accepted', 'rejected', 'superseded']).optional(),
          /** Only records flagged as a second record for a property, and the records they point at. */
          duplicates: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(assessmentOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const decision = await request.authorize('assessment.read', {
        type: 'field_assessment',
        tenantId: s.tenantId,
      });
      const q = request.query;
      const rows = await request.tx(async (trx) => {
        let x = select(trx).orderBy('assessed_at', 'desc').limit(q.limit).offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.parcelId) x = x.where('parcel_id', '=', q.parcelId);
        if (q.missionId) x = x.where('mission_id', '=', q.missionId);
        if (q.reportId) x = x.where('report_id', '=', q.reportId);
        if (q.reviewState) x = x.where('review_state', '=', q.reviewState);
        if (q.duplicates)
          x = x.where((eb) =>
            eb.or([
              eb('duplicate_of', 'is not', null),
              eb(
                'id',
                'in',
                eb
                  .selectFrom('cg.field_assessment as d')
                  .select('d.duplicate_of')
                  .where('d.duplicate_of', 'is not', null) as never,
              ),
            ]),
          );
        if (decision.recordScope === 'own') {
          const me = await holder(trx, s.accountId);
          x = x.where((eb) =>
            eb.or([
              eb('personnel_id', '=', me.person?.id ?? s.accountId),
              ...(me.teamIds.length ? [eb('team_id', 'in', me.teamIds)] : []),
            ]),
          );
        }
        return x.execute();
      });
      return rows.map(toOut);
    },
  );

  // --------------------------------------------------------------- review
  app.post(
    '/field-assessments/:id/review',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({
          decision: z.enum(['accept', 'reject']),
          reason: z.string().min(3).max(500),
        }),
        response: { 200: assessmentOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        select(trx).where('id', '=', request.params.id).executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      // A7: nobody accepts their own finding without an audited exception.
      await request.authorize(
        'assessment.approve',
        {
          type: 'field_assessment',
          id: current.id,
          tenantId: s.tenantId,
          eventId: current.event_id,
          ...(current.created_by ? { recordedBy: current.created_by } : {}),
        },
        { asNotFound: true },
      );
      if (current.review_state !== 'new')
        throw errors.validation([{ name: 'decision', message: `already ${current.review_state}` }]);
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.field_assessment')
            .set({
              review_state: b.decision === 'accept' ? 'accepted' : 'rejected',
              reviewed_by: s.accountId,
              reviewed_at: new Date(),
              review_reason: b.reason,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returning('id')
            .executeTakeFirst(),
          toOut(current),
        );
        // DCL:DEC-02/03: an accepted field visit verifies the linked report and, for a FEMA degree, sets it.
        if (b.decision === 'accept' && current.report_id) {
          const report = await trx
            .selectFrom('cg.report')
            .select(['id', 'version', 'verification_level', 'fema_degree'])
            .where('id', '=', current.report_id)
            .executeTakeFirst();
          if (report) {
            const femaDegree =
              current.degree !== 'cant_reach' && current.degree !== 'cannot_tell'
                ? current.degree
                : null;
            await trx
              .updateTable('cg.report')
              .set({
                verification_level: 'field_verified',
                ...(femaDegree
                  ? {
                      fema_degree: femaDegree,
                      fema_degree_set_by: s.accountId,
                      fema_degree_set_at: new Date(),
                    }
                  : {}),
                updated_by: s.accountId,
              })
              .where('id', '=', report.id)
              .execute();
            const evidence = JSON.stringify([{ kind: 'field_assessment', id: current.id }]);
            await trx
              .insertInto('cg.review_decision')
              .values({
                tenant_id: s.tenantId,
                report_id: report.id,
                report_version: report.version + 1,
                reviewer_account_id: s.accountId,
                decision: 'verify',
                reason: b.reason,
                evidence_refs: evidence,
              })
              .execute();
            if (femaDegree)
              await trx
                .insertInto('cg.review_decision')
                .values({
                  tenant_id: s.tenantId,
                  report_id: report.id,
                  report_version: report.version + 1,
                  reviewer_account_id: s.accountId,
                  decision: 'set_degree',
                  reason: b.reason,
                  evidence_refs: evidence,
                })
                .execute();
            await request.audit(trx, {
              action: 'report.verify',
              targetType: 'report',
              targetId: report.id,
              targetVersion: report.version + 1,
              reason: b.reason,
              changes: {
                fields: [
                  {
                    name: 'verification_level',
                    from: report.verification_level,
                    to: 'field_verified',
                  },
                  ...(femaDegree
                    ? [{ name: 'fema_degree', from: report.fema_degree, to: femaDegree }]
                    : []),
                ],
              },
            });
          }
        }
        await request.audit(trx, {
          action: 'assessment.approve',
          targetType: 'field_assessment',
          targetId: updated.id,
          targetVersion: expected + 1,
          reason: b.reason,
          changes: {
            fields: [
              {
                name: 'review_state',
                from: 'new',
                to: b.decision === 'accept' ? 'accepted' : 'rejected',
              },
            ],
          },
        });
        return select(trx).where('id', '=', current.id).executeTakeFirstOrThrow();
      });
      return toOut(row);
    },
  );

  // ----------------------------------------------------- service counters
  app.post(
    '/service-logs',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          clientUuid: z.uuid(),
          eventId: z.uuid().optional(),
          kind: z.enum(serviceKinds),
          count: z.number().int().min(-1000).max(1000).default(1),
          siteId: z.uuid().optional(),
          missionId: z.uuid().optional(),
          note: z.string().max(300).optional(),
          occurredAt: z.iso.datetime().optional(),
        }),
        response: {
          201: z.object({ id: z.uuid(), kind: z.enum(serviceKinds), count: z.number().int() }),
          200: z.object({ id: z.uuid(), kind: z.enum(serviceKinds), count: z.number().int() }),
        },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('service_log.write', { type: 'service_log', tenantId: s.tenantId });
      const b = request.body;
      const { row, created } = await request.tx(async (trx) => {
        const existing = await trx
          .selectFrom('cg.service_log')
          .select(['id', 'kind', 'count'])
          .where('client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (existing) return { row: existing, created: false };
        const me = await holder(trx, s.accountId);
        const open = me.person
          ? await trx
              .selectFrom('cg.check_in')
              .select(['event_id', 'team_id'])
              .where('personnel_id', '=', me.person.id)
              .where('ended_at', 'is', null)
              .executeTakeFirst()
          : undefined;
        const eventId = b.eventId ?? open?.event_id;
        if (!eventId)
          throw errors.validation([{ name: 'eventId', message: 'check in to an event first' }]);
        const inserted = await trx
          .insertInto('cg.service_log')
          .values({
            tenant_id: s.tenantId,
            event_id: eventId,
            client_uuid: b.clientUuid,
            kind: b.kind,
            count: b.count,
            site_id: b.siteId ?? null,
            mission_id: b.missionId ?? null,
            team_id: open?.team_id ?? null,
            personnel_id: me.person?.id ?? null,
            note: b.note ?? null,
            occurred_at: b.occurredAt ? new Date(b.occurredAt) : new Date(),
            created_by: s.accountId,
          })
          .returning(['id', 'kind', 'count'])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.activity_entry')
          .values({
            tenant_id: s.tenantId,
            event_id: eventId,
            personnel_id: me.person?.id ?? null,
            team_id: open?.team_id ?? null,
            kind: 'service',
            summary: `${b.count} ${b.kind.replace(/_/g, ' ')}`,
            ref_kind: 'service_log',
            ref_id: inserted.id,
            actor_account_id: s.accountId,
          })
          .execute();
        await request.audit(trx, {
          action: 'service_log.write',
          targetType: 'service_log',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'kind', to: b.kind },
              { name: 'count', to: String(b.count) },
            ],
          },
        });
        return { row: inserted, created: true };
      });
      return reply.code(created ? 201 : 200).send(row);
    },
  );

  app.get(
    '/service-logs/summary',
    {
      schema: {
        tags: ['field'],
        querystring: z.object({
          eventId: z.uuid().optional(),
          siteId: z.uuid().optional(),
          missionId: z.uuid().optional(),
          since: z.iso.datetime().optional(),
        }),
        response: {
          200: z.object({
            asOf: z.iso.datetime(),
            totals: z.array(
              z.object({ kind: z.string(), siteId: z.uuid().nullable(), total: z.number().int() }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('service_log.read', { type: 'service_log', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.service_log')
          .select(['kind', 'site_id', sql<string>`sum(count)`.as('total')])
          .groupBy(['kind', 'site_id'])
          .orderBy('kind');
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.siteId) x = x.where('site_id', '=', q.siteId);
        if (q.missionId) x = x.where('mission_id', '=', q.missionId);
        if (q.since) x = x.where('occurred_at', '>=', new Date(q.since));
        return x.execute();
      });
      return {
        asOf: new Date().toISOString(),
        totals: rows.map((r) => ({ kind: r.kind, siteId: r.site_id, total: Number(r.total) })),
      };
    },
  );
};
