/**
 * Referrals between organizations (FL-10, BRD:FR-17.03, NED-04, SEC-05,
 * SEC-18): the county, or a partner that holds a grant, refers a resident's
 * record to another organization the resident consented to (an active grant
 * names it); the receiving organization accepts, declines or finishes it
 * with an outcome; every step is audited in the county's log and the record
 * never leaves the grant it rides on. The worker tells the receiving
 * organization (referral.created). A legal aid organization's notes stay
 * outside the shared record (FL:FR-23): its response shares the status only
 * (accepted, declined, service given), and the note is neither stored, shown
 * to the referring organization nor written into the county's audit.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';
import { enqueueOutbox, iso, listQuery, stamped, uuidParam } from './helpers.ts';

type ReferralRow = Selectable<Database['cg.referral']>;
type Trx = Transaction<Database>;

const referralOut = z.object({
  ...stamped,
  countyTenantId: z.uuid(),
  fromTenantId: z.uuid(),
  fromTenantName: z.string().nullable(),
  toTenantId: z.uuid().nullable(),
  toTenantName: z.string().nullable(),
  toOrgType: z.string().nullable(),
  reportId: z.uuid().nullable(),
  needId: z.uuid().nullable(),
  referenceCode: z.string().nullable(),
  shareGrantId: z.uuid().nullable(),
  purpose: z.string(),
  status: z.enum(['open', 'accepted', 'declined', 'done']),
  openedBy: z.uuid(),
  acceptedBy: z.uuid().nullable(),
  closedAt: z.iso.datetime().nullable(),
  outcome: z.string().nullable(),
  attempts: z.array(z.unknown()),
});

export const referralRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  type Joined = ReferralRow & {
    from_name: string | null;
    to_name: string | null;
    code: string | null;
  };
  const query = (trx: Trx) =>
    trx
      .selectFrom('cg.referral as x')
      .leftJoin('cg.tenant as f', 'f.id', 'x.from_tenant_id')
      .leftJoin('cg.tenant as t', 't.id', 'x.to_tenant_id')
      .leftJoin('cg.report as r', 'r.id', 'x.report_id')
      .leftJoin('cg.need as n', 'n.id', 'x.need_id')
      .selectAll('x')
      .select([
        'f.name as from_name',
        't.name as to_name',
        sql<string | null>`coalesce(r.reference_code, n.reference_code)`.as('code'),
      ]);

  const toOut = (r: Joined) => ({
    id: r.id,
    version: r.version,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    countyTenantId: r.tenant_id,
    fromTenantId: r.from_tenant_id,
    fromTenantName: r.from_name,
    toTenantId: r.to_tenant_id,
    toTenantName: r.to_name,
    toOrgType: r.to_org_type,
    reportId: r.report_id,
    needId: r.need_id,
    referenceCode: r.code,
    shareGrantId: r.share_grant_id,
    purpose: r.purpose,
    status: r.status,
    openedBy: r.opened_by,
    acceptedBy: r.accepted_by,
    closedAt: iso(r.closed_at),
    outcome: r.outcome,
    attempts: (r.attempts ?? []) as unknown[],
  });

  const inCounty = <T>(request: FastifyRequest, countyId: string, fn: (trx: Trx) => Promise<T>) =>
    account(request).tenantId === countyId ? request.tx(fn) : request.txAs(countyId, fn);

  /** An active grant to a tenant covering the record (the resident's consent made concrete). */
  async function grantFor(
    trx: Trx,
    toTenantId: string,
    reportId: string | null,
    needId: string | null,
  ) {
    let q = trx
      .selectFrom('cg.share_grant')
      .select(['id', 'tenant_id'])
      .where('to_tenant_id', '=', toTenantId)
      .where('revoked_at', 'is', null);
    q = reportId ? q.where('report_id', '=', reportId) : q.where('need_id', '=', needId!);
    return q.executeTakeFirst();
  }

  // ---------------------------------------------------------------- create
  app.post(
    '/referrals',
    {
      schema: {
        tags: ['referrals'],
        body: z
          .object({
            reportId: z.uuid().optional(),
            needId: z.uuid().optional(),
            toTenantId: z.uuid(),
            purpose: z.string().min(3).max(500),
          })
          .refine((b) => Boolean(b.reportId) !== Boolean(b.needId), {
            message: 'one of reportId or needId',
          }),
        response: { 201: referralOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('referral.create', { type: 'referral', tenantId: s.tenantId });
      const b = request.body;
      const reportId = b.reportId ?? null;
      const needId = b.needId ?? null;
      // Which county owns the record: the subject's own, or the one whose grant the subject holds.
      const own = await request.tx(async (trx) =>
        reportId
          ? trx
              .selectFrom('cg.report')
              .select('tenant_id')
              .where('id', '=', reportId)
              .executeTakeFirst()
          : trx
              .selectFrom('cg.need')
              .select('tenant_id')
              .where('id', '=', needId!)
              .executeTakeFirst(),
      );
      const mine = own
        ? null
        : await request.tx((trx) => grantFor(trx, s.tenantId, reportId, needId));
      const countyId = own?.tenant_id ?? mine?.tenant_id;
      if (!countyId) throw errors.notFound();
      if (b.toTenantId === s.tenantId)
        throw errors.validation([{ name: 'toTenantId', message: 'refer to another organization' }]);
      const row = await inCounty(request, countyId, async (trx) => {
        const target = await grantFor(trx, b.toTenantId, reportId, needId);
        if (!target)
          throw errors.validation([
            {
              name: 'toTenantId',
              message: 'the resident has not consented to sharing with this organization',
            },
          ]);
        const inserted = await trx
          .insertInto('cg.referral')
          .values({
            tenant_id: countyId,
            from_tenant_id: s.tenantId,
            to_tenant_id: b.toTenantId,
            report_id: reportId,
            need_id: needId,
            share_grant_id: target.id,
            purpose: b.purpose,
            opened_by: s.accountId,
            attempts: JSON.stringify([
              { at: new Date().toISOString(), by: s.accountId, kind: 'opened' },
            ]),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          tenantId: countyId,
          action: 'referral.create',
          targetType: 'referral',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'to_tenant_id', to: b.toTenantId },
              ...(reportId ? [{ name: 'report_id', to: reportId }] : []),
              ...(needId ? [{ name: 'need_id', to: needId }] : []),
            ],
          },
        });
        await enqueueOutbox(trx, countyId, 'referral.created', { referralId: inserted.id }, null);
        return (await query(trx)
          .where('x.id', '=', inserted.id)
          .executeTakeFirstOrThrow()) as Joined;
      });
      return reply.code(201).send(toOut(row));
    },
  );

  // ------------------------------------------------------------------ list
  app.get(
    '/referrals',
    {
      schema: {
        tags: ['referrals'],
        querystring: listQuery.extend({
          status: z.enum(['open', 'accepted', 'declined', 'done']).optional(),
          direction: z.enum(['in', 'out']).optional(),
        }),
        response: { 200: z.array(referralOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request
        .authorize('referral.create', { type: 'referral', tenantId: s.tenantId })
        .catch(() =>
          request.authorize('referral.respond', { type: 'referral', tenantId: s.tenantId }),
        );
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = query(trx)
          .where((eb) =>
            eb.or([
              eb('x.from_tenant_id', '=', s.tenantId),
              eb('x.to_tenant_id', '=', s.tenantId),
              eb('x.tenant_id', '=', s.tenantId),
            ]),
          )
          .orderBy('x.created_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.status) x = x.where('x.status', '=', q.status);
        if (q.direction === 'in') x = x.where('x.to_tenant_id', '=', s.tenantId);
        if (q.direction === 'out') x = x.where('x.from_tenant_id', '=', s.tenantId);
        return x.execute();
      });
      return (rows as Joined[]).map(toOut);
    },
  );

  /**
   * FL:FR-23: the responder's notes stay with their organization when they answer as legal aid
   * (the legal aid attorney role) or their organization keeps referral outcomes confidential
   * (tenant setting `referrals.confidential_outcomes`).
   */
  async function keepsNotes(trx: Trx, s: ReturnType<typeof account>): Promise<boolean> {
    if (s.roles.some((r) => r.templateKey === 'legal_aid_attorney')) return true;
    const cfg = await trx
      .selectFrom('cg.tenant_config')
      .select('value')
      .where('tenant_id', '=', s.tenantId)
      .where('key', '=', 'referrals.confidential_outcomes')
      .executeTakeFirst();
    return cfg?.value === true;
  }

  // --------------------------------------------------------------- respond
  async function respond(
    request: FastifyRequest,
    id: string,
    status: 'accepted' | 'declined' | 'done',
    note: string | null,
  ) {
    const s = account(request);
    const { current, confidential } = await request.tx(async (trx) => ({
      current: await trx
        .selectFrom('cg.referral')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst(),
      confidential: await keepsNotes(trx, s),
    }));
    if (!current || current.to_tenant_id !== s.tenantId) throw errors.notFound();
    // FL:FR-23: only the status leaves a legal aid organization; the note goes nowhere.
    const shared = confidential ? null : note;
    await request.authorize('referral.respond', {
      type: 'referral',
      id: current.id,
      tenantId: s.tenantId,
    });
    if (status !== 'done' && current.status !== 'open')
      throw errors.conflict({ status: current.status });
    if (status === 'done' && current.status !== 'accepted' && current.status !== 'open')
      throw errors.conflict({ status: current.status });
    const row = await inCounty(request, current.tenant_id, async (trx) => {
      const attempts = [
        ...((current.attempts ?? []) as unknown[]),
        { at: new Date().toISOString(), by: s.accountId, kind: status, note: shared },
      ];
      await trx
        .updateTable('cg.referral')
        .set({
          status,
          ...(status === 'accepted' ? { accepted_by: s.accountId } : {}),
          ...(status === 'declined' || status === 'done'
            ? { closed_at: new Date(), outcome: shared }
            : {}),
          attempts: JSON.stringify(attempts),
          updated_by: s.accountId,
        })
        .where('id', '=', current.id)
        .execute();
      await request.audit(trx, {
        tenantId: current.tenant_id,
        action: 'referral.respond',
        targetType: 'referral',
        targetId: current.id,
        targetVersion: current.version,
        reason: confidential
          ? 'Legal aid: the organization keeps its notes; only the status is shared (FL:FR-23).'
          : note,
        changes: { fields: [{ name: 'status', from: current.status, to: status }] },
      });
      return (await query(trx).where('x.id', '=', current.id).executeTakeFirstOrThrow()) as Joined;
    });
    return toOut(row);
  }

  const noteBody = z.object({ note: z.string().max(500).optional() });
  app.post(
    '/referrals/:id/accept',
    {
      schema: {
        tags: ['referrals'],
        params: uuidParam,
        body: noteBody,
        response: { 200: referralOut },
      },
    },
    async (request) => respond(request, request.params.id, 'accepted', request.body.note ?? null),
  );
  app.post(
    '/referrals/:id/decline',
    {
      schema: {
        tags: ['referrals'],
        params: uuidParam,
        body: z.object({ note: z.string().min(3).max(500) }),
        response: { 200: referralOut },
      },
    },
    async (request) => respond(request, request.params.id, 'declined', request.body.note),
  );
  app.post(
    '/referrals/:id/done',
    {
      schema: {
        tags: ['referrals'],
        params: uuidParam,
        body: z.object({ note: z.string().min(3).max(500) }),
        response: { 200: referralOut },
      },
    },
    async (request) => respond(request, request.params.id, 'done', request.body.note),
  );
};
