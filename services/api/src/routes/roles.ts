/**
 * Roles, versions, preview, permission change requests and assignments
 * (ADM-04, ADM-05, BRD:FR-01.03, Section 30.2).
 *
 * - A role is created from a template or from scratch; version 1 is current.
 * - Editing a role creates a draft version; it becomes current only through a
 *   permission change request approved by a second administrator.
 * - Assignments exist only by approved change request (guardrail G6).
 * - Revocation is immediate (security must never wait on a second person).
 * - The preview runs the real policy engine.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import {
  asGrants,
  previewRole,
  roleTemplates,
  templateByKey,
  validateGrants,
  type Grant,
} from '@cg/authz';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso, listQuery, stamped, uuidParam } from './helpers.ts';

const grantSchema = z.object({
  action: z.string(),
  tenants: z.union([z.literal('own'), z.literal('subtree'), z.array(z.uuid())]).optional(),
  events: z.enum(['all', 'assigned']).optional(),
  records: z.enum(['all', 'own']).optional(),
  dataCategories: z.array(z.string()).optional(),
});

const roleOut = z.object({
  ...stamped,
  tenantId: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  templateKey: z.string().nullable(),
  currentVersion: z.number().int(),
  status: z.enum(['active', 'retired']),
});

const versionOut = z.object({
  version: z.number().int(),
  grants: z.array(grantSchema),
  changeReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  createdBy: z.uuid().nullable(),
  current: z.boolean(),
});

const previewOut = z.object({
  allowedActions: z.array(
    z.object({
      action: z.string(),
      description: z.string(),
      consequential: z.boolean(),
      ownRecordsOnly: z.boolean(),
    }),
  ),
  deniedActions: z.array(z.string()),
  visibleCategories: z.array(z.string()),
  hiddenCategories: z.array(z.object({ category: z.string(), reason: z.string() })),
});

const changeRequestOut = z.object({
  ...stamped,
  kind: z.enum(['assign_role', 'revoke_role', 'publish_role_version']),
  payload: z.record(z.string(), z.unknown()),
  requestedBy: z.uuid(),
  requestedAt: z.iso.datetime(),
  status: z.enum(['pending', 'approved', 'rejected', 'applied', 'expired', 'withdrawn']),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});

const assignmentOut = z.object({
  ...stamped,
  accountId: z.uuid(),
  roleId: z.uuid(),
  scope: z.record(z.string(), z.unknown()),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  status: z.enum(['active', 'revoked']),
  grantedBy: z.uuid(),
  approvedBy: z.uuid(),
});

const assignPayload = z.object({
  kind: z.literal('assign_role'),
  accountId: z.uuid(),
  roleId: z.uuid(),
  scope: z.object({ eventIds: z.array(z.uuid()).optional() }).default({}),
  validTo: z.iso.datetime().optional(),
});
const publishPayload = z.object({
  kind: z.literal('publish_role_version'),
  roleId: z.uuid(),
  version: z.number().int().min(1),
});
const changeRequestBody = z.discriminatedUnion('kind', [assignPayload, publishPayload]);

type RoleRow = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  tenant_id: string;
  key: string;
  name: string;
  description: string | null;
  template_key: string | null;
  current_version: number;
  status: 'active' | 'retired';
};
const toRole = (r: RoleRow): z.infer<typeof roleOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  tenantId: r.tenant_id,
  key: r.key,
  name: r.name,
  description: r.description,
  templateKey: r.template_key,
  currentVersion: r.current_version,
  status: r.status,
});

type CrRow = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  kind: 'assign_role' | 'revoke_role' | 'publish_role_version';
  payload: unknown;
  requested_by: string;
  requested_at: Date;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'expired' | 'withdrawn';
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  expires_at: Date;
};
const toChangeRequest = (r: CrRow): z.infer<typeof changeRequestOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  kind: r.kind,
  payload: (r.payload as Record<string, unknown>) ?? {},
  requestedBy: r.requested_by,
  requestedAt: iso(r.requested_at)!,
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: iso(r.decided_at),
  decisionReason: r.decision_reason,
  expiresAt: iso(r.expires_at)!,
});

type AsgRow = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  account_id: string;
  role_id: string;
  scope: unknown;
  valid_from: Date;
  valid_to: Date | null;
  status: 'active' | 'revoked';
  granted_by: string;
  approved_by: string;
};
const toAssignment = (r: AsgRow): z.infer<typeof assignmentOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  accountId: r.account_id,
  roleId: r.role_id,
  scope: (r.scope as Record<string, unknown>) ?? {},
  validFrom: iso(r.valid_from)!,
  validTo: iso(r.valid_to),
  status: r.status,
  grantedBy: r.granted_by,
  approvedBy: r.approved_by,
});

export const roleRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  // --- templates and preview -------------------------------------------------
  app.get(
    '/role-templates',
    {
      schema: {
        tags: ['roles'],
        response: {
          200: z.array(
            z.object({
              key: z.string(),
              name: z.string(),
              description: z.string(),
              source: z.string(),
              grants: z.array(grantSchema),
            }),
          ),
        },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('role.read', { type: 'role', tenantId: s.tenantId });
      return roleTemplates.map((t) => ({
        ...t,
        grants: t.grants as z.infer<typeof grantSchema>[],
      }));
    },
  );

  app.post(
    '/roles/preview',
    {
      schema: {
        tags: ['roles'],
        body: z.object({
          grants: z.array(grantSchema),
          templateKey: z.string().nullable().default(null),
        }),
        response: {
          200: previewOut,
          400: z
            .object({
              code: z.string(),
              message: z.string(),
              fields: z.array(z.object({ name: z.string(), message: z.string() })),
            })
            .passthrough(),
        },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('role.preview', { type: 'role', tenantId: s.tenantId });
      const v = validateGrants(request.body.grants);
      if (!v.ok) throw errors.validation(v.errors.map((message) => ({ name: 'grants', message })));
      return previewRole(asGrants(request.body.grants), request.body.templateKey);
    },
  );

  // --- roles -----------------------------------------------------------------
  app.get(
    '/roles',
    { schema: { tags: ['roles'], querystring: listQuery, response: { 200: z.array(roleOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('role.read', { type: 'role', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.role')
          .selectAll()
          .orderBy('name')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map(toRole);
    },
  );

  app.get(
    '/roles/:id',
    {
      schema: {
        tags: ['roles'],
        params: uuidParam,
        response: { 200: roleOut.extend({ versions: z.array(versionOut), preview: previewOut }) },
      },
    },
    async (request) => {
      const role = await request.tx((trx) =>
        trx
          .selectFrom('cg.role')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!role) throw errors.notFound();
      await request.authorize(
        'role.read',
        { type: 'role', id: role.id, tenantId: role.tenant_id },
        { asNotFound: true },
      );
      const versions = await request.tx((trx) =>
        trx
          .selectFrom('cg.role_version')
          .selectAll()
          .where('role_id', '=', role.id)
          .orderBy('version', 'desc')
          .execute(),
      );
      const current = versions.find((v) => v.version === role.current_version);
      return {
        ...toRole(role),
        versions: versions.map((v) => ({
          version: v.version,
          grants: v.grants as z.infer<typeof grantSchema>[],
          changeReason: v.change_reason,
          createdAt: iso(v.created_at)!,
          createdBy: v.created_by,
          current: v.version === role.current_version,
        })),
        preview: previewRole((current?.grants as Grant[]) ?? [], role.template_key),
      };
    },
  );

  app.post(
    '/roles',
    {
      config: { idempotent: true },
      schema: {
        tags: ['roles'],
        body: z.object({
          key: z
            .string()
            .min(2)
            .max(60)
            .regex(/^[a-z][a-z0-9_]*$/),
          name: z.string().min(1).max(120),
          description: z.string().max(1000).optional(),
          templateKey: z.string().optional(),
          grants: z.array(grantSchema).optional(),
        }),
        response: { 201: roleOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('role.create', { type: 'role', tenantId: s.tenantId });
      const template = request.body.templateKey
        ? templateByKey.get(request.body.templateKey)
        : undefined;
      if (request.body.templateKey && !template) {
        throw errors.validation([{ name: 'templateKey', message: 'unknown template' }]);
      }
      const grantsInput = request.body.grants ?? template?.grants ?? [];
      const v = validateGrants(grantsInput);
      if (!v.ok) throw errors.validation(v.errors.map((message) => ({ name: 'grants', message })));
      const grants = asGrants(grantsInput);
      const row = await request.tx(async (trx) => {
        const role = await trx
          .insertInto('cg.role')
          .values({
            tenant_id: s.tenantId,
            key: request.body.key,
            name: request.body.name,
            description: request.body.description ?? template?.description ?? null,
            template_key: template?.key ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.role_version')
          .values({
            tenant_id: s.tenantId,
            role_id: role.id,
            version: 1,
            grants: JSON.stringify(grants),
            change_reason: 'created',
            created_by: s.accountId,
          })
          .execute();
        await request.audit(trx, {
          action: 'role.create',
          targetType: 'role',
          targetId: role.id,
          targetVersion: role.version,
          changes: diffForAudit(
            null,
            { key: role.key, name: role.name, template_key: role.template_key, grants },
            classifierFor('role'),
          ),
        });
        return role;
      });
      return reply.code(201).send(toRole(row));
    },
  );

  // A draft version: becomes current only via an approved publish request.
  app.post(
    '/roles/:id/versions',
    {
      config: { idempotent: true },
      schema: {
        tags: ['roles'],
        params: uuidParam,
        body: z.object({ grants: z.array(grantSchema), changeReason: z.string().min(3).max(500) }),
        response: { 201: versionOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const role = await request.tx((trx) =>
        trx
          .selectFrom('cg.role')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!role) throw errors.notFound();
      await request.authorize(
        'role.edit',
        { type: 'role', id: role.id, tenantId: role.tenant_id },
        { asNotFound: true },
      );
      const v = validateGrants(request.body.grants);
      if (!v.ok) throw errors.validation(v.errors.map((message) => ({ name: 'grants', message })));
      const grants = asGrants(request.body.grants);
      const row = await request.tx(async (trx) => {
        const last = await trx
          .selectFrom('cg.role_version')
          .select((eb) => eb.fn.max('version').as('max'))
          .where('role_id', '=', role.id)
          .executeTakeFirstOrThrow();
        const next = Number(last.max ?? 0) + 1;
        const inserted = await trx
          .insertInto('cg.role_version')
          .values({
            tenant_id: s.tenantId,
            role_id: role.id,
            version: next,
            grants: JSON.stringify(grants),
            change_reason: request.body.changeReason,
            created_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'role.edit',
          targetType: 'role',
          targetId: role.id,
          targetVersion: next,
          changes: diffForAudit(
            null,
            { draft_version: next, grants },
            classifierFor('role_version'),
          ),
          reason: request.body.changeReason,
        });
        return inserted;
      });
      return reply.code(201).send({
        version: row.version,
        grants: row.grants as z.infer<typeof grantSchema>[],
        changeReason: row.change_reason,
        createdAt: iso(row.created_at)!,
        createdBy: row.created_by,
        current: false,
      });
    },
  );

  // --- permission change requests (second administrator) --------------------
  app.get(
    '/permission-changes',
    {
      schema: {
        tags: ['permissions'],
        querystring: listQuery.extend({ status: z.string().optional() }),
        response: { 200: z.array(changeRequestOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('permission_change.read', {
        type: 'permission_change_request',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) => {
        let q = trx
          .selectFrom('cg.permission_change_request')
          .selectAll()
          .orderBy('requested_at', 'desc');
        if (request.query.status)
          q = q.where('status', '=', request.query.status as CrRow['status']);
        return q.limit(request.query.limit).offset(request.query.offset).execute();
      });
      return rows.map(toChangeRequest);
    },
  );

  app.post(
    '/permission-changes',
    {
      config: { idempotent: true },
      schema: {
        tags: ['permissions'],
        body: changeRequestBody,
        response: { 201: changeRequestOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('permission_change.request', {
        type: 'permission_change_request',
        tenantId: s.tenantId,
      });
      const body = request.body;
      const row = await request.tx(async (trx) => {
        // Validate targets exist in this tenant before recording the request.
        const role = await trx
          .selectFrom('cg.role')
          .select(['id', 'status'])
          .where('id', '=', body.roleId)
          .executeTakeFirst();
        if (!role || role.status !== 'active')
          throw errors.validation([{ name: 'roleId', message: 'unknown or retired role' }]);
        if (body.kind === 'assign_role') {
          const account = await trx
            .selectFrom('cg.account')
            .select(['id', 'status'])
            .where('id', '=', body.accountId)
            .executeTakeFirst();
          if (!account || account.status === 'deactivated')
            throw errors.validation([
              { name: 'accountId', message: 'unknown or deactivated account' },
            ]);
        } else {
          const version = await trx
            .selectFrom('cg.role_version')
            .select('version')
            .where('role_id', '=', body.roleId)
            .where('version', '=', body.version)
            .executeTakeFirst();
          if (!version)
            throw errors.validation([{ name: 'version', message: 'unknown role version' }]);
        }
        const { kind, ...payload } = body;
        const inserted = await trx
          .insertInto('cg.permission_change_request')
          .values({
            tenant_id: s.tenantId,
            kind,
            payload: JSON.stringify(payload),
            requested_by: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'permission_change.request',
          targetType: 'permission_change_request',
          targetId: inserted.id,
          changes: diffForAudit(
            null,
            { kind, ...payload },
            classifierFor('permission_change_request'),
          ),
        });
        return inserted;
      });
      return reply.code(201).send(toChangeRequest(row));
    },
  );

  for (const decision of ['approve', 'reject', 'withdraw'] as const) {
    app.post(
      `/permission-changes/:id/${decision}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['permissions'], params: uuidParam, response: { 200: changeRequestOut } },
      },
      async (request) => {
        const s = request.subject;
        if (s.kind !== 'account') throw errors.unauthorized();
        const expected = request.expectedVersion();
        const cr = await request.tx((trx) =>
          trx
            .selectFrom('cg.permission_change_request')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!cr) throw errors.notFound();
        const action = `permission_change.${decision}` as const;
        await request.authorize(
          action,
          {
            type: 'permission_change_request',
            id: cr.id,
            tenantId: s.tenantId,
            requestedBy: cr.requested_by,
          },
          { asNotFound: true },
        );
        if (decision === 'withdraw' && cr.requested_by !== s.accountId) throw errors.notFound();
        const { reason } = request.confirmation();
        if (cr.status !== 'pending') throw errors.conflict(toChangeRequest(cr));
        if (cr.expires_at.getTime() < Date.now())
          throw errors.conflict({ ...toChangeRequest(cr), status: 'expired' });
        const now = new Date();
        const updated = await request.tx(async (trx) => {
          const nextStatus =
            decision === 'approve' ? 'applied' : decision === 'reject' ? 'rejected' : 'withdrawn';
          const row = assertUpdated(
            await trx
              .updateTable('cg.permission_change_request')
              .set({
                status: nextStatus,
                decided_by: s.accountId,
                decided_at: now,
                decision_reason: reason,
                ...(decision === 'approve' ? { applied_at: now } : {}),
                updated_by: s.accountId,
              })
              .where('id', '=', cr.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            toChangeRequest(cr),
          );
          await request.audit(trx, {
            action,
            targetType: 'permission_change_request',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(
              { status: cr.status },
              { status: row.status },
              classifierFor('permission_change_request'),
            ),
            reason,
          });
          if (decision !== 'approve') return row;

          // Apply: the approver is the second administrator (G6 checked both calls).
          const payload = cr.payload as Record<string, unknown>;
          if (cr.kind === 'assign_role') {
            await request.authorize('role_assignment.create', {
              type: 'role_assignment',
              tenantId: s.tenantId,
              changeRequestId: cr.id,
              changeRequestApproved: true,
              requestedBy: cr.requested_by,
            });
            const inserted = await trx
              .insertInto('cg.role_assignment')
              .values({
                tenant_id: s.tenantId,
                account_id: String(payload['accountId']),
                role_id: String(payload['roleId']),
                scope: JSON.stringify(payload['scope'] ?? {}),
                valid_to: payload['validTo'] ? new Date(String(payload['validTo'])) : null,
                granted_by: cr.requested_by,
                approved_by: s.accountId,
                change_request_id: cr.id,
                created_by: s.accountId,
                updated_by: s.accountId,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await request.audit(trx, {
              action: 'role_assignment.create',
              targetType: 'role_assignment',
              targetId: inserted.id,
              targetVersion: inserted.version,
              changes: diffForAudit(
                null,
                {
                  account_id: inserted.account_id,
                  role_id: inserted.role_id,
                  scope: payload['scope'] ?? {},
                },
                classifierFor('role_assignment'),
              ),
              reason,
            });
          } else if (cr.kind === 'publish_role_version') {
            await request.authorize('role.publish', {
              type: 'role',
              id: String(payload['roleId']),
              tenantId: s.tenantId,
              requestedBy: cr.requested_by,
            });
            const role = await trx
              .updateTable('cg.role')
              .set({ current_version: Number(payload['version']), updated_by: s.accountId })
              .where('id', '=', String(payload['roleId']))
              .returningAll()
              .executeTakeFirstOrThrow();
            await request.audit(trx, {
              action: 'role.publish',
              targetType: 'role',
              targetId: role.id,
              targetVersion: role.version,
              changes: { fields: [{ name: 'current_version', to: role.current_version }] },
              reason,
            });
          }
          return row;
        });
        return toChangeRequest(updated);
      },
    );
  }

  // --- assignments -----------------------------------------------------------
  app.get(
    '/role-assignments',
    {
      schema: {
        tags: ['permissions'],
        querystring: listQuery.extend({ accountId: z.uuid().optional() }),
        response: { 200: z.array(assignmentOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('role_assignment.read', {
        type: 'role_assignment',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) => {
        let q = trx.selectFrom('cg.role_assignment').selectAll().orderBy('created_at', 'desc');
        if (request.query.accountId) q = q.where('account_id', '=', request.query.accountId);
        return q.limit(request.query.limit).offset(request.query.offset).execute();
      });
      return rows.map(toAssignment);
    },
  );

  app.post(
    '/role-assignments/:id/revoke',
    {
      config: { requiresVersion: true },
      schema: { tags: ['permissions'], params: uuidParam, response: { 200: assignmentOut } },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.role_assignment')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'role_assignment.revoke',
        { type: 'role_assignment', id: current.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      if (current.status !== 'active') throw errors.conflict(toAssignment(current));
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.role_assignment')
            .set({
              status: 'revoked',
              revoked_at: new Date(),
              revoked_by: s.accountId,
              revoke_reason: reason,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toAssignment(current),
        );
        await request.audit(trx, {
          action: 'role_assignment.revoke',
          targetType: 'role_assignment',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(
            { status: current.status },
            { status: row.status },
            classifierFor('role_assignment'),
          ),
          reason,
        });
        return row;
      });
      return toAssignment(updated);
    },
  );
};
