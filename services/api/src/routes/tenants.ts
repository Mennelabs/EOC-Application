/**
 * Tenants, data-sharing agreements and tenant configuration (SCL-01, SCL-07,
 * ADM-01, BRD:FR-18.01/02). A new child tenant is created as 'provisioning';
 * the worker seeds its defaults and identity realm, then activates it.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import {
  classifierFor,
  enqueueOutbox,
  iso,
  listQuery,
  pickDefined,
  stamped,
  uuidParam,
} from './helpers.ts';

const tenantKinds = ['state', 'region', 'county', 'city', 'partner_org'] as const;

const tenantOut = z.object({
  ...stamped,
  kind: z.enum(tenantKinds),
  parentId: z.uuid().nullable(),
  slug: z.string(),
  name: z.string(),
  timezone: z.string(),
  locales: z.array(z.string()),
  status: z.enum(['provisioning', 'active', 'suspended', 'closed']),
  securityContactEmail: z.string().nullable(),
  branding: z.record(z.string(), z.unknown()),
});

type TenantRow = {
  id: string;
  kind: (typeof tenantKinds)[number];
  parent_id: string | null;
  slug: string;
  name: string;
  timezone: string;
  locales: string[];
  status: 'provisioning' | 'active' | 'suspended' | 'closed';
  security_contact_email: string | null;
  branding: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
  path?: string;
};

const toTenant = (r: TenantRow): z.infer<typeof tenantOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  kind: r.kind,
  parentId: r.parent_id,
  slug: r.slug,
  name: r.name,
  timezone: r.timezone,
  locales: r.locales,
  status: r.status,
  securityContactEmail: r.security_contact_email,
  branding: (r.branding as Record<string, unknown>) ?? {},
});

const createTenant = z.object({
  parentId: z.uuid(),
  kind: z.enum(['region', 'county', 'city', 'partner_org']),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'),
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).default('America/Chicago'),
  locales: z.array(z.string().min(2).max(10)).min(1).default(['en', 'es']),
  securityContactEmail: z.email().optional(),
});

const patchTenant = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).optional(),
  locales: z.array(z.string().min(2).max(10)).min(1).optional(),
  securityContactEmail: z.email().nullable().optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['active', 'suspended', 'closed']).optional(),
});

const agreementOut = z.object({
  ...stamped,
  fromTenantId: z.uuid(),
  toTenantId: z.uuid(),
  scope: z.enum(['deidentified_counts', 'consented_records', 'full_records']),
  dataCategories: z.array(z.string()),
  status: z.enum(['draft', 'signed', 'revoked']),
  signedAt: z.iso.datetime().nullable(),
  signedBy: z.uuid().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  /** What the agreement is for: organization type and service for sharing (layer 3, NED-04). */
  terms: z.record(z.string(), z.unknown()),
});

const configOut = z.object({
  key: z.string(),
  value: z.unknown(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});

export const tenantRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/tenants',
    {
      schema: { tags: ['tenants'], querystring: listQuery, response: { 200: z.array(tenantOut) } },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('tenant.read', { type: 'tenant', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.tenant')
          .selectAll()
          .orderBy('path')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map(toTenant);
    },
  );

  app.get(
    '/tenants/:id',
    { schema: { tags: ['tenants'], params: uuidParam, response: { 200: tenantOut } } },
    async (request) => {
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.tenant')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      await request.authorize(
        'tenant.read',
        { type: 'tenant', id: row.id, tenantId: row.id, tenantPath: row.path },
        { asNotFound: true },
      );
      return toTenant(row);
    },
  );

  app.post(
    '/tenants',
    {
      config: { idempotent: true },
      schema: { tags: ['tenants'], body: createTenant, response: { 201: tenantOut } },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const body = request.body;
      // The parent is the acting tenant: RLS only lets a tenant create its own children.
      await request.authorize('tenant.create_child', { type: 'tenant', tenantId: body.parentId });
      const { reason } = request.confirmation();
      const row = await request.tx(async (trx) => {
        const parent = await trx
          .selectFrom('cg.tenant')
          .select(['id', 'kind'])
          .where('id', '=', body.parentId)
          .executeTakeFirst();
        if (!parent) throw errors.notFound();
        const inserted = await trx
          .insertInto('cg.tenant')
          .values({
            kind: body.kind,
            parent_id: body.parentId,
            slug: body.slug,
            name: body.name,
            timezone: body.timezone,
            locales: body.locales,
            status: 'provisioning',
            security_contact_email: body.securityContactEmail ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'tenant.create_child',
          targetType: 'tenant',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            { kind: inserted.kind, slug: inserted.slug, name: inserted.name },
            classifierFor('tenant'),
          ),
          reason,
        });
        await enqueueOutbox(
          trx,
          s.tenantId,
          'tenant.provision',
          { tenantId: inserted.id },
          request.executionId,
        );
        return inserted;
      });
      return reply.code(201).send(toTenant(row));
    },
  );

  app.patch(
    '/tenants/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['tenants'],
        params: uuidParam,
        body: patchTenant,
        response: { 200: tenantOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.tenant')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'tenant.update',
        { type: 'tenant', id: current.id, tenantId: current.id, tenantPath: current.path },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      const changes = pickDefined(request.body, {
        name: 'name',
        timezone: 'timezone',
        locales: 'locales',
        securityContactEmail: 'security_contact_email',
        branding: 'branding',
        status: 'status',
      });
      if (typeof changes['branding'] === 'object' && changes['branding'] !== null) {
        changes['branding'] = JSON.stringify(changes['branding']);
      }
      const updated = await request.tx(async (trx) => {
        const row = await trx
          .updateTable('cg.tenant')
          .set({ ...changes, updated_by: s.accountId })
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        const result = assertUpdated(row, toTenant(current));
        await request.audit(trx, {
          action: 'tenant.update',
          targetType: 'tenant',
          targetId: result.id,
          targetVersion: result.version,
          changes: diffForAudit(current, result, classifierFor('tenant')),
          reason,
        });
        return result;
      });
      return toTenant(updated);
    },
  );

  // --- configuration (SCL-07), versioned with history ---------------------
  app.get(
    '/tenants/:id/config/:key',
    {
      schema: {
        tags: ['tenants'],
        params: uuidParam.extend({ key: z.string().min(1).max(120) }),
        response: { 200: configOut },
      },
    },
    async (request) => {
      await request.authorize(
        'tenant.config.read',
        { type: 'tenant_config', tenantId: request.params.id },
        { asNotFound: true },
      );
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.tenant_config')
          .selectAll()
          .where('tenant_id', '=', request.params.id)
          .where('key', '=', request.params.key)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      return {
        key: row.key,
        value: row.value,
        version: row.version,
        updatedAt: iso(row.updated_at)!,
      };
    },
  );

  app.put(
    '/tenants/:id/config/:key',
    {
      schema: {
        tags: ['tenants'],
        params: uuidParam.extend({ key: z.string().min(1).max(120) }),
        body: z.object({ value: z.unknown() }),
        response: { 200: configOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize(
        'tenant.config.write',
        { type: 'tenant_config', tenantId: request.params.id },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      const value = JSON.stringify(request.body.value ?? null);
      const row = await request.tx(async (trx) => {
        const existing = await trx
          .selectFrom('cg.tenant_config')
          .selectAll()
          .where('tenant_id', '=', request.params.id)
          .where('key', '=', request.params.key)
          .executeTakeFirst();
        let saved;
        if (existing) {
          const expected = request.expectedVersion();
          saved = assertUpdated(
            await trx
              .updateTable('cg.tenant_config')
              .set({ value, updated_by: s.accountId })
              .where('tenant_id', '=', request.params.id)
              .where('key', '=', request.params.key)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            { key: existing.key, version: existing.version, value: existing.value },
          );
        } else {
          saved = await trx
            .insertInto('cg.tenant_config')
            .values({
              tenant_id: request.params.id,
              key: request.params.key,
              value,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        await request.audit(trx, {
          action: 'tenant.config.write',
          targetType: 'tenant_config',
          targetId: request.params.key,
          targetVersion: saved.version,
          changes: diffForAudit(
            { value: existing?.value },
            { value: saved.value },
            classifierFor('tenant_config'),
          ),
          reason,
        });
        return saved;
      });
      return {
        key: row.key,
        value: row.value,
        version: row.version,
        updatedAt: iso(row.updated_at)!,
      };
    },
  );

  // --- data-sharing agreements (SCL-01) ---------------------------------------
  const toAgreement = (r: {
    id: string;
    version: number;
    created_at: Date;
    updated_at: Date;
    from_tenant_id: string;
    to_tenant_id: string;
    scope: 'deidentified_counts' | 'consented_records' | 'full_records';
    data_categories: string[];
    status: 'draft' | 'signed' | 'revoked';
    signed_at: Date | null;
    signed_by: string | null;
    revoked_at: Date | null;
    terms: unknown;
  }): z.infer<typeof agreementOut> => ({
    id: r.id,
    version: r.version,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    fromTenantId: r.from_tenant_id,
    toTenantId: r.to_tenant_id,
    scope: r.scope,
    dataCategories: r.data_categories,
    status: r.status,
    signedAt: iso(r.signed_at),
    signedBy: r.signed_by,
    revokedAt: iso(r.revoked_at),
    terms: (r.terms ?? {}) as Record<string, unknown>,
  });

  app.get(
    '/agreements',
    { schema: { tags: ['agreements'], response: { 200: z.array(agreementOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('dsa.read', { type: 'data_sharing_agreement', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.data_sharing_agreement')
          .selectAll()
          .orderBy('created_at', 'desc')
          .execute(),
      );
      return rows.map(toAgreement);
    },
  );

  app.post(
    '/agreements',
    {
      config: { idempotent: true },
      schema: {
        tags: ['agreements'],
        body: z.object({
          toTenantId: z.uuid(),
          scope: z.enum(['deidentified_counts', 'consented_records', 'full_records']),
          dataCategories: z.array(z.string().min(1)).default([]),
          terms: z.record(z.string(), z.unknown()).default({}),
        }),
        response: { 201: agreementOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('dsa.create', {
        type: 'data_sharing_agreement',
        tenantId: s.tenantId,
      });
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.data_sharing_agreement')
          .values({
            from_tenant_id: s.tenantId,
            to_tenant_id: request.body.toTenantId,
            scope: request.body.scope,
            data_categories: request.body.dataCategories,
            terms: JSON.stringify(request.body.terms),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'dsa.create',
          targetType: 'data_sharing_agreement',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            { to_tenant_id: inserted.to_tenant_id, scope: inserted.scope },
            classifierFor('data_sharing_agreement'),
          ),
        });
        return inserted;
      });
      return reply.code(201).send(toAgreement(row));
    },
  );

  for (const transition of ['sign', 'revoke'] as const) {
    app.post(
      `/agreements/:id/${transition}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['agreements'], params: uuidParam, response: { 200: agreementOut } },
      },
      async (request) => {
        const s = request.subject;
        if (s.kind !== 'account') throw errors.unauthorized();
        const expected = request.expectedVersion();
        const current = await request.tx((trx) =>
          trx
            .selectFrom('cg.data_sharing_agreement')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!current) throw errors.notFound();
        // The receiving tenant signs; the granting tenant revokes.
        const actingSide = transition === 'sign' ? current.to_tenant_id : current.from_tenant_id;
        if (actingSide !== s.tenantId) throw errors.notFound();
        await request.authorize(
          transition === 'sign' ? 'dsa.sign' : 'dsa.revoke',
          { type: 'data_sharing_agreement', id: current.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        const { reason } = request.confirmation();
        const wanted = transition === 'sign' ? 'draft' : 'signed';
        if (current.status !== wanted) throw errors.conflict(toAgreement(current));
        const now = new Date();
        const updated = await request.tx(async (trx) => {
          const row = assertUpdated(
            await trx
              .updateTable('cg.data_sharing_agreement')
              .set(
                transition === 'sign'
                  ? {
                      status: 'signed',
                      signed_at: now,
                      signed_by: s.accountId,
                      updated_by: s.accountId,
                    }
                  : {
                      status: 'revoked',
                      revoked_at: now,
                      revoked_by: s.accountId,
                      updated_by: s.accountId,
                    },
              )
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            toAgreement(current),
          );
          await request.audit(trx, {
            action: transition === 'sign' ? 'dsa.sign' : 'dsa.revoke',
            targetType: 'data_sharing_agreement',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(
              { status: current.status },
              { status: row.status },
              classifierFor('data_sharing_agreement'),
            ),
            reason,
          });
          return row;
        });
        return toAgreement(updated);
      },
    );
  }
};
