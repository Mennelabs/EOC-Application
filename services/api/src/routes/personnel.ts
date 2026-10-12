/**
 * Personnel records (BRD:FR-05.01–05.05, PER-01 basics, ACCT-01). Contact
 * details are restricted data: stored encrypted with the tenant's key
 * (SEC-10), returned only when the role's data categories include
 * 'contact', and every such read is audited (SEC-18). Exact lookup by phone
 * uses a blind index so the number is never stored in clear (FL-02 pattern).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { FieldDescriptor } from '@cg/authz';
import { normalisePhone } from '@cg/crypto';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso, listQuery, pickDefined, stamped, uuidParam } from './helpers.ts';

const FIELDS: FieldDescriptor[] = [
  { name: 'name', category: 'basic', classification: 'sensitive' },
  { name: 'agency', category: 'basic', classification: 'internal' },
  { name: 'department', category: 'basic', classification: 'internal' },
  { name: 'operationalRole', category: 'basic', classification: 'internal' },
  { name: 'skills', category: 'basic', classification: 'internal' },
  { name: 'contact', category: 'contact', classification: 'restricted' },
];

const contactSchema = z.object({
  phone: z.string().min(7).max(20).optional(),
  email: z.email().optional(),
});

const personnelOut = z.object({
  ...stamped,
  tenantId: z.uuid(),
  accountId: z.uuid().nullable(),
  name: z.string(),
  agency: z.string().nullable(),
  department: z.string().nullable(),
  operationalRole: z.string().nullable(),
  skills: z.array(z.string()),
  dutyStatus: z.enum(['off_duty', 'on_duty']),
  availability: z.enum(['unavailable', 'available', 'assigned']),
  status: z.enum(['active', 'inactive', 'archived']),
  /** Present only when the caller may see contact details. */
  contact: contactSchema.nullable().optional(),
});

type Row = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  tenant_id: string;
  account_id: string | null;
  name: string;
  agency: string | null;
  department: string | null;
  operational_role: string | null;
  skills: string[];
  duty_status: 'off_duty' | 'on_duty';
  availability: 'unavailable' | 'available' | 'assigned';
  status: 'active' | 'inactive' | 'archived';
  contact_enc: Buffer | null;
};

const toPersonnel = (r: Row): z.infer<typeof personnelOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  tenantId: r.tenant_id,
  accountId: r.account_id,
  name: r.name,
  agency: r.agency,
  department: r.department,
  operationalRole: r.operational_role,
  skills: r.skills,
  dutyStatus: r.duty_status,
  availability: r.availability,
  status: r.status,
});

export const personnelRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/personnel',
    {
      schema: {
        tags: ['personnel'],
        querystring: listQuery,
        response: { 200: z.array(personnelOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      // Lists never carry contact details; the detail route does, with an audit row.
      await request.authorize('personnel.read', {
        type: 'personnel',
        tenantId: s.tenantId,
        fields: FIELDS.filter((f) => f.name !== 'contact'),
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .selectAll()
          .where('status', '<>', 'archived')
          .orderBy('name')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map(toPersonnel);
    },
  );

  app.get(
    '/personnel/:id',
    { schema: { tags: ['personnel'], params: uuidParam, response: { 200: personnelOut } } },
    async (request) => {
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      const decision = await request.authorize(
        'personnel.read',
        { type: 'personnel', id: row.id, tenantId: row.tenant_id, fields: FIELDS },
        { asNotFound: true },
      );
      const out = toPersonnel(row);
      if (decision.fields.includes('contact')) {
        out.contact = row.contact_enc
          ? (JSON.parse(await app.fieldCrypto.decrypt(row.tenant_id, row.contact_enc)) as z.infer<
              typeof contactSchema
            >)
          : null;
        // SEC-18: every read of restricted data is audited.
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'personnel.read',
            targetType: 'personnel',
            targetId: row.id,
            targetVersion: row.version,
            classificationRead: decision.restrictedRead,
          }),
        );
      }
      return out;
    },
  );

  // FL-02 pattern: exact match by phone through the blind index, never by scanning plaintext.
  app.get(
    '/personnel/lookup',
    {
      schema: {
        tags: ['personnel'],
        querystring: z.object({ phone: z.string().min(7).max(20) }),
        response: {
          200: z.array(personnelOut.pick({ id: true, name: true, agency: true, status: true })),
        },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const decision = await request.authorize('personnel.read', {
        type: 'personnel',
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      if (!decision.fields.includes('contact')) throw errors.forbidden();
      const bidx = await app.fieldCrypto.blindIndex(
        s.tenantId,
        'phone',
        normalisePhone(request.query.phone),
      );
      const rows = await request.tx(async (trx) => {
        const found = await trx
          .selectFrom('cg.personnel')
          .select(['id', 'name', 'agency', 'status'])
          .where('tenant_id', '=', s.tenantId)
          .where('phone_bidx', '=', bidx)
          .execute();
        await request.audit(trx, {
          action: 'personnel.read',
          targetType: 'personnel',
          targetId: found.map((f) => f.id).join(',') || '-',
          classificationRead: ['contact'],
          reason: 'lookup by phone',
        });
        return found;
      });
      return rows;
    },
  );

  const createBody = z.object({
    name: z.string().min(1).max(200),
    agency: z.string().max(200).optional(),
    department: z.string().max(200).optional(),
    operationalRole: z.string().max(120).optional(),
    skills: z.array(z.string().min(1).max(60)).max(50).default([]),
    accountId: z.uuid().optional(),
    contact: contactSchema.optional(),
  });

  async function sealContact(tenantId: string, contact: z.infer<typeof contactSchema> | undefined) {
    if (!contact) return { contact_enc: null, phone_bidx: null };
    const normalised = contact.phone
      ? { ...contact, phone: normalisePhone(contact.phone) }
      : contact;
    return {
      contact_enc: await app.fieldCrypto.encrypt(tenantId, JSON.stringify(normalised)),
      phone_bidx: normalised.phone
        ? await app.fieldCrypto.blindIndex(tenantId, 'phone', normalised.phone)
        : null,
    };
  }

  app.post(
    '/personnel',
    {
      config: { idempotent: true },
      schema: { tags: ['personnel'], body: createBody, response: { 201: personnelOut } },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const decision = await request.authorize('personnel.create', {
        type: 'personnel',
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      if (request.body.contact && !decision.fields.includes('contact')) throw errors.forbidden();
      const sealed = await sealContact(s.tenantId, request.body.contact);
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.personnel')
          .values({
            tenant_id: s.tenantId,
            account_id: request.body.accountId ?? null,
            name: request.body.name,
            agency: request.body.agency ?? null,
            department: request.body.department ?? null,
            operational_role: request.body.operationalRole ?? null,
            skills: request.body.skills,
            ...sealed,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'personnel.create',
          targetType: 'personnel',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            {
              name: inserted.name,
              agency: inserted.agency,
              contact_enc: request.body.contact ?? null,
            },
            classifierFor('personnel'),
          ),
        });
        return inserted;
      });
      return reply.code(201).send(toPersonnel(row));
    },
  );

  app.patch(
    '/personnel/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['personnel'],
        params: uuidParam,
        body: createBody.partial().extend({
          dutyStatus: z.enum(['off_duty', 'on_duty']).optional(),
          availability: z.enum(['unavailable', 'available', 'assigned']).optional(),
        }),
        response: { 200: personnelOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      const decision = await request.authorize(
        'personnel.update',
        { type: 'personnel', id: current.id, tenantId: current.tenant_id, fields: FIELDS },
        { asNotFound: true },
      );
      if (request.body.contact !== undefined && !decision.fields.includes('contact'))
        throw errors.forbidden();
      // BRD:FR-05.04: duty/availability self-updates vs coordinator updates follow the role grant;
      // a person linked to this record may always update their own availability.
      const changes = pickDefined(request.body, {
        name: 'name',
        agency: 'agency',
        department: 'department',
        operationalRole: 'operational_role',
        skills: 'skills',
        accountId: 'account_id',
        dutyStatus: 'duty_status',
        availability: 'availability',
      });
      const sealed =
        request.body.contact !== undefined
          ? await sealContact(current.tenant_id, request.body.contact)
          : {};
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.personnel')
            .set({ ...changes, ...sealed, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toPersonnel(current),
        );
        await request.audit(trx, {
          action: 'personnel.update',
          targetType: 'personnel',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(
            { ...current, contact_enc: current.contact_enc ? 'set' : null },
            { ...row, contact_enc: row.contact_enc ? 'set' : null },
            classifierFor('personnel'),
          ),
        });
        return row;
      });
      return toPersonnel(updated);
    },
  );

  app.post(
    '/personnel/:id/archive',
    {
      config: { requiresVersion: true },
      schema: { tags: ['personnel'], params: uuidParam, response: { 200: personnelOut } },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'personnel.archive',
        { type: 'personnel', id: current.id, tenantId: current.tenant_id },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.personnel')
            .set({ status: 'archived', availability: 'unavailable', updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toPersonnel(current),
        );
        await request.audit(trx, {
          action: 'personnel.archive',
          targetType: 'personnel',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(
            { status: current.status },
            { status: row.status },
            classifierFor('personnel'),
          ),
          reason,
        });
        return row;
      });
      return toPersonnel(updated);
    },
  );
};
