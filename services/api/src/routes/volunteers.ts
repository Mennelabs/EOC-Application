/**
 * Volunteer reception (layer-4 task K; docs/04 FL:FR-20, PER-01, FR-05.01,
 * BDG-01, RULE-11, SEC-10): a walk-up volunteer is registered at the
 * reception desk in one step. The step reuses the console's own routes,
 * replayed inside this request with the staff member's authorization, so the
 * same permission checks, encryption and audit apply: the person (their
 * phone and email encrypted; skills become recorded, unverified credentials,
 * PER-01), the signed waiver and its version, the background-check status
 * only (never its contents), the team they join, a console check-in, and a
 * badge whose code is shown once. A resend with the same id answers with the
 * same registration. The volunteer then scans the event's code with the
 * field app, or works from a paper assignment.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, listQuery, stepKey, uuidParam } from './helpers.ts';

const checks = ['not_required', 'pending', 'cleared', 'not_cleared', 'expired'] as const;

const registrationOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  eventId: z.uuid(),
  personnelId: z.uuid(),
  name: z.string().nullable(),
  waiverSignedAt: z.iso.datetime().nullable(),
  waiverVersion: z.string().nullable(),
  skills: z.array(z.string()),
  backgroundCheckStatus: z.enum(checks),
  backgroundCheckCheckedAt: z.iso.datetime().nullable(),
  assignedTeamId: z.uuid().nullable(),
  badgeId: z.uuid().nullable(),
  registeredAt: z.iso.datetime(),
  /** Only on the first answer: the badge code to print, never stored in clear (BDG-01). */
  badgeCode: z.string().optional(),
  checkInId: z.uuid().nullable().optional(),
});

/** Replays a console route inside this request, as the same staff member (the field commands do the same). */
async function replay<T>(
  instance: FastifyInstance,
  request: FastifyRequest,
  method: 'POST',
  url: string,
  payload: Record<string, unknown>,
  key: string,
): Promise<T> {
  const res = await instance.inject({
    method,
    url,
    headers: {
      authorization: String(request.headers['authorization'] ?? ''),
      'idempotency-key': key,
    },
    payload,
  });
  const body = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
  if (res.statusCode >= 300)
    throw new ApiError(
      res.statusCode,
      String(body['code'] ?? 'error'),
      String(body['message'] ?? 'That step was refused.'),
      body['details'] !== undefined ? { details: body['details'] } : {},
    );
  return body as T;
}

export const volunteerRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  type Row = {
    id: string;
    version: number;
    event_id: string;
    personnel_id: string;
    waiver_signed_at: Date | null;
    waiver_version: string | null;
    skills: string[];
    background_check_status: (typeof checks)[number];
    background_check_checked_at: Date | null;
    assigned_team_id: string | null;
    badge_id: string | null;
    registered_at: Date;
    name?: string | null;
  };
  const toOut = (r: Row): z.infer<typeof registrationOut> => ({
    id: r.id,
    version: r.version,
    eventId: r.event_id,
    personnelId: r.personnel_id,
    name: r.name ?? null,
    waiverSignedAt: iso(r.waiver_signed_at),
    waiverVersion: r.waiver_version,
    skills: r.skills,
    backgroundCheckStatus: r.background_check_status,
    backgroundCheckCheckedAt: iso(r.background_check_checked_at),
    assignedTeamId: r.assigned_team_id,
    badgeId: r.badge_id,
    registeredAt: iso(r.registered_at)!,
  });

  app.post(
    '/volunteer-registrations',
    {
      schema: {
        tags: ['roster'],
        body: z.object({
          clientUuid: z.uuid(),
          eventId: z.uuid(),
          /** An existing person, or the walk-up's details for a new personnel record. */
          personnelId: z.uuid().optional(),
          person: z
            .object({
              name: z.string().min(1).max(200),
              agency: z.string().max(200).optional(),
              phone: z.string().min(7).max(20).optional(),
              email: z.email().optional(),
            })
            .optional(),
          skills: z.array(z.string().min(1).max(60)).max(30).default([]),
          waiverSigned: z.literal(true),
          waiverVersion: z.string().min(1).max(40),
          backgroundCheckStatus: z.enum(checks).default('not_required'),
          teamId: z.uuid().optional(),
          checkIn: z.boolean().default(true),
          badge: z
            .object({
              roleLabel: z.string().max(80).optional(),
              accessLabel: z.string().max(80).optional(),
            })
            .optional(),
        }),
        response: { 200: registrationOut, 201: registrationOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('volunteer_registration.write', {
        type: 'volunteer_registration',
        tenantId: s.tenantId,
        eventId: request.body.eventId,
      });
      const b = request.body;
      if (!b.personnelId && !b.person)
        throw errors.validation([{ name: 'person', message: 'name the volunteer or choose them' }]);
      const seen = await request.tx((trx) =>
        trx
          .selectFrom('cg.volunteer_registration as v')
          .innerJoin('cg.personnel as p', 'p.id', 'v.personnel_id')
          .selectAll('v')
          .select('p.name')
          .where('v.client_uuid', '=', b.clientUuid)
          .executeTakeFirst(),
      );
      if (seen) return reply.code(200).send(toOut(seen as Row));
      // Each step is its own console request; the phone's id keys them all, so a resend repeats none.
      const personnelId =
        b.personnelId ??
        (
          await replay<{ id: string }>(
            instance,
            request,
            'POST',
            '/api/v1/personnel',
            {
              name: b.person!.name,
              skills: b.skills,
              ...(b.person!.agency ? { agency: b.person!.agency } : {}),
              ...(b.person!.phone || b.person!.email
                ? {
                    contact: {
                      ...(b.person!.phone ? { phone: b.person!.phone } : {}),
                      ...(b.person!.email ? { email: b.person!.email } : {}),
                    },
                  }
                : {}),
            },
            stepKey(b.clientUuid, 'person'),
          )
        ).id;
      if (b.teamId)
        await replay(
          instance,
          request,
          'POST',
          `/api/v1/teams/${b.teamId}/members`,
          { personnelId },
          stepKey(b.clientUuid, 'team'),
        );
      const checkIn = b.checkIn
        ? await replay<{ id: string }>(
            instance,
            request,
            'POST',
            '/api/v1/check-ins',
            {
              eventId: b.eventId,
              personnelId,
              method: 'console',
              locationSharing: false,
              ...(b.teamId ? { teamId: b.teamId } : {}),
            },
            stepKey(b.clientUuid, 'checkin'),
          )
        : null;
      const badge = b.badge
        ? await replay<{ id: string; code?: string }>(
            instance,
            request,
            'POST',
            '/api/v1/badges',
            {
              personnelId,
              eventId: b.eventId,
              ...(b.badge.roleLabel ? { roleLabel: b.badge.roleLabel } : {}),
              ...(b.badge.accessLabel ? { accessLabel: b.badge.accessLabel } : {}),
            },
            stepKey(b.clientUuid, 'badge'),
          )
        : null;
      const row = await request.tx(async (trx) => {
        const now = new Date();
        const inserted = await trx
          .insertInto('cg.volunteer_registration')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            personnel_id: personnelId,
            waiver_signed_at: now,
            waiver_version: b.waiverVersion,
            skills: b.skills,
            background_check_status: b.backgroundCheckStatus,
            background_check_checked_at:
              b.backgroundCheckStatus === 'not_required' || b.backgroundCheckStatus === 'pending'
                ? null
                : now,
            assigned_team_id: b.teamId ?? null,
            badge_id: badge?.id ?? null,
            registered_by: s.accountId,
            client_uuid: b.clientUuid,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'volunteer_registration.write',
          targetType: 'volunteer_registration',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'waiver_version', to: b.waiverVersion },
              { name: 'background_check_status', to: b.backgroundCheckStatus },
              { name: 'assigned_team_id', to: b.teamId ?? null },
              { name: 'badge', to: badge ? 'generated' : 'none' },
            ],
          },
        });
        return { ...inserted, name: b.person?.name ?? null } as Row;
      });
      return reply.code(201).send({
        ...toOut(row),
        ...(badge?.code ? { badgeCode: badge.code } : {}),
        checkInId: checkIn?.id ?? null,
      });
    },
  );

  app.get(
    '/volunteer-registrations',
    {
      schema: {
        tags: ['roster'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          backgroundCheckStatus: z.enum(checks).optional(),
        }),
        response: { 200: z.array(registrationOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('volunteer_registration.read', {
        type: 'volunteer_registration',
        tenantId: s.tenantId,
      });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.volunteer_registration as v')
          .leftJoin('cg.personnel as p', 'p.id', 'v.personnel_id')
          .selectAll('v')
          .select('p.name')
          .orderBy('v.registered_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('v.event_id', '=', q.eventId);
        if (q.backgroundCheckStatus)
          x = x.where('v.background_check_status', '=', q.backgroundCheckStatus);
        return x.execute();
      });
      return rows.map((r) => toOut(r as Row));
    },
  );

  /** The background-check status changes (status only, RULE-11), or the volunteer moves team. */
  app.patch(
    '/volunteer-registrations/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object({ backgroundCheckStatus: z.enum(checks) }),
        response: { 200: registrationOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('volunteer_registration.write', {
        type: 'volunteer_registration',
        tenantId: s.tenantId,
      });
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const result = await trx
          .updateTable('cg.volunteer_registration')
          .set({
            background_check_status: request.body.backgroundCheckStatus,
            background_check_checked_at: new Date(),
            updated_by: s.accountId,
          })
          .where('id', '=', request.params.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        const current = result
          ? null
          : await trx
              .selectFrom('cg.volunteer_registration')
              .selectAll()
              .where('id', '=', request.params.id)
              .executeTakeFirst();
        if (!result && !current) throw errors.notFound();
        const updated = assertUpdated(result, current);
        await request.audit(trx, {
          action: 'volunteer_registration.write',
          targetType: 'volunteer_registration',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: {
            fields: [{ name: 'background_check_status', to: request.body.backgroundCheckStatus }],
          },
        });
        return toOut(updated as Row);
      });
    },
  );
};
