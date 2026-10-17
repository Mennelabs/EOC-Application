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
 *
 * A walk-up can also sign up on their own phone through a link reception
 * opens for the event (FL:FR-20). Reception sees the requests waiting at the
 * desk (name, organization, skills and whether they gave a phone or email,
 * never the contact itself), completes one through the same step, which
 * takes the contact straight from the encrypted request into the roster, or
 * declines it. Either way the request's details are erased at once.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { signupTokenHash } from '../public/volunteer-signup.ts';
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
          /** FL:FR-20: the volunteer's own request from the desk link; its details fill `person`. */
          signupId: z.uuid().optional(),
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
      if (!b.personnelId && !b.person && !b.signupId)
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
      // FL:FR-20: a request from the desk link; what reception typed wins over what it says.
      const signup = b.signupId
        ? await request.tx((trx) =>
            trx
              .selectFrom('cg.volunteer_signup')
              .select(['id', 'status', 'event_id', 'details_enc', 'waiver_accepted_at'])
              .where('id', '=', b.signupId!)
              .executeTakeFirst(),
          )
        : undefined;
      if (b.signupId && (!signup || signup.event_id !== b.eventId)) throw errors.notFound();
      if (signup && (signup.status !== 'waiting' || !signup.details_enc))
        throw new ApiError(
          409,
          'already_decided',
          'Someone at the desk already took this request.',
        );
      type Person = {
        name: string;
        agency?: string | undefined;
        phone?: string | undefined;
        email?: string | undefined;
      };
      const person: Person | undefined = signup
        ? {
            ...(JSON.parse(
              await instance.fieldCrypto.decrypt(s.tenantId, signup.details_enc!),
            ) as Person),
            ...b.person,
          }
        : b.person;
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
              name: person!.name,
              skills: b.skills,
              ...(person!.agency ? { agency: person!.agency } : {}),
              ...(person!.phone || person!.email
                ? {
                    contact: {
                      ...(person!.phone ? { phone: person!.phone } : {}),
                      ...(person!.email ? { email: person!.email } : {}),
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
            // FL:FR-20: accepted on the phone when the link showed the county's waiver text.
            waiver_signed_at: signup?.waiver_accepted_at ?? now,
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
              ...(signup ? [{ name: 'volunteer_signup', to: signup.id }] : []),
            ],
          },
        });
        if (signup) {
          // The request is done; its details now live in the roster and are erased here.
          const taken = await trx
            .updateTable('cg.volunteer_signup')
            .set({
              status: 'registered',
              registration_id: inserted.id,
              decided_at: now,
              decided_by: s.accountId,
              details_enc: null,
              updated_by: s.accountId,
            })
            .where('id', '=', signup.id)
            .where('status', '=', 'waiting')
            .returning(['id', 'version'])
            .executeTakeFirst();
          if (!taken)
            throw new ApiError(
              409,
              'already_decided',
              'Someone at the desk already took this request.',
            );
          await request.audit(trx, {
            action: 'volunteer_registration.write',
            targetType: 'volunteer_signup',
            targetId: taken.id,
            targetVersion: taken.version,
            changes: { fields: [{ name: 'status', to: 'registered' }] },
          });
        }
        return { ...inserted, name: person?.name ?? null } as Row;
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

  // ------------------------------------------------- FL:FR-20: sign-up by QR at the desk
  const linkOut = z.object({
    id: z.uuid(),
    eventId: z.uuid(),
    waiverVersion: z.string(),
    /** Languages the county gave its waiver text in; none means volunteers sign at the desk. */
    waiverLanguages: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    waiting: z.number().int(),
    /** Only when the link is opened: its address, shown once (the token is never stored). */
    url: z.string().optional(),
  });
  const languagesOf = (texts: Record<string, string> | null) =>
    Object.entries(texts ?? {})
      .filter(([, t]) => t.trim())
      .map(([k]) => k);

  app.post(
    '/volunteer-signup-links',
    {
      schema: {
        tags: ['roster'],
        body: z.object({
          eventId: z.uuid(),
          waiverVersion: z.string().trim().min(1).max(40),
          /** The county's waiver as volunteers read it, by language; leave out to sign at the desk. */
          waiverText: z
            .object({
              en: z.string().trim().max(20_000).optional(),
              es: z.string().trim().max(20_000).optional(),
            })
            .default({}),
          hours: z.number().int().min(1).max(72).default(12),
        }),
        response: { 201: linkOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('volunteer_registration.write', {
        type: 'volunteer_signup',
        tenantId: s.tenantId,
        eventId: b.eventId,
      });
      const token = randomBytes(32).toString('base64url');
      const texts = Object.fromEntries(Object.entries(b.waiverText).filter(([, t]) => t));
      const row = await request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event as e')
          .innerJoin('cg.tenant as t', 't.id', 'e.tenant_id')
          .select(['e.status', 't.slug'])
          .where('e.id', '=', b.eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        if (event.status !== 'active')
          throw new ApiError(409, 'event_not_active', 'Open a sign-up link for an active event.');
        const made = await trx
          .insertInto('cg.volunteer_signup_link')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            token_hash: signupTokenHash(token),
            waiver_version: b.waiverVersion,
            waiver_text: JSON.stringify(texts),
            expires_at: new Date(Date.now() + b.hours * 3_600_000),
            created_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'volunteer_registration.write',
          targetType: 'volunteer_signup_link',
          targetId: made.id,
          changes: {
            fields: [
              { name: 'waiver_version', to: b.waiverVersion },
              { name: 'expires_at', to: made.expires_at.toISOString() },
            ],
          },
        });
        return { ...made, slug: event.slug };
      });
      const base = `${request.protocol}://${request.hostname}`;
      return reply.code(201).send({
        id: row.id,
        eventId: row.event_id,
        waiverVersion: row.waiver_version,
        waiverLanguages: languagesOf(row.waiver_text),
        expiresAt: row.expires_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        waiting: 0,
        url: `${base}/${row.slug}/help?view=volunteer&join=${token}`,
      });
    },
  );

  app.get(
    '/volunteer-signup-links',
    {
      schema: {
        tags: ['roster'],
        querystring: z.object({ eventId: z.uuid() }),
        response: { 200: z.array(linkOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('volunteer_registration.read', {
        type: 'volunteer_signup',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.volunteer_signup_link as k')
          .select([
            'k.id',
            'k.event_id',
            'k.waiver_version',
            'k.waiver_text',
            'k.expires_at',
            'k.created_at',
          ])
          .select((eb) =>
            eb
              .selectFrom('cg.volunteer_signup as v')
              .select((x) => x.fn.countAll<string>().as('n'))
              .whereRef('v.link_id', '=', 'k.id')
              .where('v.status', '=', 'waiting')
              .as('waiting'),
          )
          .where('k.event_id', '=', request.query.eventId)
          .where('k.closed_at', 'is', null)
          .where('k.expires_at', '>', new Date())
          .orderBy('k.created_at', 'desc')
          .execute(),
      );
      return rows.map((r) => ({
        id: r.id,
        eventId: r.event_id,
        waiverVersion: r.waiver_version,
        waiverLanguages: languagesOf(r.waiver_text),
        expiresAt: r.expires_at.toISOString(),
        createdAt: r.created_at.toISOString(),
        waiting: Number(r.waiting ?? 0),
      }));
    },
  );

  app.post(
    '/volunteer-signup-links/:id/close',
    { schema: { tags: ['roster'], params: uuidParam, response: { 204: z.null() } } },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('volunteer_registration.write', {
        type: 'volunteer_signup',
        tenantId: s.tenantId,
      });
      await request.tx(async (trx) => {
        const row = await trx
          .updateTable('cg.volunteer_signup_link')
          .set({ closed_at: new Date(), closed_by: s.accountId })
          .where('id', '=', request.params.id)
          .where('closed_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!row) {
          const known = await trx
            .selectFrom('cg.volunteer_signup_link')
            .select('id')
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!known) throw errors.notFound();
          return; // already closed
        }
        await request.audit(trx, {
          action: 'volunteer_registration.write',
          targetType: 'volunteer_signup_link',
          targetId: row.id,
          changes: { fields: [{ name: 'closed_at', to: 'now' }] },
        });
      });
      return reply.code(204).send(null);
    },
  );

  const signupOut = z.object({
    id: z.uuid(),
    version: z.number().int(),
    eventId: z.uuid(),
    deskCode: z.string(),
    name: z.string(),
    agency: z.string().nullable(),
    /** Whether they gave a way to reach them; the contact itself goes straight to the roster. */
    gavePhone: z.boolean(),
    gaveEmail: z.boolean(),
    skills: z.array(z.string()),
    waiverVersion: z.string(),
    waiverAcceptedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  });

  app.get(
    '/volunteer-signups',
    {
      schema: {
        tags: ['roster'],
        querystring: z.object({ eventId: z.uuid() }),
        response: { 200: z.array(signupOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('volunteer_registration.read', {
        type: 'volunteer_signup',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.volunteer_signup')
          .selectAll()
          .where('event_id', '=', request.query.eventId)
          .where('status', '=', 'waiting')
          .orderBy('created_at')
          .limit(500)
          .execute(),
      );
      const out = [];
      for (const r of rows) {
        const d = JSON.parse(await instance.fieldCrypto.decrypt(r.tenant_id, r.details_enc!)) as {
          name: string;
          agency?: string;
          phone?: string;
          email?: string;
        };
        out.push({
          id: r.id,
          version: r.version,
          eventId: r.event_id,
          deskCode: r.desk_code,
          name: d.name,
          agency: d.agency ?? null,
          gavePhone: Boolean(d.phone),
          gaveEmail: Boolean(d.email),
          skills: r.skills,
          waiverVersion: r.waiver_version,
          waiverAcceptedAt: iso(r.waiver_accepted_at),
          createdAt: r.created_at.toISOString(),
        });
      }
      if (rows.length)
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'volunteer_registration.read',
            targetType: 'volunteer_signup',
            targetId: 'list',
            changes: { fields: [{ name: 'count', to: rows.length }] },
          }),
        );
      return out;
    },
  );

  app.post(
    '/volunteer-signups/:id/decline',
    {
      config: { requiresVersion: true },
      schema: { tags: ['roster'], params: uuidParam, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('volunteer_registration.write', {
        type: 'volunteer_signup',
        tenantId: s.tenantId,
      });
      const expected = request.expectedVersion();
      await request.tx(async (trx) => {
        const result = await trx
          .updateTable('cg.volunteer_signup')
          .set({
            status: 'declined',
            decided_at: new Date(),
            decided_by: s.accountId,
            details_enc: null,
            updated_by: s.accountId,
          })
          .where('id', '=', request.params.id)
          .where('status', '=', 'waiting')
          .where('version', '=', expected)
          .returning(['id', 'version'])
          .executeTakeFirst();
        const current = result
          ? null
          : await trx
              .selectFrom('cg.volunteer_signup')
              .select(['id', 'version', 'status'])
              .where('id', '=', request.params.id)
              .executeTakeFirst();
        if (!result && !current) throw errors.notFound();
        if (!result && current?.status !== 'waiting')
          throw new ApiError(
            409,
            'already_decided',
            'Someone at the desk already took this request.',
          );
        const updated = assertUpdated(result, current);
        await request.audit(trx, {
          action: 'volunteer_registration.write',
          targetType: 'volunteer_signup',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: [{ name: 'status', to: 'declined' }] },
        });
      });
      return reply.code(204).send(null);
    },
  );
};
