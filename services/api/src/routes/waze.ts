/**
 * The Waze for Cities closure feed as staff see it (FL:FR-05, Q-04): whether
 * the county has switched it on, the address to give Waze when enrolling,
 * which closures are in it now and which are left out and why (a road drawn
 * as a single point has no line for Waze). Switching it on or off is the
 * county setting `waze.feed_enabled`, changed like any other setting.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { configValue } from '../public/submit.ts';
import { cifsFeed, currentClosures } from '../public/waze-cifs.ts';
import { errors } from '../errors.ts';

export const wazeRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/integrations/waze',
    {
      schema: {
        tags: ['integrations'],
        response: {
          200: z.object({
            enabled: z.boolean(),
            /** Relative to the public host; give the full address to Waze when enrolling. */
            feedPath: z.string(),
            included: z.array(
              z.object({ street: z.string(), type: z.string(), since: z.string() }),
            ),
            leftOut: z.array(z.object({ name: z.string(), reason: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('tenant.config.read', {
        type: 'tenant_config',
        tenantId: s.tenantId,
      });
      return request.tx(async (trx) => {
        const tenant = await trx
          .selectFrom('cg.tenant')
          .select('slug')
          .where('id', '=', s.tenantId)
          .executeTakeFirstOrThrow();
        const { feed, leftOut } = cifsFeed(await currentClosures(trx));
        return {
          enabled: (await configValue<boolean>(trx, 'waze.feed_enabled')) === true,
          feedPath: `/api/public/waze/${tenant.slug}/cifs.json`,
          included: feed.incidents.map((i) => ({
            street: i.street,
            type: i.type === 'ROAD_CLOSED' ? 'Road closed' : 'One lane open',
            since: i.starttime,
          })),
          leftOut: leftOut.map((l) => ({ name: l.name, reason: l.reason })),
        };
      });
    },
  );
};
