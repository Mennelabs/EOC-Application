/**
 * The joint damage assessment and the state liaison's view (layer-6 task F;
 * FL:FR-10, DCL:DEC-13, Form 010-0-13 Box 10, ADM-05 G4, SCL-01).
 *
 * Joint assessment: the county schedules it (dates, areas, teams) and draws
 * a sample route in proportion to its verified, counted homes by degree of
 * damage, from a recorded seed. Validators (FEMA, on a time-limited role,
 * and the county's coordinator) see each stop as the street sheet shows it,
 * never a name, contact or address, and mark it validated, seen at a
 * different degree, or not seen. Nobody marks a home whose degree they set
 * or assessed (G4). A sample with marks on it is not redrawn.
 *
 * Liaison view: a state liaison sees a county's declaration figures only
 * when the county has signed an agreement with the liaison's tenant, and
 * then only de-identified counts (DEC-13): the same figures as the county's
 * Declaration screen, confirmed outages only, and the joint assessment's
 * progress as counts. Each read is in the county's audit chain.
 */
import { randomInt } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { Database } from '@cg/db';
import {
  declarationData,
  jointCandidates,
  jointSchedule,
  jointStops,
  jointSummary,
  proportionalSample,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;

const DEGREES = ['affected', 'minor', 'major', 'destroyed'] as const;
const day = z.iso.date();

const scheduleOut = z.object({
  id: z.uuid().nullable(),
  version: z.number().int().nullable(),
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  areas: z.array(z.string()),
  teams: z.array(z.object({ name: z.string(), members: z.string() })),
  status: z.enum(['planned', 'in_progress', 'done']),
  sampleVersion: z.number().int(),
  sampleSize: z.number().int().nullable(),
  sampleSeed: z.number().int().nullable(),
  sampledAt: z.string().nullable(),
});
const summaryOut = z.object({
  stops: z.number().int(),
  validated: z.number().int(),
  different: z.number().int(),
  notSeen: z.number().int(),
  pending: z.number().int(),
});
const markOut = z.object({
  result: z.enum(['validated', 'different', 'not_seen']),
  degreeSeen: z.enum([...DEGREES, 'no_damage']).nullable(),
  note: z.string().nullable(),
  markedBy: z.string().nullable(),
  markedAt: z.string(),
});
const stopOut = z.object({
  id: z.uuid(),
  seq: z.number().int(),
  stratum: z.enum(DEGREES),
  home: z
    .object({
      ref: z.string().nullable(),
      degree: z.string().nullable(),
      type: z.string().nullable(),
      units: z.number().nullable(),
      usng: z.string().nullable(),
      postal: z.string().nullable(),
      tract: z.string().nullable(),
      jurisdiction: z.string().nullable(),
      point: z.tuple([z.number(), z.number()]).nullable(),
      counted: z.boolean(),
    })
    .nullable(),
  mark: markOut.nullable(),
});
const jointOut = z.object({
  eventId: z.uuid(),
  schedule: scheduleOut,
  stops: z.array(stopOut),
  summary: summaryOut,
  /** Verified, counted homes a sample can be drawn from. */
  candidates: z.number().int(),
});

export const jointPdaRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const eventOf = async (trx: Trx, eventId: string) => {
    const event = await trx
      .selectFrom('cg.event')
      .select(['id', 'tenant_id'])
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!event) throw errors.notFound();
    return event;
  };
  const view = async (trx: Trx, tenantId: string, eventId: string) => {
    const schedule = await jointSchedule(trx, eventId);
    const stops = await jointStops(trx, tenantId, eventId, schedule);
    return {
      eventId,
      schedule,
      stops,
      summary: jointSummary(stops),
      candidates: (await jointCandidates(trx, tenantId, eventId)).length,
    };
  };

  // ------------------------------------------------------------ the joint assessment
  app.get(
    '/events/:id/joint-pda',
    { schema: { tags: ['joint-assessment'], params: uuidParam, response: { 200: jointOut } } },
    async (request) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('joint_assessment.read', {
        type: 'joint_assessment',
        tenantId: s.tenantId,
        eventId,
      });
      return request.tx(async (trx) => {
        await eventOf(trx, eventId);
        return view(trx, s.tenantId, eventId);
      });
    },
  );

  app.put(
    '/events/:id/joint-pda',
    {
      schema: {
        tags: ['joint-assessment'],
        params: uuidParam,
        body: z
          .object({
            startsOn: day.nullable().optional(),
            endsOn: day.nullable().optional(),
            areas: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
            teams: z
              .array(
                z.object({
                  name: z.string().trim().min(1).max(80),
                  members: z.string().trim().max(500),
                }),
              )
              .max(30)
              .optional(),
            status: z.enum(['planned', 'in_progress', 'done']).optional(),
          })
          .refine((b) => !b.startsOn || !b.endsOn || b.endsOn >= b.startsOn, {
            path: ['endsOn'],
            message: 'ends before it starts',
          }),
        response: { 200: scheduleOut, 201: scheduleOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('joint_assessment.plan', {
        type: 'joint_assessment',
        tenantId: s.tenantId,
        eventId,
      });
      const b = request.body;
      const set = {
        ...(b.startsOn !== undefined ? { starts_on: b.startsOn } : {}),
        ...(b.endsOn !== undefined ? { ends_on: b.endsOn } : {}),
        ...(b.areas !== undefined ? { areas: b.areas } : {}),
        ...(b.teams !== undefined ? { teams: JSON.stringify(b.teams) } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
      };
      const { schedule, created } = await request.tx(async (trx) => {
        const event = await eventOf(trx, eventId);
        const existing = await trx
          .selectFrom('cg.joint_pda')
          .selectAll()
          .where('event_id', '=', eventId)
          .executeTakeFirst();
        if (!existing) {
          const inserted = await trx
            .insertInto('cg.joint_pda')
            .values({
              tenant_id: event.tenant_id,
              event_id: eventId,
              ...set,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'joint_assessment.plan',
            targetType: 'joint_pda',
            targetId: inserted.id,
            targetVersion: inserted.version,
            changes: diffForAudit(null, b, classifierFor('joint_pda')),
          });
          return { schedule: await jointSchedule(trx, eventId), created: true };
        }
        const expected = request.expectedVersion();
        const updated = await trx
          .updateTable('cg.joint_pda')
          .set({ ...set, updated_by: s.accountId })
          .where('id', '=', existing.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        assertUpdated(updated, await jointSchedule(trx, eventId));
        await request.audit(trx, {
          action: 'joint_assessment.plan',
          targetType: 'joint_pda',
          targetId: existing.id,
          targetVersion: updated!.version,
          changes: diffForAudit(existing, updated!, classifierFor('joint_pda')),
        });
        return { schedule: await jointSchedule(trx, eventId), created: false };
      });
      return reply.code(created ? 201 : 200).send(schedule);
    },
  );

  app.post(
    '/events/:id/joint-pda/sample',
    {
      schema: {
        tags: ['joint-assessment'],
        params: uuidParam,
        body: z.object({
          size: z.number().int().min(1).max(500),
          /** Draw a sample again exactly by giving its seed. */
          seed: z.number().int().min(0).max(2_147_483_647).optional(),
        }),
        response: { 201: jointOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('joint_assessment.plan', {
        type: 'joint_assessment',
        tenantId: s.tenantId,
        eventId,
      });
      const seed = request.body.seed ?? randomInt(0, 2_147_483_647);
      const out = await request.tx(async (trx) => {
        const event = await eventOf(trx, eventId);
        let j = await trx
          .selectFrom('cg.joint_pda')
          .selectAll()
          .where('event_id', '=', eventId)
          .executeTakeFirst();
        if (!j)
          j = await trx
            .insertInto('cg.joint_pda')
            .values({
              tenant_id: event.tenant_id,
              event_id: eventId,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        // Marks are validation work: a sample with marks on it stands.
        if (j.sample_version > 0) {
          const marked = await trx
            .selectFrom('cg.joint_pda_mark as m')
            .innerJoin('cg.joint_pda_stop as st', 'st.id', 'm.stop_id')
            .select('m.id')
            .where('st.joint_pda_id', '=', j.id)
            .where('st.sample_version', '=', j.sample_version)
            .executeTakeFirst();
          if (marked)
            throw new ApiError(
              409,
              'sample_marked',
              'Validators have marked this sample; it is not redrawn.',
            );
        }
        const candidates = await jointCandidates(trx, event.tenant_id, eventId);
        if (!candidates.length)
          throw new ApiError(
            409,
            'no_counted_homes',
            'There are no verified, counted homes to sample yet.',
          );
        const { stops, allocation } = proportionalSample(candidates, request.body.size, seed);
        const next = j.sample_version + 1;
        const moved = await trx
          .updateTable('cg.joint_pda')
          .set({
            sample_version: next,
            sample_size: request.body.size,
            sample_seed: seed,
            sampled_at: new Date(),
            sampled_by: s.accountId,
            updated_by: s.accountId,
          })
          .where('id', '=', j.id)
          .where('sample_version', '=', j.sample_version)
          .returning('version')
          .executeTakeFirst();
        if (!moved) throw errors.conflict(await jointSchedule(trx, eventId));
        await trx
          .insertInto('cg.joint_pda_stop')
          .values(
            stops.map((st) => ({
              tenant_id: event.tenant_id,
              joint_pda_id: j.id,
              sample_version: next,
              seq: st.seq,
              record_kind: st.kind ?? ('report' as const),
              record_id: st.recordId,
              stratum: st.degree,
            })),
          )
          .execute();
        await request.audit(trx, {
          action: 'joint_assessment.sample',
          targetType: 'joint_pda',
          targetId: j.id,
          targetVersion: moved.version,
          changes: {
            sampleVersion: next,
            size: request.body.size,
            seed,
            drawn: stops.length,
            allocation,
          },
        });
        return view(trx, event.tenant_id, eventId);
      });
      return reply.code(201).send(out);
    },
  );

  app.post(
    '/joint-pda/stops/:id/marks',
    {
      schema: {
        tags: ['joint-assessment'],
        params: uuidParam,
        body: z
          .object({
            result: z.enum(['validated', 'different', 'not_seen']),
            degreeSeen: z.enum([...DEGREES, 'no_damage']).optional(),
            note: z.string().trim().max(500).optional(),
          })
          .refine((b) => (b.result === 'different') === (b.degreeSeen !== undefined), {
            path: ['degreeSeen'],
            message: 'give the degree seen when, and only when, it differs',
          }),
        response: { 201: stopOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      const stop = await request.tx((trx) =>
        trx
          .selectFrom('cg.joint_pda_stop as st')
          .innerJoin('cg.joint_pda as j', 'j.id', 'st.joint_pda_id')
          .select([
            'st.id',
            'st.tenant_id',
            'st.record_id',
            'st.sample_version',
            'j.event_id',
            'j.sample_version as current_version',
          ])
          .where('st.id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!stop) throw errors.notFound();
      // G4: who set or assessed this home's degree does not validate it.
      const recordedBy = await request.tx(async (trx) => {
        const report = await trx
          .selectFrom('cg.report')
          .select('fema_degree_set_by')
          .where('id', '=', stop.record_id)
          .executeTakeFirst();
        if (report) return report.fema_degree_set_by;
        const assessment = await trx
          .selectFrom('cg.field_assessment as a')
          .leftJoin('cg.personnel as p', 'p.id', 'a.personnel_id')
          .select(['p.account_id', 'a.reviewed_by'])
          .where('a.id', '=', stop.record_id)
          .executeTakeFirst();
        return assessment?.account_id ?? assessment?.reviewed_by ?? null;
      });
      await request.authorize(
        'joint_assessment.validate',
        {
          type: 'joint_assessment',
          id: stop.id,
          tenantId: stop.tenant_id,
          eventId: stop.event_id,
          ...(recordedBy ? { recordedBy } : {}),
        },
        { asNotFound: true },
      );
      if (stop.sample_version !== stop.current_version)
        throw new ApiError(409, 'stale_sample', 'This stop is from an earlier sample.');
      const out = await request.tx(async (trx) => {
        const mark = await trx
          .insertInto('cg.joint_pda_mark')
          .values({
            tenant_id: stop.tenant_id,
            stop_id: stop.id,
            result: b.result,
            degree_seen: b.degreeSeen ?? null,
            note: b.note ?? null,
            marked_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'joint_assessment.validate',
          targetType: 'joint_pda_stop',
          targetId: stop.id,
          changes: { result: b.result, degreeSeen: b.degreeSeen ?? null, markId: mark.id },
          ...(b.note ? { reason: b.note } : {}),
        });
        const schedule = await jointSchedule(trx, stop.event_id);
        return (await jointStops(trx, stop.tenant_id, stop.event_id, schedule)).find(
          (x) => x.id === stop.id,
        )!;
      });
      return reply.code(201).send(out);
    },
  );

  // ------------------------------------------------------------ the state liaison (DEC-13)
  /** Counties that signed an agreement with the subject's tenant, any scope (counts are the least). */
  const grantors = async (request: FastifyRequest) => {
    const s = account(request);
    return request.tx((trx) =>
      trx
        .selectFrom('cg.data_sharing_agreement as a')
        .innerJoin('cg.tenant as t', 't.id', 'a.from_tenant_id')
        .select(['a.id', 'a.from_tenant_id', 'a.scope', 'a.signed_at', 't.name', 't.path'])
        .where('a.to_tenant_id', '=', s.tenantId)
        .where('a.status', '=', 'signed')
        .orderBy('t.name')
        .execute(),
    );
  };

  app.get(
    '/shared-declarations',
    {
      schema: {
        tags: ['joint-assessment'],
        response: {
          200: z.array(
            z.object({
              tenantId: z.uuid(),
              tenantName: z.string(),
              events: z.array(z.object({ id: z.uuid(), name: z.string(), status: z.string() })),
            }),
          ),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('shared_declaration.read', {
        type: 'declaration',
        tenantId: s.tenantId,
      });
      const out: {
        tenantId: string;
        tenantName: string;
        events: { id: string; name: string; status: string }[];
      }[] = [];
      for (const g of await grantors(request)) {
        const allowed = await request
          .authorize('shared_declaration.read', {
            type: 'declaration',
            tenantId: g.from_tenant_id,
            tenantPath: g.path,
          })
          .then(
            () => true,
            () => false,
          );
        if (!allowed || out.some((o) => o.tenantId === g.from_tenant_id)) continue;
        const events = await request.txAs(g.from_tenant_id, (trx) =>
          trx
            .selectFrom('cg.event')
            .select(['id', 'name', 'status'])
            .where('tenant_id', '=', g.from_tenant_id)
            .orderBy('opened_at', 'desc')
            .limit(50)
            .execute(),
        );
        out.push({ tenantId: g.from_tenant_id, tenantName: g.name, events });
      }
      return out;
    },
  );

  app.get(
    '/shared-declarations/:id',
    { schema: { tags: ['joint-assessment'], params: uuidParam } },
    async (request) => {
      const eventId = request.params.id;
      // The event is found only in a county that signed an agreement with this tenant.
      let found: { tenantId: string; name: string; path: string; agreementId: string } | null =
        null;
      for (const g of await grantors(request)) {
        const event = await request.txAs(g.from_tenant_id, (trx) =>
          trx
            .selectFrom('cg.event')
            .select('id')
            .where('id', '=', eventId)
            .where('tenant_id', '=', g.from_tenant_id)
            .executeTakeFirst(),
        );
        if (event) {
          found = { tenantId: g.from_tenant_id, name: g.name, path: g.path, agreementId: g.id };
          break;
        }
      }
      await request.authorize(
        'shared_declaration.read',
        {
          type: 'declaration',
          tenantId: found?.tenantId ?? '00000000-0000-0000-0000-000000000000',
          ...(found ? { tenantPath: found.path } : {}),
          eventId,
        },
        { asNotFound: true },
      );
      if (!found) throw errors.notFound();
      const county = found;
      return request.txAs(county.tenantId, async (trx) => {
        const data = await declarationData(trx, county.tenantId, eventId);
        if (!data) throw errors.notFound();
        const schedule = await jointSchedule(trx, eventId);
        const stops = await jointStops(trx, county.tenantId, eventId, schedule);
        await request.audit(trx, {
          tenantId: county.tenantId,
          action: 'shared_declaration.read',
          targetType: 'event',
          targetId: eventId,
          changes: { agreementId: county.agreementId },
        });
        const confirmed = data.outages.items.filter((o) => o.confirmed);
        return {
          county: { id: county.tenantId, name: county.name },
          agreementId: county.agreementId,
          ...data,
          // As in the package: staff-entered or confirmed outages only (GATE-07).
          outages: {
            items: confirmed,
            open: confirmed.filter((o) => !o.restoredAt).length,
            over72Hours: confirmed.filter((o) => o.over72Hours).length,
            unconfirmed: 0,
          },
          jointAssessment: {
            startsOn: schedule.startsOn,
            endsOn: schedule.endsOn,
            areas: schedule.areas,
            status: schedule.status,
            summary: jointSummary(stops),
          },
        };
      });
    },
  );
};
