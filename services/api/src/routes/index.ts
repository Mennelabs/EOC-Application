import type { FastifyPluginAsync } from 'fastify';
import { accountRoutes } from './accounts.ts';
import { aiRegisterRoutes } from './ai-register.ts';
import { auditRoutes } from './audit.ts';
import { breakGlassRoutes } from './breakglass.ts';
import { definitionRoutes } from './definitions.ts';
import { eventRoutes } from './events.ts';
import { intakeGraphRoutes } from './intake-graphs.ts';
import { meRoutes } from './me.ts';
import { personnelRoutes } from './personnel.ts';
import { reportRoutes } from './reports.ts';
import { roleRoutes } from './roles.ts';
import { sharedRoutes } from './shared.ts';
import { tenantRoutes } from './tenants.ts';

/** Route plugins mounted under /api/v1. Each layer adds its modules here. */
export const routes: FastifyPluginAsync[] = [
  meRoutes,
  tenantRoutes,
  eventRoutes,
  accountRoutes,
  personnelRoutes,
  roleRoutes,
  breakGlassRoutes,
  auditRoutes,
  definitionRoutes,
  aiRegisterRoutes,
  reportRoutes,
  intakeGraphRoutes,
  sharedRoutes,
];
