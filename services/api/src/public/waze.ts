/**
 * The county's Waze for Cities closure feed (FL:FR-05, CON-14, Q-04): a public
 * CIFS document of the roads closed now, which Waze reads on its own schedule
 * once the county has enrolled and given Waze this address. It answers only
 * when the county has switched it on (`waze.feed_enabled`); until then it is
 * not found. Road names, their lines and why they are closed are public road
 * information; nothing about a person is in it.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.ts';
import { configValue } from './submit.ts';
import { cifsFeed, currentClosures } from './waze-cifs.ts';

export const wazeFeedRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const tenantOf = (request: FastifyRequest) => {
    const t = (request as FastifyRequest & { publicTenant?: { id: string } }).publicTenant;
    if (!t) throw errors.notFound();
    return t;
  };

  app.get(
    '/waze/:tenant/cifs.json',
    { schema: { tags: ['public feeds'], params: z.object({ tenant: z.string().min(2).max(60) }) } },
    async (request, reply) => {
      const tenant = tenantOf(request);
      await request.authorize('help.read', { type: 'help', tenantId: tenant.id, published: true });
      const feed = await request.tx(async (trx) => {
        if ((await configValue<boolean>(trx, 'waze.feed_enabled')) !== true)
          throw errors.notFound();
        return cifsFeed(await currentClosures(trx)).feed;
      });
      reply.header('cache-control', 'public, max-age=60');
      return feed;
    },
  );
};
