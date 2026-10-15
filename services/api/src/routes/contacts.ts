/**
 * Interagency contact registry (BRD:FR-17.01/17.02, CNT-01, F17, SEC-10,
 * SEC-18): who to reach at each agency, 24-hour and backup contacts, media
 * and liaison roles, with verification dates and a re-verification due date.
 * Names and reach-me details are restricted: encrypted at rest, shown only to
 * roles with the contact category, every such read audited.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { FieldDescriptor } from '@cg/authz';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type ContactRow = Selectable<Database['cg.partner_contact']>;

const types = ['operations', 'twenty_four_hour', 'backup', 'media', 'liaison'] as const;
const FIELDS: FieldDescriptor[] = [
  { name: 'name', category: 'contact', classification: 'restricted' },
  { name: 'methods', category: 'contact', classification: 'restricted' },
];
const DEFAULT_VERIFY_DAYS = 180;

const methodsIn = z.object({
  phone: z.string().max(40).optional(),
  phoneAfterHours: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  radio: z.string().max(100).optional(),
  other: z.string().max(200).optional(),
});

const contactOut = z.object({
  ...stamped,
  orgTenantId: z.uuid().nullable(),
  agency: z.string(),
  role: z.string().nullable(),
  type: z.enum(types),
  active: z.boolean(),
  verifiedAt: z.iso.datetime().nullable(),
  verifyBy: z.string().nullable(),
  /** Past the re-verification date (seasonal reminder, F17). */
  due: z.boolean(),
  backupOf: z.uuid().nullable(),
  ownerAccountId: z.uuid().nullable(),
  name: z.string().nullable(),
  methods: methodsIn.nullable(),
});

export const contactRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  const dateOnly = (d: Date | string | null) =>
    d === null ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

  async function toOut(r: ContactRow, fields: string[]) {
    const name = fields.includes('name')
      ? await app.fieldCrypto.decrypt(r.tenant_id, r.name_enc)
      : null;
    const methods = fields.includes('methods')
      ? (JSON.parse(await app.fieldCrypto.decrypt(r.tenant_id, r.methods_enc)) as z.infer<
          typeof methodsIn
        >)
      : null;
    const verifyBy = dateOnly(r.verify_by);
    return {
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      orgTenantId: r.org_tenant_id,
      agency: r.agency,
      role: r.role,
      type: r.type,
      active: r.active,
      verifiedAt: iso(r.verified_at),
      verifyBy,
      due: Boolean(verifyBy && verifyBy < new Date().toISOString().slice(0, 10)),
      backupOf: r.backup_of,
      ownerAccountId: r.owner_account_id,
      name,
      methods,
    };
  }

  async function load(request: FastifyRequest, id: string): Promise<ContactRow> {
    const row = await request.tx((trx) =>
      trx.selectFrom('cg.partner_contact').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!row) throw errors.notFound();
    return row;
  }

  app.get(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        querystring: listQuery.extend({
          type: z.enum(types).optional(),
          active: z.coerce.boolean().optional(),
          due: z.coerce.boolean().optional(),
          /** CMD-17: part of the agency's name. */
          agency: z.string().trim().min(1).max(120).optional(),
        }),
        response: { 200: z.array(contactOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const decision = await request.authorize('contact.read', {
        type: 'partner_contact',
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.partner_contact')
          .selectAll()
          .orderBy('agency')
          .orderBy('type')
          .limit(q.limit)
          .offset(q.offset);
        if (q.type) x = x.where('type', '=', q.type);
        if (q.active !== undefined) x = x.where('active', '=', q.active);
        if (q.agency)
          x = x.where('agency', 'ilike', `%${q.agency.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        return x.execute();
      });
      const out = [];
      for (const r of rows) out.push(await toOut(r, decision.fields));
      if (decision.restrictedRead.length > 0 && rows.length > 0)
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'contact.read',
            targetType: 'partner_contact',
            targetId: 'list',
            classificationRead: decision.restrictedRead,
            changes: { fields: [{ name: 'count', to: rows.length }] },
          }),
        );
      return q.due === undefined ? out : out.filter((c) => c.due === q.due);
    },
  );

  app.get(
    '/contacts/:id',
    { schema: { tags: ['contacts'], params: uuidParam, response: { 200: contactOut } } },
    async (request) => {
      const s = account(request);
      const row = await load(request, request.params.id);
      const decision = await request.authorize(
        'contact.read',
        { type: 'partner_contact', id: row.id, tenantId: s.tenantId, fields: FIELDS },
        { asNotFound: true },
      );
      const out = await toOut(row, decision.fields);
      if (decision.restrictedRead.length > 0)
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'contact.read',
            targetType: 'partner_contact',
            targetId: row.id,
            targetVersion: row.version,
            classificationRead: decision.restrictedRead,
          }),
        );
      return out;
    },
  );

  const body = {
    orgTenantId: z.uuid().nullable(),
    agency: z.string().min(1).max(200),
    role: z.string().max(120).nullable(),
    type: z.enum(types),
    active: z.boolean(),
    verifyBy: z.iso.date().nullable(),
    backupOf: z.uuid().nullable(),
    name: z.string().min(1).max(200),
    methods: methodsIn,
  };

  app.post(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        body: z.object({
          ...body,
          orgTenantId: body.orgTenantId.optional(),
          role: body.role.optional(),
          type: body.type.default('operations'),
          active: body.active.default(true),
          verifyBy: body.verifyBy.optional(),
          backupOf: body.backupOf.optional(),
        }),
        response: { 201: contactOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('contact.edit', {
        type: 'partner_contact',
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      const b = request.body;
      if (!b.methods.phone && !b.methods.email && !b.methods.radio && !b.methods.other)
        throw errors.validation([
          { name: 'methods', message: 'at least one way to reach the contact' },
        ]);
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.partner_contact')
          .values({
            tenant_id: s.tenantId,
            org_tenant_id: b.orgTenantId ?? null,
            agency: b.agency,
            name_enc: await app.fieldCrypto.encrypt(s.tenantId, b.name),
            role: b.role ?? null,
            methods_enc: await app.fieldCrypto.encrypt(s.tenantId, JSON.stringify(b.methods)),
            type: b.type,
            active: b.active,
            verified_at: new Date(),
            verify_by:
              b.verifyBy ??
              new Date(Date.now() + DEFAULT_VERIFY_DAYS * 86_400_000).toISOString().slice(0, 10),
            backup_of: b.backupOf ?? null,
            owner_account_id: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'contact.create',
          targetType: 'partner_contact',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: {
            fields: [
              { name: 'agency', to: b.agency },
              { name: 'type', to: b.type },
            ],
          },
        });
        return inserted;
      });
      return reply.code(201).send(await toOut(row, ['name', 'methods']));
    },
  );

  app.patch(
    '/contacts/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['contacts'],
        params: uuidParam,
        body: z.object(
          Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v.optional()])) as {
            [K in keyof typeof body]: z.ZodOptional<(typeof body)[K]>;
          },
        ),
        response: { 200: contactOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await load(request, request.params.id);
      await request.authorize(
        'contact.edit',
        { type: 'partner_contact', id: current.id, tenantId: s.tenantId, fields: FIELDS },
        { asNotFound: true },
      );
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.partner_contact')
            .set({
              ...(b.orgTenantId !== undefined ? { org_tenant_id: b.orgTenantId } : {}),
              ...(b.agency !== undefined ? { agency: b.agency } : {}),
              ...(b.role !== undefined ? { role: b.role } : {}),
              ...(b.type !== undefined ? { type: b.type } : {}),
              ...(b.active !== undefined ? { active: b.active } : {}),
              ...(b.verifyBy !== undefined ? { verify_by: b.verifyBy } : {}),
              ...(b.backupOf !== undefined ? { backup_of: b.backupOf } : {}),
              ...(b.name !== undefined
                ? { name_enc: await app.fieldCrypto.encrypt(s.tenantId, b.name) }
                : {}),
              ...(b.methods !== undefined
                ? {
                    methods_enc: await app.fieldCrypto.encrypt(
                      s.tenantId,
                      JSON.stringify(b.methods),
                    ),
                  }
                : {}),
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          await toOut(current, []),
        );
        await request.audit(trx, {
          action: 'contact.update',
          targetType: 'partner_contact',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: {
            fields: Object.keys(b).map((name) => ({
              name,
              to:
                name === 'name' || name === 'methods'
                  ? '[restricted]'
                  : (b as Record<string, unknown>)[name],
            })),
          },
        });
        return updated;
      });
      return toOut(row, ['name', 'methods']);
    },
  );

  app.post(
    '/contacts/:id/verify',
    {
      schema: {
        tags: ['contacts'],
        params: uuidParam,
        body: z.object({ days: z.number().int().min(1).max(730).default(DEFAULT_VERIFY_DAYS) }),
        response: { 200: contactOut },
      },
    },
    async (request) => {
      const s = account(request);
      const current = await load(request, request.params.id);
      await request.authorize(
        'contact.edit',
        { type: 'partner_contact', id: current.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      const row = await request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cg.partner_contact')
          .set({
            verified_at: new Date(),
            verify_by: new Date(Date.now() + request.body.days * 86_400_000)
              .toISOString()
              .slice(0, 10),
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'contact.verify',
          targetType: 'partner_contact',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: {
            fields: [
              {
                name: 'verify_by',
                from: dateOnly(current.verify_by),
                to: dateOnly(updated.verify_by),
              },
            ],
          },
        });
        return updated;
      });
      return toOut(row, []);
    },
  );
};
