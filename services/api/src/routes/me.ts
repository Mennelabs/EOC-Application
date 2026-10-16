/**
 * GET /api/v1/me: the signed-in account, its tenant, active roles and
 * break-glass state. The first route through the full plugin chain.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actions, decide, type AccountSubject } from '@cg/authz';
import { errors } from '../errors.ts';

const meResponse = z.object({
  accountId: z.uuid(),
  tenantId: z.uuid(),
  /** county, city, region, state or partner_org: the console picks its workspaces by it. */
  tenantKind: z.string(),
  /** BRD:FR-00.08: the tenant's approved time zone (IANA name); the console shows times in it. */
  timeZone: z.string(),
  status: z.string(),
  roles: z.array(
    z.object({ key: z.string(), version: z.number().int(), templateKey: z.string().nullable() }),
  ),
  agreementTenantIds: z.array(z.uuid()),
  breakGlass: z.object({ id: z.uuid(), expiresAt: z.iso.datetime() }).nullable(),
  /**
   * Actions the account may take on its own tenant's records, as the policy
   * engine answers for a list (FLD-01: the field app builds the home screen by
   * role from this; ADM-04). Every request is still checked on the server.
   */
  actions: z.array(z.string()),
  /** Actions limited to work the account holds (FLD-14). */
  ownRecordsOnly: z.array(z.string()),
});

function allowedActions(subject: AccountSubject): {
  actions: string[];
  ownRecordsOnly: string[];
} {
  const out: string[] = [];
  const own: string[] = [];
  for (const [key, meta] of Object.entries(actions)) {
    const d = decide(subject, key, { type: meta.resource, tenantId: subject.tenantId });
    if (d.effect !== 'allow') continue;
    out.push(key);
    if (d.recordScope === 'own') own.push(key);
  }
  return { actions: out, ownRecordsOnly: own };
}

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
      // The kind rides on the subject (loaded with the account), so this route touches no table.
      return {
        accountId: s.accountId,
        tenantId: s.tenantId,
        tenantKind: s.tenantKind ?? 'county',
        timeZone: s.tenantTimeZone ?? 'UTC',
        status: s.status,
        roles: s.roles.map((r) => ({ key: r.key, version: r.version, templateKey: r.templateKey })),
        agreementTenantIds: s.agreementTenantIds ?? [],
        breakGlass: s.breakGlass
          ? { id: s.breakGlass.id, expiresAt: s.breakGlass.expiresAt.toISOString() }
          : null,
        ...allowedActions(s),
      };
    },
  );
};
