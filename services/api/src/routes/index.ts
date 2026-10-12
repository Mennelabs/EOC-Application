import type { FastifyPluginAsync } from 'fastify';
import { accountRoutes } from './accounts.ts';
import { eventRoutes } from './events.ts';
import { meRoutes } from './me.ts';
import { tenantRoutes } from './tenants.ts';

/** Route plugins mounted under /api/v1. Each layer adds its modules here. */
export const routes: FastifyPluginAsync[] = [meRoutes, tenantRoutes, eventRoutes, accountRoutes];
