/**
 * GET /api/v1/me: the signed-in account, its tenant, active roles and
 * break-glass state. The first route through the full plugin chain.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.ts';

const meResponse = z.object({
  accountId: z.uuid(),
  tenantId: z.uuid(),
  status: z.string(),
  roles: z.array(
    z.object({ key: z.string(), version: z.number().int(), templateKey: z.string().nullable() }),
  ),
  agreementTenantIds: z.array(z.uuid()),
  breakGlass: z.object({ id: z.uuid(), expiresAt: z.iso.datetime() }).nullable(),
});

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/me',
    {
      schema: {
        tags: ['account'],
        security: [{ bearer: [] }],
        response: { 200: meResponse },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('me.read', {
        type: 'account',
        id: s.accountId,
        tenantId: s.tenantId,
      });
      return {
        accountId: s.accountId,
        tenantId: s.tenantId,
        status: s.status,
        roles: s.roles.map((r) => ({ key: r.key, version: r.version, templateKey: r.templateKey })),
        agreementTenantIds: s.agreementTenantIds ?? [],
        breakGlass: s.breakGlass
          ? { id: s.breakGlass.id, expiresAt: s.breakGlass.expiresAt.toISOString() }
          : null,
      };
    },
  );
};
