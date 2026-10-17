export * from './types.ts';
export {
  actions,
  actionMatches,
  isActionKey,
  SELF_REVIEW_ACTIONS,
  type ActionKey,
  type ActionMeta,
} from './actions.ts';
export { guardrails, qualifiedProtectedCategories, type Guardrail } from './guardrails.ts';
export { decide, type DecideOptions } from './engine.ts';
export {
  roleTemplates,
  templateByKey,
  CATEGORY_TEMPLATES,
  type RoleTemplate,
} from './templates.ts';
export { validateGrants, asGrants, grantSchema, grantsSchema } from './grants.ts';
export { previewRole, type RolePreview } from './preview.ts';
export {
  SHARING_SERVICES,
  SECTION_CATEGORY,
  SECTIONS_BY_SERVICE,
  RESTRICTED_SECTIONS,
  CASE_SECTION,
  isSharingService,
  sectionsFor,
  deriveGrants,
  householdBand,
  project,
  type SharingService,
  type SharingSection,
  type SharingAgreement,
  type SharingConsent,
  type SharingSubject,
  type DerivedGrant,
  type SharingFacts,
  type Projection,
} from './sharing.ts';
