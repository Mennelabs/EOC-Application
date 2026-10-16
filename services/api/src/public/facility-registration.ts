/**
 * Public facility self-registration (layer-7 task D; REC-01): a school,
 * place of worship, business or community group offers a place for disaster
 * use. The offer goes to the county's approval queue as a proposal; nothing
 * enters the registry until a named approver accepts it. The person's name
 * and contact are encrypted; the answer echoes nothing back. Offers are
 * limited per address, and a retried submission makes no second proposal.
 *
 * A facility's own contacts keep its entry current (REC-01) through the
 * single-use link in their yearly re-check email: the link shows the
 * entry's details (never its contacts), and what they send, a correction or
 * "nothing has changed", is a proposal for the approval queue. The link is
 * spent once used and expires; an unknown, spent or expired link is simply
 * not found.
 */
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errors } from '../errors.ts';
import { attributesIn } from '../routes/facilities.ts';
import { WindowCounter } from './abuse.ts';

const offerIn = attributesIn
  .pick({
    name: true,
    kind: true,
    address: true,
    sqft: true,
    ada: true,
    powerBackup: true,
    kitchen: true,
    showers: true,
    petPolicy: true,
    parkingSpaces: true,
    truckAccess: true,
    communities: true,
    notes: true,
  })
  .extend({ address: attributesIn.shape.address.unwrap().unwrap() });

const submitterIn = z
  .object({
    name: z.string().trim().min(2).max(120),
    organization: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    email: z.email().max(200).optional(),
  })
  .refine((v) => v.phone || v.email, 'a phone number or an email to reach you');

/** What the owner sees of their entry: the details they can correct, never contacts. */
const entryOut = z.object({
  name: z.string(),
  kind: z.string(),
  address: z.object({
    line1: z.string().nullable(),
    city: z.string().nullable(),
    postal: z.string().nullable(),
  }),
  sqft: z.number().nullable(),
  ada: z.boolean().nullable(),
  powerBackup: z.string().nullable(),
  kitchen: z.boolean().nullable(),
  showers: z.number().nullable(),
  parkingSpaces: z.number().nullable(),
  truckAccess: z.boolean().nullable(),
});

const tokenParams = z.object({
  tenant: z.string().min(2).max(60),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const hashOf = (token: string) => createHash('sha256').update(token).digest();

export const facilityRegistrationRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const perAddress = new WindowCounter(60 * 60_000);
  /** Owners' re-check links, counted apart from offers: one county may email many owners. */
  const perAddressUpdates = new WindowCounter(60 * 60_000);

  const tenantOf = (request: FastifyRequest) => {
    const t = (request as FastifyRequest & { publicTenant?: { id: string } }).publicTenant;
    if (!t) throw errors.notFound();
    return t;
  };

  app.post(
    '/facilities/:tenant/register',
    {
      schema: {
        tags: ['public facilities'],
        params: z.object({ tenant: z.string().min(2).max(60) }),
        body: z.object({
          executionId: z.uuid(),
          facility: offerIn,
          submitter: z
            .object({
              name: z.string().trim().min(2).max(120),
              organization: z.string().trim().max(200).optional(),
              phone: z.string().trim().max(40).optional(),
              email: z.email().max(200).optional(),
            })
            .refine((v) => v.phone || v.email, 'a phone number or an email to reach you'),
          /** The person says they may offer the place. */
          authorized: z.literal(true),
        }),
        response: { 202: z.object({ received: z.literal(true), message: z.string() }) },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      await request.authorize('facility.self_register', {
        type: 'facility_change',
        tenantId: tenant.id,
      });
      if (request.ip && perAddress.hit(request.ip) > 5)
        throw new ApiError(429, 'too_many_offers', 'Too many offers from here. Please try later.', {
          retryable: true,
        });
      const b = request.body;
      const contact = {
        name: b.submitter.name,
        ...(b.submitter.organization ? { role: b.submitter.organization } : {}),
        ...(b.submitter.phone ? { phone: b.submitter.phone } : {}),
        ...(b.submitter.email ? { email: b.submitter.email } : {}),
      };
      const enc = await base.fieldCrypto.encrypt(tenant.id, JSON.stringify([contact]));
      const submitter = await base.fieldCrypto.encrypt(tenant.id, JSON.stringify(b.submitter));
      await request.tx(async (trx) => {
        const row = await trx
          .insertInto('cg.facility_change')
          .values({
            tenant_id: tenant.id,
            facility_id: null,
            change: 'create',
            proposed: JSON.stringify(b.facility),
            contacts_enc: enc,
            source: 'self_registration',
            proposed_by: null,
            proposed_by_tenant_id: null,
            submitter_enc: submitter,
            execution_id: b.executionId,
          })
          .onConflict((oc) =>
            oc
              .columns(['tenant_id', 'execution_id'])
              .where('execution_id', 'is not', null)
              .doNothing(),
          )
          .returning(['id', 'version'])
          .executeTakeFirst();
        if (row)
          await request.audit(trx, {
            action: 'facility.self_registered',
            targetType: 'facility_change',
            targetId: row.id,
            targetVersion: row.version,
            executionId: b.executionId,
          });
      });
      return reply.code(202).send({
        received: true,
        message: 'Thank you. The county will review the offer and contact you.',
      });
    },
  );

  // ---------------------------------------------------------------- an owner's re-check link
  const gone = () =>
    new ApiError(
      404,
      'not_found',
      'This link has expired or was already used. Contact the county to update the entry.',
    );

  app.get(
    '/facilities/:tenant/update/:token',
    {
      schema: {
        tags: ['public facilities'],
        params: tokenParams,
        response: { 200: entryOut },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      await request.authorize('facility.self_register', {
        type: 'facility_change',
        tenantId: tenant.id,
      });
      return request.tx(async (trx) => {
        const row = await trx
          .selectFrom('cg.facility_update_link as k')
          .innerJoin('cg.facility as f', 'f.id', 'k.facility_id')
          .leftJoin('cg.location as l', 'l.id', 'f.location_id')
          .select([
            'f.name',
            'f.kind',
            'f.sqft',
            'f.ada',
            'f.power_backup',
            'f.kitchen',
            'f.showers',
            'f.parking_spaces',
            'f.truck_access',
            'f.status',
            'l.line1',
            'l.city',
            'l.postal',
          ])
          .where('k.tenant_id', '=', tenant.id)
          .where('k.token_hash', '=', hashOf(request.params.token))
          .where('k.used_at', 'is', null)
          .where('k.expires_at', '>', new Date())
          .executeTakeFirst();
        if (!row || row.status !== 'approved') throw gone();
        return {
          name: row.name,
          kind: row.kind,
          address: { line1: row.line1, city: row.city, postal: row.postal },
          sqft: row.sqft,
          ada: row.ada,
          powerBackup: row.power_backup,
          kitchen: row.kitchen,
          showers: row.showers,
          parkingSpaces: row.parking_spaces,
          truckAccess: row.truck_access,
        };
      });
    },
  );

  app.post(
    '/facilities/:tenant/update/:token',
    {
      schema: {
        tags: ['public facilities'],
        params: tokenParams,
        body: z
          .object({
            executionId: z.uuid(),
            /** "Nothing has changed": the entry is confirmed as it stands. */
            unchanged: z.boolean(),
            facility: offerIn.optional(),
            submitter: submitterIn,
          })
          .refine((b) => b.unchanged || b.facility, 'the details, or that nothing has changed'),
        response: { 202: z.object({ received: z.literal(true), message: z.string() }) },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      await request.authorize('facility.self_register', {
        type: 'facility_change',
        tenantId: tenant.id,
      });
      if (request.ip && perAddressUpdates.hit(request.ip) > 20)
        throw new ApiError(429, 'too_many_offers', 'Too many tries from here. Please try later.', {
          retryable: true,
        });
      const b = request.body;
      const submitter = await base.fieldCrypto.encrypt(tenant.id, JSON.stringify(b.submitter));
      await request.tx(async (trx) => {
        const link = await trx
          .selectFrom('cg.facility_update_link')
          .select(['id', 'facility_id', 'used_at', 'expires_at'])
          .where('tenant_id', '=', tenant.id)
          .where('token_hash', '=', hashOf(request.params.token))
          .forUpdate()
          .executeTakeFirst();
        // A retried submission finds its own proposal and answers the same.
        const again = await trx
          .selectFrom('cg.facility_change')
          .select('id')
          .where('execution_id', '=', b.executionId)
          .executeTakeFirst();
        if (again) return;
        if (!link || link.used_at || link.expires_at <= new Date()) throw gone();
        const row = await trx
          .insertInto('cg.facility_change')
          .values({
            tenant_id: tenant.id,
            facility_id: link.facility_id,
            change: 'update',
            proposed: JSON.stringify(b.unchanged ? {} : b.facility),
            contacts_enc: null,
            source: 'owner_link',
            proposed_by: null,
            proposed_by_tenant_id: null,
            submitter_enc: submitter,
            execution_id: b.executionId,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('cg.facility_update_link')
          .set({ used_at: new Date() })
          .where('id', '=', link.id)
          .execute();
        await request.audit(trx, {
          action: 'facility.owner_rechecked',
          targetType: 'facility_change',
          targetId: row.id,
          targetVersion: row.version,
          changes: { unchanged: b.unchanged },
          executionId: b.executionId,
        });
      });
      return reply.code(202).send({
        received: true,
        message: b.unchanged
          ? 'Thank you. The county will mark the entry as checked.'
          : 'Thank you. The county will review the changes and contact you if it has questions.',
      });
    },
  );
};
