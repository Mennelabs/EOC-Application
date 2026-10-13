/**
 * "What can this role do" (ADM-04): runs the real decide() for every action
 * in the catalog against a synthetic subject holding only this role, so the
 * preview can never drift from runtime behaviour.
 */
import { actions, type ActionKey } from './actions.ts';
import { decide } from './engine.ts';
import { qualifiedProtectedCategories } from './guardrails.ts';
import {
  DATA_CATEGORIES,
  type AccountSubject,
  type DataCategory,
  type FieldDescriptor,
  type Grant,
} from './types.ts';

export interface RolePreview {
  allowedActions: {
    action: ActionKey;
    description: string;
    consequential: boolean;
    /** FLD-14: only records the holder of the role is assigned to (directly or through a team). */
    ownRecordsOnly: boolean;
  }[];
  deniedActions: ActionKey[];
  /** Field categories visible on records this role can read. */
  visibleCategories: DataCategory[];
  /** Categories this role can never see, and why. */
  hiddenCategories: { category: DataCategory; reason: string }[];
}

const SAMPLE_TENANT = '00000000-0000-0000-0000-00000000aaaa';
const SAMPLE_ACCOUNT = '00000000-0000-0000-0000-00000000bbbb';

export function previewRole(grants: Grant[], templateKey: string | null): RolePreview {
  const now = new Date();
  const subject: AccountSubject = {
    kind: 'account',
    accountId: SAMPLE_ACCOUNT,
    tenantId: SAMPLE_TENANT,
    tenantPath: 'sample',
    status: 'active',
    roles: [{ roleId: 'preview', key: 'preview', version: 0, templateKey, grants, scope: {} }],
    resolvedAt: now,
  };
  // No cji sample: G3 hard-denies any read touching CJI, which is the point
  // (SEC-12); the category is reported below as hidden with that reason.
  const sampleFields: FieldDescriptor[] = DATA_CATEGORIES.filter((c) => c !== 'cji').map(
    (category) => ({
      name: `sample_${category}`,
      category,
      classification: category === 'basic' ? 'internal' : 'restricted',
    }),
  );

  const allowed: RolePreview['allowedActions'] = [];
  const denied: ActionKey[] = [];
  const visible = new Set<DataCategory>();

  for (const key of Object.keys(actions) as ActionKey[]) {
    const meta = actions[key];
    const resource = {
      type: meta.resource,
      tenantId: SAMPLE_TENANT,
      tenantPath: 'sample',
      // Give the second-administrator guardrail something to approve.
      requestedBy: '00000000-0000-0000-0000-00000000cccc',
      changeRequestId: '00000000-0000-0000-0000-00000000dddd',
      changeRequestApproved: true,
      ...(meta.kind === 'read' ? { fields: sampleFields } : {}),
    };
    const d = decide(subject, key, resource, { now });
    if (d.effect === 'allow') {
      allowed.push({
        action: key,
        description: meta.description,
        consequential: meta.consequential === true,
        ownRecordsOnly: d.recordScope === 'own',
      });
      for (const name of d.fields) visible.add(name.replace('sample_', '') as DataCategory);
    } else {
      denied.push(key);
    }
  }

  const qualified = qualifiedProtectedCategories(subject);
  const hidden: RolePreview['hiddenCategories'] = [];
  for (const category of DATA_CATEGORIES) {
    if (visible.has(category)) continue;
    if (category === 'cji')
      hidden.push({
        category,
        reason: 'Criminal-justice data lives only in the CJIS enclave (SEC-12)',
      });
    else if (
      ['health', 'counseling', 'legal', 'access_needs'].includes(category) &&
      !qualified.has(category)
    ) {
      hidden.push({
        category,
        reason: 'Only the shipped role for this category can see it (ADM-05)',
      });
    } else if (allowed.some((a) => actions[a.action].kind === 'read')) {
      hidden.push({ category, reason: 'Not in this role’s data categories' });
    }
  }

  return {
    allowedActions: allowed,
    deniedActions: denied,
    visibleCategories: [...visible],
    hiddenCategories: hidden,
  };
}
