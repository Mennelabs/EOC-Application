import type { FastifyPluginAsync } from 'fastify';
import { accountRoutes } from './accounts.ts';
import { aiRegisterRoutes } from './ai-register.ts';
import { auditRoutes } from './audit.ts';
import { breakGlassRoutes } from './breakglass.ts';
import { contactRoutes } from './contacts.ts';
import { definitionRoutes } from './definitions.ts';
import { dispatchRoutes, type DispatchDeps } from './dispatch.ts';
import { eventRoutes } from './events.ts';
import { fieldAssessmentRoutes } from './field-assessments.ts';
import { fieldOpsRoutes } from './field-ops.ts';
import { fieldRecordRoutes, type FieldRecordDeps } from './field-records.ts';
import { fieldSyncRoutes, type FieldSyncDeps } from './field-sync.ts';
import { fieldVoiceRoutes, type FieldVoiceDeps } from './field-voice.ts';
import { intakeGraphRoutes } from './intake-graphs.ts';
import { meRoutes } from './me.ts';
import { messageRoutes } from './messages.ts';
import { missionRoutes } from './missions.ts';
import { needRoutes } from './needs.ts';
import { personnelRoutes } from './personnel.ts';
import { referralRoutes } from './referrals.ts';
import { reportRoutes } from './reports.ts';
import { resourceRoutes } from './resources.ts';
import { roleRoutes } from './roles.ts';
import { rosterRoutes } from './roster.ts';
import { siteRoutes } from './sites.ts';
import { sharedRoutes } from './shared.ts';
import { tenantRoutes } from './tenants.ts';

/** What the server gives the routes that talk to the broker, object storage or the AI provider (absent in tests: poll fallback, no map extracts). */
export interface RouteDeps {
  dispatch?: DispatchDeps;
  fieldSync?: FieldSyncDeps;
  fieldVoice?: FieldVoiceDeps;
  fieldRecords?: FieldRecordDeps;
}

/** Route plugins mounted under /api/v1. Each layer adds its modules here. */
export const routesWith = (deps: RouteDeps = {}): FastifyPluginAsync[] => [
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
  needRoutes,
  siteRoutes,
  missionRoutes,
  rosterRoutes,
  fieldOpsRoutes,
  fieldAssessmentRoutes,
  fieldVoiceRoutes(deps.fieldVoice),
  fieldRecordRoutes(deps.fieldRecords ?? deps.fieldSync),
  dispatchRoutes(deps.dispatch),
  fieldSyncRoutes(deps.fieldSync),
  resourceRoutes(),
  contactRoutes,
  messageRoutes,
  referralRoutes,
];

/** The default set, as the tests mount it. */
export const routes: FastifyPluginAsync[] = routesWith();
