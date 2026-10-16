import type { FastifyPluginAsync } from 'fastify';
import { accountRoutes } from './accounts.ts';
import { aiRegisterRoutes } from './ai-register.ts';
import { auditRoutes } from './audit.ts';
import { commandAliasRoutes } from './command-aliases.ts';
import { commandRoutesWith, type CommandDeps } from './commands.ts';
import { breakGlassRoutes } from './breakglass.ts';
import { contactRoutes } from './contacts.ts';
import { declarationRoutesWith } from './declaration.ts';
import { femaMappingRoutes } from './fema-mappings.ts';
import { officialReportRoutesWith } from './official-reports.ts';
import type { DraftingDeps } from './drafting.ts';
import { definitionRoutes } from './definitions.ts';
import { dispatchRoutes, type DispatchDeps } from './dispatch.ts';
import { eventRoutes } from './events.ts';
import { exportRoutes, type ExportDeps } from './exports.ts';
import { jointPdaRoutes } from './joint-pda.ts';
import { metricRoutes } from './metrics.ts';
import { equityRoutes } from './equity.ts';
import { integrationRoutes } from './integrations.ts';
import { situationAreaRoutes } from './situation-areas.ts';
import { packagePhotoRoutes, type PackagePhotoDeps } from './package-photos.ts';
import { discoveryRoutes } from './discovery.ts';
import { facilityRoutes } from './facilities.ts';
import { fieldAssessmentRoutes } from './field-assessments.ts';
import { fieldOpsRoutes } from './field-ops.ts';
import { fieldRecordRoutes, type FieldRecordDeps } from './field-records.ts';
import { fieldSyncRoutes, type FieldSyncDeps } from './field-sync.ts';
import { fieldVoiceRoutes, type FieldVoiceDeps } from './field-voice.ts';
import { intakeGraphRoutes } from './intake-graphs.ts';
import { meRoutes } from './me.ts';
import { messageRoutes } from './messages.ts';
import { missionRoutesWith, type MissionDeps } from './missions.ts';
import { needRoutes } from './needs.ts';
import { personnelRoutes } from './personnel.ts';
import { recommendationRoutes } from './recommendations.ts';
import { referralRoutes } from './referrals.ts';
import { survivorLookupRoutes } from './survivor-lookup.ts';
import { sharedDocumentRoutes } from './shared-documents.ts';
import { refdataRoutes, type RefdataDeps } from './refdata.ts';
import { reportRoutes } from './reports.ts';
import { resourceRoutes } from './resources.ts';
import { roleRoutes } from './roles.ts';
import { rosterRoutes } from './roster.ts';
import { handoverRoutesWith } from './handover.ts';
import { translationRoutesWith } from './translation.ts';
import { scribeRoutesWith, type ScribeDeps } from './scribe.ts';
import { siteRoutesWith } from './sites.ts';
import { sharedRoutes } from './shared.ts';
import { situationRoutes } from './situation.ts';
import { tenantRoutes } from './tenants.ts';
import { volunteerRoutes } from './volunteers.ts';

/** What the server gives the routes that talk to the broker, object storage or the AI provider (absent in tests: poll fallback, no map extracts). */
export interface RouteDeps {
  dispatch?: DispatchDeps;
  exports?: ExportDeps;
  packagePhotos?: PackagePhotoDeps;
  fieldSync?: FieldSyncDeps;
  fieldVoice?: FieldVoiceDeps;
  fieldRecords?: FieldRecordDeps;
  missions?: MissionDeps;
  refdata?: RefdataDeps;
  metrics?: { productName?: string };
  commands?: CommandDeps;
  drafting?: DraftingDeps;
  scribe?: ScribeDeps;
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
  siteRoutesWith(deps.drafting),
  scribeRoutesWith(deps.scribe),
  handoverRoutesWith(deps.drafting),
  translationRoutesWith(deps.drafting),
  missionRoutesWith(deps.missions),
  rosterRoutes,
  volunteerRoutes,
  fieldOpsRoutes,
  fieldAssessmentRoutes,
  fieldVoiceRoutes(deps.fieldVoice),
  fieldRecordRoutes(deps.fieldRecords ?? deps.fieldSync),
  dispatchRoutes(deps.dispatch),
  situationRoutes,
  fieldSyncRoutes(deps.fieldSync),
  resourceRoutes(),
  contactRoutes,
  messageRoutes,
  referralRoutes,
  survivorLookupRoutes,
  sharedDocumentRoutes,
  refdataRoutes(deps.refdata),
  declarationRoutesWith(deps.drafting),
  officialReportRoutesWith(deps.drafting),
  femaMappingRoutes,
  exportRoutes(deps.exports),
  packagePhotoRoutes(deps.packagePhotos),
  jointPdaRoutes,
  metricRoutes(deps.metrics),
  equityRoutes,
  integrationRoutes,
  situationAreaRoutes,
  commandRoutesWith(deps.commands),
  commandAliasRoutes,
  facilityRoutes,
  recommendationRoutes,
  discoveryRoutes,
];

/** The default set, as the tests mount it. */
export const routes: FastifyPluginAsync[] = routesWith();
