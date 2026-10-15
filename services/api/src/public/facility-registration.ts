/**
 * Public facility self-registration (layer-7 task D; REC-01): a school,
 * place of worship, business or community group offers a place for disaster
 * use. The offer goes to the county's approval queue as a proposal; nothing
 * enters the registry until a named approver accepts it. The person's name
 * and contact are encrypted; the answer echoes nothing back. Offers are
 * limited per address, and a retried submission makes no second proposal.
 */
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

export const facilityRegistrationRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const perAddress = new WindowCounter(60 * 60_000);

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
};
