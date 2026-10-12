/**
 * Validation for county-authored role grants (ADM-04). Rejects unknown
 * actions, unknown categories and any attempt to grant a template-protected
 * category (ADM-05 guardrail 7), so a bad role cannot even be saved.
 */
import { z } from 'zod';
import { actions } from './actions.ts';
import { DATA_CATEGORIES, TEMPLATE_PROTECTED_CATEGORIES, type Grant } from './types.ts';

const actionPattern = z
  .string()
  .min(1)
  .refine(
    (p) =>
      p === '*' ||
      Object.hasOwn(actions, p) ||
      (p.endsWith('.*') && Object.keys(actions).some((k) => k.startsWith(p.slice(0, -1)))),
    { message: 'unknown action' },
  );

export const grantSchema = z.object({
  action: actionPattern,
  tenants: z.union([z.literal('own'), z.literal('subtree'), z.array(z.uuid()).min(1)]).optional(),
  events: z.enum(['all', 'assigned']).optional(),
  dataCategories: z
    .array(z.enum(DATA_CATEGORIES as [string, ...string[]]))
    .optional()
    .refine(
      (cats) =>
        !cats?.some(
          (c) => (TEMPLATE_PROTECTED_CATEGORIES as readonly string[]).includes(c) || c === 'cji',
        ),
      {
        message: 'protected categories come only from role templates (ADM-05)',
      },
    ),
});

export const grantsSchema = z.array(grantSchema).max(200);

export interface GrantValidation {
  ok: boolean;
  errors: string[];
}

export function validateGrants(input: unknown): GrantValidation {
  const parsed = grantsSchema.safeParse(input);
  if (parsed.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

export function asGrants(input: unknown): Grant[] {
  return grantsSchema.parse(input) as Grant[];
}
